// Reminder + daily-brief scheduling. Best-effort foreground/background PWA
// scheduling: reminders fire while the app is open or running in the
// background (visible/installed PWA). Truly offline push is not available to
// a local-only app, and the UI communicates that honestly rather than faking it.

import { nextOccurrence } from './util/date.js';
import { todayKey } from './util/util.js';
import { DAY_NAMES_SHORT } from './util/constants.js';

export function canNotify() {
  return typeof Notification !== 'undefined' && 'Notification' in window;
}
export function perm() {
  return canNotify() ? Notification.permission : 'unsupported';
}
export async function requestPermission() {
  if (!canNotify()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try { return await Notification.requestPermission(); } catch { return 'unsupported'; }
}

export function matchesToday(recur, d) {
  if (!recur) return false;
  if (recur.freq === 'daily') return true;
  if (recur.freq === 'weekly') return recur.days ? recur.days.includes(d.getDay()) : true;
  if (recur.freq === 'monthly') return (recur.dayOfMonth || d.getDate()) === d.getDate();
  if (recur.freq === 'yearly') return (recur.monthOfYear == null || recur.monthOfYear === d.getMonth()) && (recur.dayOfMonth == null || recur.dayOfMonth === d.getDate());
  return false;
}

function minutesNow() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }

export class Scheduler {
  constructor(ctx) {
    this.ctx = ctx;
    this._interval = null;
  }
  start() {
    this._check();
    this._interval = setInterval(() => this._check(), 15000);
    // wake lock best-effort to keep running while visible
    if (typeof navigator !== 'undefined' && navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request('screen').catch(() => {});
    }
  }
  stop() { if (this._interval) clearInterval(this._interval); }

  _check() {
    const store = this.ctx.store;
    const now = new Date();
    const day = todayKey(now);
    const fire = [];
    for (const rem of store.list('reminder')) {
      if (rem.status !== 'active') continue;
      if (rem.recur) {
        if (matchesToday(rem.recur, now)) {
          const t = rem.recur.time || '09:00';
          const [hh, mm] = t.split(':').map(Number);
          const mins = hh * 60 + mm;
          if (rem.lastFiredKey !== day && mins <= minutesNow()) fire.push({ rem, day });
        }
      } else if (rem.at) {
        const at = new Date(rem.at);
        if (at <= now && rem.lastFiredKey !== 'fired-' + rem.at) fire.push({ rem, day: 'fired-' + rem.at, once: true });
      }
    }
    for (const f of fire) this._fire(f.rem, f.day, !!f.once);
  }

  _fire(rem, key, once) {
    const store = this.ctx.store;
    store.updateSync('reminder', rem.id, once ? { status: 'done', lastFiredKey: key } : { lastFiredKey: key });
    const msg = rem.title || 'Reminder';
    this.ctx.notify(msg);
    this.ctx.pushAlert(`🔔 ${msg}`);
    if (rem.recur) {
      // schedule next occurrence so UI can show an up-next line
      const next = nextOccurrence(rem.recur, new Date());
      if (next) store.updateSync('reminder', rem.id, { nextAt: next.toISOString() });
    }
  }
}

/** Build a concise daily brief. Returns null if nothing worth showing. */
export function brief(store) {
  const now = new Date(); const day = todayKey(now);
  const out = [];
  // overdue open tasks
  const overdue = store.list('task').filter(t => t.status !== 'done' && t.due && new Date(t.due) < now);
  if (overdue.length) out.push(`${overdue.length} overdue task${overdue.length > 1 ? 's' : ''}: ${overdue.slice(0, 2).map(t => t.title).join(', ')}${overdue.length > 2 ? '…' : ''}`);
  // today tasks
  const todayTasks = store.list('task').filter(t => t.status !== 'done' && t.due && todayKey(new Date(t.due)) === day);
  for (const t of todayTasks.slice(0, 5)) out.push(`• ${t.title}`);
  // today events
  for (const e of store.list('event')) if (e.at && todayKey(new Date(e.at)) === day) out.push(`📅 ${e.title}`);
  // active reminders today
  const rems = store.list('reminder').filter(r => r.status === 'active');
  const remToday = rems.filter(r => (r.at && todayKey(new Date(r.at)) === day) || (r.recur && matchesToday(r.recur, now)));
  if (remToday.length) out.push(`🔔 ${remToday.length} reminder${remToday.length > 1 ? 's' : ''} today`);
  // upcoming birthdays within 7 days
  const soon = birthdaysSoon(store);
  if (soon) out.push('🎂 ' + soon);
  // low stock
  const low = store.list('stockItem').filter(x => x.lowThreshold != null && x.qty <= x.lowThreshold);
  if (low.length) out.push(`⚠️ low: ${low.map(x => x.name).join(', ')}`);
  // open debts
  const debts = store.list('debt').filter(d => d.status !== 'settled');
  if (debts.length) out.push(`💸 ${debts.filter(d => d.dir === 'they_owe_me').length} owed to you, you owe ${debts.filter(d => d.dir === 'i_owe_them').length}`);
  if (!out.length) return null;
  const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 17 ? 'Good afternoon' : 'Good evening';
  const name = store.settings.name ? ', ' + store.settings.name : '';
  const intro = `Good ${now.getHours() < 12 ? 'morning' : now.getHours() < 17 ? 'afternoon' : 'evening'}${name}.`;
  return intro + '\n' + out.slice(0, 6).join('\n');
}

function birthdaysSoon(store) {
  const now = new Date(); const soon = [];
  for (const p of store.list('person')) {
    if (!p.birthday) continue;
    const d = parseBirthday(p.birthday, now);
    if (!d) continue;
    const diff = Math.round((d - startOfToday(now)) / 86400000);
    if (diff >= 0 && diff <= 7) soon.push({ name: p.name, diff });
  }
  if (!soon.length) return null;
  soon.sort((a, b) => a.diff - b.diff);
  const s = soon[0];
  return `${s.name}'s birthday ${s.diff === 0 ? 'today' : s.diff === 1 ? 'tomorrow' : 'in ' + s.diff + ' days'}` + (soon.length > 1 ? ` (+${soon.length - 1} more)` : '');
}
function startOfToday(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function parseBirthday(str, now) {
  const m = str.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})/i);
  const mm = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  if (!m || mm[m[1].slice(0, 3).toLowerCase()] == null) return null;
  let d = new Date(now.getFullYear(), mm[m[1].slice(0, 3).toLowerCase()], +m[2]);
  if (d < startOfToday(now)) d.setFullYear(d.getFullYear() + 1);
  return d;
}

export function recurShort(recur) {
  if (recur.freq === 'daily') return 'daily';
  if (recur.freq === 'weekly' && recur.days) return recur.days.map(x => DAY_NAMES_SHORT[x]).join(',');
  return recur.freq;
}
