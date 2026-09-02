import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../js/util/date.js';

// Deterministic reference: Friday 2026-03-06, 09:00 local.
const NOW = new Date(2026, 2, 6, 9, 0, 0);

function at(y, m, d, h = 0, min = 0) { return new Date(y, m - 1, d, h, min, 0, 0); }
function day(y, m, d) { return at(y, m, d); }

test('clock parsing', () => {
  assert.deepEqual(D.timeFromText('at 7pm'), { h: 19, min: 0, label: '7:00 pm' });
  assert.deepEqual(D.timeFromText('7:30am'), { h: 7, min: 30, label: '7:30 am' });
  assert.deepEqual(D.timeFromText('19:00'), { h: 19, min: 0, label: '7:00 pm' });
  assert.deepEqual(D.timeFromText('noon'), { h: 12, min: 0, label: '12:00 pm' });
  assert.deepEqual(D.timeFromText('midnight'), { h: 0, min: 0, label: '12:00 am' });
  // bare "7" -> evening default
  assert.deepEqual(D.timeFromText('at 7'), { h: 19, min: 0, label: '7:00 pm' });
});

test('implicit time words', () => {
  assert.deepEqual(D.implicitTime('this morning'), { h: 9, min: 0 });
  assert.deepEqual(D.implicitTime('tonight'), { h: 20, min: 0 });
  assert.deepEqual(D.implicitTime('every evening'), { h: 20, min: 0 });
});

test('date words', () => {
  assert.equal(+D.dateWordFromText('tomorrow', NOW).date, +day(2026, 3, 7));
  assert.equal(+D.dateWordFromText('day after tomorrow', NOW).date, +day(2026, 3, 8));
  assert.equal(+D.dateWordFromText('today', NOW).date, +day(2026, 3, 6));
  // friday from friday -> next friday
  assert.equal(+D.dateWordFromText('friday', NOW).date, +day(2026, 3, 13));
  assert.equal(+D.dateWordFromText('next friday', NOW).date, +day(2026, 3, 13));
  // monday from friday -> mar 9
  assert.equal(+D.dateWordFromText('monday', NOW).date, +day(2026, 3, 9));
  assert.equal(+D.dateWordFromText('next week', NOW).date, +day(2026, 3, 13));
});

test('literal calendar dates', () => {
  assert.equal(+D.dateLiteralFromText('march 12', NOW), +day(2026, 3, 12));
  assert.equal(+D.dateLiteralFromText('12 march', NOW), +day(2026, 3, 12));
  assert.equal(+D.dateLiteralFromText('12th march', NOW), +day(2026, 3, 12));
  assert.equal(+D.dateWordFromText('march 12', NOW).date.getTime(), day(2026, 3, 12).getTime());
  // a date already passed this year rolls to next year
  assert.equal(+D.dateWordFromText('jan 5', NOW).date, +day(2027, 1, 5));
  // invalid
  assert.equal(D.dateLiteralFromText('feb 30', NOW), null);
});

test('relative times', () => {
  assert.equal(+D.relativeFromText('in 2 hours', NOW).date, +new Date(NOW.getTime() + 2 * 3600000));
  assert.equal(+D.relativeFromText('in 30 minutes', NOW).date, +new Date(NOW.getTime() + 30 * 60000));
  assert.equal(+D.relativeFromText('in 3 days', NOW).date, +(NOW.getTime() + 3 * 86400000));
});

test('resolveMoment combines day + time', () => {
  const a = D.resolveMoment('tomorrow at 7pm', NOW);
  assert.equal(+a.date, +at(2026, 3, 7, 19));
  const b = D.resolveMoment('7pm', NOW);
  assert.equal(+b.date, +at(2026, 3, 6, 19));
  const c = D.resolveMoment('friday', NOW);
  assert.equal(+c.date, +at(2026, 3, 13, 9)); // default 9am
  const d = D.resolveMoment('in 2 hours', NOW);
  assert.equal(d.hasTime, false);
});

test('recurrence parsing', () => {
  assert.deepEqual(D.parseRecur('every day', NOW), { freq: 'daily', interval: 1, time: null });
  assert.deepEqual(D.parseRecur('daily at 8pm', NOW), { freq: 'daily', interval: 1, time: '20:00' });
  assert.deepEqual(D.parseRecur('every monday', NOW), { freq: 'weekly', interval: 1, days: [1], time: null });
  assert.deepEqual(D.parseRecur('every monday and thursday', NOW), { freq: 'weekly', interval: 1, days: [1, 4], time: null });
  assert.deepEqual(D.parseRecur('every weekday', NOW), { freq: 'weekly', interval: 1, days: [1, 2, 3, 4, 5], time: null });
  assert.deepEqual(D.parseRecur('every weekend', NOW), { freq: 'weekly', interval: 1, days: [0, 6], time: null });
  assert.equal(D.parseRecur('every month', NOW).freq, 'monthly');
  assert.equal(D.parseRecur('yearly', NOW).freq, 'yearly');
  assert.equal(D.parseRecur('buy milk', NOW), null);
});

test('nextOccurrence', () => {
  // daily at 7pm, from friday 9am -> friday 7pm
  let next = D.nextOccurrence({ freq: 'daily', interval: 1, time: '19:00' }, NOW);
  assert.equal(+next, +at(2026, 3, 6, 19));
  // daily from after 7pm -> tomorrow
  next = D.nextOccurrence({ freq: 'daily', interval: 1, time: '19:00' }, at(2026, 3, 6, 21));
  assert.equal(+next, +at(2026, 3, 7, 19));
  // weekly monday from friday -> mar 9
  next = D.nextOccurrence({ freq: 'weekly', days: [1], interval: 1, time: '09:00' }, NOW);
  assert.equal(+next, +at(2026, 3, 9, 9));
  // weekly sunday from friday -> mar 8
  next = D.nextOccurrence({ freq: 'weekly', days: [0], interval: 1, time: '09:00' }, NOW);
  assert.equal(+next, +at(2026, 3, 8, 9));
  // month boundary: monthly on 31 from a short month
  const fromJan = new Date(2026, 0, 15, 9, 0);
  next = D.nextOccurrence({ freq: 'monthly', interval: 1, time: '09:00', dayOfMonth: 31 }, fromJan);
  // Jan has 31 -> Jan 31
  assert.equal(next.getFullYear(), 2026); assert.equal(next.getMonth(), 0); assert.equal(next.getDate(), 31);
  // monthly day 31 from after Jan31 -> skips Feb (28) -> Mar31
  const afterJan31 = new Date(2026, 0, 31, 12, 0);
  next = D.nextOccurrence({ freq: 'monthly', interval: 1, time: '09:00', dayOfMonth: 31 }, afterJan31);
  assert.equal(next.getMonth(), 2); assert.equal(next.getDate(), 31);
});

test('year boundary recurrence', () => {
  // yearly on dec 31
  const spec = { freq: 'yearly', interval: 1, monthOfYear: 11, dayOfMonth: 31, time: '09:00' };
  const from = new Date(2025, 11, 20, 9, 0);
  const next = D.nextOccurrence(spec, from);
  assert.equal(next.getFullYear(), 2025); assert.equal(next.getMonth(), 11); assert.equal(next.getDate(), 31);
});

test('daysBetween & fmtHM', () => {
  assert.equal(D.daysBetween(day(2026, 3, 6), day(2026, 3, 8)), 2);
  assert.equal(D.fmtHM(13, 5), '1:05 pm');
  assert.equal(D.fmtHM(0, 0), '12:00 am');
});
