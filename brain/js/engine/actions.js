// Actions layer — every intent maps to a validated store write plus a concise,
// human confirmation. This is the single source of truth the NL engine and the
// quick-add UI both call, so typed input and forms behave identically.

import { toDate, cleanName, formatMoney, moneyToken } from '../util/util.js';
import * as D from '../util/date.js';
import { nowISO, todayKey } from '../util/util.js';

export function fmtMoney(n, cur, locale) {
  return formatMoney(n, { currency: cur, locale });
}

// ---------- Tasks ----------
export function createTask(store, { title, due = null, recur = null, note = '' }) {
  const rec = store.addSync('task', { title, note, due: due ? toISO(due) : null, status: 'open' });
  const dueTxt = due ? D.fmtHM(due.getHours(), due.getMinutes()) + ' ' + dateShort(store, due) : '';
  return { id: rec.id, kind: 'task', text: `Added task “${title}”` + (due ? ' · due ' + dueTxt : '') + '.', rec };
}
export function completeTask(store, id) {
  const r = store.updateSync('task', id, { status: 'done', completedAt: nowISO() });
  return r ? { id, kind: 'task', text: `Marked “${r.title}” done.` } : null;
}
export function reopenTask(store, id) {
  const r = store.updateSync('task', id, { status: 'open', completedAt: null });
  return r ? { id, kind: 'task', text: `Reopened “${r.title}”.` } : null;
}

// ---------- Reminders ----------
export function createReminder(store, { title, at = null, recur = null }) {
  const rec = store.addSync('reminder', { title, at: at ? toISO(at) : null, recur: recur || null });
  const when = describeWhen(store, at, recur);
  return { id: rec.id, kind: 'reminder', text: `Set: “${title}” ${when}.`, rec };
}

// ---------- Notes ----------
export function saveNote(store, { title, body, isPrivate, tags }) {
  const rec = store.addSync('note', { title: title || shortBody(body), body, private: !!isPrivate, tags: tags || [] });
  return { id: rec.id, kind: 'note', text: (rec.private ? 'Private note saved 🔒 · ' : 'Note saved · ') + (rec.title), rec };
}

// ---------- People ----------
export function savePerson(store, { name, phone, birthday, relationship, notes }) {
  const rec = store.addSync('person', { name, phone, birthday, relationship, notes });
  return { id: rec.id, kind: 'person', text: `Saved ${name}${phone ? ' · ' + phone : ''}${birthday ? ' · birthday ' + birthday : ''}.`, rec };
}

// ---------- Money ----------
export function logMoney(store, { kind, amount, category, date }) {
  const rec = store.addSync('money', { kind, amount: Math.abs(amount), category, date: date ? toISO(date) : nowISO() });
  const arrow = kind === 'income' ? 'In' : 'Out';
  return { id: rec.id, kind: 'money', text: `${arrow}: ${moneyToken(amount)} · ${category || 'expense'}.`, rec };
}

// ---------- Debt ----------
export function logDebt(store, { person, amount, dir }) {
  const rec = store.addSync('debt', { person: cleanName(person), amount: Math.abs(amount), dir });
  const who = dir === 'they_owe_me' ? `${rec.person} owes you` : `You owe ${rec.person}`;
  return { id: rec.id, kind: 'debt', text: `${who} ${moneyToken(rec.amount)}.`, rec };
}
export function settleDebt(store, id) {
  const r = store.updateSync('debt', id, { status: 'settled', settledAt: nowISO() });
  return r ? { id, kind: 'debt', text: `Marked the ${moneyToken(r.amount)} debt with ${r.person} as settled.` } : null;
}

