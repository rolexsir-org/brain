// Validated domain actions. The intent engine and the universal UI dispatcher
// both use these helpers so natural-language and button flows mutate identical
// records.

import { toDate, cleanName, formatMoney, moneyToken, nowISO, todayKey } from '../util/util.js';
import * as D from '../util/date.js';

export function fmtMoney(value, currency, locale) { return formatMoney(value, { currency, locale }); }

function created(record, kind) {
  return record ? { record } : { error: `Couldn’t save that ${kind}. Your device storage may be full.` };
}

// ---------- Tasks ----------
export function createTask(store, { title, due = null, recur = null, note = '' }) {
  const recurrence = recur ? { ...recur, anchor: recur.anchor || nowISO() } : null;
  const dueDate = due ? toDate(due) : null;
  const record = store.addSync('task', {
    title, note, due: dueDate ? dueDate.toISOString() : null, recur: recurrence, status: 'open'
  });
  if (!record) return created(record, 'task');
  const dueText = dueDate ? ` · due ${D.fmtHM(dueDate.getHours(), dueDate.getMinutes())} ${dateShort(store, dueDate)}` : '';
  return { id: record.id, kind: 'task', text: `Added task “${title}”${dueText}.`, rec: record };
}

export function completeTask(store, id) {
  const task = store.get('task', id);
  if (!task) return null;
  // Card buttons can be tapped twice before the UI re-renders. A recurring
  // task must create exactly one successor, never one per duplicate tap.
  if (task.status === 'done') return { id, kind: 'task', already: true, text: `“${task.title}” is already completed.` };
  const done = store.updateSync('task', id, { status: 'done', completedAt: nowISO() });
  if (!done) return null;
  if (task.recur && task.due) {
    // Do not create a stale chain of missed successors when an overdue task is
    // completed late; advance from whichever is later, its scheduled due time
    // or the current local time.
    const scheduled = new Date(task.due);
    const reference = !Number.isNaN(scheduled.getTime()) && scheduled > new Date() ? scheduled : new Date();
    const next = D.nextOccurrence(task.recur, reference);
    if (next) {
      const future = store.addSync('task', {
        title: task.title, note: task.note, due: next.toISOString(), recur: task.recur, status: 'open'
      });
      if (future) {
        store.updateSync('task', id, { nextTaskId: future.id });
        return { id, kind: 'task', nextId: future.id, text: `Marked “${task.title}” done. The next occurrence is ${dateShort(store, next)}.` };
      }
    }
  }
  return { id, kind: 'task', text: `Marked “${task.title}” done.` };
}

export function reopenTask(store, id) {
  const record = store.updateSync('task', id, { status: 'open', completedAt: null });
  return record ? { id, kind: 'task', text: `Reopened “${record.title}”.` } : null;
}

// ---------- Reminders ----------
/**
 * Establish a recurring rule from "now", without treating a pre-existing time
 * today as an overdue alert. Editors use this too, so changing a rule has the
 * same first-occurrence behavior as creating one by voice.
 */
export function recurringReminderSchedule(recurrence, now = new Date()) {
  if (!recurrence) return { lastFiredKey: null, nextAt: null };
  const [hour, minute] = String(recurrence.time || '09:00').split(':').map(Number);
  const scheduledMinutes = Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : 9 * 60;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  let lastFiredKey = null;
  // Creating or materially editing “every day at 9” at 10pm should schedule
  // the next occurrence, not immediately fire a time before the rule existed.
  if (D.recurrenceMatches(recurrence, now, recurrence.anchor) && scheduledMinutes <= currentMinutes) {
    lastFiredKey = `recur:${todayKey(now)}`;
  }
  const next = D.nextOccurrence(recurrence, now);
  return { lastFiredKey, nextAt: next ? next.toISOString() : null };
}

export function createReminder(store, { title, at = null, recur = null }) {
  const recurrence = recur ? { ...recur, anchor: recur.anchor || nowISO() } : null;
  const atDate = at ? toDate(at) : null;
  if (!recurrence && !atDate) return { error: 'Choose a valid date and time for that reminder.' };
  const schedule = recurringReminderSchedule(recurrence);
  const record = store.addSync('reminder', {
    title, at: atDate ? atDate.toISOString() : null, recur: recurrence, status: 'active', ...schedule
  });
  if (!record) return created(record, 'reminder');
  return { id: record.id, kind: 'reminder', text: `Set: “${title}” ${describeWhen(store, atDate, recurrence)}.`, rec: record };
}

