// DateEngine — robust parsing of human dates/times/recurrence.
// All "today/tomorrow/at 7pm" logic is based on the device's LOCAL wall clock,
// because that is the user's mental model. Recurring reminders store a local
// time-of-day and are re-computed against local dates each check (safe across
// DST and device timezone changes for the common cases).

export const WD = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
export const WD_SHORT = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11
};

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function endOfDay(d) {
  const x = startOfDay(d);
  x.setDate(x.getDate() + 1);
  x.setTime(x.getTime() - 1);
  return x;
}
export function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function daysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }
// Set the day to one before changing a month/year. JavaScript otherwise turns
// January 31 + one month into early March instead of the last valid February day.
export function addMonths(d, n) {
  const x = new Date(d);
  const day = x.getDate();
  x.setDate(1);
  x.setMonth(x.getMonth() + n);
  x.setDate(Math.min(day, daysInMonth(x.getFullYear(), x.getMonth())));
  return x;
}
export function addYears(d, n) {
  const x = new Date(d);
  const day = x.getDate();
  x.setDate(1);
  x.setFullYear(x.getFullYear() + n);
  x.setDate(Math.min(day, daysInMonth(x.getFullYear(), x.getMonth())));
  return x;
}
export function daysBetween(a, b) {
  const A = startOfDay(a).getTime(), B = startOfDay(b).getTime();
  return Math.round((B - A) / 86400000);
}
export function diffMin(a, b) { return Math.round((b - a) / 60000); }

export function nextWeekday(wd, from = new Date()) {
  let diff = (wd - from.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(startOfDay(from), diff);
}

/** Turn an HH:MM 24h string (optionally with am/pm suffix) into {h,min}. */
function clockParts(s) {
  const m = String(s).match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = +m[1], min = +(m[2] || 0), ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (!ap && h < 8) h += 12; // "7" without marker read as 19:00 (evening default)
  if (h > 23 || min > 59) return null;
  return { h, min };
}

/** Extract an explicit clock time from free text. Returns {h,min,label} or null. */
export function timeFromText(text) {
  const t = String(text || '').toLowerCase();
  if (/\bnoon\b/.test(t)) return { h: 12, min: 0, label: '12:00 pm' };
  if (/\bmidnight\b/.test(t)) return { h: 0, min: 0, label: '12:00 am' };
  // HH:MM (optionally am/pm) or H am/pm / H:mm
  let m = t.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  if (m) { const p = clockParts(m[1] + ':' + m[2] + ' ' + (m[3] || '')); if (p) return { h: p.h, min: p.min, label: fmtHM(p.h, p.min) }; }
  // marked hours: "7pm", "7 pm", "7 o'clock"
  m = t.match(/(?:^|\s)(?:at\s+|by\s+|@\s*)?(\d{1,2})\s*(?:(am|pm)|(?:o'?clock))\b/i);
  if (m) {
    const ap = (m[2] || '').toLowerCase();
    let h = +m[1];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23) return null;
    return { h, min: 0, label: fmtHM(h, 0) };
  }
  // "at 7" / "by 7" (bare hour, no marker) -> evening default when small
  m = t.match(/\b(?:at|by|@)\s+(\d{1,2})\b/i);
  if (m) {
    let h = +m[1];
    if (h < 8) h += 12;
    if (h > 23) return null;
    return { h, min: 0, label: fmtHM(h, 0) };
  }
  // plain whole-number clock like "7" as the only meaningful token
  m = t.match(/^\s*(\d{1,2})\s*$/);
  if (m) { let h = +m[1]; if (h < 8) h += 12; if (h > 23) return null; return { h, min: 0, label: fmtHM(h, 0) }; }
  return null;
}

/** Infer an implicit time from words like "morning/afternoon/evening". */
export function implicitTime(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(midnight)\b/.test(t)) return { h: 0, min: 0 };
  if (/\bthis morning\b|morning/.test(t)) return { h: 9, min: 0 };
  if (/\b(afternoon)\b/.test(t)) return { h: 14, min: 0 };
  if (/\btonight\b|this evening|evening|tonight/.test(t)) return { h: 20, min: 0 };
  return null;
}

export function fmtHM(h, min) {
  const ap = h >= 12 ? 'pm' : 'am';
  const hh = h % 12 === 0 ? 12 : h % 12;
  const mm = ':' + String(min == null ? 0 : min).padStart(2, '0');
  return hh + mm + ' ' + ap;
}
export function hhmm24(h, min) { return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0'); }

/** Parse a literal calendar date from text: "march 12", "12 march", "12/03", "2026-03-12". Returns Date(midnight local) or null. */
export function dateLiteralFromText(text, ref = new Date()) {
  const t = String(text || '').toLowerCase();
  const today = startOfDay(ref);
  let m;
  function literal(month, day, year) {
    const nowY = today.getFullYear();
    let y = year != null ? year : nowY;
    const cand = new Date(y, month, day);
    if (cand.getMonth() !== month || cand.getDate() !== day) return null; // invalid like Feb 30
    // If only month+day given and it has already passed this year, assume next year
    if (year == null && cand < today) cand.setFullYear(y + 1);
    return startOfDay(cand);
  }
  // month-name first: "march 12", "march 12 2027", "12 march".
  m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b[\s.,-]+(\d{1,2})(?:st|nd|rd|th)?(?:[\s,]+(\d{4}))?\b/);
  if (m && MONTHS[m[1]] != null) return literal(MONTHS[m[1]], +m[2], m[3] ? +m[3] : null);
  m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?[\s.,-]+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)(?:[\s,]+(\d{4}))?\b/);
  if (m && MONTHS[m[2]] != null) return literal(MONTHS[m[2]], +m[1], m[3] ? +m[3] : null);
  // ISO must precede the shorter numeric matcher so the latter cannot consume
  // the trailing “03-12” portion of “2026-03-12” and lose its year.
  m = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return literal(+m[2] - 1, +m[3], +m[1]);
  // numeric d/m(/y)
  m = t.match(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/);
  if (m) {
    let a = +m[1], b = +m[2];
    let day, month;
    if (a > 12) { day = a; month = b - 1; }
    else if (b > 12) { day = b; month = a - 1; }
    else { day = a; month = b - 1; } // ambiguous like 5/6 -> treat as day/month
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
    return literal(month, day, y);
  }
  return null;
}

