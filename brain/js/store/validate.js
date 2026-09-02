// Entity definitions, validation, and sanitization.
// Imported files and browser input are untrusted. Sanitizers copy only known
// fields into plain records so malformed backups cannot poison app state.

import { uid, nowISO } from '../util/util.js';

export const MAX_STR = 8000;
export const MAX_IMAGE = 5_000_000;

export function cleanText(value, max = MAX_STR) {
  if (value == null) return '';
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, max);
}

function cleanName(value) { return cleanText(value, 200).replace(/\s+/g, ' ').trim(); }
function cleanDateIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function finiteNumber(value, fallback = 0, { min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
function base(raw = {}) {
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 64) : uid(),
    createdAt: cleanDateIso(raw.createdAt) || nowISO(),
    updatedAt: cleanDateIso(raw.updatedAt) || nowISO()
  };
}

export function sanitizeRecur(recurrence) {
  if (!recurrence || typeof recurrence !== 'object' || Array.isArray(recurrence)) return null;
  const out = {};
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(recurrence.freq)) return null;
  out.freq = recurrence.freq;
  out.interval = Number.isInteger(Number(recurrence.interval)) && Number(recurrence.interval) >= 1 && Number(recurrence.interval) <= 60
    ? Number(recurrence.interval) : 1;
  if (out.freq === 'weekly') {
    const days = Array.isArray(recurrence.days) ? recurrence.days.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6) : [];
    out.days = [...new Set(days)].sort((a, b) => a - b);
  }
  const time = String(recurrence.time || '09:00');
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (match && +match[1] >= 0 && +match[1] < 24 && +match[2] >= 0 && +match[2] < 60) {
    out.time = `${String(+match[1]).padStart(2, '0')}:${match[2]}`;
  } else out.time = '09:00';
  if (out.freq === 'monthly' || out.freq === 'yearly') {
    if (Number.isInteger(Number(recurrence.dayOfMonth)) && Number(recurrence.dayOfMonth) >= 1 && Number(recurrence.dayOfMonth) <= 31) out.dayOfMonth = Number(recurrence.dayOfMonth);
  }
  if (out.freq === 'yearly' && Number.isInteger(Number(recurrence.monthOfYear)) && Number(recurrence.monthOfYear) >= 0 && Number(recurrence.monthOfYear) <= 11) {
    out.monthOfYear = Number(recurrence.monthOfYear);
  }
  const anchor = cleanDateIso(recurrence.anchor);
  if (anchor) out.anchor = anchor;
  return out;
}

export function makeTask(raw = {}) {
  return {
    ...base(raw), type: 'task', title: cleanName(raw.title), note: cleanText(raw.note),
    due: cleanDateIso(raw.due), status: raw.status === 'done' ? 'done' : 'open',
    priority: [0, 1, 2, 3].includes(Number(raw.priority)) ? Number(raw.priority) : 1,
    completedAt: raw.status === 'done' ? cleanDateIso(raw.completedAt) || nowISO() : null,
    recur: sanitizeRecur(raw.recur), nextTaskId: typeof raw.nextTaskId === 'string' ? raw.nextTaskId.slice(0, 64) : null,
    deletedAt: null
  };
}

export function makeReminder(raw = {}) {
  const status = ['active', 'fired', 'done'].includes(raw.status) ? raw.status : 'active';
  return {
    ...base(raw), type: 'reminder', title: cleanName(raw.title), at: cleanDateIso(raw.at),
    recur: sanitizeRecur(raw.recur), snoozedUntil: cleanDateIso(raw.snoozedUntil),
    status, acknowledgedAt: cleanDateIso(raw.acknowledgedAt), deletedAt: null,
    nextAt: cleanDateIso(raw.nextAt), lastFiredKey: typeof raw.lastFiredKey === 'string' ? raw.lastFiredKey.slice(0, 100) : null,
    lastSnoozeKey: typeof raw.lastSnoozeKey === 'string' ? raw.lastSnoozeKey.slice(0, 100) : null
  };
}

export function makeNote(raw = {}) {
  return {
    ...base(raw), type: 'note', title: cleanName(raw.title), body: cleanText(raw.body),
    private: !!raw.private,
    tags: Array.isArray(raw.tags) ? raw.tags.map(tag => cleanText(tag, 80)).filter(Boolean).slice(0, 20) : [],
    deletedAt: null
  };
}

function cleanInstagram(value) { return cleanText(value, 80).trim().replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, ''); }
function cleanAliases(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(alias => cleanName(alias)).filter(Boolean).map(alias => alias.slice(0, 100)))].slice(0, 20);
}

export function makePerson(raw = {}) {
  return {
    ...base(raw), type: 'person', name: cleanName(raw.name), phone: cleanText(raw.phone, 40),
    email: cleanText(raw.email, 120).trim().toLowerCase(), address: cleanText(raw.address, 400),
    birthday: cleanText(raw.birthday, 60), relationship: cleanText(raw.relationship, 60),
    aliases: cleanAliases(raw.aliases), instagram: cleanInstagram(raw.instagram),
    notes: cleanText(raw.notes), tags: Array.isArray(raw.tags) ? raw.tags.map(tag => cleanText(tag, 80)).filter(Boolean).slice(0, 20) : [],
    deletedAt: null
  };
}

export function makeMoney(raw = {}) {
  return {
    ...base(raw), type: 'money', kind: raw.kind === 'income' ? 'income' : 'expense',
    amount: finiteNumber(raw.amount, 0, { min: -1_000_000_000_000, max: 1_000_000_000_000 }),
    category: cleanText(raw.category, 120), party: cleanName(raw.party),
    date: cleanDateIso(raw.date) || nowISO(), deletedAt: null
  };
}