// ---------- Stock ----------
export function adjustStock(store, { name, delta, unit }) {
  const nm = cleanName(name);
  let item = store.list('stockItem').find(x => x.name.toLowerCase() === nm.toLowerCase());
  if (!item) {
    item = store.addSync('stockItem', { name: nm, qty: 0, unit: unit || 'unit', lowThreshold: defaultLow(unit) });
  }
  const newQty = Math.max(0, (item.qty || 0) + delta);
  const hist = (item.history || []).concat([{ at: nowISO(), delta, note: '' }]).slice(-300);
  item = store.updateSync('stockItem', item.id, { qty: newQty, history: hist });
  const low = item.lowThreshold != null && item.qty <= item.lowThreshold;
  return { id: item.id, kind: 'stockItem', text: `${item.name}: ${item.qty} ${item.unit}${low ? ' ⚠️ low' : ''}.`, rec: item };
}
function defaultLow(unit) {
  const u = String(unit || '').toLowerCase();
  if (u === 'kg' || u === 'L') return 1;
  if (u === 'g' || u === 'ml') return 200;
  return 2;
}

// ---------- Habits ----------
export function logHabit(store, name) {
  let h = store.list('habit').find(x => x.name.toLowerCase() === name.toLowerCase());
  const key = todayKey();
  if (h) {
    if (h.log.includes(key)) return { id: h.id, kind: 'habit', text: `${h.name} already logged today.`, rec: h };
    h = store.updateSync('habit', h.id, { log: h.log.concat(key) });
  } else {
    h = store.addSync('habit', { name: cleanName(name), schedule: { freq: 'daily', interval: 1, time: null }, log: [key] });
  }
  return { id: h.id, kind: 'habit', text: `Logged ${h.name} · streak ${streakOf(h.log)}.`, rec: h };
}
export function streakOf(log) {
  const set = new Set(log);
  let n = 0; const d = new Date();
  while (true) { const k = todayKey(d); if (set.has(k)) { n++; d.setDate(d.getDate() - 1); } else break; }
  return n;
}

// ---------- Journal ----------
export function logJournal(store, text, mood) {
  const rec = store.addSync('journal', { text, mood });
  return { id: rec.id, kind: 'journal', text: 'Journal entry saved.' };
}

// ---------- Events / birthdays ----------
export function createEvent(store, { title, at, allDay, kind }) {
  const rec = store.addSync('event', { title, at: at ? toISO(at) : null, allDay: allDay !== false, kind });
  return { id: rec.id, kind: 'event', text: `Added ${title}${at ? ' on ' + dateShort(store, at) : ''}.`, rec };
}

export function nextBirthdayFor(birthdayText) {
  const d = D.dateLiteralFromText(birthdayText, new Date());
  if (!d) return null;
  // re-roll if needed so it's in the future
  let cand = new Date(d);
  const now = new Date();
  let nb = new Date(now.getFullYear(), cand.getMonth(), cand.getDate());
  if (nb < new Date(now.getFullYear(), now.getMonth(), now.getDate())) nb = new Date(now.getFullYear() + 1, cand.getMonth(), cand.getDate());
  return nb;
}

// ---------- helpers ----------
function toISO(d) { return d instanceof Date && !isNaN(d) ? d.toISOString() : null; }
function dateShort(store, d) {
  try { return new Date(d).toLocaleDateString(store.settings.locale || 'en-IN', { weekday: 'short', day: 'numeric', month: 'short' }); }
  catch { return new Date(d).toDateString(); }
}
function describeWhen(store, at, recur) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (recur) {
    const dayTxt = recur.freq === 'daily' ? 'every day' :
      recur.freq === 'weekly' ? 'every ' + recur.days.map(x => DAYS[x]).join(', ') :
        recur.freq === 'monthly' ? 'monthly' : 'yearly';
    return dayTxt + (recur.time ? ' at ' + D.fmtHM(+recur.time.split(':')[0], +recur.time.split(':')[1]) : '');
  }
  if (at) { const d = new Date(at); return D.fmtHM(d.getHours(), d.getMinutes()) + ' on ' + dateShort(store, d); }
  return 'sometime';
}

function shortBody(b) { return String(b || '').split('\n')[0].slice(0, 40) || 'Note'; }
