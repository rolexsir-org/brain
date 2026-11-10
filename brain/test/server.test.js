// Production static server tests: public-surface allowlisting, headers, cache
// policy, compression, conditional requests, and method handling.
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer, contentSecurityPolicy, resolvePublicPath, __test } from '../server/static-server.mjs';

async function withServer(run) {
  const server = createServer({ publicOrigin: 'https://brain.example' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('serves the app shell with hardened headers', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(response.headers.get('content-security-policy'), /connect-src [^;]*https:\/\/brain\.example/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('strict-transport-security'), /max-age=31536000/);
    assert.equal(response.headers.get('cache-control'), 'no-cache, must-revalidate');
    assert.match(await response.text(), /<title>Brain/);
  });
});

test('service worker and manifest are never cached long-term', async () => {
  await withServer(async base => {
    for (const file of ['/sw.js', '/manifest.webmanifest']) {
      const response = await fetch(`${base}${file}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-cache, must-revalidate');
    }
    const asset = await fetch(`${base}/js/app.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=300, must-revalidate');
    assert.match(asset.headers.get('content-type'), /javascript/);
  });
});

test('private paths are not served', async () => {
  await withServer(async base => {
    for (const path of ['/package.json', '/server/instagram-exchange.js', '/test/store.test.js', '/node_modules/jsdom/package.json', '/../audit.js', '/js/../../package.json']) {
      const response = await fetch(`${base}${path}`, { redirect: 'manual' });
      assert.ok(response.status === 404 || response.status === 400, `${path} should not be served (got ${response.status})`);
    }
  });
});

test('deep links fall back to the app shell but asset misses are 404', async () => {
  await withServer(async base => {
    const deepLink = await fetch(`${base}/auth/instagram/callback?code=abc&state=def`);
    assert.equal(deepLink.status, 200);
    assert.match(await deepLink.text(), /<title>Brain/);
    const missingAsset = await fetch(`${base}/js/missing.js`);
    assert.equal(missingAsset.status, 404);
  });
});

test('conditional requests return 304', async () => {
  await withServer(async base => {
    const first = await fetch(`${base}/js/app.js`);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    const second = await fetch(`${base}/js/app.js`, { headers: { 'If-None-Match': etag } });
    assert.equal(second.status, 304);
  });
});

test('compresses compressible assets when the client accepts gzip', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/js/app.js`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.match(await response.text(), /navigator|document/);
  });
});

test('HEAD and unsupported methods are handled', async () => {
  await withServer(async base => {
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers.get('content-length')) > 0);
    const post = await fetch(`${base}/`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  });
});

test('health endpoint responds without secrets', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, app: 'brain' });
  });
});

test('path resolution rejects traversal and dotfiles', () => {
  assert.equal(resolvePublicPath('/').relativePath, 'index.html');
  assert.ok(path.isAbsolute(resolvePublicPath('/').file), 'resolved file path must be absolute');
  assert.equal(resolvePublicPath('/index.html').file, resolvePublicPath('/').file);
  assert.equal(resolvePublicPath('/../etc/passwd'), null);
  assert.equal(resolvePublicPath('/js/%2e%2e/package.json'), null);
  assert.equal(resolvePublicPath('/js/.hidden.js'), null);
  assert.equal(resolvePublicPath('/css/app.css').relativePath, 'css/app.css');
  assert.equal(resolvePublicPath('/index.html').relativePath, 'index.html');
  assert.equal(__test.resolvePublicPath('/js/app.js').file.endsWith('app.js'), true);
});

test('CSP builder tolerates malformed origins', () => {
  assert.match(contentSecurityPolicy('not a url'), /connect-src [^;]*'self'/);
  assert.doesNotMatch(contentSecurityPolicy('not a url'), /not a url/);
  assert.equal(__test.PUBLIC_FILES.has('sw.js'), true);
  assert.equal(__test.PUBLIC_DIRS.has('js'), true);
});

// ── Filesystem containment (symlinks and traversal) ──────────────────────────
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const created = [];

function link(name, target) {
  const file = path.join(ROOT, 'js', name);
  try { fs.unlinkSync(file); } catch {}
  fs.symlinkSync(target, file);
  created.push(file);
  return file;
}

function cleanup() {
  for (const file of created.splice(0)) { try { fs.unlinkSync(file); } catch {} }
}

async function statusFor(base, urlPath) {
  const response = await fetch(`${base}${urlPath}`);
  await response.arrayBuffer().catch(() => {});
  return response.status;
}

test('symlinks that escape the public surface are refused', async () => {
  // Each target is a real, readable file that must never be served.
  link('probe-package.js', '../package.json');
  link('probe-server.js', '../server/instagram-exchange.js');
  link('probe-outside.js', '../../../audit.js');
  link('probe-missing.js', '../does-not-exist.js');
  const outDir = path.join(ROOT, 'js', 'probe-out-dir');
  try { fs.unlinkSync(outDir); } catch {}
  fs.symlinkSync('../server', outDir); // escapes into server/
  created.push(outDir);
  const inDir = path.join(ROOT, 'js', 'probe-in-dir');
  try { fs.unlinkSync(inDir); } catch {}
  fs.symlinkSync('.', inDir); // stays inside js/
  created.push(inDir);
  try {
    await withServer(async base => {
      assert.equal(await statusFor(base, '/js/probe-package.js'), 404, 'package.json must not be reachable');
      assert.equal(await statusFor(base, '/js/probe-server.js'), 404, 'server code must not be reachable');
      assert.equal(await statusFor(base, '/js/probe-outside.js'), 404, 'files outside the deployment must not be reachable');
      assert.equal(await statusFor(base, '/js/probe-missing.js'), 404, 'broken symlink is a 404');
      assert.equal(await statusFor(base, '/js/probe-out-dir/instagram-exchange.js'), 404, 'symlinked directories must not escape');
      assert.equal(await statusFor(base, '/js/probe-in-dir/app.js'), 200, 'a symlink that resolves inside the public dir still works');
      assert.equal(await statusFor(base, '/js/app.js'), 200, 'normal assets are unaffected');
    });
  } finally { cleanup(); }
});

test('traversal variants are refused in raw and encoded form', async () => {
  await withServer(async base => {
    for (const urlPath of [
      '/../package.json',
      '/js/../../package.json',
      '/js/%2e%2e/package.json',
      '/js/%2e%2e%2fpackage.json',
      '/%2e%2e%2f%2e%2e%2faudit.js',
      '/js/app.js%00.png',
      '/js/%c0%ae%c0%ae/package.json'
    ]) {
      const status = await statusFor(base, urlPath);
      assert.ok(status === 404 || status === 400, `${urlPath} returned ${status}`);
    }
  });
});

test('directories and internal trees are not served as documents', async () => {
  await withServer(async base => {
    for (const urlPath of ['/js', '/js/', '/css', '/icons', '/server', '/test', '/node_modules', '/docs', '/.env', '/.git/config', '/js/.hidden']) {
      assert.equal(await statusFor(base, urlPath), 404, `${urlPath} must not fall back to the shell`);
    }
    assert.equal(await statusFor(base, '/auth/instagram/callback'), 200, 'real deep links still serve the shell');
    assert.equal(await statusFor(base, '/'), 200);
  });
});

test('canonicalPublicFile rejects escapes and accepts public files', async () => {
  const { canonicalPublicFile } = await import('../server/static-server.mjs');
  assert.equal(await canonicalPublicFile(path.join(ROOT, 'package.json')), null);
  assert.equal(await canonicalPublicFile(path.join(ROOT, '..', 'audit.js')), null);
  assert.equal(await canonicalPublicFile(path.join(ROOT, 'js')), null, 'directories are not files');
  assert.equal(await canonicalPublicFile(path.join(ROOT, 'js', 'nope.js')), null);
  const app = await canonicalPublicFile(path.join(ROOT, 'js', 'app.js'));
  assert.ok(app && app.relativePath === 'js/app.js');
  assert.ok(app.stat.isFile());
});
