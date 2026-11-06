import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isSafeImageDataUrl, makeInstagramDraft } from '../js/store/validate.js';
import { validateState, generateState, validateCallbackParams } from '../js/instagram/auth.js';
import { normalizeStatus, canTransition, isDuplicatePublish } from '../js/instagram/stateMachine.js';
import { isEncryptedBackup, encryptedVersion } from '../js/util/crypto.js';
import { previewImport } from '../js/store/store.js';

// Mock sessionStorage for auth
global.sessionStorage = { _m:{}, getItem(k){return this._m[k]??null}, setItem(k,v){this._m[k]=String(v)}, removeItem(k){delete this._m[k]}};
global.localStorage = { _m:{}, getItem(k){return this._m[k]??null}, setItem(k,v){this._m[k]=String(v)}, removeItem(k){delete this._m[k]}};
if (typeof global.crypto==='undefined' || !global.crypto.getRandomValues) global.crypto={ getRandomValues(a){for(let i=0;i<a.length;i++)a[i]=Math.floor(Math.random()*256); return a}};

test('K: stored XSS sanitized — rendering escapes HTML (stored but not executed)', ()=>{
  const d = makeInstagramDraft({ videoName:'x.mp4', caption:'<script>alert(1)</script> hello', status:'DRAFT' });
  assert.ok(d.caption.includes('hello'));
  const cards = fs.readFileSync('js/ui/cards.js','utf8');
  assert.doesNotMatch(cards, /innerHTML.*caption/);
});

test('K: OAuth state is single-use and format enforced', ()=>{
  const s = generateState();
  assert.match(s, /^[a-z0-9]+-[0-9a-f]{64}$/);
  const ok = validateState(s);
  assert.equal(ok.ok, true);
  const replay = validateState(s);
  assert.equal(replay.ok, false);
  assert.match(replay.reason, /Missing|mismatch/i);
});

test('K: OAuth callback validation rejects bad code/state', ()=>{
  assert.equal(validateCallbackParams({ code:'short', state: generateState() }).ok, false);
  assert.equal(validateCallbackParams({ code:'validcode1234567890', state:'badformat' }).ok, false);
  const unknown = validateCallbackParams({ error:'some_weird_error', errorDesc:'' });
  assert.equal(unknown.unknownError, true);
});

test('K: malicious backup rejected and unknown keys dropped', ()=>{
  assert.throws(()=> previewImport({ hello:1 }), /not-a-backup/);
  const d = makeInstagramDraft({ videoName:'a.mp4', caption:'hi', extraInject:'<svg onload=alert(1)>', status:'DRAFT' });
  assert.equal(d.extraInject, undefined);
});

test('K: image header validation blocks fake image', ()=>{
  // text/plain masquerading as image
  const fake = 'data:image/png;base64,' + Buffer.from('not an image').toString('base64') + 'A'.repeat(100);
  assert.equal(isSafeImageDataUrl(fake), false);
});

test('K: duplicate publish blocked', ()=>{
  const d = { status:'PUBLISHED', updatedAt: new Date().toISOString(), retryCount:0 };
  assert.equal(isDuplicatePublish(d).duplicate, true);
  const d2 = { status:'UPLOADING', updatedAt: new Date().toISOString(), retryCount:0 };
  assert.equal(isDuplicatePublish(d2).duplicate, true);
});

test('K: state transitions enforce authorization boundary', ()=>{
  assert.equal(canTransition('DRAFT','PUBLISHED'), false);
  assert.equal(canTransition('READY','UPLOADING'), true);
  assert.equal(normalizeStatus('pending'), 'AWAITING_APPROVAL');
});

test('K: encrypted backup versioned', ()=>{
  assert.equal(isEncryptedBackup('brain-enc-v1.abc.def.ghi'), true);
  assert.equal(isEncryptedBackup('brain-enc-v2.abc.def.ghi'), true);
  assert.equal(isEncryptedBackup('plain'), false);
  assert.equal(encryptedVersion('brain-enc-v2.x.y.z'), 'v2');
});

test('K: unauthorized automation in manual mode blocked', async ()=>{
  const { isEligibleForAutomation } = await import('../js/instagram/automation.js');
  const automation = { enabled:false, paused:false, mode:'MANUAL', rules:[] };
  const draft = { id:'d1', status:'READY', hashtags:[] };
  const rule = { id:'r1', enabled:true, filters:{ eligibleDraftIds:['d1'], tags:[], namePattern:'', allowedDays:[0,1,2,3,4,5,6], allowedHours:{start:0,end:24}}, schedule:{freq:'daily', time:'09:00', days:[]}};
  const elig = isEligibleForAutomation(draft, rule, automation);
  assert.equal(elig.eligible, false);
});

test('K: CSP meta present', ()=>{
  const html = fs.readFileSync('index.html','utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /frame-ancestors/);
  assert.doesNotMatch(html, /FACEBOOK_APP_SECRET/);
});
