import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateLegacy, readLegacy } from '../js/store/migrate.js';

test('migrates all legacy collections into current schema', () => {
  const legacy = {
    name: 'Dev',
    tasks: [{ title: 'Buy milk', done: true, completedDate: '2024-01-02T10:00:00Z' }],
    reminders: [{ title: 'call mom', at: '2025-03-01T09:00:00Z', every: 'daily', time: '09:00' }],
    notes: [{ title: 'n', body: 'b', tags: ['x'] }],
    people: [{ name: 'Priya', birthday: 'March 12' }],
    money: [{ amount: 120, kind: 'expense', cat: 'food', date: '2024-05-01T00:00:00Z' }],
    debts: [{ person: 'Ali', amount: 500, dir: 'they_owe_me' }],
    stock: [{ name: 'Rice', qty: 5, unit: 'kg', low: 1 }],
    habits: [{ name: 'run', log: ['2024-01-01T00:00:00Z'] }],
    journal: [{ text: 'good day', mood: 4 }],
    events: [{ title: 'Concert', date: '2025-06-01T19:00:00Z' }]
  };
  const c = migrateLegacy(legacy);
  assert.equal(c.task.length, 1);
  assert.equal(c.task[0].status, 'done');
  assert.equal(c.reminder[0].recur.freq, 'daily');
  assert.equal(c.debt[0].dir, 'they_owe_me');
  assert.equal(c.stockItem[0].name, 'Rice');
  assert.equal(c.money[0].amount, 120);
});

test('readLegacy returns null when nothing stored', () => {
  const mem = { getItem: () => null };
  assert.equal(readLegacy(mem), null);
});

test('readLegacy parses stored blob and keeps name', () => {
  const mem = { getItem: () => JSON.stringify({ name: 'Sam', notes: [{ title: 'hi' }] }) };
  const out = readLegacy(mem);
  assert.ok(out);
  assert.equal(out.settings.name, 'Sam');
  assert.equal(out.collections.note.length, 1);
});
