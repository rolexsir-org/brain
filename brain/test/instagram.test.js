import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../js/store/store.js';
import { MemoryBackend } from '../js/store/db.js';
import { Brain } from '../js/engine/intent.js';

import { validateFileBasics, validateCaption, validateHashtags, buildCaptionWithHashtags } from '../js/instagram/media.js';
import { generateState, validateState, isTokenExpired, getConnectionStatus, buildConnectedConnection, buildDisconnectedConnection, tokenExpiryLabel } from '../js/instagram/auth.js';
import { preparePublishPreview } from '../js/instagram/publish.js';

// SessionStorage mock for Node
global.sessionStorage = {
  _m: {},
  getItem(k){ return this._m[k] ?? null; },
  setItem(k,v){ this._m[k]=String(v); },
  removeItem(k){ delete this._m[k]; }
};
global.localStorage = { _m:{}, getItem(k){return this._m[k]??null;}, setItem(k,v){this._m[k]=String(v);}, removeItem(k){delete this._m[k];} };
// crypto.getRandomValues - Node 22 has it globally; mock only if missing
if (typeof global.crypto === 'undefined' || !global.crypto.getRandomValues) {
  global.crypto = {
    getRandomValues(arr){ for(let i=0;i<arr.length;i++) arr[i]=Math.floor(Math.random()*256); return arr; }
  };
} else {
  // patch sessionStorage behavior for auth state in Node
}

let store, brain;
beforeEach(async () => {
  // Ensure clean DB regardless of backend (fake-indexeddb vs MemoryBackend)
  try { if (typeof indexedDB !== 'undefined' && indexedDB.deleteDatabase) { await new Promise(res=>{ const req=indexedDB.deleteDatabase('brain'); req.onsuccess=()=>res(); req.onerror=()=>res(); req.onblocked=()=>res(); }); } } catch {}
  MemoryBackend._m={};
  global.sessionStorage._m={};
  store=new Store(); await store.init(); await store.updateSettings({ name:'Tester' }); brain=new Brain(store);
});
afterEach(async ()=>{ try{ await store.db.destroy(); }catch{}; MemoryBackend._m={}; });

test('media: validate unsupported file rejected', () => {
  // text/plain is not a valid video MIME — should be rejected
  const r = validateFileBasics({ name: 'notes.txt', type: 'text/plain', size: 1000 });
  assert.equal(r.ok, false);
  // empty file
  const e2 = validateFileBasics({ name: 'empty.mp4', type: 'video/mp4', size: 0 });
  assert.equal(e2.ok, false);
});

