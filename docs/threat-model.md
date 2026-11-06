# Threat Model — Brain v2.3.0

**Scope:** Static PWA `brain/` + minimal stateless exchange `brain/server/instagram-exchange.js`. Personal data (`task, reminder, note, person, money, debt, stockItem, habit, journal, event, photo, instagramDraft/ Publication`) is IndexedDB-only. External traffic is limited to: (1) `GET` app shell from hosting origin, (2) Meta Graph `graph.facebook.com v26.0` after explicit publish, (3) your exchange host for OAuth. No analytics, fonts, error-reporters, or background telemetry.

**Assumptions:** Browser enforces same-origin, `crypto.subtle`, IDB; OS protects hosting; presigned URL lifetime is yours to set; extensions can read DOM but cannot bypass explicit-publish tap.

## Trust boundaries

| Boundary | Trusted side | Untrusted side |
|----------|--------------|----------------|
| UI ↔ Store | Store sanitizes everything (`validate.js`). UI uses `textContent`/`E.div`. | All user input, imported backups, captions/hashtags, photo payloads. |
| Store ↔ IndexedDB / backup file | Sanitized snapshots. | Corrupt records, quota-full, future-schema, malicious JSON/enc blobs, Oversized 25 MB. |
| Browser ↔ Exchange | Exchange holds `FACEBOOK_APP_SECRET`, validates `ALLOWED_REDIRECT_URI/ORIGINS`. | Network, client token, injected App ID. |
| Client ↔ Meta | Meta Graph over TLS. | Meta responses (treat as opaque data; never `innerHTML`). |
| SW ↔ Cache | Same-origin precache 41 assets only. | Old `brain-*` caches, network responses. |
| Automation rule ↔ Queue | `isEligibleForAutomation` + `processQueue` re-validation. | Drafts not in `eligibleDraftIds`, paused/disabled rules. |

## Threats & mitigations

