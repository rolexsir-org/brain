// Publishing queue — durable, ordered, cancellable, restart-safe.

import { STATES, normalizeStatus, canTransition } from './stateMachine.js';
import { isEligibleForAutomation, recordAutomationExecution } from './automation.js';

const QUEUE_KEY = 'instagram:queue';
const STORE_VERSION = 1;

function nowISO(){ return new Date().toISOString(); }

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
  // Ensure draft exists and is in queueable state
  const draft = store.get('instagramDraft', draftId);
  if (!draft) return { ok:false, error:'Draft not found' };
  const s = normalizeStatus(draft.status);
  if (!['READY','AWAITING_APPROVAL','SCHEDULED'].includes(s) && s !== STATES.FAILED) {
    // allow failed to be re-queued
    if (s !== 'FAILED') return { ok:false, error:`Status ${s} not queueable` };
  }
  const queue = await getQueue(store);
  // prevent duplicate queue entry for same draft in pending states
  const existing = queue.find(q=> q.draftId===draftId && ['SCHEDULED','UPLOADING','PROCESSING'].includes(q.status));
  if (existing) return { ok:false, error:'Already in publishing queue' };

  const entry = makeQueueEntry(draftId, opts);
  queue.push(entry);
  await saveQueue(store, queue);
  // update draft to SCHEDULED if not already
  if (s !== STATES.SCHEDULED) await store.update('instagramDraft', draftId, { status: STATES.SCHEDULED, scheduledAt: entry.scheduledAt });
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

// Process queue — called on app boot and periodically while app open
export async function processQueue(store, connection, { onPublish } = {}) {
  const pending = await getPendingQueue(store);
  if (!pending.length) return { ok:true, processed:0 };
  const automation = store.settings?.instagram?.automation;
  let processed=0;
  for (const entry of pending) {
    const draft = store.get('instagramDraft', entry.draftId);
    if (!draft) { await dequeue(store, entry.id); continue; }
    const s = normalizeStatus(draft.status);
    if (s===STATES.CANCELLED || s===STATES.PUBLISHED) { await dequeue(store, entry.id); continue; }
    // Check automation permission if this entry was automation-triggered
    if (entry.actor==='automation' && automation) {
      if (automation.paused || !automation.enabled) { continue; }
      // Still check rule eligibility at execution time
      const rule = (automation.rules||[]).find(r=>r.id===entry.ruleId);
      if (rule) {
        const elig = isEligibleForAutomation(draft, rule, automation);
        if (!elig.eligible) {
          await store.update('instagramDraft', draft.id, { status: STATES.FAILED, lastError: `Automation blocked: ${elig.reason}` });
          await dequeue(store, entry.id);
          continue;
        }
      }
    }
    // Attempt publish via provided callback (which handles actual API)
    if (onPublish) {
      try {
        const res = await onPublish(draft, connection, entry);
        if (res && res.ok) {
          // Remove from queue on success
          await dequeue(store, entry.id);
          processed++;
        } else {
          entry.attempts = (entry.attempts||0)+1;
          entry.lastError = res?.error || 'Unknown';
          entry.updatedAt = nowISO();
          if (entry.attempts >= entry.maxAttempts) {
            await store.update('instagramDraft', draft.id, { status: STATES.FAILED, lastError: entry.lastError });
            await dequeue(store, entry.id);
          } else {
            // backoff 5m per attempt
            entry.scheduledAt = new Date(Date.now() + 5*60*1000*entry.attempts).toISOString();
            const q = await getQueue(store);
            const idx = q.findIndex(qq=>qq.id===entry.id);
            if (idx!==-1) { q[idx]=entry; await saveQueue(store,q); }
          }
        }
      } catch (e) {
        entry.lastError = e.message || String(e);
        await saveQueue(store, await getQueue(store)); // ensure persisted
      }
    }
  }
  return { ok:true, processed };
}

export async function clearAllQueue(store) {
  await saveQueue(store, []);
  return { ok:true };
}