export function makeDebt(raw = {}) {
  return {
    ...base(raw), type: 'debt', person: cleanName(raw.person),
    amount: Math.abs(finiteNumber(raw.amount, 0, { min: -1_000_000_000_000, max: 1_000_000_000_000 })),
    dir: raw.dir === 'i_owe_them' ? 'i_owe_them' : 'they_owe_me',
    status: raw.status === 'settled' ? 'settled' : 'open',
    settledAt: raw.status === 'settled' ? cleanDateIso(raw.settledAt) || nowISO() : null,
    date: cleanDateIso(raw.date) || nowISO(), deletedAt: null
  };
}

export function makeStockItem(raw = {}) {
  return {
    ...base(raw), type: 'stockItem', name: cleanName(raw.name),
    qty: finiteNumber(raw.qty, 0, { min: 0, max: 1_000_000_000 }),
    unit: cleanText(raw.unit, 20) || 'unit',
    lowThreshold: raw.lowThreshold == null ? null : finiteNumber(raw.lowThreshold, 0, { min: 0, max: 1_000_000_000 }),
    history: Array.isArray(raw.history) ? raw.history.slice(-300).map(entry => ({
      at: cleanDateIso(entry && entry.at) || nowISO(),
      delta: finiteNumber(entry && entry.delta, 0, { min: -1_000_000_000, max: 1_000_000_000 }),
      note: cleanText(entry && entry.note, 200)
    })) : [],
    deletedAt: null
  };
}

export function makeHabit(raw = {}) {
  return {
    ...base(raw), type: 'habit', name: cleanName(raw.name),
    schedule: sanitizeRecur(raw.schedule) || { freq: 'daily', interval: 1, time: '09:00' },
    log: Array.isArray(raw.log) ? [...new Set(raw.log.map(cleanDateIso).filter(Boolean))].slice(-1000) : [],
    deletedAt: null
  };
}

export function makeJournal(raw = {}) {
  return {
    ...base(raw), type: 'journal', text: cleanText(raw.text), mood: cleanText(raw.mood, 30),
    date: cleanDateIso(raw.date) || nowISO(),
    photoId: typeof raw.photoId === 'string' && raw.photoId ? raw.photoId.slice(0, 64) : null,
    deletedAt: null
  };
}

function imageHeaderBytes(base64) {
  // Decode only a small, whole base64 prefix. This rejects a renamed text blob
  // without allocating a potentially multi-megabyte imported image.
  const length = Math.min(64, String(base64 || '').length);
  const end = length - (length % 4);
  const sample = String(base64 || '').slice(0, end);
  if (!sample) return null;
  try {
    if (typeof atob === 'function') return Uint8Array.from(atob(sample), char => char.charCodeAt(0));
    if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(sample, 'base64'));
  } catch {}
  return null;
}
function startsWithBytes(bytes, values, offset = 0) {
  return !!bytes && values.every((value, index) => bytes[offset + index] === value);
}
function plausibleImageHeader(mime, base64) {
  const bytes = imageHeaderBytes(base64);
  // Older restricted runtimes may not expose a base64 decoder. The strict MIME
  // and base64 checks still prevent script/data URL injection there.
  if (!bytes) return true;
  const ascii = (offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length));
  if (mime === 'image/jpeg') return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
  if (mime === 'image/png') return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mime === 'image/gif') return ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a';
  if (mime === 'image/bmp') return ascii(0, 2) === 'BM';
  if (mime === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
  // ISO base media files (AVIF) carry their brand after a four-byte box size.
  return ascii(4, 4) === 'ftyp' && /avif|avis/.test(ascii(8, 4));
}

export function isSafeImageDataUrl(value) {
  const text = String(value || '');
  const match = /^data:(image\/(?:jpeg|png|webp|gif|avif|bmp));base64,([a-z0-9+/=]+)$/i.exec(text);
  return !!match && text.length >= 100 && text.length <= MAX_IMAGE && plausibleImageHeader(match[1].toLowerCase(), match[2]);
}

export function makePhoto(raw = {}) {
  const dataUrl = isSafeImageDataUrl(raw.dataUrl) ? String(raw.dataUrl) : '';
  const mime = dataUrl ? (dataUrl.match(/^data:(image\/[\w.+-]+);/i) || [])[1] || 'image/jpeg' : 'image/jpeg';
  return {
    ...base(raw), type: 'photo', name: cleanText(raw.name, 160) || 'photo.jpg', mime,
    size: finiteNumber(raw.size, dataUrl.length, { min: 0, max: MAX_IMAGE }),
    width: finiteNumber(raw.width, 0, { min: 0, max: 20_000 }),
    height: finiteNumber(raw.height, 0, { min: 0, max: 20_000 }),
    dataUrl, deletedAt: null
  };
}

export function makeEvent(raw = {}) {
  const at = cleanDateIso(raw.at);
  let end = cleanDateIso(raw.end);
  if (at && end && new Date(end) < new Date(at)) end = null;
  return {
    ...base(raw), type: 'event', title: cleanName(raw.title), kind: cleanText(raw.kind, 60), at,
    end, allDay: !!raw.allDay, location: cleanText(raw.location, 400), notes: cleanText(raw.notes), deletedAt: null
  };
}

/** Re-shape an incoming record by collection while dropping unknown properties. */
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

export const COLLECTIONS = ['task', 'reminder', 'note', 'person', 'money', 'debt', 'stockItem', 'habit', 'journal', 'event', 'photo'];

export function emptyCollections() {
  return Object.fromEntries(COLLECTIONS.map(collection => [collection, []]));
}
