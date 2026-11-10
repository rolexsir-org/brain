// Production static server tests: public-surface allowlisting, headers, cache
// policy, compression, conditional requests, and method handling.
import test from 'node:test';
import path from 'node:path';
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
