#!/usr/bin/env node
// Production static server for Brain. Zero runtime dependencies.
//
// It serves only the public app shell (index.html, manifest, service worker,
// css/, js/, icons/) — never package.json, tests, or the token-exchange service.
// Security headers, cache policy, compression, ETags, and graceful shutdown are
// handled here so a self-hosted deployment does not depend on CDN defaults.
//
// Usage: PORT=8000 node server/static-server.mjs
//   HOST=0.0.0.0 (default)  PORT=8000 (default)
//   BRAIN_PUBLIC_ORIGIN=https://brain.example  (adds it to CSP connect-src)

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Canonical root, resolved once. A deployment directory may itself be a
// symlink (for example /app -> /srv/brain), so containment is always checked
// against the real path rather than the configured one.
let realRootCache = null;
function realRoot() {
  if (realRootCache) return realRootCache;
  try { realRootCache = fs.realpathSync(ROOT); } catch { realRootCache = ROOT; }
  return realRootCache;
}
const PUBLIC_DIRS = new Set(['css', 'js', 'icons']);
const PUBLIC_FILES = new Set(['index.html', 'manifest.webmanifest', 'sw.js', 'favicon.ico']);
const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
}));
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg)/;
const MAX_COMPRESS_BYTES = 2 * 1024 * 1024;

/**
 * Content-Security-Policy mirrors the meta tag in index.html. Headers add the
 * directives a meta tag cannot express (frame-ancestors) and can allow an
 * operator-chosen Instagram exchange origin.
 */
