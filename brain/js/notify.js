// Honest reminder scheduling.
// Browser timers run only while a page/PWA receives execution time; neither a
// local-only web app nor a service worker can promise an alarm after the OS has
// fully suspended it. This scheduler therefore persists state, catches up when
// Brain is opened again, and delegates real visible notifications when allowed.

import { nextOccurrence, recurrenceMatches } from './util/date.js';
import { todayKey } from './util/util.js';
import { DAY_NAMES_SHORT } from './util/constants.js';

export function canNotify() { return typeof window !== 'undefined' && typeof Notification !== 'undefined'; }
export function perm() { return canNotify() ? Notification.permission : 'unsupported'; }
export async function requestPermission() {
  if (!canNotify()) return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return 'unsupported'; }
}

/** Compatibility export for callers/tests; anchor enables correct intervals. */
export function matchesToday(recur, date = new Date(), anchor = null) {
  return recurrenceMatches(recur, date, anchor);
}

function clockMinutes(time) {
  const [hour, minute] = String(time || '09:00').split(':').map(Number);
  return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : 9 * 60;
}
function nowMinutes(now) { return now.getHours() * 60 + now.getMinutes(); }
function recurringKey(date) { return `recur:${todayKey(date)}`; }
function onceKey(at) { return `once:${at}`; }
function snoozeKey(until) { return `snooze:${until}`; }

export class Scheduler {
  constructor(ctx) {
    this.ctx = ctx;
    this._interval = null;
    this._onVisible = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') this.check(); };
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.check();
    this._interval = setInterval(() => this.check(), 15_000);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisible);
      window.addEventListener('pageshow', this._onVisible);
    }
  }

  stop() {
    this._running = false;
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisible);
      window.removeEventListener('pageshow', this._onVisible);
    }
  }

  check(now = new Date()) {
    const store = this.ctx.store;
    const due = [];
    for (const reminder of store.list('reminder')) {
      if (!reminder || reminder.status === 'done') continue;

      // A pending snooze always takes precedence over the normal recurrence.
      if (reminder.snoozedUntil) {
        const until = new Date(reminder.snoozedUntil);
        const key = snoozeKey(reminder.snoozedUntil);
        if (!Number.isNaN(until.getTime()) && until <= now && reminder.lastSnoozeKey !== key) {
          due.push({ reminder, key, kind: 'snooze', once: !reminder.recur, now });
        }
        continue;
      }

      if (reminder.recur) {
        const key = recurringKey(now);
        if (matchesToday(reminder.recur, now, reminder.recur.anchor || reminder.createdAt)
          && clockMinutes(reminder.recur.time) <= nowMinutes(now)
          && reminder.lastFiredKey !== key) {
          due.push({ reminder, key, kind: 'recurring', once: false, now });
        }
      } else if (reminder.at && reminder.status === 'active') {
        const at = new Date(reminder.at);
        const key = onceKey(reminder.at);
        if (!Number.isNaN(at.getTime()) && at <= now && reminder.lastFiredKey !== key) due.push({ reminder, key, kind: 'once', once: true, now });
      }
    }
    for (const item of due) this._fire(item);
  }

  _fire({ reminder, key, kind, once, now = new Date() }) {
    const store = this.ctx.store;
    const patch = kind === 'snooze'
      ? {
        status: once ? 'fired' : 'active', snoozedUntil: null, lastSnoozeKey: key,
        // Keep the original recurring occurrence key. A late-night snooze that
        // crosses midnight must not suppress tomorrow's independently scheduled
        // occurrence.
        ...(reminder.recur ? {} : { lastFiredKey: key })
      }
      : once
        ? { status: 'fired', lastFiredKey: key }
        : { status: 'active', lastFiredKey: key };
    const updated = store.updateSync('reminder', reminder.id, patch);
    if (!updated) return;
    if (updated.recur) {
      const next = nextOccurrence(updated.recur, now);
      if (next) store.updateSync('reminder', updated.id, { nextAt: next.toISOString() });
    }
    // Commit the fired key immediately (through Store's serialized queue). This
    // substantially reduces duplicate catch-up notifications if the page is
    // suspended immediately after a reminder becomes due.
    if (typeof store.flush === 'function') Promise.resolve(store.flush()).catch(() => {});
    const message = updated.title || 'Reminder';
    if (store.settings.notifEnabled !== false && typeof this.ctx.notify === 'function') {
      Promise.resolve(this.ctx.notify(message, updated)).catch(() => {});
    }
    if (typeof this.ctx.pushAlert === 'function') this.ctx.pushAlert(`🔔 ${message}`, updated);
    if (typeof this.ctx.afterMutate === 'function') this.ctx.afterMutate();
  }
}