/**
 * Resolve an explicit day modifier (relative/named day/week) from text to a Date.
 * Returns {date, matched:boolean}.
 */
export function dateWordFromText(text, now = new Date()) {
  const t = String(text || '').toLowerCase();
  const today = startOfDay(now);
  // absolute literal date has priority when clearly present
  const lit = dateLiteralFromText(text, today);
  if (lit) return { date: lit, matched: true };

  const tomorrow = addDays(today, 1);
  if (/\bday after tomorrow\b/.test(t)) return { date: addDays(today, 2), matched: true };
  if (/\btomorrow\b|\btomr\b/.test(t)) return { date: tomorrow, matched: true };
  if (/\byesterday\b/.test(t)) return { date: addDays(today, -1), matched: true };
  if (/\btoday\b|\btonight\b|\bthis evening\b|\blater today\b/.test(t)) return { date: today, matched: true };

  // named days
  const wdMatch = t.match(/(next|last)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/);
  if (wdMatch) {
    const name = wdMatch[2];
    const wd = WD_SHORT[name] != null ? WD_SHORT[name] : WD[name];
    const qualifier = wdMatch[1];
    let d;
    if (qualifier === 'next') { d = nextWeekday(wd, today); }
    else if (qualifier === 'last') { let x = nextWeekday(wd, today); x = addDays(x, -7); d = x; }
    else {
      // plain day name -> the upcoming one (this week / next, never today? Allow today if same)
      d = nextWeekday(wd, today);
    }
    return { date: d, matched: true };
  }

  if (/\bnext week\b/.test(t)) { const d = addDays(today, 7); return { date: d, matched: true }; }
  if (/\bthis weekend\b/.test(t)) return { date: nextWeekday(WD.saturday, today), matched: true };
  if (/\bnext month\b/.test(t)) return { date: startOfDay(addMonths(today, 1)), matched: true };
  if (/\bnext year\b/.test(t)) return { date: startOfDay(addYears(today, 1)), matched: true };

  return { date: null, matched: false };
}

/** Resolve relative "in N minutes/hours/days/weeks" from text -> Date (exact instant). */
export function relativeFromText(text, now = new Date()) {
  const t = String(text || '').toLowerCase();
  const units = [
    { re: /\bin\s+(\d+)\s*(?:min|minute|mins)s?\b/, ms: 60000 },
    { re: /\bin\s+(\d+)\s*(?:hr|hour|hours?)\b/, ms: 3600000 },
    { re: /\bin\s+(\d+)\s*days?\b/, ms: 86400000 },
    { re: /\bin\s+(\d+)\s*(?:wk|week|weeks?)\b/, ms: 604800000 }
  ];
  for (const u of units) {
    const m = t.match(u.re);
    if (m) return { date: new Date(now.getTime() + (+m[1]) * u.ms), matched: true };
  }
  const mo = t.match(/\bin\s+(\d+)\s*(month|months?)\b/);
  if (mo) return { date: addMonths(now, +mo[1]), matched: true };
  return { date: null, matched: false };
}

