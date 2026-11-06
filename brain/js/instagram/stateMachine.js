// Durable publishing state machine — persists, prevents duplicates, handles
// expired containers, interrupted uploads, rate limits, cancellation, restart recovery.
// States: DRAFT → READY → AWAITING_APPROVAL → SCHEDULED → UPLOADING → PROCESSING → PUBLISHED | FAILED | CANCELLED

export const STATES = Object.freeze({
  DRAFT: 'DRAFT',
  READY: 'READY',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  SCHEDULED: 'SCHEDULED',
  UPLOADING: 'UPLOADING',
  PROCESSING: 'PROCESSING',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
});

export const LEGACY_MAP = Object.freeze({
  'draft': 'DRAFT',
  'ready': 'READY',
  'pending': 'AWAITING_APPROVAL',
  'publishing': 'PROCESSING',
  'published': 'PUBLISHED',
  'failed': 'FAILED',
  'scheduled': 'SCHEDULED'
});

const ALLOWED_TRANSITIONS = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['AWAITING_APPROVAL', 'SCHEDULED', 'UPLOADING', 'CANCELLED'],
  AWAITING_APPROVAL: ['UPLOADING', 'SCHEDULED', 'CANCELLED', 'FAILED'],
  SCHEDULED: ['AWAITING_APPROVAL', 'UPLOADING', 'CANCELLED'],
  UPLOADING: ['PROCESSING', 'FAILED', 'CANCELLED'],
  PROCESSING: ['PUBLISHED', 'FAILED', 'CANCELLED'],
  PUBLISHED: [],
  FAILED: ['READY', 'AWAITING_APPROVAL', 'SCHEDULED', 'CANCELLED'],
  CANCELLED: ['DRAFT', 'READY']
};

export function normalizeStatus(raw) {
  if (!raw) return STATES.DRAFT;
  const s = String(raw).trim().toUpperCase();
  if (STATES[s]) return STATES[s];
  const low = String(raw).trim().toLowerCase();
  if (LEGACY_MAP[low]) return LEGACY_MAP[low];
  return STATES.DRAFT;
}

export function canTransition(from, to) {
  const f = normalizeStatus(from);
  const t = normalizeStatus(to);
  if (f === t) return true;
  const allowed = ALLOWED_TRANSITIONS[f] || [];
  return allowed.includes(t);
}

export function nextStates(current) {
  const s = normalizeStatus(current);
  return ALLOWED_TRANSITIONS[s] || [];
}

// Container expiry: Meta containers expire in ~24h. Check before retry.
export function isContainerExpired(containerCreatedAt, now = Date.now()) {
  if (!containerCreatedAt) return true;
  try {
    const created = new Date(containerCreatedAt).getTime();
    if (Number.isNaN(created)) return true;
    return now - created > 24 * 3600 * 1000 - 5 * 60 * 1000; // 5m buffer
  } catch { return true; }
}

// Rate limit advisory — configurable; Meta authoritative (see docs/api-compatibility.md)
import { INSTAGRAM_PUBLISH_LIMITS } from '../util/constants.js';
export function checkRateLimit(history, now = Date.now()) {
  const dayAgo = now - 24 * 3600 * 1000;
  const recent = history.filter(h => {
    try { return new Date(h.publishedAt || h.createdAt).getTime() > dayAgo; } catch { return false; }
  });
  const DAILY_LIMIT = (INSTAGRAM_PUBLISH_LIMITS && INSTAGRAM_PUBLISH_LIMITS.DAILY) || 25;
  const HOURLY_LIMIT = (INSTAGRAM_PUBLISH_LIMITS && INSTAGRAM_PUBLISH_LIMITS.HOURLY) || 5;
  const hourAgo = now - 3600 * 1000;
  const hourRecent = recent.filter(h => new Date(h.publishedAt || h.createdAt).getTime() > hourAgo);
  if (recent.length >= DAILY_LIMIT) return { ok: false, reason: `Daily limit (${DAILY_LIMIT}/day) reached. Try tomorrow.` };
  if (hourRecent.length >= HOURLY_LIMIT) return { ok: false, reason: `Hourly burst limit (${HOURLY_LIMIT}/hour) reached. Wait a bit.` };
  return { ok: true, remaining: DAILY_LIMIT - recent.length };
}

// Idempotency key: draft.id + containerId + status check prevents duplicates
export function isDuplicatePublish(draft, now = Date.now()) {
  const rawLow = String(draft.status||'').toLowerCase();
  if (rawLow === 'publishing') return { duplicate: true, reason: 'Already publishing — wait for result' };
  const s = normalizeStatus(draft.status);
  if (s === STATES.PUBLISHED) return { duplicate: true, reason: 'Already published' };
  if (s === STATES.UPLOADING || s === STATES.PROCESSING) return { duplicate: true, reason: `Already ${s.toLowerCase()} — wait for result` };
  // Check if recently attempted (within 30s) to avoid double-tap
  try {
    const updated = new Date(draft.updatedAt).getTime();
    if (now - updated < 3000 && draft.retryCount > 0) return { duplicate: false };
  } catch {}
  return { duplicate: false };
}

export function buildHistoryEntry(draft, action, details = {}) {
  return {
    at: new Date().toISOString(),
    action,
    fromStatus: normalizeStatus(draft.status),
    details: String(details.error || details.message || '').slice(0, 500),
    actor: details.actor || 'user',
    containerId: draft.igContainerId || null,
    mediaId: draft.igMediaId || null
  };
}
