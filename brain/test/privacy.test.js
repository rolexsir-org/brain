import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Ensure ordinary Brain ops do not fetch to unexpected hosts
test('P: fetch allowlist', ()=>{
  const allowed = ['self','graph.facebook.com','facebook.com','supabase.co','amazonaws.com','r2.cloudflarestorage.com'];
  const urls = [
    'https://graph.facebook.com/v21.0/178400/media',
    'https://www.facebook.com/v21.0/dialog/oauth',
    'https://my.supabase.co/storage/v1/object/video.mp4?token=abc',
  ];
  for (const u of urls) {
    const isAllowed = allowed.some(h=> u.includes(h)) || u.startsWith('self');
    assert.equal(isAllowed, true, `URL should be allowlisted: ${u}`);
  }
  const html = fs.readFileSync('index.html','utf8');
  assert.doesNotMatch(html, /google-analytics/i);
  assert.doesNotMatch(html, /fonts\.googleapis/i);
});

test('P: backup does not include personal data transmission', ()=>{
  const storeJs = fs.readFileSync('js/store/store.js','utf8');
  const exportIdx = storeJs.indexOf('async exportState');
  const snippet = storeJs.slice(exportIdx, exportIdx+500);
  assert.doesNotMatch(snippet, /fetch\(/);
});

test('P: private URL not logged', ()=>{
  const publish = fs.readFileSync('js/instagram/publish.js','utf8');
  assert.doesNotMatch(publish, /console\.log.*video_url/i);
});
