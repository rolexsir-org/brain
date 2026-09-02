import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function workerHarness(clients, caches = { keys: async () => [], delete: async () => true }) {
  const handlers = {};
  const self = {
    location: { origin: 'https://brain.test' },
    registration: { scope: 'https://brain.test/app/' },
    clients: { ...clients, claim: clients.claim || (() => Promise.resolve()) },
    addEventListener(type, callback) { handlers[type] = callback; },
    skipWaiting() { return Promise.resolve(); }
  };
  const source = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { self, caches, URL, Response, Promise, console });
  return handlers;
}

async function dispatchClick(handler, { reminderId = 'r1', action = '' } = {}) {
  let pending;
  let closed = false;
  handler({
    action,
    notification: { data: { reminderId }, close() { closed = true; } },
    waitUntil(value) { pending = Promise.resolve(value); }
  });
  await pending;
  assert.equal(closed, true);
}

test('service worker routes an active notification action back to the live app', async () => {
  const posted = [];
  let focused = false;
  const handlers = workerHarness({
    matchAll: async () => [{ postMessage: message => posted.push(message), focus: async () => { focused = true; } }],
    openWindow: async () => { throw new Error('should not open a second window'); }
  });
  await dispatchClick(handlers.notificationclick, { action: 'snooze' });
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ type: 'brain:reminder-action', action: 'snooze', reminderId: 'r1' }]);
  assert.equal(focused, true);
});

test('service worker prefers a focused or visible client for notification actions', async () => {
  const background = [];
  const visible = [];
  const handlers = workerHarness({
    matchAll: async () => [
      { visibilityState: 'hidden', postMessage: message => background.push(message), focus: async () => {} },
      { visibilityState: 'visible', postMessage: message => visible.push(message), focus: async () => {} }
    ],
    openWindow: async () => { throw new Error('should not open a second window'); }
  });
  await dispatchClick(handlers.notificationclick, { action: 'complete' });
  assert.equal(background.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(visible)), [{ type: 'brain:reminder-action', action: 'complete', reminderId: 'r1' }]);
});

test('service worker routes a plain notification open to the matching active reminder', async () => {
  const posted = [];
  const handlers = workerHarness({
    matchAll: async () => [{ postMessage: message => posted.push(message), focus: async () => {} }],
    openWindow: async () => { throw new Error('should not open a second window'); }
  });
  await dispatchClick(handlers.notificationclick);
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ type: 'brain:reminder-open', reminderId: 'r1' }]);
});

test('service worker puts reminder context in the launch URL when no client exists', async () => {
  let opened = '';
  const handlers = workerHarness({
    matchAll: async () => [],
    openWindow: async href => { opened = href; }
  });
  await dispatchClick(handlers.notificationclick, { reminderId: 'late', action: 'complete' });
  const url = new URL(opened);
  assert.equal(url.pathname, '/app/');
  assert.equal(url.searchParams.get('brainReminderId'), 'late');
  assert.equal(url.searchParams.get('brainReminderAction'), 'complete');
});

test('service worker removes only its own old caches', async () => {
  const removed = [];
  const handlers = workerHarness({ matchAll: async () => [], openWindow: async () => {} }, {
    keys: async () => ['brain-v2.1.0', 'other-app-cache', 'brain-v2.1.1', 'brain-v2.1.2'],
    delete: async key => { removed.push(key); return true; }
  });
  let pending;
  handlers.activate({ waitUntil(value) { pending = Promise.resolve(value); } });
  await pending;
  assert.deepEqual(removed, ['brain-v2.1.0', 'brain-v2.1.1']);
});