export function snoozeReminder(store, id, minutes = 10) {
  const record = store.get('reminder', id);
  if (!record) return null;
  const until = new Date(Date.now() + Math.max(1, Math.min(24 * 60, Number(minutes) || 10)) * 60_000);
  const next = store.updateSync('reminder', id, {
    status: 'active', snoozedUntil: until.toISOString(), lastSnoozeKey: null, ...(record.recur ? { lastFiredKey: `recur:${todayKey()}` } : {})
  });
  return next ? { id, kind: 'reminder', text: `Snoozed “${record.title}” for ${Math.round((until - Date.now()) / 60_000)} minutes.` } : null;
}

export function completeReminder(store, id) {
  const record = store.get('reminder', id);
  if (!record) return null;
  if (record.recur) {
    const next = store.updateSync('reminder', id, { acknowledgedAt: nowISO(), snoozedUntil: null, lastFiredKey: `recur:${todayKey()}` });
    return next ? { id, kind: 'reminder', text: `Dismissed “${record.title}” for this occurrence.` } : null;
  }
  const next = store.updateSync('reminder', id, { status: 'done', acknowledgedAt: nowISO(), snoozedUntil: null });
  return next ? { id, kind: 'reminder', text: `Completed “${record.title}”.` } : null;
}

// ---------- Notes ----------
export function saveNote(store, { title, body, isPrivate, tags }) {
  const record = store.addSync('note', { title: title || shortBody(body), body, private: !!isPrivate, tags: tags || [] });
  if (!record) return created(record, 'note');
  return { id: record.id, kind: 'note', text: `${record.private ? 'Private note saved 🔒' : 'Note saved'} · ${record.title}.`, rec: record };
}

// ---------- People ----------
export function savePerson(store, { name, phone, email, birthday, relationship, aliases, instagram, notes, address }) {
  const record = store.addSync('person', { name, phone, email, birthday, relationship, aliases, instagram, notes, address });
  if (!record) return created(record, 'person');
  return { id: record.id, kind: 'person', text: `Saved ${record.name}${record.phone ? ` · ${record.phone}` : ''}${record.birthday ? ` · birthday ${record.birthday}` : ''}.`, rec: record };
}

// ---------- Money / debt ----------
export function logMoney(store, { kind, amount, category, date }) {
  const record = store.addSync('money', { kind, amount: Math.abs(amount), category, date: date ? toISO(date) : nowISO() });
  if (!record) return created(record, 'money record');
  return { id: record.id, kind: 'money', text: `${kind === 'income' ? 'In' : 'Out'}: ${moneyToken(amount)} · ${category || 'expense'}.`, rec: record };
}

export function logDebt(store, { person, amount, dir }) {
  const record = store.addSync('debt', { person: cleanName(person), amount: Math.abs(amount), dir });
  if (!record) return created(record, 'debt');
  const who = dir === 'they_owe_me' ? `${record.person} owes you` : `You owe ${record.person}`;
  return { id: record.id, kind: 'debt', text: `${who} ${moneyToken(record.amount)}.`, rec: record };
}

export function settleDebt(store, id) {
  const record = store.updateSync('debt', id, { status: 'settled', settledAt: nowISO() });
  return record ? { id, kind: 'debt', text: `Marked the ${moneyToken(record.amount)} debt with ${record.person} as settled.` } : null;
}

