// Instagram token-exchange service — keeps the App Secret off the client.
//
// Deploy separately from Brain's static hosting. The service is stateless: it
// stores no user data, writes no logs containing tokens, and only talks to
// graph.facebook.com.
//
// Required env:
//   FACEBOOK_APP_ID, FACEBOOK_APP_SECRET
// Strongly recommended env:
//   ALLOWED_REDIRECT_URI   comma-separated exact redirect URIs
//   ALLOWED_ORIGINS        comma-separated exact browser origins ("*" opts in to any)
// Optional env:
//   GRAPH_VERSION          defaults to v26.0
//   RATE_LIMIT_MAX         requests per window per IP (default 30)
//   RATE_LIMIT_WINDOW_MS   window length in ms (default 60000)
//   UPSTREAM_TIMEOUT_MS    Meta request timeout (default 10000)
//   TRUST_PROXY            which client identity to trust (default: none)
//                          "cloudflare" -> cf-connecting-ip (Cloudflare sets it)
//                          "forwarded"  -> first x-forwarded-for entry
//                          "vercel" | "netlify" -> their forwarded headers
//                          Only enable this when a proxy you control overwrites
//                          the header; otherwise clients can rotate it.
//
// Routes (a deployment prefix such as /api/instagram is supported):
//   POST   .../exchange           { code, redirect_uri } -> { access_token, ... }
//   POST   .../exchange/refresh   { access_token }       -> { access_token, ... }
//   GET    .../health             { ok, configured, graph }
//
// Failure behaviour is deliberately conservative: a missing App Secret, an
// unlisted Origin, an unlisted redirect URI, an oversized body, or a Meta
// timeout all fail closed with a JSON error and no token material.

const DEFAULT_GRAPH_VERSION = 'v26.0';
const MAX_BODY_BYTES = 4 * 1024;
const DEFAULT_RATE_LIMIT_MAX = 30;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_RATE_BUCKETS = 5_000;

const SECURITY_HEADERS = Object.freeze({
  // Token responses must never be stored by a browser, proxy, or CDN.
  'Cache-Control': 'no-store, max-age=0',
  'Pragma': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
});

function splitList(value) {
  return String(value == null ? '' : value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...SECURITY_HEADERS,
      ...extraHeaders
    }
  });
}

/**
 * Compute CORS headers. Fail-closed by default: with no ALLOWED_ORIGINS the
 * response carries no CORS headers at all, so browsers block cross-origin use.
 * An operator must opt in with explicit origins, or "*" explicitly.
 */
function corsHeaders(origin, allowedOrigins) {
  const list = splitList(allowedOrigins);
  if (origin) {
    if (list.includes('*')) {
      return { 'Access-Control-Allow-Origin': '*', 'Vary': 'Origin' };
    }
    if (list.includes(origin)) {
      return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
        'Vary': 'Origin'
      };
    }
    return null; // Origin present but not allowed → no CORS grant.
  }
  // No Origin header: same-origin, server-to-server, or a non-browser client.
  return list.length ? { 'Vary': 'Origin' } : {};
}

function originAllowed(origin, allowedOrigins) {
  if (!origin) return true;
  const list = splitList(allowedOrigins);
  return list.includes('*') || list.includes(origin);
}

/**
 * Normalise an address to a rate-limit key, rejecting anything that is not a
 * plausible IP. Forwarding headers are attacker-controlled unless a proxy you
 * operate overwrites them, so nothing here is read unless the deployment says
 * so explicitly (or Cloudflare's runtime marker proves the edge is in front).
 */
export function normalizeClientIp(value) {
  if (typeof value !== 'string') return '';
  let candidate = value.trim();
  if (!candidate) return '';
  // Forwarding headers may carry a port or an IPv6 bracket: [2001:db8::1]:443,
  // 203.0.113.5:443. Strip the port only; never strip IPv6 colons.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(candidate);
  if (bracketed) {
    candidate = bracketed[1];
  } else {
    const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(candidate);
    if (v4WithPort) candidate = v4WithPort[1];
  }
  if (candidate.length < 2 || candidate.length > 45) return '';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(candidate);
  if (v4) {
    // Reject 999.1.1.1 and similar: a bucket key should be a real address.
    if (v4.slice(1).some(octet => Number(octet) > 255)) return '';
    return candidate;
  }
  if (!/^[0-9a-fA-F:]+$/.test(candidate) || candidate.split(':').length < 3) return '';
  return candidate.toLowerCase();
}

