// Publishing queue — durable, ordered, cancellable, restart-safe.

import { STATES, normalizeStatus, canTransition } from './stateMachine.js';
import { isEligibleForAutomation, recordAutomationExecution } from './automation.js';

const QUEUE_KEY = 'instagram:queue';
const STORE_VERSION = 1;
const MAX_QUEUE_SIZE = 100;
export const MAX_ATTEMPTS_DEFAULT = 5;
export let EMERGENCY_STOP = false;
export function setEmergencyStop(v){ EMERGENCY_STOP = !!v; }

function nowISO(){ return new Date().toISOString(); }
function jitter(ms){ return ms + Math.floor(Math.random()*Math.min(30000, ms*0.3)); }
function backoffMs(attempt){ return jitter(Math.min(3600000, 30000 * Math.pow(2, Math.max(0, attempt-1)))); } // 30s, 60s, 120s… cap 1h with jitter

// Queue entry
export function makeQueueEntry(draftId, opts={}) {
  return {
    id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`,
    draftId: String(draftId).slice(0,64),
    status: opts.status || STATES.SCHEDULED,
    scheduledAt: opts.scheduledAt || nowISO(),
    attempts: opts.attempts || 0,
    maxAttempts: opts.maxAttempts || 3,
    lastError: opts.lastError || null,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    ruleId: opts.ruleId || null,
    actor: opts.actor || 'user'
  };
}

export async function enqueue(store, draftId, opts={}) {
  if (EMERGENCY_STOP) return { ok:false, error:'Queue is emergency-stopped. Resume in Automation Centre.' };
  const draft = store.get('instagramDraft', draftId);
  if (!draft) return { ok:false, error:'Draft not found' };
  const s = normalizeStatus(draft.status);
  if (!['READY','AWAITING_APPROVAL','SCHEDULED'].includes(s) && s !== STATES.FAILED) {
    if (s !== 'FAILED') return { ok:false, error:`Status ${s} not queueable` };
  }
  const queue = await getQueue(store);
  if (queue.length >= MAX_QUEUE_SIZE) return { ok:false, error:`Queue full (${MAX_QUEUE_SIZE}). Remove old jobs first.` };
  const existing = queue.find(q=> q.draftId===draftId && ['SCHEDULED','UPLOADING','PROCESSING','CLAIMED'].includes(q.status));
  if (existing) return { ok:false, error:'Already in publishing queue' };

  const entry = makeQueueEntry(draftId, opts);
  // Atomic: append then verify no duplicate slipped in (single transaction via kvSetMany)
  queue.push(entry);
  await saveQueue(store, queue);
  // Re-read to detect race
  const verify = await getQueue(store);
  const dupCount = verify.filter(q=> q.draftId===draftId && ['SCHEDULED','UPLOADING','PROCESSING','CLAIMED'].includes(q.status)).length;
  if (dupCount > 1) {
    // rollback last
    const pruned = verify.filter((q,i)=> !(q.draftId===draftId && q.id===entry.id && i!== verify.findIndex(x=> x.draftId===draftId)));
    await saveQueue(store, pruned);
    return { ok:false, error:'Duplicate detected — job already claimed' };
  }
  if (s !== STATES.SCHEDULED) await store.update('instagramDraft', draftId, { status: STATES.SCHEDULED, scheduledAt: entry.scheduledAt, history: [...(draft.history||[]), { at: nowISO(), action:'queued', fromStatus:s, actor: opts.actor||'user' }].slice(-100) });
  return { ok:true, entry };
}

export async function dequeue(store, queueId) {
  const queue = await getQueue(store);
  const idx = queue.findIndex(q=>q.id===queueId);
  if (idx===-1) return { ok:false, error:'Queue entry not found' };
  const entry = queue[idx];
  queue.splice(idx,1);
  await saveQueue(store, queue);
  // mark draft cancelled if it was scheduled for this queue
  const draft = store.get('instagramDraft', entry.draftId);
  if (draft && normalizeStatus(draft.status)===STATES.SCHEDULED) {
    await store.update('instagramDraft', entry.draftId, { status: STATES.CANCELLED });
  }
  return { ok:true };
}

export async function cancelQueueForDraft(store, draftId) {
  const queue = await getQueue(store);
  const remaining = queue.filter(q=>q.draftId!==draftId);
  if (remaining.length===queue.length) return { ok:false, error:'No queue entry for draft' };
  await saveQueue(store, remaining);
  const draft = store.get('instagramDraft', draftId);
  if (draft) {
    const s = normalizeStatus(draft.status);
    if (s===STATES.SCHEDULED || s===STATES.UPLOADING || s===STATES.AWAITING_APPROVAL) {
      await store.update('instagramDraft', draftId, { status: STATES.CANCELLED });
    }
  }
  return { ok:true };
}

export async function getQueue(store) {
  try {
    const raw = await store.db.kvGet(QUEUE_KEY);
    if (!raw || !Array.isArray(raw.entries)) return [];
    return raw.entries;
  } catch { return []; }
}

export async function saveQueue(store, entries) {
  try {
    await store.db.kvSet(QUEUE_KEY, { version: STORE_VERSION, entries: entries.slice(0,200), updatedAt: nowISO() });
  } catch {}
}

export async function getPendingQueue(store) {
  const q = await getQueue(store);
  const now = Date.now();
  return q.filter(entry=>{
    try {
      const at = new Date(entry.scheduledAt).getTime();
      return at <= now && ['SCHEDULED'].includes(entry.status);
    } catch { return false; }
  }).sort((a,b)=> new Date(a.scheduledAt)-new Date(b.scheduledAt));
}

// Fencing token + renewable lease: prevents stale worker from committing
function generateFencingToken(){ try { const b=new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join(''); } catch { return Math.random().toString(36).slice(2)+Date.now().toString(36); } }

// Atomic job claiming: CLAIMED prevents concurrent workers; returns {entry, leaseToken}
export async function claimJob(store, entryId) {
  const queue = await getQueue(store);
  const idx = queue.findIndex(q=> q.id===entryId);
  if (idx===-1) return null;
  const entry = queue[idx];
  if (entry.status !== STATES.SCHEDULED) return null; // already claimed/processing
  // Lock with fencing token and lease
  const leaseToken = generateFencingToken();
  const leaseExpiry = new Date(Date.now()+ 5*60*1000).toISOString(); // 5 min lease
  entry.status = 'CLAIMED';
  entry.claimedAt = nowISO();
  entry.leaseToken = leaseToken;
  entry.leaseExpiry = leaseExpiry;
  entry.updatedAt = nowISO();
  await saveQueue(store, queue);
  // Verify we still hold the claim with our token
  const verify = await getQueue(store);
  const held = verify.find(q=> q.id===entryId);
  if (!held || held.status !== 'CLAIMED' || held.leaseToken !== leaseToken) return null; // race lost
  return { entry: held, leaseToken };
}

export async function renewLease(store, entryId, leaseToken) {
  const queue = await getQueue(store);
  const idx = queue.findIndex(q=> q.id===entryId);
  if (idx===-1) return { ok:false, error:'not found' };
  const entry = queue[idx];
  if (entry.leaseToken !== leaseToken) return { ok:false, error:'fencing token mismatch — job claimed by another worker' };
  if (new Date(entry.leaseExpiry).getTime() < Date.now()) return { ok:false, error:'lease expired' };
  entry.leaseExpiry = new Date(Date.now()+ 5*60*1000).toISOString();
  entry.updatedAt = nowISO();
  await saveQueue(store, queue);
  return { ok:true, entry };
}

export function classifyRetry(errorMsg) {
  const msg = String(errorMsg||'').toLowerCase();
  if (/rate limit|429|too many/i.test(msg)) return { retry:true, backoff: 600000, reason:'rate-limited' }; // 10m
  if (/network|timeout|fetch failed|econnreset|etimedout/i.test(msg)) return { retry:true, backoff: null, reason:'transient' };
  if (/expired|container|not found|invalid/i.test(msg)) return { retry:false, reason:'permanent' };
  if (/permission|auth|revoked|expired token|190/i.test(msg)) return { retry:false, reason:'auth' };
  return { retry:true, reason:'unknown' };
}

// Stale-job recovery: CLAIMED >5m old → reset to SCHEDULED
export async function recoverStaleJobs(store) {
  const queue = await getQueue(store);
  let recovered=0;
  for (const entry of queue) {
    if (entry.status === 'CLAIMED' && entry.claimedAt) {
      try {
        const age = Date.now() - new Date(entry.claimedAt).getTime();
        if (age > 5*60*1000) {
          entry.status = STATES.SCHEDULED;
          entry.updatedAt = nowISO();
          recovered++;
        }
      } catch {}
    }
  }
  if (recovered) await saveQueue(store, queue);
  return recovered;
}

// Process queue — atomic, with rate-limit-aware scheduling, jitter, and emergency stop
export async function processQueue(store, connection, { onPublish } = {}) {
  if (EMERGENCY_STOP) return { ok:true, processed:0, stopped:true };
  await recoverStaleJobs(store);
  const pending = await getPendingQueue(store);
  if (!pending.length) return { ok:true, processed:0 };
  const automation = store.settings?.instagram?.automation;
  // Rate-limit pre-check
  const { checkRateLimit } = await import('./stateMachine.js');
  const pubs = store.list('instagramPublication');
  const rate = checkRateLimit(pubs);
  if (!rate.ok) {
    // Defer all by 30m
    const q = await getQueue(store);
    let deferred=false;
    for (const e of q) if (e.status===STATES.SCHEDULED) { e.scheduledAt = new Date(Date.now()+30*60*1000).toISOString(); deferred=true; }
    if (deferred) await saveQueue(store, q);
    return { ok:false, error: rate.reason, deferred:true };
  }

  let processed=0;
  // Per-rule execution limits tracking for this batch
  const perRuleCounts = {};
  for (const entry of pending) {
    if (EMERGENCY_STOP) break;
    // Per-rule limit
    if (entry.ruleId) {
      const rule = (automation?.rules||[]).find(r=> r.id===entry.ruleId);
      const maxPerDay = rule?.limits?.maxPerDay || 10;
      const cnt = perRuleCounts[entry.ruleId] || 0;
      if (cnt >= maxPerDay) continue;
    }
    // Atomic claim with fencing token
    const claimRes = await claimJob(store, entry.id);
    if (!claimRes) continue; // lost race
    const { entry: claimedEntry, leaseToken } = claimRes;
    // Check cancellation after claim (race protection) — verify fencing token
    const freshQ = await getQueue(store);
    const still = freshQ.find(q=> q.id===entry.id);
    if (!still || still.status !== 'CLAIMED' || still.leaseToken !== leaseToken) continue;
    if (still.cancelled) { await dequeue(store, entry.id); continue; }

    const draft = store.get('instagramDraft', entry.draftId);
    if (!draft) { await dequeue(store, entry.id); continue; }
    const s = normalizeStatus(draft.status);
    if (s===STATES.CANCELLED || s===STATES.PUBLISHED) { await dequeue(store, entry.id); continue; }
    if (entry.actor==='automation' && automation) {
      if (automation.paused || !automation.enabled) {
        // release claim back to SCHEDULED without counting attempt
        const q2 = await getQueue(store);
        const idx2 = q2.findIndex(q=> q.id===entry.id);
        if (idx2!==-1) { q2[idx2].status = STATES.SCHEDULED; q2[idx2].updatedAt=nowISO(); await saveQueue(store,q2); }
        continue;
      }
      const rule = (automation.rules||[]).find(r=>r.id===entry.ruleId);
      if (rule) {
        const elig = isEligibleForAutomation(draft, rule, automation);
        if (!elig.eligible) {
          await store.update('instagramDraft', draft.id, { status: STATES.FAILED, lastError: `Automation blocked: ${elig.reason}`, history: [...(draft.history||[]), { at: nowISO(), action:'automation_blocked', fromStatus:s, details: elig.reason, actor:'system' }].slice(-100) });
          await dequeue(store, entry.id);
          continue;
        }
      }
    }

    // Mark attempt persistent before network (prevents blind repeat after timeout)
    const attemptEntry = (await getQueue(store)).find(q=> q.id===entry.id);
    if (attemptEntry) { attemptEntry.attempts=(attemptEntry.attempts||0)+1; attemptEntry.updatedAt=nowISO(); await saveQueue(store, await getQueue(store)); }

    // Determine if Meta accepted before blind repeat: we rely on executePublish to return ok only if mediaId exists; ambiguous timeout is treated as transient and will retry with check before retry
    if (onPublish) {
      let res;
      try {
        // Check before retry: if entry already has containerId from previous attempt, verify it before re-creating
        res = await onPublish(draft, connection, entry);
      } catch (e) {
        res = { ok:false, error: e.message || String(e) };
      }
      const qNow = await getQueue(store);
      const cur = qNow.find(q=> q.id===entry.id);
      if (!cur) continue; // was cancelled mid-flight
      if (res && res.ok) {
        await dequeue(store, entry.id);
        if (entry.ruleId) perRuleCounts[entry.ruleId]=(perRuleCounts[entry.ruleId]||0)+1;
        // audit
        try {
          const { recordAutomationExecution } = await import('./automation.js');
          if (automation && entry.ruleId) {
            const upd = recordAutomationExecution(automation, { draftId: draft.id, ruleId: entry.ruleId, action:'published', result:'ok', actor:'automation' });
            await store.updateSettings({ instagram:{...store.settings.instagram, automation: upd }});
          }
        } catch {}
        processed++;
      } else {
        const errMsg = res?.error || 'Unknown';
        const cls = classifyRetry(errMsg);
        // Release claim: either FAILED or reschedule with backoff+jitter
        const isLastAttempt = (cur.attempts||0) >= (cur.maxAttempts||MAX_ATTEMPTS_DEFAULT);
        if (!cls.retry || isLastAttempt || cls.reason==='auth' || cls.reason==='permanent') {
          await store.update('instagramDraft', draft.id, { status: STATES.FAILED, lastError: errMsg, history: [...(store.get('instagramDraft',draft.id)?.history||[]), { at: nowISO(), action:'publish_failed', fromStatus:s, details: errMsg, actor: entry.actor||'automation' }].slice(-100) });
          await dequeue(store, entry.id);
          try {
            const { recordAutomationExecution } = await import('./automation.js');
            if (automation && entry.ruleId) {
              const upd = recordAutomationExecution(automation, { draftId: draft.id, ruleId: entry.ruleId, action:'failed', result:'failed', error: errMsg, actor:'automation' });
              await store.updateSettings({ instagram:{...store.settings.instagram, automation: upd }});
            }
          } catch {}
        } else {
          const delay = cls.backoff || backoffMs(cur.attempts||1);
          cur.status = STATES.SCHEDULED;
          cur.lastError = errMsg;
          cur.scheduledAt = new Date(Date.now()+delay).toISOString();
          cur.updatedAt = nowISO();
          await saveQueue(store, qNow);
        }
      }
    } else {
      // no publisher, release claim
      const q2 = await getQueue(store);
      const idx2 = q2.findIndex(q=> q.id===entry.id);
      if (idx2!==-1) { q2[idx2].status = STATES.SCHEDULED; await saveQueue(store,q2); }
    }
  }
  return { ok:true, processed };
}

export async function clearAllQueue(store) {
  await saveQueue(store, []);
  return { ok:true };
}
