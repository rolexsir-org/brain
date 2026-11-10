// Hardening tests for the token-exchange service. These run against the real
// handler with an injected fetch so no network or Meta credentials are needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, __test } from '../server/instagram-exchange.js';

const APP = 'app-123';
const SECRET = 'super-secret-value';
const REDIRECT = 'https://brain.example/auth/instagram/callback';
const ORIGIN = 'https://brain.example';

function env(overrides = {}) {
  return {
    FACEBOOK_APP_ID: APP,
    FACEBOOK_APP_SECRET: SECRET,
    ALLOWED_REDIRECT_URI: REDIRECT,
    ALLOWED_ORIGINS: ORIGIN,
    RATE_LIMIT_MAX: '100',
    ...overrides
  };
}

function request(path, { method = 'POST', body, headers = {}, origin = ORIGIN } = {}) {
  const allHeaders = new Headers({ 'Content-Type': 'application/json', ...headers });
  if (origin) allHeaders.set('Origin', origin);
  return new Request(`https://exchange.example${path}`, {
    method,
    headers: allHeaders,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  });
}

function tokenFetch(payload = { access_token: 'short-token', token_type: 'bearer', expires_in: 3600 }) {
  const calls = [];
  const impl = async url => {
    calls.push(String(url));
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  impl.calls = calls;
  return impl;
}

test('missing credentials fail closed without leaking config', async () => {
  const response = await handleRequest(
    request('/exchange', { body: { code: 'abcdefghijk', redirect_uri: REDIRECT } }),
    env({ FACEBOOK_APP_SECRET: '' }),
    { fetchImpl: tokenFetch() }
  );
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.match(text, /service_misconfigured/);
  assert.doesNotMatch(text, new RegExp(SECRET));
});

test('unlisted Origin is rejected and gets no CORS grant', async () => {
  const response = await handleRequest(
    request('/exchange', { body: { code: 'abcdefghijk', redirect_uri: REDIRECT }, origin: 'https://evil.example' }),
    env(),
    { fetchImpl: tokenFetch() }
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await response.json(), { error: 'origin_not_allowed' });
});

test('preflight for an unlisted Origin is denied', async () => {
  const response = await handleRequest(
    request('/exchange', { method: 'OPTIONS', origin: 'https://evil.example' }),
    env(),
    { fetchImpl: tokenFetch() }
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('allowed Origin receives an exact-match CORS header', async () => {
  const response = await handleRequest(
    request('/exchange', { method: 'OPTIONS' }),
    env(),
    { fetchImpl: tokenFetch() }
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
});

test('no ALLOWED_ORIGINS means no cross-origin grant (fail closed)', async () => {
  const response = await handleRequest(
    request('/health', { method: 'GET', origin: '' }),
    env({ ALLOWED_ORIGINS: '' }),
    { fetchImpl: tokenFetch() }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('oversized body is rejected before JSON parsing', async () => {
  const response = await handleRequest(
    request('/exchange', { body: JSON.stringify({ code: 'a'.repeat(__test.MAX_BODY_BYTES) }) }),
    env(),
    { fetchImpl: tokenFetch() }
  );
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, 'payload_too_large');
});

test('invalid JSON and wrong content type are rejected', async () => {
  const badJson = await handleRequest(
    request('/exchange', { body: '{"code": ' }),
    env(),
    { fetchImpl: tokenFetch() }
  );
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error, 'invalid_json');

  const wrongType = await handleRequest(
    request('/exchange', { body: 'code=x', headers: { 'Content-Type': 'text/plain' } }),
    env(),
    { fetchImpl: tokenFetch() }
  );
  assert.equal(wrongType.status, 415);
});

test('redirect URI must be explicitly allowlisted', async () => {
  const missing = await handleRequest(
    request('/exchange', { body: { code: 'abcdefghijk', redirect_uri: 'https://evil.example/cb' } }),
    env(),
    { fetchImpl: tokenFetch() }
  );
  assert.equal(missing.status, 403);

  const noList = await handleRequest(
    request('/exchange', { body: { code: 'abcdefghijk', redirect_uri: REDIRECT } }),
    env({ ALLOWED_REDIRECT_URI: '' }),
    { fetchImpl: tokenFetch() }
  );
  assert.equal(noList.status, 500);
  assert.match(await noList.text(), /ALLOWED_REDIRECT_URI/);
});

test('malformed authorization code is rejected', async () => {
  const response = await handleRequest(
    request('/exchange', { body: { code: 'short', redirect_uri: REDIRECT } }),
    env(),
    { fetchImpl: tokenFetch() }
  );
  assert.equal(response.status, 400);
});

test('successful exchange returns a long-lived token with no-store headers', async () => {
  const fetchImpl = tokenFetch({ access_token: 'long-lived-token', token_type: 'bearer', expires_in: 5184000 });
  const response = await handleRequest(
    request('/exchange', { body: { code: 'abcdefghijk', redirect_uri: REDIRECT } }),
    env(),
    { fetchImpl }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await response.json()).access_token, 'long-lived-token');
  // Two upstream calls: code exchange, then long-lived exchange.
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(fetchImpl.calls[1].includes('grant_type=fb_exchange_token'));
});

test('upstream failure never echoes client_secret', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'Invalid verification code' } }), { status: 400 });
  const response = await handleRequest(
    request('/exchange', { body: { code: 'abcdefghijk', redirect_uri: REDIRECT } }),
    env(),
    { fetchImpl }
  );
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.match(text, /Invalid verification code/);
  assert.doesNotMatch(text, new RegExp(SECRET));
  assert.doesNotMatch(text, /client_secret/);
});