function normalizeTrustProxy(value) {
  const mode = String(value == null ? '' : value).trim().toLowerCase();
  if (mode === '1' || mode === 'true') return 'forwarded';
  if (['cloudflare', 'forwarded', 'vercel', 'netlify'].includes(mode)) return mode;
  return '';
}

export function clientKey(request, env = {}, options = {}) {
  const headers = request.headers;
  const mode = normalizeTrustProxy(env.TRUST_PROXY);

  if (mode === 'cloudflare') {
    const cf = normalizeClientIp(headers.get('cf-connecting-ip'));
    if (cf) return `cf:${cf}`;
  }
  if (mode === 'forwarded' || mode === 'vercel' || mode === 'netlify') {
    const forwarded = headers.get('x-forwarded-for');
    const first = forwarded ? normalizeClientIp(forwarded.split(',')[0]) : '';
    if (first) return `ip:${first}`;
    const platform = normalizeClientIp(headers.get('x-real-ip'))
      || (mode === 'netlify' ? normalizeClientIp(headers.get('x-nf-client-connection-ip')) : '');
    if (platform) return `ip:${platform}`;
  }

  // Cloudflare Workers expose request.cf, which only exists when the request
  // really arrived through Cloudflare. In that runtime cf-connecting-ip is set
  // by the edge, so it is trustworthy without extra configuration.
  if (request.cf && mode !== 'forwarded' && mode !== 'vercel' && mode !== 'netlify') {
    const cf = normalizeClientIp(headers.get('cf-connecting-ip'));
    if (cf) return `cf:${cf}`;
  }

  // Direct Node/VPS deployment: the socket address cannot be forged by a client.
  const socket = normalizeClientIp(options.remoteAddress);
  if (socket) return `ip:${socket}`;

  // Serverless runtimes without a socket and without explicit trust: one shared
  // bucket. Fail-safe (stricter), never bypassable via headers.
  return 'unknown';
}

function rateLimitState(request, env, options = {}) {
  if (env.RATE_LIMIT_DISABLED === '1') return { limited: false };
  const maxRaw = Number(env.RATE_LIMIT_MAX);
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : DEFAULT_RATE_LIMIT_MAX;
  const windowRaw = Number(env.RATE_LIMIT_WINDOW_MS);
  const windowMs = Number.isFinite(windowRaw) && windowRaw > 0 ? Math.floor(windowRaw) : DEFAULT_RATE_LIMIT_WINDOW_MS;
  const store = env.__rateBuckets instanceof Map ? env.__rateBuckets : rateBuckets;
  const key = clientKey(request, env, options);
  const now = Date.now();
  let bucket = store.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    store.set(key, bucket);
  }
  bucket.count += 1;
  if (store.size > MAX_RATE_BUCKETS) {
    for (const [entryKey, entry] of store) {
      if (entry.resetAt <= now) store.delete(entryKey);
    }
    if (store.size > MAX_RATE_BUCKETS) store.delete(store.keys().next().value);
  }
  if (bucket.count > max) {
    return { limited: true, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { limited: false };
}

// Module-level buckets are best-effort: serverless isolates get their own.
const rateBuckets = new Map();

/** Read a JSON body with a hard size cap before parsing. */
async function readJsonBody(request) {
  const contentType = String(request.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.includes('application/json')) {
    return { error: 'unsupported_media_type', status: 415 };
  }
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { error: 'payload_too_large', status: 413 };
  }
  let text;
  try { text = await request.text(); } catch { return { error: 'unreadable_body', status: 400 }; }
  if (typeof text !== 'string') return { error: 'unreadable_body', status: 400 };
  if (text.length > MAX_BODY_BYTES) return { error: 'payload_too_large', status: 413 };
  if (!text.trim()) return { error: 'empty_body', status: 400 };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'invalid_json', status: 400 };
    return { value };
  } catch {
    return { error: 'invalid_json', status: 400 };
  }
}

function upstreamTimeout(env) {
  const raw = Number(env.UPSTREAM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 60_000) : DEFAULT_UPSTREAM_TIMEOUT_MS;
}