| Threat | Mitigation (implemented) | Limitation |
|--------|--------------------------|------------|
| **Stored XSS (caption/notes/etc.)** | `validate.js` `cleanText(8000)`, `cleanCaption(2200)`, `cleanHashtags(30×80)`, `cleanMoney`… strip control chars; rendering via `textContent` / `E.*` DSL, zero `innerHTML` with user data (sweep: `grep -r innerHTML brain/js` → only static `coverPicker.wrap` template + now DOM-safe `setPreviewImage`); photo `isSafeImageDataUrl` MIME+header. | If a future editor uses `innerHTML`, `security.test.js` fails (`/no innerHTML with user data/`). |
| **DOM XSS (coverPicker)** | Former `preview.innerHTML="<img src=${dataUrl}>"` fixed → `createElement('img').src=dataUrl`. Static `wrap.innerHTML` contains no interpolation. | Disclose: `wrap.innerHTML` static template remains (audited, no `${}`). |
| **CSRF on OAuth** | `state` 32 B `crypto.getRandomValues` + `Date.now` prefix → `sessionStorage brain:instagram:oauth_state/_ts`, format `^[a-z0-9]+-[0-9a-f]{64}$`, 10-min expiry + clock-skew -1 s, single-use (cleared even on format fail), mismatch → `OAuth state mismatch — possible CSRF`. `validateCallbackParams` checks `code ^[A-Za-z0-9._-]{10,500}$`, known `error` allowlist. | State in `sessionStorage` — shared across same tab; attacker with tab access could read it (same-origin assumption). |
| **Code interception** | Strict `ALLOWED_REDIRECT_URI` on exchange (403 if not allowlisted), exchange validates `code+redirect_uri`, posts to `graph/v26.0/oauth/access_token` with `client_secret` server-side; `state` timestamp check; PKCE-like (not PKCE, but single-use). | Exchange CORS `ALLOWED_ORIGINS`; open CORS if unset (disclosed). |
| **Token theft** | Token in IDB only (`settings.instagram.accessToken`); UI warns browser storage ≠ vault; exchange returns long-lived (60 d) and CORS-limited; revoke `DELETE /{user}/permissions?access_token` + local `buildDisconnectedConnection` (always runs); CSP `connect-src` limited; backup includes token only if user exports plaintext (recommend encrypted). `isTokenExpired` 5-min buffer, `needesRefresh <24h`. | Any XSS would read IDB — hence XSS defenses are critical. Use encrypted backup for portability. |
| **Malicious extension** | DOM-read risk accepted; publish still needs explicit tap (no background) + `canTransition` + `eligibleDraftIds` allowlist; attacker cannot forge container without token; `EMERGENCY_STOP` per-tab flag. | Cannot defend against extension that automates clicks — disclosed. |
| **Dependency compromise** | Runtime **0 npm deps**; dev-only `fake-indexeddb`, `jsdom` not bundled; `npm audit` in CI shows 2 HIGH dev-only `undici` (not shipped); `package-lock.json` pinned; SW pins same-origin. | Supply chain of dev deps still trusted. |
| **SW compromise** | SW caches only same-origin `GET`; `install` explicit `ASSETS` list 41; `activate` deletes only `brain-*`; no `importScripts` CDN. | If hosting origin is compromised, SW is compromised. |
| **DB manipulation** | `init()` `_sanitizeAll` per collection, dedup `ids.has`, drop `photo!dataUrl`, repair journal→photo `null`, `corruptionReport.issues` (read fail / non-array / removed count / future schema / migration backup fail), migration backup `backup:pre-migration:*` before write, `MAX_RECORDS 10k`. | Future schema shows warning, not auto-downgrade. |
| **Malicious backup** | `previewImport` rejects `app!=='brain'`, `MAX_BACKUP_CHARS 25 MB` before parse, `sanitizeRecord` per item (unknown key drop, fingerprint dedup), encrypted requires password + GCM tag auth, `invalid`/`errors` reported, `replaceAll` rollback on throw. | Malicious photo `dataUrl` with valid header but exploit payload is still sanitized to bounded JPEG — not executed. |
| **Unauthorized automation** | `MANUAL` default; `AUTOMATED` needs `enabled && mode AUTOMATED && !paused && rule.enabled` + `isEligibleForAutomation` (status READY/AWAITING/SCHEDULED, explicit `eligibleDraftIds` or tag/pattern with window, allowedDays/Hours); `processQueue` re-validates; pause immediate each cycle; `availableActions` hides Instagram publish when not connected. | Rules can still publish wrong video if you tick it — you explicitly allowlisted it. |
| **Duplicate/replay publish** | `isDuplicatePublish` (PUBLISHED/UPLOADING/PROCESSING + legacy `publishing`), `PUBLISHED` lock `UPLOADING→PROCESSING` before network, debounce 3 s `createPublishGuard`, `retryCount` history, `isContainerExpired 24h-5m`, `checkRateLimit 25/5` defer 30 m, queue `MAX 100`, fencing `leaseToken` random + `renewLease` + `recoverStaleJobs 5m` + atomic claim+duplicateCount rollback. | If Meta accepts but network drops, reconciliation requires user retry after checking permalink — no silent double-publish. |
| **Malicious media** | `validateFileBasics` (MIME whitelist `video/mp4, video/quicktime, video/mov, video/x-m4v`, ext `mp4|mov|m4v|quicktime`, size ≤1 GB / warn 250 MB, 0-byte reject), `probeVideoMetadata` (15 s timeout, duration 3–900, <320×480 warn, portrait prefer, header check), `coverDataUrl` `isSafeImageDataUrl`. | Probe needs `HTMLVideoElement.createObjectURL`; falls back to basic-only in test. |
| **Temp URL leak** | Stored only `instagramDraft.tempVideoUrl`, sent only to `graph.facebook.com`; UI shows exact URL; `isPrivateUrl` heuristic (`x-amz-signature|signature|sv|sig|token|expiry|expires` or search>20), `shouldCleanupVideoUrl` deletes after publish or 48 h stale, exchange streams without log, `console.log private` sweep 0. | Network: Meta receives URL by design; use short presigned expiry. |

## CSP (from `brain/index.html:12`)

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline'   /* app.css only, no external */
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

## Audit & lifecycle

- Every publish/automation writes history: `{at, action:"queued/publish_attempt/publish_failed/published", fromStatus, details, actor, containerId, mediaId}` + `automation.history[200]`.
- Diagnostics panel (`diagnostics.js`) shows storageMode/isPersistent, corruptionReport, migration, failed ops, health, redacted copy (token → `••••`).
- Disconnect: confirm → `revokePermissions(best-effort)` → `buildDisconnectedConnection()` → `updateSettings` → audit entry. Token cleared even if revoke network fails.
- Release gate: `npm test` includes `security.test.js` (8 tests: XSS, CSP, state format) + `threat-model.md` disclosure.

See [`privacy-audit.md`](privacy-audit.md) for data that actually leaves device, [`instagram-integration.md`](instagram-integration.md) for OAuth contract.
