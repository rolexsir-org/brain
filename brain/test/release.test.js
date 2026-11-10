// Release-gate tests: version coherence, deployable security headers, PWA
// manifest integrity, and a secret scan over the public asset surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, SCHEMA_VERSION, DB_VERSION } from '../js/util/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ROOT, rel));

test('package version, app constant, and service-worker cache agree', () => {
  const pkg = JSON.parse(read('package.json'));
  const sw = read('sw.js');
  assert.equal(pkg.version, VERSION, 'package.json and constants.js versions differ');
  assert.match(sw, new RegExp(`brain-v${VERSION.replace(/\./g, '\\.')}`), 'service worker cache version is stale');
  assert.equal(typeof SCHEMA_VERSION, 'number');
  assert.equal(typeof DB_VERSION, 'number');
});

test('PWA manifest is complete and every icon exists', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.ok(manifest.name && manifest.short_name);
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.start_url);
  assert.ok(manifest.theme_color && manifest.background_color);
  const sizes = manifest.icons.map(icon => icon.sizes);
  assert.ok(sizes.includes('192x192'), '192px icon missing');
  assert.ok(sizes.includes('512x512'), '512px icon missing');
  assert.ok(manifest.icons.some(icon => (icon.purpose || '').includes('maskable')), 'maskable icon missing');
  for (const icon of manifest.icons) assert.ok(exists(icon.src), `${icon.src} does not exist`);
});

test('app shell declares a strict CSP and required meta tags', () => {
  const html = read('index.html');
  assert.match(html, /<meta http-equiv="Content-Security-Policy"/);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /frame-ancestors 'none'/);
  assert.match(html, /base-uri 'self'/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /rel="manifest"/);
  assert.match(html, /apple-touch-icon/);
  assert.match(html, /theme-color/);
});

test('service worker precaches only existing public assets', () => {
  const sw = read('sw.js');
  const list = sw.match(/const ASSETS = \[([\s\S]*?)\];/);
  assert.ok(list, 'ASSETS list not found');
  const assets = [...list[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(assets.length >= 40, `expected the full shell, found ${assets.length}`);
  for (const asset of assets) {
    const rel = asset === './' ? 'index.html' : asset.replace(/^\.\//, '');
    assert.ok(exists(rel), `precached asset missing on disk: ${asset}`);
  }
  // The worker must never precache server or test code.
  assert.ok(!assets.some(asset => /server\/|test\/|package/.test(asset)));
});

test('no App Secret or token material is present in shipped assets', () => {
  const candidates = ['index.html', 'sw.js', 'manifest.webmanifest'];
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(js|css|html|webmanifest)$/.test(entry.name)) candidates.push(rel);
    }
  };
  walk('js');
  walk('css');
  for (const rel of candidates) {
    const source = read(rel);
    assert.doesNotMatch(source, /FACEBOOK_APP_SECRET\s*=/, `${rel} contains a hardcoded App Secret`);
    assert.doesNotMatch(source, /client_secret['"]?\s*[:=]\s*['"][^'"]+['"]/, `${rel} contains a hardcoded client secret`);
  }
});

test('meta CSP and header CSP agree on every allowed network origin', () => {
  const html = read('index.html');
  const meta = (html.match(/connect-src([^;"]*)/) || [])[1] || '';
  const cspLine = (read('_headers').match(/Content-Security-Policy:([^\n]*)/) || [])[1] || '';
  const header = (cspLine.match(/connect-src([^;]*)/) || [])[1] || '';
  const origins = meta.split(/\s+/).filter(token => /^(https:\/\/|'self')/.test(token));
  assert.ok(origins.length >= 5, 'meta connect-src looks truncated');
  for (const origin of origins) {
    assert.ok(header.includes(origin), `header CSP is missing ${origin}`);
  }
});

test('deployment header files exist and harden the origin', () => {
  const headers = read('_headers');
  for (const required of ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'Referrer-Policy', 'frame-ancestors']) {
    assert.ok(headers.includes(required), `_headers is missing ${required}`);
  }
  const vercel = JSON.parse(read('vercel.json'));
  const flattened = JSON.stringify(vercel);
  for (const required of ['Strict-Transport-Security', 'X-Content-Type-Options', 'Content-Security-Policy']) {
    assert.ok(flattened.includes(required), `vercel.json is missing ${required}`);
  }
});

test('release notes and deploy documentation are present', () => {
  for (const doc of [
    'docs/deployment.md',
    'docs/production-hardening-2.4.0.md',
    'docs/threat-model.md',
    'docs/backup-recovery.md'
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, '..', doc)), `${doc} is missing`);
  }
});
