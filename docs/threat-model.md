# Threat Model — Brain v2.3.0 (K)

**Scope:** Browser PWA + minimal token-exchange service. Personal data (tasks, notes, people, journal, photos) is local-only. External traffic is limited to: (1) app shell fetch, (2) Meta Graph API via explicit user approval, (3) optional exchange service. No analytics, fonts, or error reporters.

## Trust boundaries
| Boundary | Trusted | Untrusted |
|----------|---------|-----------|
| UI ↔ Store | Store sanitizes; UI uses textContent | All user input, imported backups, captions, notes |
| Browser ↔ Exchange service | Exchange holds APP_SECRET, validates redirect | Network, client token |
| Client ↔ Meta | Meta Graph API over TLS, OAuth | Meta responses (treat as data) |
| Service Worker ↔ Cache | Same-origin precache only | Old caches, network responses |
| Backup file ↔ Import | Preview + sanitize before merge | Malicious JSON, encrypted blobs |

**Assumptions:** Browser provides same-origin isolation, WebCrypto, secure IndexedDB; OS protects file hosting for video_url; user controls presigned URL lifetime; extensions may read DOM but cannot bypass explicit publish tap.

## Threats & mitigations
- **XSS stored/reflected/DOM:** All input sanitized in validate.js (cleanText 8000, cleanCaption 2200, cleanHashtags 30×80, videoName 260, etc). Rendering uses `nodes` builder + `textContent`/`escHtml`; no `innerHTML` with user data. CSP below blocks inline scripts. Media files validated by MIME+header (isSafeImageDataUrl, validateFileBasics).
- **CSRF:** OAuth state is 32-byte `crypto.getRandomValues` + timestamp, stored in sessionStorage, 10-min expiry, single-use, validated before exchange; `validateState` clears on failure to prevent replay.
- **Code interception:** Strict `redirect_uri` allowlist on server; code → token exchange only via POST JSON to configured exchangeEndpoint; no APP_SECRET in client, logs, or repo; `state` mismatch rejected; PKCE-like timestamp check.
- **Token theft:** Token in IndexedDB only; warning that browser storage ≠ vault; exchange service holds secret and returns long-lived token; backup includes token only if user exports (recommend encrypted backup); service uses CORS allowlist; revoke via `DELETE /{user}/permissions` + local wipe; CSP `connect-src` limited.
- **Malicious extensions:** DOM read risk accepted; publish still requires explicit tap (no background auto) and per-rule allowlist; extensions cannot forge Meta container without token.
- **Dependency compromise:** `fake-indexeddb`/`jsdom` dev-only; runtime has zero npm deps; `npm audit` in CI; lockfile checked; SW precache pinned to same-origin.
- **SW compromise:** SW only caches same-origin GET; `install` caches explicit ASSETS list; `activate` deletes only `brain-*` caches; no importScripts from CDN.
- **DB manipulation:** All collections sanitized on load (`_sanitizeAll`), invalid photo dropped, duplicate IDs skipped, fingerprint dedup on merge, journal→photo referential repair; migrations backup `backup:pre-migration:*` before write.
- **Malicious backups:** `previewImport` rejects non-brain, oversized (>25 MB), malformed, duplicate IDs, invalid photo headers; `sanitizeRecord` drops unknown keys; encrypted backups require password and fail-closed on bad tag.
- **Unauthorized automation:** Mode is MANUAL by default; AUTOMATED requires explicit enable + at least one rule with `eligibleDraftIds` or tag/pattern; `isEligibleForAutomation` checks every filter; `processQueue` re-validates at execution; pause is immediate (checked each cycle).
- **Replay/duplicate publish:** `isDuplicatePublish` blocks PUBLISHED/UPLOADING/PROCESSING; publish sets `status=UPLOADING` atomically before network; `containerId` persisted; rate limits (configurable 25/day, 5/hour) checked; idempotency via status lock + retryCount.
- **Malicious media:** validateFileBasics (MIME whitelist, 250 MB client cap, 0-byte reject), probeVideoMetadata (duration 3–900s, resolution, aspect), coverDataUrl must pass isSafeImageDataUrl.
- **Temporary URL leak:** URLs stored only in draft, sent only to Graph; UI shows URL being sent; deletion after publish/48h; private URL detection helper; exchange proxy streams without disk/log; never console.log URLs.

## Audit & revocation
- Every publish/automation records history entry (`at, action, fromStatus, details, actor, containerId, mediaId`).
- Disconnect: confirm dialog → `revokePermissions` (best-effort) → `buildDisconnectedConnection` → `updateSettings` → toast → audit history entry; token cleared even if revoke fails.
- Security regression tests in `test/security.test.js`.

## CSP (index.html)
```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline'  /* app.css only, no external */
img-src 'self' data: blob: https:;
media-src 'self' blob: https:;
connect-src 'self' https://graph.facebook.com https://*.facebook.com https://*.supabase.co https://*.amazonaws.com https://*.r2.cloudflarestorage.com;
font-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self' https://www.facebook.com;
frame-ancestors 'none';
worker-src 'self';
```
Secrets never in meta/frontend; server checks authorization.