/** Call Meta with a hard timeout and never surface the URL (it holds secrets). */
async function fetchGraph(urlString, env, fetchImpl) {
  const timeoutMs = upstreamTimeout(env);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(urlString, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller ? controller.signal : undefined
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || /abort/i.test(String(error.message)));
    return { ok: false, status: aborted ? 504 : 502, data: null, timedOut: aborted };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function metaError(result) {
  if (result && result.timedOut) return 'Meta did not respond in time. Try again.';
  const message = result && result.data && result.data.error && result.data.error.message;
  if (message) return String(message).slice(0, 300);
  return `Token service failed (${result ? result.status : 'unknown'})`;
}

function matchRoute(pathname) {
  const parts = String(pathname || '/').split('/').filter(Boolean).map(part => part.toLowerCase());
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  const previous = parts[parts.length - 2];
  if (last === 'health') return 'health';
  if (last === 'refresh' && previous === 'exchange') return 'refresh';
  if (last === 'exchange') return 'exchange';
  return null;
}

/**
 * Universal handler for Cloudflare Workers, Netlify/Vercel functions, Deno, and
 * the Node adapter below.
 *
 * @param {Request} request
 * @param {Record<string, string|undefined>} env
 * @param {{ fetchImpl?: typeof fetch }} [options] - injection seam for tests.
 */
export async function handleRequest(request, env = {}, options = {}) {
  const environment = env || {};
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  const cors = corsHeaders(origin, environment.ALLOWED_ORIGINS);
  const withCors = headers => ({ ...(headers || {}), ...(cors || {}) });
  const graphVersion = String(environment.GRAPH_VERSION || DEFAULT_GRAPH_VERSION);
  const graph = `https://graph.facebook.com/${graphVersion}`;
  const route = matchRoute(url.pathname);

  if (request.method === 'OPTIONS') {
    if (!origin) return new Response(null, { status: 204, headers: withCors() });
    if (!cors) return jsonResponse({ error: 'origin_not_allowed' }, 403, { Vary: 'Origin' });
    return new Response(null, { status: 204, headers: withCors() });
  }

  if (origin && !originAllowed(origin, environment.ALLOWED_ORIGINS)) {
    return jsonResponse({ error: 'origin_not_allowed' }, 403, { Vary: 'Origin' });
  }

  if (!route) return jsonResponse({ error: 'Not found' }, 404, withCors());

  if (route === 'health') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: 'Method not allowed' }, 405, withCors({ Allow: 'GET, HEAD' }));
    }
    const missing = ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'].filter(key => !environment[key]);
    return jsonResponse({
      ok: true,
      configured: missing.length === 0,
      graph: graphVersion
    }, 200, withCors());
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, withCors({ Allow: 'POST, OPTIONS' }));
  }

  if (!fetchImpl) return jsonResponse({ error: 'service_misconfigured', detail: 'fetch unavailable' }, 500, withCors());

  // Configuration is checked before consuming the body or contacting Meta.
  const missing = ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'].filter(key => !environment[key]);
  if (missing.length) {
    return jsonResponse({ error: 'service_misconfigured' }, 500, withCors());
  }

  const limited = rateLimitState(request, environment, options);
  if (limited.limited) {
    return jsonResponse({ error: 'rate_limited', retryAfter: limited.retryAfterSec }, 429, withCors({
      'Retry-After': String(limited.retryAfterSec)
    }));
  }

  const parsed = await readJsonBody(request);
  if (parsed.error) return jsonResponse({ error: parsed.error }, parsed.status, withCors());

  if (route === 'exchange') {
    const body = parsed.value;
    const code = typeof body.code === 'string' ? body.code : '';
    const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : '';
    if (!code || !redirectUri) return jsonResponse({ error: 'Missing code or redirect_uri' }, 400, withCors());
    if (!/^[A-Za-z0-9._-]{10,600}$/.test(code)) return jsonResponse({ error: 'Invalid authorization code' }, 400, withCors());

    const allowedRedirects = splitList(environment.ALLOWED_REDIRECT_URI);
    if (!allowedRedirects.length) {
      // Without an allowlist any redirect URI would be accepted. Fail closed in
      // production rather than silently weakening the OAuth flow.
      return jsonResponse({ error: 'service_misconfigured', detail: 'ALLOWED_REDIRECT_URI is required' }, 500, withCors());
    }
    if (!allowedRedirects.includes(redirectUri)) {
      return jsonResponse({ error: 'redirect_uri not allowlisted' }, 403, withCors());
    }

    const tokenUrl = new URL(`${graph}/oauth/access_token`);
    tokenUrl.searchParams.set('client_id', environment.FACEBOOK_APP_ID);
    tokenUrl.searchParams.set('client_secret', environment.FACEBOOK_APP_SECRET);
    tokenUrl.searchParams.set('redirect_uri', redirectUri);
    tokenUrl.searchParams.set('code', code);

    const result = await fetchGraph(tokenUrl.toString(), environment, fetchImpl);
    if (!result.ok || !result.data || !result.data.access_token) {
      const status = result.status >= 400 && result.status < 500 ? 400 : 502;
      return jsonResponse({ error: metaError(result) }, status, withCors());
    }

    // Exchange the short-lived token for the 60-day long-lived token. If that
    // call fails, return the short-lived token rather than failing the login.
    const longUrl = new URL(`${graph}/oauth/access_token`);
    longUrl.searchParams.set('grant_type', 'fb_exchange_token');
    longUrl.searchParams.set('client_id', environment.FACEBOOK_APP_ID);
    longUrl.searchParams.set('client_secret', environment.FACEBOOK_APP_SECRET);
    longUrl.searchParams.set('fb_exchange_token', result.data.access_token);
    const longResult = await fetchGraph(longUrl.toString(), environment, fetchImpl);
    if (longResult.ok && longResult.data && longResult.data.access_token) {
      return jsonResponse(longResult.data, 200, withCors());
    }
    return jsonResponse(result.data, 200, withCors());
  }

  // route === 'refresh'
  const token = typeof parsed.value.access_token === 'string' ? parsed.value.access_token : '';
  if (!token) return jsonResponse({ error: 'Missing access_token' }, 400, withCors());
  if (token.length > 2_000) return jsonResponse({ error: 'Invalid access_token' }, 400, withCors());
  const refreshUrl = new URL(`${graph}/oauth/access_token`);
  refreshUrl.searchParams.set('grant_type', 'fb_exchange_token');
  refreshUrl.searchParams.set('client_id', environment.FACEBOOK_APP_ID);
  refreshUrl.searchParams.set('client_secret', environment.FACEBOOK_APP_SECRET);
  refreshUrl.searchParams.set('fb_exchange_token', token);
  const refreshed = await fetchGraph(refreshUrl.toString(), environment, fetchImpl);
  if (!refreshed.ok || !refreshed.data || !refreshed.data.access_token) {
    const status = refreshed.status >= 400 && refreshed.status < 500 ? 400 : 502;
    return jsonResponse({ error: metaError(refreshed) }, status, withCors());
  }
  return jsonResponse(refreshed.data, 200, withCors());
}