export function contentSecurityPolicy(publicOrigin = '') {
  const connect = ["'self'", 'https://graph.facebook.com', 'https://*.facebook.com', 'https://*.supabase.co', 'https://*.amazonaws.com', 'https://*.r2.cloudflarestorage.com'];
  if (publicOrigin) {
    try { connect.push(new URL(publicOrigin).origin); } catch { /* ignore malformed */ }
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    `connect-src ${connect.join(' ')}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://www.facebook.com",
    "frame-ancestors 'none'",
    "worker-src 'self'",
    "manifest-src 'self'"
  ].join('; ');
}

export function securityHeaders(publicOrigin = '') {
  return {
    'Content-Security-Policy': contentSecurityPolicy(publicOrigin),
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(self), payment=(), usb=(), serial=(), midi=()',
    'Origin-Agent-Cluster': '?1'
  };
}

// Paths that describe the deployed tree rather than an app route. They must
// 404 instead of falling back to the shell, so a directory can never be served
// as a document and internal names cannot be probed through the rewrite.
const RESERVED_SEGMENTS = new Set(['server', 'test', 'node_modules', 'docs', 'scripts', 'package.json']);

function isFilesystemPath(urlPath) {
  const clean = String(urlPath || '/');
  if (clean.endsWith('/') && clean !== '/') return true;
  const first = clean.split('/').filter(Boolean)[0] || '';
  return PUBLIC_DIRS.has(first) || PUBLIC_FILES.has(first) || RESERVED_SEGMENTS.has(first);
}

function cacheControl(relativePath) {
  if (relativePath === 'sw.js' || relativePath === 'index.html' || relativePath === 'manifest.webmanifest') {
    // Never let a browser or CDN pin the shell or the worker: that would strand
    // users on an old release.
    return 'no-cache, must-revalidate';
  }
  return 'public, max-age=300, must-revalidate';
}

/** Resolve a URL path to a file inside the allowed public surface, or null. */
export function resolvePublicPath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(String(urlPath || '/')); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const normalized = path.posix.normalize(decoded.replace(/\\/g, '/'));
  if (normalized.includes('..')) return null;
  const relative = normalized.replace(/^\/+/, '');
  if (!relative) return { file: path.join(ROOT, 'index.html'), relativePath: 'index.html' };
  const segments = relative.split('/');
  if (segments.length === 1) {
    if (!PUBLIC_FILES.has(relative)) return null;
    // Always return an absolute path: resolution must not depend on the
    // process working directory.
    return { file: path.join(ROOT, relative), relativePath: relative };
  }
  if (!PUBLIC_DIRS.has(segments[0])) return null;
  // Directories may contain only plain asset names: no dotfiles, no nesting
  // beyond js/instagram/ and friends.
  if (segments.some(segment => !segment || segment.startsWith('.'))) return null;
  if (!segments.every(segment => /^[A-Za-z0-9._-]+$/.test(segment))) return null;
  const absolute = path.join(ROOT, ...segments);
  const expectedPrefix = path.join(ROOT, segments[0]) + path.sep;
  if (!absolute.startsWith(expectedPrefix)) return null;
  return { file: absolute, relativePath: relative };
}

/**
 * Resolve a candidate file to its canonical path and prove that it is still a
 * regular file inside the public surface.
 *
 * `resolvePublicPath` is a lexical check on the URL; it cannot see symlinks. A
 * link inside js/ pointing at ../package.json or outside the deployment would
 * otherwise be read and served. realpath() collapses every link, and the final
 * path is re-validated against the canonical root plus the same public
 * allowlist. Ordinary in-tree symlinks (js/x.js -> js/app.js) still work.
 *
 * Returns null for anything that escapes, is missing, is a directory, or cannot
 * be resolved.
 */
export async function canonicalPublicFile(file) {
  if (typeof file !== 'string' || !file) return null;
  let real;
  try { real = await fsp.realpath(file); } catch { return null; }
  const root = realRoot();
  const relative = path.relative(root, real);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return null;
  const segments = relative.split(path.sep);
  if (segments.some(segment => !segment || segment.startsWith('.'))) return null;
  const allowed = segments.length === 1
    ? PUBLIC_FILES.has(relative)
    : PUBLIC_DIRS.has(segments[0]);
  if (!allowed) return null;
  let stat;
  try { stat = await fsp.stat(real); } catch { return null; }
  if (!stat.isFile()) return null;
  return { file: real, relativePath: relative.split(path.sep).join('/'), stat };
}

function etagFor(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

async function sendFile(req, res, target, headers) {
  // Canonicalise before touching the file: this is the containment boundary.
  const canonical = await canonicalPublicFile(target.file);
  if (!canonical) return sendStatus(res, 404, headers);
  const { stat } = canonical;
  if (target.relativePath !== canonical.relativePath) {
    // A symlink resolved to a different public path; cache and MIME decisions
    // must describe the file actually being served.
    target = { file: canonical.file, relativePath: canonical.relativePath };
  }
  const etag = etagFor(stat);
  const baseHeaders = {
    ...headers,
    'Content-Type': MIME.get(path.extname(target.file).toLowerCase()) || 'application/octet-stream',
    'ETag': etag,
    'Cache-Control': cacheControl(target.relativePath),
    'Last-Modified': new Date(stat.mtimeMs).toUTCString()
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, baseHeaders);
    res.end();
    return;
  }
  const supportsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const compressible = COMPRESSIBLE.test(baseHeaders['Content-Type']) && stat.size <= MAX_COMPRESS_BYTES;
  if (req.method === 'HEAD') {
    res.writeHead(200, { ...baseHeaders, 'Content-Length': String(stat.size), ...(compressible ? { Vary: 'Accept-Encoding' } : {}) });
    res.end();
    return;
  }
  let body;
  try { body = await fsp.readFile(target.file); }
  catch { return sendStatus(res, 404, headers); }
  if (supportsGzip && compressible) {
    const compressed = zlib.gzipSync(body);
    res.writeHead(200, { ...baseHeaders, 'Content-Encoding': 'gzip', 'Content-Length': String(compressed.length), Vary: 'Accept-Encoding' });
    res.end(compressed);
    return;
  }
  res.writeHead(200, { ...baseHeaders, 'Content-Length': String(body.length), ...(compressible ? { Vary: 'Accept-Encoding' } : {}) });
  res.end(body);
}

function sendStatus(res, status, headers, body = '') {
  const payload = body || (status === 404 ? 'Not found' : status === 405 ? 'Method not allowed' : '');
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(payload))
  });
  res.end(payload);
}

export function createServer({ publicOrigin = process.env.BRAIN_PUBLIC_ORIGIN || '' } = {}) {
  const headers = securityHeaders(publicOrigin);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, app: 'brain' }));
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        sendStatus(res, 405, headers);
        return;
      }
      // A navigation deep-link (for example /auth/instagram/callback) serves the
      // app shell; the client parses the query string and cleans the URL.
      const target = resolvePublicPath(url.pathname) || (
        !path.posix.extname(url.pathname) && !isFilesystemPath(url.pathname) ? resolvePublicPath('/index.html') : null
      );
      if (!target) return sendStatus(res, 404, headers);
      await sendFile(req, res, target, headers);
    } catch (error) {
      console.error('Static server error:', error && error.message ? error.message : error);
      if (!res.headersSent) sendStatus(res, 500, headers);
      else res.end();
    }
  });
}

const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  const port = Number(process.env.PORT) || 8000;
  const host = process.env.HOST || '0.0.0.0';
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`Brain static server listening on http://${host}:${port} (root ${ROOT})`);
  });
  const shutdown = signal => {
    console.log(`Received ${signal}, closing server…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export const __test = { resolvePublicPath, canonicalPublicFile, realRoot, isFilesystemPath, cacheControl, MIME, PUBLIC_FILES, PUBLIC_DIRS };
