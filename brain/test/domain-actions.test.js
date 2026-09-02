import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../js/store/store.js';
import { MemoryBackend } from '../js/store/db.js';
import { createReminder, completeTask, completeReminder, snoozeReminder, recurringReminderSchedule } from '../js/engine/actions.js';
import { Scheduler } from '../js/notify.js';
import { todayKey } from '../js/util/util.js';

let store;
beforeEach(async () => {
  MemoryBackend._m = {};
  store = new Store();
  await store.init();
});

test('completing a recurring task twice creates exactly one successor', () => {
  const task = store.addSync('task', {
    title: 'Water plants', due: '2026-03-09T09:00:00.000Z',
    recur: { freq: 'weekly', interval: 1, days: [1], time: '09:00', anchor: '2026-03-09T09:00:00.000Z' }
  });
  const first = completeTask(store, task.id);
  const second = completeTask(store, task.id);
  assert.ok(first.nextId);
  assert.equal(second.already, true);
  assert.equal(store.list('task').length, 2);
  assert.equal(store.list('task').filter(item => item.status === 'open').length, 1);
});

test('a newly created recurring reminder does not fire for a time already passed today', () => {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const created = createReminder(store, { title: 'Daily review', recur: { freq: 'daily', interval: 1, time } });
  const reminder = store.get('reminder', created.id);
  assert.equal(reminder.lastFiredKey, `recur:${todayKey(now)}`);
  assert.ok(new Date(reminder.nextAt) > now);
  let alerts = 0;
  new Scheduler({ store, notify() {}, pushAlert() { alerts += 1; }, afterMutate() {} }).check(now);
  assert.equal(alerts, 0);
});

test('editing a recurring reminder to an already-passed same-day time waits for the next occurrence', () => {
  // This mirrors the editor's Domain.recurringReminderSchedule call, with a
  // fixed afternoon clock rather than the host machine's current time.
  const now = new Date(2026, 2, 6, 15, 0, 0);
  const recurrence = { freq: 'daily', interval: 1, time: '09:00', anchor: now.toISOString() };
  const reminder = store.addSync('reminder', {
    title: 'Daily review', status: 'active',
    recur: { freq: 'daily', interval: 1, time: '18:00', anchor: now.toISOString() }
  });
  const schedule = recurringReminderSchedule(recurrence, now);
  store.updateSync('reminder', reminder.id, { recur: recurrence, status: 'active', snoozedUntil: null, ...schedule });
  assert.equal(store.get('reminder', reminder.id).lastFiredKey, 'recur:2026-03-06');
  assert.ok(new Date(store.get('reminder', reminder.id).nextAt) > now);
  let alerts = 0;
  new Scheduler({ store, notify() {}, pushAlert() { alerts += 1; }, afterMutate() {} }).check(now);
  assert.equal(alerts, 0);
});

test('one-time reminders require a usable date and time', () => {
  const result = createReminder(store, { title: 'Incomplete reminder' });
  assert.match(result.error, /valid date and time/i);
  assert.equal(store.list('reminder').length, 0);
});

test('reminder snooze and completion preserve the expected durable state', () => {
  const once = store.addSync('reminder', { title: 'Call dentist', at: new Date().toISOString(), status: 'fired' });
  snoozeReminder(store, once.id, 10);
  assert.equal(store.get('reminder', once.id).status, 'active');
  assert.ok(store.get('reminder', once.id).snoozedUntil);
  completeReminder(store, once.id);
  assert.equal(store.get('reminder', once.id).status, 'done');

  const recurring = store.addSync('reminder', { title: 'Stretch', recur: { freq: 'daily', interval: 1, time: '09:00' }, status: 'active' });
  completeReminder(store, recurring.id);
  assert.equal(store.get('reminder', recurring.id).status, 'active');
  assert.match(store.get('reminder', recurring.id).lastFiredKey, /^recur:/);
});
