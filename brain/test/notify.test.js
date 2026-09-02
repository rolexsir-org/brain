import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../js/store/store.js';
import { MemoryBackend } from '../js/store/db.js';
import { Scheduler, matchesToday } from '../js/notify.js';
import { recurrenceMatches } from '../js/util/date.js';

let store;
beforeEach(async () => {
  MemoryBackend._m = {};
  store = new Store();
  await store.init();
});

test('one-time reminder becomes fired, not silently completed, and is persisted', async () => {
  const at = new Date(2026, 2, 6, 9, 0).toISOString();
  const reminder = store.addSync('reminder', { title: 'Call John', at, status: 'active' });
  const notices = [];
  const alerts = [];
  const scheduler = new Scheduler({ store, notify: (text, record) => notices.push([text, record.id]), pushAlert: (text, record) => alerts.push([text, record.id]), afterMutate() {} });
  scheduler.check(new Date(2026, 2, 6, 10, 0));
  assert.equal(store.get('reminder', reminder.id).status, 'fired');
  assert.equal(notices.length, 1);
  assert.equal(alerts.length, 1);
  await store.flush();
  const restored = new Store();
  await restored.init();
  assert.equal(restored.get('reminder', reminder.id).status, 'fired');
});

test('snoozed reminder fires once at the snooze time and does not duplicate', () => {
  const until = new Date(2026, 2, 6, 10, 5).toISOString();
  const reminder = store.addSync('reminder', { title: 'Water plants', at: '2026-03-06T09:00:00.000Z', snoozedUntil: until, status: 'active' });
  let alerts = 0;
  const scheduler = new Scheduler({ store, notify() {}, pushAlert() { alerts += 1; }, afterMutate() {} });
  scheduler.check(new Date(2026, 2, 6, 10, 4));
  assert.equal(alerts, 0);
  scheduler.check(new Date(2026, 2, 6, 10, 6));
  assert.equal(alerts, 1);
  assert.equal(store.get('reminder', reminder.id).status, 'fired');
  scheduler.check(new Date(2026, 2, 6, 10, 7));
  assert.equal(alerts, 1);
});

test('a recurring snooze crossing midnight does not suppress the next day', () => {
  const snoozedUntil = new Date(2026, 2, 7, 0, 5).toISOString();
  const anchor = new Date(2026, 2, 6, 23, 50).toISOString();
  const reminder = store.addSync('reminder', {
    title: 'Late medicine', status: 'active', snoozedUntil,
    lastFiredKey: 'recur:2026-03-06',
    recur: { freq: 'daily', interval: 1, time: '23:50', anchor }
  });
  let alerts = 0;
  const scheduler = new Scheduler({ store, notify() {}, pushAlert() { alerts += 1; }, afterMutate() {} });
  scheduler.check(new Date(2026, 2, 7, 0, 6));
  assert.equal(store.get('reminder', reminder.id).lastFiredKey, 'recur:2026-03-06');
  scheduler.check(new Date(2026, 2, 7, 23, 51));
  assert.equal(alerts, 2);
  assert.equal(store.get('reminder', reminder.id).lastFiredKey, 'recur:2026-03-07');
});

test('recurrence intervals use an anchor instead of changing cadence on reload', () => {
  const spec = { freq: 'daily', interval: 2, time: '09:00', anchor: '2026-03-04T09:00:00.000Z' };
  assert.equal(recurrenceMatches(spec, new Date(2026, 2, 4)), true);
  assert.equal(matchesToday(spec, new Date(2026, 2, 5)), false);
  assert.equal(matchesToday(spec, new Date(2026, 2, 6)), true);
  const weekly = { freq: 'weekly', interval: 2, days: [1], time: '09:00', anchor: '2026-03-02T09:00:00.000Z' };
  assert.equal(matchesToday(weekly, new Date(2026, 2, 9)), false);
  assert.equal(matchesToday(weekly, new Date(2026, 2, 16)), true);
});