test('media: valid mp4 passes basics', () => {
  const r = validateFileBasics({ name: 'reel.mp4', type: 'video/mp4', size: 5*1024*1024 });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('media: oversized file flagged', () => {
  const r = validateFileBasics({ name: 'huge.mp4', type: 'video/mp4', size: 2*1024*1024*1024 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /exceeds/);
});

test('caption: too long fails', () => {
  const r = validateCaption('a'.repeat(3000));
  assert.equal(r.ok, false);
});

test('caption: empty warns but passes', () => {
  const r = validateCaption('');
  assert.equal(r.ok, true);
});

test('hashtags: too many fails', () => {
  const tags = Array.from({length:31}, (_,i)=>`tag${i}`);
  const r = validateHashtags(tags);
  assert.equal(r.ok, false);
});

test('hashtags: valid passes', () => {
  const r = validateHashtags(['travel','viral']);
  assert.equal(r.ok, true);
});

test('buildCaptionWithHashtags includes tags', () => {
  const s = buildCaptionWithHashtags('Hello world', ['travel','reel']);
  assert.match(s, /Hello world/);
  assert.match(s, /#travel/);
});

test('auth: state generation and validation', () => {
  const s = generateState();
  assert.ok(s.length > 20);
  const ok = validateState(s);
  assert.equal(ok.ok, true);
  // replay fails (single use)
  const replay = validateState(s);
  assert.equal(replay.ok, false);
});

test('auth: token expiry detection', () => {
  const conn = buildConnectedConnection({ igUserId:'123', username:'tester', accessToken:'tok', expiresIn: 3600 });
  assert.equal(isTokenExpired(conn), false);
  assert.equal(getConnectionStatus(conn), 'connected');
  const expired = { ...conn, expiresAt: new Date(Date.now()-1000).toISOString() };
  assert.equal(isTokenExpired(expired), true);
  assert.equal(getConnectionStatus(expired), 'expired');
  assert.match(tokenExpiryLabel(expired), /expired/);
});

test('auth: disconnected status', () => {
  const d = buildDisconnectedConnection();
  assert.equal(getConnectionStatus(d), 'disconnected');
});

test('publish preview requires connection', () => {
  const draft = { caption:'hi', hashtags:['test'], tempVideoUrl:'https://example.com/video.mp4', videoName:'reel.mp4', videoSize:1000, videoWidth:1080, videoHeight:1920, videoDuration:10 };
  const disconnected = buildDisconnectedConnection();
  const r = preparePublishPreview(draft, disconnected);
  assert.equal(r.ok, false);
  assert.match(r.error, /not connected/i);
});

test('publish preview requires videoUrl', () => {
  const draft = { caption:'hi', hashtags:[], videoName:'reel.mp4', videoSize:1000 };
  const conn = buildConnectedConnection({ igUserId:'123', username:'u', accessToken:'tok', expiresIn:3600 });
  const r = preparePublishPreview(draft, conn);
  assert.equal(r.ok, false);
  assert.equal(r.needsHosting, true);
});

test('publish preview succeeds with valid draft', () => {
  const draft = { caption:'My reel', hashtags:['viral'], tempVideoUrl:'https://example.com/v.mp4', videoName:'reel.mp4', videoSize: 5*1024*1024, videoWidth:1080, videoHeight:1920, videoDuration:15 };
  const conn = buildConnectedConnection({ igUserId:'178400000', username:'testuser', accessToken:'tok', expiresIn:3600 });
  const r = preparePublishPreview(draft, conn);
  assert.equal(r.ok, true);
  assert.ok(r.preview.caption.includes('My reel'));
  assert.ok(r.preview.videoUrl.includes('example.com'));
});

test('store: instagramDraft CRUD and validation', async () => {
  const draft = store.addSync('instagramDraft', { videoName:'a.mp4', videoSize:1000, caption:'Hello', hashtags:['test'], status:'draft' });
  assert.ok(draft);
  assert.equal(store.list('instagramDraft').length, 1);
  // caption trimmed
  const long = 'x'.repeat(3000);
  const draft2 = store.addSync('instagramDraft', { videoName:'b.mp4', videoSize:1000, caption: long, hashtags: Array.from({length:40},(_,i)=>`t${i}`) });
  assert.equal(draft2.caption.length, 2200);
  assert.equal(draft2.hashtags.length, 30);
  await store.flush();
  const fetched = store.get('instagramDraft', draft.id);
  assert.equal(fetched.videoName, 'a.mp4');
});

test('store: instagram connection persisted in settings', async () => {
  const conn = buildConnectedConnection({ igUserId:'999', username:'mybiz', accessToken:'secret', expiresIn: 3600 });
  const saved = await store.updateSettings({ instagram: conn });
  assert.ok(saved);
  assert.equal(store.settings.instagram.username, 'mybiz');
  assert.equal(store.settings.instagram.igUserId, '999');
});

test('NL: connect Instagram intent', async () => {
  // Ensure disconnected state for this specific test
  await store.updateSettings({ instagram: buildDisconnectedConnection() });
  brain = new Brain(store);
  const r = await brain.handle('connect my Instagram account');
  assert.match(r.text, /Connect/i);
  assert.equal(r.run.id, 'instagram.connect');
});

test('NL: show drafts intent', async () => {
  store.addSync('instagramDraft', { videoName:'v1.mp4', videoSize:1000, caption:'test' });
  await store.flush();
  const r = await brain.handle('show my Instagram drafts');
  assert.match(r.text, /draft/i);
});

test('NL: disconnect Instagram intent', async () => {
  const conn = buildConnectedConnection({ igUserId:'1', username:'u', accessToken:'t', expiresIn:3600 });
  await store.updateSettings({ instagram: conn });
  brain = new Brain(store); // re-read settings
  const r = await brain.handle('disconnect Instagram');
  assert.match(r.text, /connected as/i);
});

test('NL: publish requires confirmation — never auto-publishes', async () => {
  store.addSync('instagramDraft', { videoName:'myreel.mp4', videoSize:1000, caption:'hi' });
  await store.flush();
  const r = await brain.handle('publish this Reel');
  // Must not claim published; must ask for confirmation
  assert.ok(!/published/i.test(r.text) || /confirm/i.test(r.text) || /preview/i.test(r.text));
  assert.ok(r.run && r.run.id === 'instagram.publish.preview');
});

test('NL: prepare this video as Reel', async () => {
  const r = await brain.handle('Prepare this video as an Instagram Reel.');
  assert.equal(r.run.id, 'instagram.draft.create');
});

test('duplicate publish prevention via status', async () => {
  const conn = buildConnectedConnection({ igUserId:'123', username:'u', accessToken:'tok', expiresIn:3600 });
  await store.updateSettings({ instagram: conn });
  const draft = store.addSync('instagramDraft', { videoName:'a.mp4', videoSize:1000, caption:'hi', hashtags:[], status:'publishing', tempVideoUrl:'https://example.com/v.mp4' });
  await store.flush();
  // Simulate publish attempt while publishing — should be blocked
  const { executePublish } = await import('../js/instagram/publish.js');
  const res = await executePublish(store, draft.id, store.settings.instagram);
  assert.equal(res.ok, false);
  assert.match(res.error, /already publishing/);
});

test('offline: local drafts remain after disconnect', async () => {
  const beforeCount = store.list('instagramDraft').length;
  const conn = buildConnectedConnection({ igUserId:'1', username:'u', accessToken:'t', expiresIn:3600 });
  await store.updateSettings({ instagram: conn });
  store.addSync('instagramDraft', { videoName:'keep.mp4', videoSize:1000 });
  await store.flush();
  const afterAdd = store.list('instagramDraft').length;
  assert.equal(afterAdd, beforeCount + 1);
  const dis = buildDisconnectedConnection();
  await store.updateSettings({ instagram: dis });
  assert.equal(store.list('instagramDraft').length, afterAdd);
  assert.equal(store.settings.instagram.connected, false);
});