/**
 * Primary API: combine time + day/date/relative into a concrete Date.
 * Returns { date, matched, hasTime } where hasTime indicates an explicit clock was parsed.
 */
export function resolveMoment(text, now = new Date()) {
  const time = timeFromText(text);
  const implicit = implicitTime(text);
  const rel = relativeFromText(text, now);
  if (rel.matched) {
    // An explicit wall-clock qualifier wins over the incidental current clock
    // carried by “in 2 days”, so “in 2 days at 3pm” is actually 3pm.
    if (time) rel.date.setHours(time.h, time.min, 0, 0);
    else if (implicit) rel.date.setHours(implicit.h, implicit.min, 0, 0);
    return { date: rel.date, matched: true, hasTime: !!time };
  }
  const dw = dateWordFromText(text, now);
  if (dw.matched) {
    const d = dw.date;
    if (time) { d.setHours(time.h, time.min, 0, 0); }
    else if (implicit) d.setHours(implicit.h, implicit.min, 0, 0);
    else d.setHours(9, 0, 0, 0); // sensible default for a dated reminder
    return { date: d, matched: true, hasTime: !!time };
  }
  // No explicit day; pure time (e.g. "7pm") means today at that time
  if (time) {
    const d = new Date(now);
    d.setHours(time.h, time.min, 0, 0);
    // If already passed today, roll to tomorrow for a reminder
    if (d < now) d.setTime(d.getTime() + 86400000);
    return { date: d, matched: true, hasTime: true };
  }
  if (implicit) {
    const d = new Date(now);
    d.setHours(implicit.h, implicit.min, 0, 0);
    if (d < now) d.setTime(d.getTime() + 86400000);
    return { date: d, matched: true, hasTime: false };
  }
  return { date: null, matched: false, hasTime: false };
}

// ---------------- Recurrence ----------------

