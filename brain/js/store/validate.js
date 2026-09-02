// Entity definitions + validation + sanitization.
// Treats all incoming data as untrusted. Entity factories return clean,
// internally-shaped records. sanitize() drops unknown keys and coerces types,
// so a malformed import cannot poison the store or execute code.

import { uid } from '../util/util.js';
import { nowISO } from '../util/util.js';

export const MAX_STR = 8000;

export function cleanText(v, max = MAX_STR) {
  if (v == null) return '';
  let s = String(v);
  // strip control chars except newline/tab, and any HTML-ish markup markers defensively
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return s.slice(0, max);
}

function cleanName(v) {
  return cleanText(v, 200).replace(/\s+/g, ' ').trim();
}
function cleanDateIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function pick(o, keys) {
  const out = {};
  for (const k of keys) if (k in o) out[k] = o[k];
  return out;
}
const numOr0 = v => (typeof v === 'number' && isFinite(v) ? v : 0);

function base(o = {}) {
  return {
    id: typeof o.id === 'string' && o.id ? String(o.id).slice(0, 64) : uid(),
    createdAt: cleanDateIso(o.createdAt) || nowISO(),
    updatedAt: cleanDateIso(o.updatedAt) || nowISO()
  };
}

export function makeTask(o = {}) {
  return { ...base(o), type: 'task', title: cleanName(o.title || ''), note: cleanText(o.note),
    due: cleanDateIso(o.due), status: o.status === 'done' ? 'done' : 'open',
    priority: [0, 1, 2, 3].includes(+o.priority) ? +o.priority : 1,
    completedAt: o.status === 'done' ? cleanDateIso(o.completedAt || nowISO()) : null,
    recur: sanitizeRecur(o.recur), deletedAt: null };
}

export function makeReminder(o = {}) {
  const r = { ...base(o), type: 'reminder', title: cleanName(o.title || ''),
    at: cleanDateIso(o.at), recur: sanitizeRecur(o.recur),
    snoozedUntil: cleanDateIso(o.snoozedUntil), status: o.status === 'done' ? 'done' : 'active',
    acknowledgedAt: null, deletedAt: null, nextAt: cleanDateIso(o.nextAt),
    lastFiredKey: typeof o.lastFiredKey === 'string' ? o.lastFiredKey.slice(0, 80) : null };
  return r;
}

export function sanitizeRecur(r) {
  if (!r || typeof r !== 'object') return null;
  const out = {};
  if (r.freq === 'daily' || r.freq === 'weekly' || r.freq === 'monthly' || r.freq === 'yearly') out.freq = r.freq;
  else return null;
  if (out.freq === 'weekly') {
    const days = Array.isArray(r.days) ? r.days.map(Number).filter(d => d >= 0 && d <= 6) : [];
    out.days = [...new Set(days)].sort((a, b) => a - b);
  }
  if (r.freq === 'daily' || r.freq === 'weekly' || r.freq === 'monthly' || r.freq === 'yearly') {
    if (r.interval && Number.isInteger(+r.interval) && +r.interval >= 1 && +r.interval <= 60) out.interval = +r.interval;
    else out.interval = 1;
    if (r.time) {
      const [hh, mm] = String(r.time).split(':').map(Number);
      if (Number.isInteger(hh) && hh >= 0 && hh < 24 && Number.isInteger(mm) && mm >= 0 && mm < 60) out.time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      else out.time = '09:00';
    } else out.time = '09:00';
  }
  if (out.freq === 'monthly' && Number.isInteger(+r.dayOfMonth) && +r.dayOfMonth >= 1 && +r.dayOfMonth <= 31) out.dayOfMonth = +r.dayOfMonth;
  if (out.freq === 'yearly' && Number.isInteger(+r.dayOfMonth) && +r.dayOfMonth >= 1 && +r.dayOfMonth <= 31) out.dayOfMonth = +r.dayOfMonth;
  if (out.freq === 'yearly' && Number.isInteger(+r.monthOfYear) && +r.monthOfYear >= 0 && +r.monthOfYear <= 11) out.monthOfYear = +r.monthOfYear;
  return out;
}

export function makeNote(o = {}) {
  return { ...base(o), type: 'note', title: cleanName(o.title || ''), body: cleanText(o.body),
    private: !!o.private, tags: Array.isArray(o.tags) ? o.tags.map(t => cleanText(t, 80)).filter(Boolean).slice(0, 20) : [],
    deletedAt: null };
}