test('upstream timeout maps to a 504 without hanging', async () => {
  const fetchImpl = async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; };
  const response = await handleRequest(
    request('/exchange', { body: { code: 'abcdefghijk', redirect_uri: REDIRECT } }),
    env(),
    { fetchImpl }
  );
  assert.equal(response.status, 502);
});

test('refresh route exchanges a long-lived token', async () => {
  const fetchImpl = tokenFetch({ access_token: 'refreshed-token', expires_in: 5184000 });
  const response = await handleRequest(
    request('/exchange/refresh', { body: { access_token: 'existing-token' } }),
    env(),
    { fetchImpl }
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).access_token, 'refreshed-token');
  assert.ok(fetchImpl.calls[0].includes('fb_exchange_token=existing-token'));
});

test('rate limiting returns 429 with Retry-After', async () => {
  const shared = { __rateBuckets: new Map() };
  const fetchImpl = tokenFetch();
  let last;
  for (let index = 0; index < 4; index += 1) {
    last = await handleRequest(
      request('/exchange/refresh', { body: { access_token: 'token' }, headers: { 'CF-Connecting-IP': '203.0.113.5' } }),
      env({ ...shared, RATE_LIMIT_MAX: '3' }),
      { fetchImpl }
    );
  }
  assert.equal(last.status, 429);
  assert.equal(last.headers.get('retry-after'), '60');
  assert.equal((await last.json()).error, 'rate_limited');
});

test('health reports configuration without secrets', async () => {
  const ok = await handleRequest(request('/health', { method: 'GET' }), env(), { fetchImpl: tokenFetch() });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(body, { ok: true, configured: true, graph: 'v26.0' });

  const unconfigured = await handleRequest(request('/health', { method: 'GET' }), env({ FACEBOOK_APP_ID: '' }), { fetchImpl: tokenFetch() });
  assert.equal((await unconfigured.json()).configured, false);
});

test('unknown routes and wrong methods are rejected', async () => {
  const missing = await handleRequest(request('/nope', { body: {} }), env(), { fetchImpl: tokenFetch() });
  assert.equal(missing.status, 404);

  const method = await handleRequest(request('/exchange', { method: 'GET' }), env(), { fetchImpl: tokenFetch() });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'POST, OPTIONS');
});

test('deployment prefixes are supported and parsers agree', () => {
  assert.equal(__test.matchRoute('/api/instagram/exchange'), 'exchange');
  assert.equal(__test.matchRoute('/api/instagram/exchange/refresh'), 'refresh');
  assert.equal(__test.matchRoute('/health'), 'health');
  assert.equal(__test.matchRoute('/api/instagram/nope'), null);
  assert.equal(__test.matchRoute('/'), null);
  assert.deepEqual(__test.splitList(' a , b,,'), ['a', 'b']);
});
