import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store, previewImport } from '../js/store/store.js';
import { MemoryBackend } from '../js/store/db.js';

let store;
beforeEach(async () => {
  MemoryBackend._m = {};
  store = new Store();
  await store.init();
});
afterEach(async () => { try { await store.db.destroy(); } catch {} });

test('add/list/update/remove round trip', async () => {
  const t = await store.add('task', { title: 'Write tests' });
  assert.ok(t.id);
  assert.equal(store.list('task').length, 1);
  const u = await store.update('task', t.id, { status: 'done' });
  assert.equal(u.status, 'done');
  assert.equal(store.list('task').length, 1, 'update must not duplicate');
  const removed = await store.remove('task', t.id);
  assert.equal(removed.id, t.id);
  assert.equal(store.list('task').length, 0);
});

test('a failed durable update restores the editor-visible record', async () => {
  const task = await store.add('task', { title: 'Original title' });
  const originalWrite = store.db.kvSet.bind(store.db);
  store.db.kvSet = async () => { throw new Error('quota exceeded'); };
  try {
    const updated = await store.update('task', task.id, { title: 'Unsaved title' });
    assert.equal(updated, null);
    assert.equal(store.get('task', task.id).title, 'Original title');
  } finally {
    store.db.kvSet = originalWrite;
  }
});

test('persistence across instances (same backend)', async () => {
  await store.add('note', { title: 'persist me', body: 'hello' });
  const s2 = new Store();
  await s2.init();
  assert.equal(s2.list('note').length, 1);
  assert.equal(s2.list('note')[0].title, 'persist me');
});

test('corrupt/primitive collection data does not crash loading', async () => {
  await store.db.kvSet('note', 'not-an-array');
  await store.db.kvSet('task', [{ title: 'ok' }, null, 42, 'junk']);
  const s2 = new Store();
  await s2.init();
  assert.ok(Array.isArray(s2.list('note')));
  assert.equal(s2.list('note').length, 0);
  // primitives are dropped, valid objects kept
  assert.ok(s2.list('task').some(t => t.title === 'ok'));
});

test('export / preview import / replaceAll', async () => {
  await store.add('task', { title: 'A' });
  await store.add('person', { name: 'John' });
  const snapshot = await store.exportState();
  assert.equal(snapshot.app, 'brain');
  const preview = previewImport(JSON.stringify(snapshot));
  assert.equal(preview.ok, true);
  assert.equal(preview.counts.task, 1);
  assert.equal(preview.counts.person, 1);
  // replace into a fresh store
  MemoryBackend._m = {};
  const fresh = new Store();
  await fresh.init();
  await fresh.replaceAll(snapshot.collections, snapshot.settings);
  assert.equal(fresh.list('task').length, 1);
  assert.equal(fresh.list('person').length, 1);
});

test('restore drops malformed photos and repairs journal attachment references durably', async () => {
  const raw = {
    app: 'brain', schema: 3, collections: {
      photo: [{ id: 'broken-photo', name: 'bad', dataUrl: 'data:text/html;base64,PGgxPk5vcGU8L2gxPg==' }],
      journal: [{ id: 'journal-1', text: 'Attached', photoId: 'broken-photo' }]
    }
  };
  const preview = previewImport(JSON.stringify(raw));
  assert.equal(preview.counts.photo, 0);
  assert.equal(preview.counts.journal, 1);
  const result = await store.replaceAll({
    photo: [{ id: 'broken-photo', name: 'bad', dataUrl: 'data:text/html;base64,PGgxPk5vcGU8L2gxPg==' }],
    journal: [{ id: 'journal-1', text: 'Attached', photoId: 'broken-photo' }]
  });
  assert.equal(result.ok, true);
  assert.equal(store.list('photo').length, 0);
  assert.equal(store.list('journal')[0].photoId, null);
  const restored = new Store();
  await restored.init();
  assert.equal(restored.list('photo').length, 0);
  assert.equal(restored.list('journal')[0].photoId, null);
});

test('merge recognizes equivalent records even when IDs and write timestamps differ', async () => {
  await store.add('note', { id: 'current-note', title: 'Packing', body: 'Bring passport', createdAt: '2026-01-01T00:00:00.000Z' });
  const backup = {
    app: 'brain', schema: 3, settings: {}, collections: {
      note: [{ id: 'other-device-note', title: 'Packing', body: 'Bring passport', createdAt: '2026-04-01T00:00:00.000Z', updatedAt: '2026-04-01T00:00:00.000Z' }]
    }
  };
  const merged = await store.mergeBackup(JSON.stringify(backup));
  assert.equal(merged.ok, true);
  assert.equal(merged.added, 0);
  assert.equal(merged.duplicates, 1);
  assert.equal(store.list('note').length, 1);
});

test('merge keeps a journal attachment when an equivalent photo has a different ID', async () => {
  const dataUrl = `data:image/jpeg;base64,/9j/${'A'.repeat(120)}`;
  await store.add('photo', { id: 'local-photo', name: 'receipt.jpg', dataUrl });
  const backup = {
    app: 'brain', schema: 3, settings: {}, collections: {
      photo: [{ id: 'remote-photo', name: 'receipt.jpg', dataUrl, createdAt: '2026-04-01T00:00:00.000Z' }],
      journal: [{ id: 'remote-journal', text: 'Receipt attached', photoId: 'remote-photo', createdAt: '2026-04-01T00:00:00.000Z' }]
    }
  };
  const merged = await store.mergeBackup(JSON.stringify(backup));
  assert.equal(merged.ok, true);
  assert.equal(store.list('photo').length, 1);
  assert.equal(store.list('journal').length, 1);
  assert.equal(store.list('journal')[0].photoId, 'local-photo');
});

test('schema upgrades persist the new schema and sanitized records', async () => {
  await store.db.kvSet('schema', { version: 2 });
  await store.db.kvSet('photo', [{ id: 'bad-photo', dataUrl: 'not-image' }]);
  const upgraded = new Store();
  await upgraded.init();
  assert.equal(upgraded.schema, 3);
  assert.equal(upgraded.list('photo').length, 0);
  assert.equal((await upgraded.db.kvGet('schema')).version, 3);
  assert.deepEqual(await upgraded.db.kvGet('photo'), []);
});

test('previewImport rejects non-backup / malformed', () => {
  assert.throws(() => previewImport('{bad'), /not-a-backup|JSON/);
  assert.throws(() => previewImport('{"hello":1}'), /not-a-backup/);
});

test('wipe clears everything', async () => {
  await store.add('task', { title: 'x' });
  await store.wipe();
  assert.equal(store.list('task').length, 0);
});