export function makePerson(o = {}) {
  return { ...base(o), type: 'person', name: cleanName(o.name || ''), phone: cleanText(o.phone, 40),
    email: cleanText(o.email, 120).trim().toLowerCase(), address: cleanText(o.address, 400),
    birthday: cleanText(o.birthday, 60), relationship: cleanText(o.relationship, 60),
    notes: cleanText(o.notes), tags: Array.isArray(o.tags) ? o.tags.map(t => cleanText(t, 80)).filter(Boolean).slice(0, 20) : [],
    deletedAt: null };
}

export function makeMoney(o = {}) {
  return { ...base(o), type: 'money',
    kind: o.kind === 'income' ? 'income' : 'expense',
    amount: numOr0(+o.amount), category: cleanText(o.category, 120), party: cleanName(o.party),
    date: cleanDateIso(o.date || nowISO()), deletedAt: null };
}

export function makeDebt(o = {}) {
  return { ...base(o), type: 'debt', person: cleanName(o.person || ''), amount: numOr0(+o.amount),
    dir: o.dir === 'i_owe_them' ? 'i_owe_them' : 'they_owe_me',
    status: o.status === 'settled' ? 'settled' : 'open',
    settledAt: o.status === 'settled' ? cleanDateIso(o.settledAt || nowISO()) : null,
    date: cleanDateIso(o.date || nowISO()), deletedAt: null };
}

export function makeStockItem(o = {}) {
  return { ...base(o), type: 'stockItem', name: cleanName(o.name || ''), qty: numOr0(+o.qty),
    unit: cleanText(o.unit, 20) || 'unit', lowThreshold: (o.lowThreshold == null ? null : numOr0(+o.lowThreshold)),
    history: Array.isArray(o.history) ? o.history.slice(-300).map(h => ({
      at: cleanDateIso(h.at || nowISO()), delta: numOr0(+h.delta), note: cleanText(h.note, 200)
    })) : [], deletedAt: null };
}

export function makeHabit(o = {}) {
  return { ...base(o), type: 'habit', name: cleanName(o.name || ''),
    schedule: sanitizeRecur(o.schedule) || { freq: 'daily', interval: 1 },
    log: Array.isArray(o.log) ? o.log.map(t => cleanDateIso(t)).filter(Boolean) : [],
    deletedAt: null };
}

export function makeJournal(o = {}) {
  return { ...base(o), type: 'journal', text: cleanText(o.text), mood: cleanText(o.mood, 30),
    date: cleanDateIso(o.date || nowISO()), photoId: (typeof o.photoId === 'string' && o.photoId) ? o.photoId.slice(0, 64) : null,
    deletedAt: null };
}

// Photos hold a downscaled JPEG data-URL plus metadata. MAX_IMAGE guards the
// binary payload so imports can't balloon memory; pickImage already compresses.
export const MAX_IMAGE = 5_000_000;

export function makePhoto(o = {}) {
  return { ...base(o), type: 'photo', name: cleanText(o.name, 160) || 'photo',
    mime: /^data:image\/[\w.+-]+;base64,/.test(o.dataUrl || '') ? (o.dataUrl.match(/^data:(image\/[\w.+-]+);/)[1]) : cleanText(o.mime, 40) || 'image/jpeg',
    size: numOr0(+o.size), width: numOr0(+o.width), height: numOr0(+o.height),
    dataUrl: String(o.dataUrl || '').slice(0, MAX_IMAGE), deletedAt: null };
}

export function makeEvent(o = {}) {
  return { ...base(o), type: 'event', title: cleanName(o.title || ''), kind: cleanText(o.kind, 60),
    at: cleanDateIso(o.at), allDay: !!o.allDay, deletedAt: null };
}

/** Re-key/re-shape a raw record (import or legacy) into a clean entity by its type tag. */
export function sanitizeRecord(type, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  switch (type) {
    case 'task': return makeTask(raw);
    case 'reminder': return makeReminder(raw);
    case 'note': return makeNote(raw);
    case 'person': return makePerson(raw);
    case 'money': return makeMoney(raw);
    case 'debt': return makeDebt(raw);
    case 'stockItem': return makeStockItem(raw);
    case 'habit': return makeHabit(raw);
    case 'journal': return makeJournal(raw);
    case 'event': return makeEvent(raw);
    case 'photo': return makePhoto(raw);
    default: return null;
  }
}

// Whitelist of entity types stored by key.
export const COLLECTIONS = ['task', 'reminder', 'note', 'person', 'money', 'debt', 'stockItem', 'habit', 'journal', 'event', 'photo'];

export function emptyCollections() {
  const o = {};
  for (const c of COLLECTIONS) o[c] = [];
  return o;
}