export const RECUR = { daily: 'daily', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly' };

/** Produce a canonical 'HH:MM' clock string from explicit or implicit words, or null. */
export function clockString(text) {
  const c = timeFromText(text);
  if (c) return hhmm24(c.h, c.min);
  const im = implicitTime(text);
  if (im) return hhmm24(im.h, im.min);
  return null;
}

/** Parse recurrence expression. Returns spec object (time as 'HH:MM' string) or null. */
export function parseRecur(text, now = new Date()) {
  const t = String(text || '').toLowerCase();
  const tstr = clockString(t);

  // Read numeric cadences before the one-word shortcuts. The interval is
  // bounded here as well as in persistence validation, so a malformed command
  // cannot become an unbounded recurrence scan.
  const dayCadence = t.match(/\bevery\s+(\d+)\s*days?\b/);
  if (dayCadence) return { freq: RECUR.daily, interval: Math.max(1, Math.min(60, +dayCadence[1] || 1)), time: tstr };
  if (/\bevery\s+other\s+day\b/.test(t)) return { freq: RECUR.daily, interval: 2, time: tstr };
  if (/\bevery (?:day|morning|evening|night)\b|\bdaily\b/.test(t)) {
    return { freq: RECUR.daily, interval: 1, time: tstr };
  }
  if (/\bevery weekday\b|\bweekdays\b/.test(t)) {
    return { freq: RECUR.weekly, interval: 1, days: [1, 2, 3, 4, 5], time: tstr };
  }
  if (/\bevery weekend\b/.test(t)) {
    return { freq: RECUR.weekly, interval: 1, days: [0, 6], time: tstr };
  }
  // Every-N cadence is read before named days, so "every 2 weeks on Monday"
  // does not accidentally become a weekly rule.
  const iv = t.match(/\bevery\s+(\d+)\s*(weeks?|months?|years?)\b/);
  // named days list
  const dayNames = Object.keys(WD);
  const foundDays = [];
  for (const d of dayNames) if (t.includes(d)) foundDays.push(WD[d]);
  // A named weekday is meaningful with a weekly cadence. Do not silently turn
  // “every 2 months on Monday” into weekly: the supported monthly rule remains
  // monthly and the UI can show its concrete monthly date.
  if (foundDays.length && /every|each|weekly/.test(t) && (!iv || iv[2].startsWith('week'))) {
    const interval = iv && iv[2].startsWith('week') ? Math.max(1, Math.min(60, +iv[1] || 1)) : 1;
    return { freq: RECUR.weekly, interval, days: [...new Set(foundDays)], time: tstr };
  }
  // every N weeks/months/years
  if (iv) {
    const n = Math.max(1, Math.min(60, +iv[1] || 1)), unit = iv[2];
    if (unit.startsWith('week')) return { freq: RECUR.weekly, interval: n, days: [now.getDay()], time: tstr };
    if (unit.startsWith('month')) return { freq: RECUR.monthly, interval: n, dayOfMonth: now.getDate(), time: tstr };
    return { freq: RECUR.yearly, interval: n, monthOfYear: now.getMonth(), dayOfMonth: now.getDate(), time: tstr };
  }
  if (/\bevery\s+month\b|\bmonthly\b/.test(t)) {
    return { freq: RECUR.monthly, interval: 1, dayOfMonth: now.getDate(), time: tstr };
  }
  if (/\bevery\s+year\b|\byearly\b/.test(t)) {
    return { freq: RECUR.yearly, interval: 1, monthOfYear: now.getMonth(), dayOfMonth: now.getDate(), time: tstr };
  }
  return null;
}

/** Turn a recurrence clock into a validated local wall-clock time. */
function specTime(spec) {
  const raw = spec && spec.time;
  if (raw && typeof raw === 'object' && Number.isInteger(raw.h) && Number.isInteger(raw.min)) return { h: raw.h, min: raw.min };
  if (typeof raw === 'string') {
    const parts = raw.split(':').map(Number);
    if (Number.isInteger(parts[0]) && parts[0] >= 0 && parts[0] < 24 && Number.isInteger(parts[1]) && parts[1] >= 0 && parts[1] < 60) return { h: parts[0], min: parts[1] };
  }
  return { h: 9, min: 0 };
}

function calendarDayNumber(date) {
  // UTC noon gives a stable integer across local DST changes.
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
}
function startOfWeek(date) {
  const result = startOfDay(date);
  result.setDate(result.getDate() - result.getDay());
  return result;
}
function monthIndex(date) { return date.getFullYear() * 12 + date.getMonth(); }
function validDayOfMonth(date, wanted) { return date.getDate() === wanted; }

/**
 * Whether `date` is an occurrence according to a recurrence and anchor. The
 * anchor makes "every 2 weeks" stable after reload rather than accidentally
 * changing cadence based on the day Brain happens to be open.
 */
export function recurrenceMatches(spec, date = new Date(), anchor = null) {
  if (!spec || !(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  const interval = Math.max(1, Number(spec.interval) || 1);
  const day = startOfDay(date);
  const anchorDate = startOfDay(anchor || spec.anchor || date);
  if (day < anchorDate) return false;
  if (spec.freq === RECUR.daily) {
    return (calendarDayNumber(day) - calendarDayNumber(anchorDate)) % interval === 0;
  }
  if (spec.freq === RECUR.weekly) {
    const days = Array.isArray(spec.days) && spec.days.length ? spec.days : [anchorDate.getDay()];
    if (!days.includes(day.getDay())) return false;
    const weeks = Math.round((calendarDayNumber(startOfWeek(day)) - calendarDayNumber(startOfWeek(anchorDate))) / 7);
    return weeks >= 0 && weeks % interval === 0;
  }
  if (spec.freq === RECUR.monthly) {
    const wanted = Number(spec.dayOfMonth || anchorDate.getDate());
    return validDayOfMonth(day, wanted) && (monthIndex(day) - monthIndex(anchorDate)) % interval === 0;
  }
  if (spec.freq === RECUR.yearly) {
    const wantedMonth = spec.monthOfYear == null ? anchorDate.getMonth() : Number(spec.monthOfYear);
    const wantedDay = Number(spec.dayOfMonth || anchorDate.getDate());
    return day.getMonth() === wantedMonth && validDayOfMonth(day, wantedDay) && (day.getFullYear() - anchorDate.getFullYear()) % interval === 0;
  }
  return false;
}

/**
 * Compute the next recurrence strictly after `from`, preserving local clock
 * semantics through timezone/DST changes. The scan is bounded to avoid a bad
 * imported rule looping forever.
 */
export function nextOccurrence(spec, from = new Date()) {
  if (!spec || !(from instanceof Date) || Number.isNaN(from.getTime())) return null;
  const time = specTime(spec);
  const anchor = spec.anchor ? new Date(spec.anchor) : from;
  let day = startOfDay(from);
  const limit = 366 * 65; // supports the maximum validated yearly interval
  for (let index = 0; index < limit; index += 1) {
    if (recurrenceMatches(spec, day, anchor)) {
      const candidate = new Date(day);
      candidate.setHours(time.h, time.min, 0, 0);
      if (candidate > from) return candidate;
    }
    day = addDays(day, 1);
  }
  return null;
}