// ---------- Stock ----------
export function adjustStock(store, { name, delta, unit }) {
  const cleanedName = cleanName(name);
  let item = store.list('stockItem').find(record => record.name.toLowerCase() === cleanedName.toLowerCase());
  if (!item) item = store.addSync('stockItem', { name: cleanedName, qty: 0, unit: unit || 'unit', lowThreshold: defaultLow(unit) });
  if (!item) return created(null, 'stock item');
  const amount = Number.isFinite(Number(delta)) ? Number(delta) : 0;
  const history = (item.history || []).concat([{ at: nowISO(), delta: amount, note: '' }]).slice(-300);
  item = store.updateSync('stockItem', item.id, { qty: Math.max(0, (item.qty || 0) + amount), history });
  if (!item) return created(null, 'stock item');
  const low = item.lowThreshold != null && item.qty <= item.lowThreshold;
  return { id: item.id, kind: 'stockItem', text: `${item.name}: ${item.qty} ${item.unit}${low ? ' ⚠️ low' : ''}.`, rec: item };
}

function defaultLow(unit) {
  const value = String(unit || '').toLowerCase();
  if (value === 'kg' || value === 'l') return 1;
  if (value === 'g' || value === 'ml') return 200;
  return 2;
}

// ---------- Habits / journal / events ----------
export function logHabit(store, name) {
  let habit = store.list('habit').find(record => record.name.toLowerCase() === String(name).toLowerCase());
  const key = todayKey();
  if (habit) {
    if ((habit.log || []).includes(key)) return { id: habit.id, kind: 'habit', text: `${habit.name} already logged today.`, rec: habit };
    habit = store.updateSync('habit', habit.id, { log: [...(habit.log || []), key] });
  } else habit = store.addSync('habit', { name: cleanName(name), schedule: { freq: 'daily', interval: 1 }, log: [key] });
  if (!habit) return created(null, 'habit');
  return { id: habit.id, kind: 'habit', text: `Logged ${habit.name} · streak ${streakOf(habit.log)}.`, rec: habit };
}

export function streakOf(log = []) {
  const set = new Set(log);
  const day = new Date();
  let count = 0;
  while (set.has(todayKey(day))) { count += 1; day.setDate(day.getDate() - 1); }
  return count;
}

export function logJournal(store, text, mood, photoId = null) {
  const record = store.addSync('journal', { text, mood, photoId });
  if (!record) return created(null, 'journal entry');
  return { id: record.id, kind: 'journal', text: 'Journal entry saved.', rec: record };
}

export function createEvent(store, { title, at, end, allDay, kind, location, notes }) {
  const record = store.addSync('event', {
    title, at: at ? toISO(at) : null, end: end ? toISO(end) : null,
    allDay: allDay !== false, kind, location, notes
  });
  if (!record) return created(null, 'event');
  return { id: record.id, kind: 'event', text: `Added ${record.title}${at ? ` on ${dateShort(store, at)}` : ''}.`, rec: record };
}

export function nextBirthdayFor(birthdayText) {
  const date = D.dateLiteralFromText(birthdayText, new Date());
  if (!date) return null;
  const now = new Date();
  let candidate = new Date(now.getFullYear(), date.getMonth(), date.getDate());
  if (candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) candidate = new Date(now.getFullYear() + 1, date.getMonth(), date.getDate());
  return candidate;
}

function toISO(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}
function dateShort(store, value) {
  const date = toDate(value) || new Date();
  try { return date.toLocaleDateString(store.settings.locale || 'en-IN', { weekday: 'short', day: 'numeric', month: 'short' }); }
  catch { return date.toDateString(); }
}
function describeWhen(store, at, recur) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (recur) {
    const wording = recur.freq === 'daily' ? (recur.interval > 1 ? `every ${recur.interval} days` : 'every day')
      : recur.freq === 'weekly' ? `every ${recur.days && recur.days.length ? recur.days.map(day => days[day]).join(', ') : 'week'}`
        : recur.freq === 'monthly' ? (recur.interval > 1 ? `every ${recur.interval} months` : 'monthly')
          : recur.interval > 1 ? `every ${recur.interval} years` : 'yearly';
    if (!recur.time) return wording;
    const [hour, minute] = recur.time.split(':').map(Number);
    return `${wording} at ${D.fmtHM(hour, minute)}`;
  }
  if (at) {
    const date = toDate(at);
    return date ? `${D.fmtHM(date.getHours(), date.getMinutes())} on ${dateShort(store, date)}` : 'sometime';
  }
  return 'sometime';
}
function shortBody(body) { return String(body || '').split('\n')[0].slice(0, 40) || 'Note'; }