/** Build a concise local daily brief. */
export function brief(store) {
  const now = new Date();
  const day = todayKey(now);
  const lines = [];
  const overdue = store.list('task').filter(task => task.status !== 'done' && task.due && new Date(task.due) < now);
  if (overdue.length) lines.push(`${overdue.length} overdue task${overdue.length === 1 ? '' : 's'}: ${overdue.slice(0, 2).map(task => task.title).join(', ')}${overdue.length > 2 ? '…' : ''}`);
  for (const task of store.list('task').filter(task => task.status !== 'done' && task.due && todayKey(new Date(task.due)) === day).slice(0, 5)) lines.push(`• ${task.title}`);
  for (const event of store.list('event')) if (event.at && todayKey(new Date(event.at)) === day) lines.push(`📅 ${event.title}`);
  const reminders = store.list('reminder').filter(reminder => reminder.status !== 'done');
  const todayReminders = reminders.filter(reminder => (reminder.at && todayKey(new Date(reminder.at)) === day) || (reminder.recur && matchesToday(reminder.recur, now, reminder.recur.anchor || reminder.createdAt)));
  if (todayReminders.length) lines.push(`🔔 ${todayReminders.length} reminder${todayReminders.length === 1 ? '' : 's'} today`);
  const birthday = birthdaysSoon(store);
  if (birthday) lines.push(`🎂 ${birthday}`);
  const low = store.list('stockItem').filter(item => item.lowThreshold != null && item.qty <= item.lowThreshold);
  if (low.length) lines.push(`⚠️ low: ${low.map(item => item.name).join(', ')}`);
  const debts = store.list('debt').filter(debt => debt.status !== 'settled');
  if (debts.length) lines.push(`💸 ${debts.filter(debt => debt.dir === 'they_owe_me').length} owed to you, you owe ${debts.filter(debt => debt.dir === 'i_owe_them').length}`);
  if (!lines.length) return null;
  const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 17 ? 'Good afternoon' : 'Good evening';
  return `${greeting}${store.settings.name ? `, ${store.settings.name}` : ''}.\n${lines.slice(0, 6).join('\n')}`;
}

function birthdaysSoon(store) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const found = [];
  for (const person of store.list('person')) {
    const date = parseBirthday(person.birthday, now);
    if (!date) continue;
    const diff = Math.round((date - today) / 86400000);
    if (diff >= 0 && diff <= 7) found.push({ name: person.name, diff });
  }
  found.sort((left, right) => left.diff - right.diff);
  if (!found.length) return null;
  const first = found[0];
  return `${first.name}'s birthday ${first.diff === 0 ? 'today' : first.diff === 1 ? 'tomorrow' : `in ${first.diff} days`}${found.length > 1 ? ` (+${found.length - 1} more)` : ''}`;
}
function parseBirthday(value, now) {
  const match = String(value || '').match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})/i);
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  if (!match || months[match[1].slice(0, 3).toLowerCase()] == null) return null;
  const result = new Date(now.getFullYear(), months[match[1].slice(0, 3).toLowerCase()], +match[2]);
  if (result.getMonth() !== months[match[1].slice(0, 3).toLowerCase()]) return null;
  if (result < new Date(now.getFullYear(), now.getMonth(), now.getDate())) result.setFullYear(result.getFullYear() + 1);
  return result;
}

export function recurShort(recur) {
  if (!recur) return '';
  if (recur.freq === 'daily') return recur.interval > 1 ? `${recur.interval}d` : 'daily';
  if (recur.freq === 'weekly' && recur.days) return recur.days.map(day => DAY_NAMES_SHORT[day]).join(',');
  return recur.freq;
}
