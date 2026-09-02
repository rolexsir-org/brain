import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRecord, COLLECTIONS, isSafeImageDataUrl } from '../js/store/validate.js';

test('sanitizeRecord drops unknown/injected keys', () => {
  const r = sanitizeRecord('note', {
    title: 'x', body: 'hello',
    __proto__: { polluted: true },
    constructor: 'bad',
    deleteMe: 1
  });
  assert.equal(r.title, 'x');
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'polluted'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'deleteMe'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'body'), true); // legit fields kept
  assert.equal(Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(r) || {}, 'polluted'), false);
  // ensure object prototype isn't polluted by the raw input
  assert.equal({}.polluted, undefined);
});

test('sanitizeRecord coerces types & strips control chars', () => {
  const m = sanitizeRecord('money', { amount: '850', category: 'groceries\u0000\x01' });
  assert.equal(m.amount, 850);
  assert.equal(m.category, 'groceries');
});

test('task sanitize: due/invalid dates and status', () => {
  const t = sanitizeRecord('task', { title: '  Submit  ', due: 'not-a-date', status: 'nonsense', priority: 99 });
  assert.equal(t.title, 'Submit');
  assert.equal(t.due, null);
  assert.equal(t.status, 'open');
  assert.equal(t.priority, 1);
  const d = sanitizeRecord('task', { title: 'a', status: 'done' });
  assert.equal(d.status, 'done');
  assert.ok(d.completedAt);
});

test('money negative/positive & kind normalize', () => {
  assert.equal(sanitizeRecord('money', { amount: -50, kind: 'income' }).amount, -50);
  assert.equal(sanitizeRecord('money', { amount: 50, kind: 'expense' }).amount, 50);
  assert.equal(sanitizeRecord('money', { amount: 50, kind: 'garbage' }).kind, 'expense');
});

test('stock lowThreshold & qty clamping', () => {
  const s = sanitizeRecord('stockItem', { name: 'Rice', qty: 'abc' });
  assert.equal(s.qty, 0);
  assert.equal(s.lowThreshold, null);
});

test('recur sanitize accepts string time, rejects bad', () => {
  const rem = sanitizeRecord('reminder', { title: 'x', recur: { freq: 'daily', time: '21:30', interval: 1 } });
  assert.deepEqual(rem.recur, { freq: 'daily', interval: 1, time: '21:30' });
  const bad = sanitizeRecord('reminder', { title: 'x', recur: { freq: 'sometimes', time: 'x' } });
  assert.equal(bad.recur, null);
  const week = sanitizeRecord('reminder', { title: 'x', recur: { freq: 'weekly', days: [9, 1, 1], interval: 1 } });
  assert.deepEqual(week.recur.days, [1]);
});

test('photo data URLs require both a safe MIME type and a plausible raster header', () => {
  assert.equal(isSafeImageDataUrl(`data:image/jpeg;base64,/9j/${'A'.repeat(120)}`), true);
  assert.equal(isSafeImageDataUrl(`data:image/jpeg;base64,${'A'.repeat(124)}`), false);
  assert.equal(isSafeImageDataUrl('data:text/html;base64,PGgxPkhlbGxvPC9oMT4='), false);
});

test('every collection is sanitizable', () => {
  for (const c of COLLECTIONS) {
    const r = sanitizeRecord(c, {});
    assert.ok(r, 'expected to sanitize ' + c);
    assert.ok(r.id && r.createdAt && r.updatedAt);
  }
});