/**
 * Node http adapter. `node server/instagram-exchange.js` starts a real server on
 * PORT (default 8787) using the environment variables above.
 */
export function createNodeHandler(env = process.env, options = {}) {
  return async function nodeHandler(req, res) {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; break; }
      chunks.push(chunk);
    }
    const base = `http://${req.headers.host || 'localhost'}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(', '));
    }
    let request;
    try {
      request = new Request(new URL(req.url || '/', base), {
        method: req.method,
        headers,
        body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || tooLarge ? undefined : Buffer.concat(chunks)
      });
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'invalid_request' }));
      return;
    }
    if (tooLarge) {
      res.writeHead(413, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'payload_too_large' }));
      return;
    }
    const remoteAddress = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
    const response = await handleRequest(request, env, { ...options, remoteAddress });
    const body = response.status === 204 ? null : await response.text();
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(body || undefined);
  };
}

export function createNodeServer(env = process.env, options = {}) {
  // Imported lazily so bundlers targeting Workers never pull node:http in.
  return import('node:http').then(({ createServer }) => createServer(createNodeHandler(env, options)));
}

const isMain = (() => {
  try {
    return typeof process !== 'undefined' && process.argv && process.argv[1]
      && /instagram-exchange\.js$/.test(process.argv[1]);
  } catch { return false; }
})();

if (isMain) {
  const port = Number(process.env.PORT) || 8787;
  createNodeServer(process.env).then(server => {
    server.listen(port, '0.0.0.0', () => {
      const configured = !!(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);
      console.log(`Brain Instagram exchange listening on :${port} (configured=${configured})`);
    });
  }).catch(error => {
    console.error('Failed to start exchange service:', error.message);
    process.exit(1);
  });
}

export const __test = { corsHeaders, matchRoute, rateLimitState, readJsonBody, splitList, normalizeClientIp, normalizeTrustProxy, SECURITY_HEADERS, MAX_BODY_BYTES };

// Example Netlify Function wrapper:
// exports.handler = async (event) => {
//   const req = new Request(`https://example.com${event.path}`, { method:event.httpMethod, headers:event.headers, body:event.body });
//   const res = await handleRequest(req, process.env);
//   return { statusCode: res.status, headers: Object.fromEntries(res.headers.entries()), body: await res.text() };
// }
