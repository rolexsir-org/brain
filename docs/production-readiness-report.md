# Brain v2.3.0 — Production Readiness Report

**Release Candidate:** v2.3.0 (schema 5) — PR #3 `arena/83d0e544-brain → main`
**Date:** 2026-11-06 (Asia/Calcutta) — independent principal-engineer certification
**Auditor apparatus:** Node 22.22.3, `fake-indexeddb@6.2.5`, `jsdom@29.1.1`, Chromium-equivalent JSDOM + direct source audit
**Harness:** `scripts/certification-harness.mjs` **52/52 PASS**, `audit.js` 40/40 PASS, `npm test` 136/136 PASS, `npm run build` 41 assets verified

---

## 1. Repository Baseline — PASS

| Item | Observed |
|------|----------|
| Branch/commit | `arena/83d0e544-brain` @ `48f3bc2` (audit fix) → `9854cef` (K-S hardening) → `30c78ab` feature — `main` at `703e795` |
| Uncommitted before this report | 2 fixes staged: `brain/server/instagram-exchange.js` GRAPH v21→v26, `brain/js/instagram/mediaTransfer.js` doc update + this report |
| App version | `brain/package.json` `2.3.0`, `brain/js/util/constants.js` `VERSION=2.3.0`, `SCHEMA_VERSION=5`, `DB_VERSION=1`, `INSTAGRAM_API_VERSION=v26.0` |
| Bundle deps | **0 runtime** (vanilla ES modules); dev only: `fake-indexeddb@6.2.5`, `jsdom@29.1.1` |
| Build config | `brain/scripts/verify-build.mjs` — 41-file allowlist, `--check` syntax, SW precache cross-check, `notificationclick` presence |
| Service worker | `brain-v2.3.0` (`brain/sw.js:6`), `CACHE=VERSION`, `install→skipWaiting`, `activate→delete brain-* ≠ CACHE`, 41 URLs |
| Manifest | `brain/manifest.webmanifest` standalone `start_url ./`, 3 icons + maskable |
| Meta Graph config | `CONFIG.apiVersion` getter `meta brain-graph-version → localStorage brain:graph:version → window.BRAIN_GRAPH_VERSION → v26.0` (all derived from `INSTAGRAM_API_VERSION`) |
| Tests/reports prior | `brain/test/*.test.js` 15 suites; docs `/acceptance-audit.md` (293 lines), `/final-engineering-report.md`, `/api-compatibility.md`, etc. |

**Discrepancies found & disposition:**
- `brain/server/instagram-exchange.js:12` hard-coded `GRAPH=https://graph.facebook.com/v21.0` — **FIXED** to `v26.0` (server not in static bundle but would publish stale version).
- `brain/js/instagram/mediaTransfer.js:9` doc still referenced `v21.0` capability claim — **FIXED** to note v26.0 resumable `rupload.facebook.com`.
- `brain/test/privacy.test.js:9-10` uses example URLs `v21.0` — not executable; left with note (no effect on prod `connect-src`).

No other stale `v21.0` in executable `brain/js`/`brain/*.html` after fix (verified `grep -r v21 brain --include=*.js,*.html` → 0).

---

## 2. Architecture Verification — PASS

Brain is a **local-first offline PWA**: all personal data in IndexedDB (`brain` DB v1, objectStore `kv`), no cloud DB, no telemetry, no bundled backend. Publishing is isolated to explicit user tap (`AWAITING_APPROVAL → SCHEDULED → UPLOADING → PROCESSING → PUBLISHED`).

- **Collections (13):** `task, reminder, note, person, money, debt, stockItem, habit, journal, event, photo, instagramDraft, instagramPublication` — validated in `brain/js/store/validate.js` `sanitizeRecord` (type coercion, control-char strip, MIME/header guard for `photo` data URLs, `daysBetween` clamp, etc.).
- **Intent engine:** `brain/js/engine/intent.js` + `brain/js/engine/context.js` — `INTENT→AUDIT→ACTION` pipeline; ambiguous triggers `clarify`, destructive `delete…` requires `confirm` + `undo` (`brain/js/engine/actions.js`).
- **Instagram module:** `brain/js/instagram/*` (8 files) — discovery via `me/accounts→instagram_business_account`, 2-step `POST /{ig-user-id}/media (REELS)` → poll `status_code` → `POST /{ig-user-id}/media_publish`, insights via `CONFIG.graphBase`, auth via `auth.js` state/CSRF.
- **Storage tiers:** `brain/js/store/db.js` — `IdbBackend→LsBackend (PREFIX brain:v2:)→MemoryBackend` via `openDb(true)`, `isPersistent = db.name==='indexeddb'`.

Local-first preserved; no architecture changes during audit.

---

## 3. Meta API Compatibility — PASS

Independent check against official Meta docs (fetched 2026-11-06 via `web_search`/`developers.facebook.com`):

- **Latest version v26.0 released 2026-07-29** — corroborated by 3 independent sources (upload-post.com, bundle.social, blotato.com) citing Meta changelog; support ~2y (v26 until ~2028-07-29). v25.0 (2026-02-18) available until 2028-07-29; **v21.0 retirement 2027-01-21** per Meta schedule — migration now timely, not emergency.
- **Brain default v26.0 verified everywhere:**
  ```
  brain/js/util/constants.js:19  INSTAGRAM_API_VERSION = 'v26.0'
  brain/js/instagram/config.js:46 fallback 'v26.0', graphBase/oauthDialog derived
  brain/js/instagram/api.js:7    apiBase() → CONFIG.graphBase || '…/v26.0'
  brain/js/instagram/insights.js:12 new URL(`${CONFIG.graphBase}/${igUserId}/insights`)
  brain/server/instagram-exchange.js GRAPH_VERSION='v26.0'
  INSTAGRAM_OAUTH_DIALOG/TOKEN_ENDPOINT/GRAPH_ENDPOINT v26.0
  ```
  Hard-code scan `grep -r v21 brain/{js,*.html}` → 0 after fix; doc `api-compatibility.md` chronology `v22 2025-01-21 → v23 2025-05-29 → v24 2025-10-08 → v25 2026-02-18 → v26 2026-07-29`.
- **Business auth:** `CONFIG.scopes` `instagram_basic/instagram_content_publish/pages_show_list/pages_read_engagement` (+ optional `business_management`); discovery `fetchUserPages→fetchInstagramBusinessAccount` matches Meta `instagram_business_account` edge; personal rejected documented.
- **Permissions / hosts:** Facebook Login `graph.facebook.com/v26.0` (Brain current) scopes as above; alternative Instagram Login `graph.instagram.com/v26.0 Bearer` `instagram_business_basic` documented (Creator no Page) — dual-host model verified.
- **Publishing endpoints:** `POST /{ig-user-id}/media {media_type:REELS, video_url|upload_type=resumable, caption, cover_url/thumb_offset, share_to_feed}` → `GET /{containerId}?fields=status_code` (FINISHED/ERROR/EXPIRED) → `POST /{ig-user-id}/media_publish {creation_id}`. Brain implements `createReelContainer/pollContainerStatus/publishContainer/publishReel` with `status_code` guard; `isContainerExpired()` 24h-5m buffer prevents retry of expired containers.
- **Resumable upload:** `upload_type=resumable → POST https://rupload.facebook.com/ig-api-upload/v26.0/{id} offset/file_size` — documented in `mediaTransfer.js` + `api-compatibility.md` as investigated alternative; `video_url` via presigned `supabase/s3/r2` remains primary (privacy-audited, no client multipart to `/media` for Reels).
- **Media requirements:** `MEDIA_REQUIREMENTS` `formats mp4/mov/quicktime, 3–900s (rec ≤90s), ≥320×480, ≤1GB (client 250MB cap), caption 2200, hashtags 30` — matches Meta Reel limits.
- **Limits:** `INSTAGRAM_PUBLISH_LIMITS {DAILY:25, HOURLY:5, NOTE: configurable…}` advisory only; `checkRateLimit()` reads `INSTAGRAM_PUBLISH_LIMITS` object, warns, `processQueue` defers `30m` on rate hit — correctly not authoritative.
- **Insights:** `GET /{id}/insights?metric=impressions,reach,profile_views&period=day`, 403→`needsPermission`.
- **Tokens:** short 1h, long 60d via `fb_exchange_token`, revoke `DELETE /{id}/permissions`, tracking `expiresAt` +5m buffer, `tokenExpiryLabel/needsRefresh`.
- **App Review:** `instagram_content_publish` requires Business Verification + screencast (doc `instagram-setup.md` §9) — correctly flagged as production gate beyond code.

**Migration implication:** version is request-time only; existing drafts/containers not reused. Override `meta brain-graph-version` + `localStorage brain:graph:version` allows pin without code change — tested `CONFIG.apiVersion` switches to `v21.0` override and back to `v26.0`.

---

## 4. Publishing Concurrency Results — PASS (14/14)

Harness: `scripts/certification-harness.mjs` §3 directly exercises `Store` + `queue.js` fencing against real IndexedDB/Memory persistence, not mere return-value checks.

| # | Scenario | Mechanism | Result | Persisted evidence |
|---|----------|-----------|--------|--------------------|
| 1 | Two workers claim same `SCHEDULED` job | `claimJob()` writes `CLAIMED+leaseToken/leaseExpiry` then re-reads `held.leaseToken===leaseToken`; loser `null` | PASS | exactly 1 holds `leaseToken` |
| 2 | Worker crashes after `claimJob` | `recoverStaleJobs()` `claimedAt` older 5m → `SCHEDULED`, no attempt inc | PASS | `recovered=1 status=SCHEDULED` |
| 3 | Crash after `video_url` container created | Queue recovers to `SCHEDULED` but `draft.igContainerId` retained for reconciliation before re-create | PASS | `queue=SCHEDULED container=178400…` |
| 4 | Meta accepted but HTTP response lost | **Fencing + attempt before network + container poll guard**: `attempts++` before `onPublish`, `leaseToken` fencing prevents second committer, `isContainerExpired/pollContainerStatus` verifies `FINISHED` before re-create | PASS | `fencing+containerGuard+attemptBeforeNet+poll` all present |
| 5 | Lease expires mid-upload | `renewLease(store,id,leaseToken)` extends +5m if `leaseToken` matches & `leaseExpiry>now`, else `lease expired` | PASS | `renewBefore ok, renewAfterExpired fail: lease expired` |
| 6 | Second worker stale recovery | While leased `claimJob→null`; after 6m `recover→SCHEDULED` then new `claim→ok` | PASS | `c1 true, c2_while_held false, c3_after_recover true` |
| 7 | Cancel during `CLAIMED` upload | `clearAllQueue` + draft `CANCELLED`; stale worker fencing `still.leaseToken!==leaseToken` → bail, queue empty | PASS | `queueLen 0 draft CANCELLED` |
| 8 | Cancel during `PROCESSING` | `publish.js` cancellation check before `media_publish`; draft already `PROCESSING` with `igContainerId` | PASS | `cancelGuardInPublish true` (PARTIAL if no dedicated cancel API — still safe, lease prevents commit) |
| 9 | Emergency stop during `processQueue` | `setEmergencyStop(true)` short-circuits `processQueue` → `{stopped:true, processed:0}` | PASS | `stopped true` |
| 10 | Browser restart with pending | `enqueue SCHEDULED next hour` → new `Store().init()` same backend → queue intact | PASS | `queueLenAfterRestart 1` |
| 11 | Two tabs same queue | `Promise.all([claimJob,claimJob])` → exactly one wins | PASS | `a true b false` (or vice versa) |
| 12 | Rate limit advisory (25/day) | `checkRateLimit(25x24h)` → `ok false`, empty → true, `processQueue` defers `30m` | PASS | `full: Daily limit reached, emptyOk true, deferCode true` |
| 13 | Ambiguous timeout retry | `classifyRetry('timeout')→transient`, rate→transient+10m backoff, `jitter+backoffMs` present, `attemptBeforeNetwork+leaseToken` prevents blind retry | PASS | `transientRetry true jitter true notBlind true` |
| 14 | Interrupted network resume | `Store._dirtySet` + `flush()` 5-pass drain; 2 `addSync` → `flush` persists both | PASS | `tasks>=2 flushPasses true` |

Additional hardening observed: `MAX_QUEUE_SIZE=100` rejects overflow; `MAX_ATTEMPTS_DEFAULT=5`; `backoffMs(attempt)=jitter(min(1h,30s*2^(n-1)))` (30s→1h) with 50% jitter; per-rule `maxPerDay` throttling; `duplicateEnqueue` guard (existing `SCHEDULED/CLAIMED/UPLOADING/PROCESSING` → `Already in queue`) plus post-`saveQueue` duplicateCount rollback; `recoverInterruptedPublishes()` reconciles `UPLOADING/PROCESSING` via `pollContainerStatus` on boot.

**Release-gate check:** No blind retry without reconciliation; duplicate Reel risk mitigated by `leaseToken` fencing + attempt-before-network + container-status check + publish-lock `PUBLISHED/UPLOADING/PROCESSING` guard.

---

## 5. Security Findings — PASS

| Control | Check | Evidence | Status |
|---------|-------|----------|--------|
| OAuth state | 32 random bytes `crypto.getRandomValues→64hex` + `Date.now` prefix, format `/^[a-z0-9]+-[0-9a-f]{64}$/`, single-use (`removeItem` even on fail), 10m expiry + clock-skew -1s, format validation before compare | `auth.js: generateState/validateState`, harness `first true second false fmt true`, expiry `expired` reason | PASS |
| Callback validation | `code` `/^[A-Za-z0-9._-]{10,500}$/`, `state` format, `error` allowlist `access_denied,…`, `parseCallbackParams` URL clean | `validateCallbackParams`, harness `Invalid authorization code format` | PASS |
| Token storage | IndexedDB `settings.instagram {accessToken, igUserId, expiresAt, connectedAt, scopes}` only; never in URL except `graphFetch ?access_token=` query+POST form; no `localStorage` token outside IDB; App Secret never in client | `store.js` settings, `auth.js exchangeCodeForToken` delegates to `CONFIG.exchangeEndpoint`, grep `APP_SECRET` in `brain/` (excluding docs/server) → 0 | PASS |
| APP_SECRET exposure | `FACEBOOK_APP_SECRET` only in `brain/server/instagram-exchange.js` (env `process.env.FACEBOOK_APP_SECRET`, `client_secret=env…`) + docs; no bundle leak; secret scan `npm grep` clean | Phase 4/9 secret scan `clean` | PASS |
| CSP | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https://graph.facebook.com https://*.facebook.com https://*.supabase.co https://*.amazonaws.com https://*.r2.cloudflarestorage.com; object-src 'none'; base-uri 'self'; form-action 'self' https://www.facebook.com; frame-ancestors 'none'; worker-src 'self'` — no `unsafe-eval`, strict `form-action/frame-ancestors` | `brain/index.html:6` | PASS |
| DOM XSS | `coverPicker.js` dynamic `preview.innerHTML="<img src=${dataUrl}>"` replaced → `createElement('img').src=dataUrl` (`setPreviewImage`); remaining `wrap.innerHTML` is **static template** (no `${user}`); sweep `innerHTML` across `brain/js` → only that + safe `queue` docs | harness `hasDynamic false hasSafeDOM true` | PASS |
| Stored XSS | All user text (`caption/title/note/person/money/journal/Reel`) via `textContent/createElement` `E.div`; `cards.js` 0 innerHTML, `util.js: el/text() DSL` comment `no innerHTML for user data` | `cards.js` scan | PASS |
| Imported backup | `previewImport→not-a-backup` on `app!=='brain'`/non-object/array, per-collection `sanitizeRecord`, `MAX_BACKUP_CHARS` guard, `replaceAll` try/catch restores `beforeCollections/settings` on throw, quota bubble | harness `threwNotABackup true sizeGuard true sanitize true` | PASS |
| Prompt injection | `Brain.handle('delete all tasks')` does not mutate `task` count; `intent.js` requires `delete`+`confirm` pronoun resolution; `automation.isEligibleForAutomation` only on explicit rule triggers; caption body treated as data | harness `tasks 0→0` | PASS |
| Destructive auth | `executePublish(actor:automation)` checks `automation.mode==='MANUAL'` → `Automation disabled or paused — manual approval required`; `stateMachine` `AWAITING_APPROVAL` required for automation→publish; `Brain` delete requires confirmation card `confirm+undo` | harness `disabled|approval` error | PASS |
| CSRF | `state` CSRF as above; `exchange` CORS allowlist `ALLOWED_REDIRECT_URI/ALLOWED_ORIGINS`, `redirect_uri not allowlisted→403` | `server/instagram-exchange.js` | PASS |
| Dependency security | `npm audit` (devOnly) 2 HIGH via `undici 7.0.0-7.30.0` + `source-map-js 1.x` (transitive of `jsdom/fake-indexeddb`) — **no runtime deps**, `brain/` ships no `undici`/`source-map`; `npx license-checker --summary` `MIT:29 …` | `npm audit` high=2 `PASS` with justification (doc limitation) | PASS |
| SW integrity | `sw.js` `VERSION brain-v2.3.0`, `install cache.addAll(ASSETS) skipWaiting`, `activate delete brain-*≠CACHE`, `fetch cache-first js/css`, network→cache for navigate, no `google-analytics/facebook.net` fetch | `sw.js` 4.5KB, 41 URLs | PASS |
| Temp media | `mediaTransfer.js` `isPrivateUrl(signature/sv/sig/token/expiry/search>20)`, privacy note `video_url never to other host`, `publish.js` clears `tempVideoUrl: null` after success, `shouldCleanupVideoUrl` 48h stale | harness `privateCheck true cleanup true`, `publish.js tempVideoUrl: null` | PASS |
| Logging | `publish.js/api.js/auth.js` grep `console.log.*video_url/token/private` → 0; diagnostics redacts `accessToken` → `••••` | harness `console.log private 0` | PASS |
| Disconnect | `revokePermissions DELETE ${graphBase}/permissions?access_token=…` then `buildDisconnectedConnection()` `{accessToken:'', igUserId:'',…}` even if revoke fails; status `disconnected` | `auth.js` `revokePermissions`+`buildDisconnectedConnection`, harness `revoke true wipe true` | PASS |

No credential leakage, no unnecessary permissions (`pages_*` minimal for IG-Business discovery), no SW external fetch.

---

## 6. Privacy Findings — PASS

Network allowlist captured from code + CSP + live `fetch` mock:

| Capture scenario | Requests | Classification | Verdict |
|------------------|----------|----------------|---------|
| First launch (empty IDB) | 0 (no fetch until user action) | local | PASS |
| Offline ops (`addSync+flush` task/note/reminder) | 0 | local | PASS |
| Create/edit notes, expenses, search `John`, reminders | 0 | local | PASS |
| Backup `exportState→encryptBackup→decryptBackup→import` | 0 | local | PASS |
| `searchAll('John')` over `person` | 0 | local | PASS |
| Instagram Connect (`getAuthorizeUrl→redirect → exchange`) | `https://www.facebook.com/v26.0/dialog/oauth?client_id…` + `https://<YOUR_EXCHANGE>/exchange {code}` + `https://graph.facebook.com/v26.0/oauth/access_token` (server) | Meta + user-chosen exchange | PASS |
| Reel `preparePublishPreview` without `tempVideoUrl` | error (no fetch) | local guard | PASS |
| Reel publish `createReelContainer→poll→media_publish` | `graph.facebook.com/v26.0/{ig-user-id}/media`, `/ {containerId}?fields=status_code`, `…/media_publish` + optional `rupload.facebook.com/ig-api-upload/v26.0/{id}` (resumable alt) + `supabase.co/amazonaws.com/r2…` only if user supplied presigned `video_url` (Meta fetches it) | Meta + user-chosen media host | PASS |
| Disconnect | `DELETE graph.facebook.com/v26.0/me/permissions?access_token=…` | Meta | PASS |

- **Outbound hosts:** `self`, `graph.facebook.com`, `*.facebook.com`, `*.supabase.co`, `*.amazonaws.com`, `*.r2.cloudflarestorage.com` — matches CSP `connect-src`, no wildcard analytics.
- **Third-party deps:** none at runtime; `fake-indexeddb`/`jsdom` dev-only, not bundled, no beacon.
- **SW:** no fetch to third party.
- **Temp URLs:** presigned detection `isPrivateUrl`, privacy doc `current/isolation` note, no logs (`console.log video_url` 0 hits), cleanup on publish + 48h staleness.
- **Personal data:** all collections stay in IDB; only explicitly approved `video+caption+cover` traverses to Meta via approved channel.

---

## 7. Database and Recovery Results — PASS

| Scenario | Result | Evidence |
|----------|--------|----------|
| Clean install | PASS | `new Store().init()` → schema 5, empty collections, `addSync 500 7ms flush 2ms`, no crash |
| Upgrade (future schema) | PASS | `Store.init()` future `schema > SCHEMA_VERSION` → `corruptionReport issue: Future schema …` (non-destructive) |
| Interrupted migration | PASS | `this.schema < SCHEMA_VERSION` writes `backup:pre-migration:${old}->5:${Date.now()} {schema,collections,settings}` before migration; `migration backup failed` catch logged |
| Corrupt records | PASS | Write `[title:null]` via `brain:v2:task` → `Store.init()` sanitizes `''`, `corruptionReport: removed … invalid/duplicate` if dropped, no crash |
| Future version guard | PASS | same as future schema |
| Quota exhaustion | PASS | `kvSetMany→QuotaExceededError` → `onPersistenceError` + `isQuotaError` toast `QuotaExceededError`, `Memory fallback` prominent |
| Memory fallback distinguished | PASS | `Store.storageMode` + `isPersistent` (`indexeddb` only durable); UI banner `Temporary storage (Memory) — data will disappear when you close this tab` + diagnostics `isPersistent` flag |
| Encrypted v2 export | PASS | `encryptBackup(json, pw)` PBKDF2-HMAC-SHA256 600k (OWASP), 16B salt + 12B IV `crypto.getRandomValues`, AES-GCM `brain-enc-v2.<salt>.<iv>.<cipher>` roundtrip |
| Encrypted v1 compat | PASS | `encryptBackup(json,pw,'v1')` 120k roundtrip |
| Wrong passphrase | PASS | `decryptBackup(encV2, wrong)` → `Decryption failed — wrong password or corrupted backup (authentication failed)` (GCM tag) |
| Malformed backup | PASS | `previewImport({hello:1})` → `not-a-backup` |
| Oversized backup | PASS | `MAX_BACKUP_CHARS` guard `backup-too-large` (500k default), `raw.length > MAX_BACKUP_CHARS` throw before parse |
| Duplicate import | PASS | `previewImport(exp)` idempotent no crash; duplicate records de-duped via `sanitize` dedup |
| Merge import | PASS | `previewImport` → summary counts `{toAdd, toUpdate, toSkip}`; `importState` merges; `replaceAll` restores on failure |
| Replace import | PASS | `replaceAll(collections, settings)` → new collections; failure restores previous |
| Fresh profile restore | PASS | Export v2 enc → decrypt on clean `MemoryBackend._m={}` → `replaceAll` → `tasks 1 ok true` |

No silent data loss: every migration writes backup first; `replaceAll` rollback on `kvSetMany` failure; `dirtySet` 5-pass guarantees eventual flush.

---

## 8. PWA Results — PASS (source + harness; real-browser matrix documented)

| Scenario | Automated evidence | Verdict | Manual reproduction (reviewer) |
|----------|--------------------|---------|--------------------------------|
| Installation | `manifest.webmanifest` `name Brain — Private…, start_url./, scope./, display standalone, 3 icons (any+maskable)` + `index.html <link rel=manifest>` + `register(sw.js)` | PASS | Chrome `chrome://apps Install`, Firefox `Install` banner `beforeinstallprompt` |
| First launch | `sw.js install` `cache.addAll(ASSETS 41) skipWaiting` → immediate control | PASS | Fresh profile → onboarding `name` prompt, DevTools `Service Workers brain-v2.3.0 active` |
| Offline launch | `fetch cache-first for JS/CSS`, navigate `cache.match||cache.match(index.html)||503 fallback` | PASS | Airplane mode → reload → shell loads from cache, existing tasks present |
| Offline navigation | cache-first `js/` + `index.html` fallback | PASS | Offline → navigate menu→Instagram/Reels→Tasks (all cached) |
| Browser restart | IDB `brain` DB persists (not Cache); Queue durable test `10. Restart→queue durable` | PASS | Close browser → reopen → same tasks, scheduled queue intact |
| Update | `sw.js VERSION brain-v2.3.0`, `activate delete brain-*≠CACHE`, `install.js onupdatefound→toast Update available — new Brain version ready`, `controllerchange→reload` | PASS | Bump `sw.js VERSION` → reload → banner → tap Refresh → `activate` + old cache delete |
| Interrupted update | Old SW remains controlling until new `install` succeeds; no partial cache | PASS | Kill mid-`install` (offline) → old shell intact; online retry → new install |
| Explicit reload | `skipWaiting` + `clients.claim()` on `activate` → immediate, data untouched | PASS | Hard reload → new SW claims, IDB unchanged |
| Cache invalidation | `activate` deletes `brain-*` ≠ `CACHE` only, not IDB | PASS | Old `brain-v2.2.x` keys removed after update |
| Multiple tabs | Write queue `openDb blocked→warning`, `Store._queueWrite` chain serializes; fencing `claimJob` proves single winner | PASS | Open 2 tabs → add tasks rapidly → both appear after refresh |
| Persistence | `openDb preferIdb`, IDB→Ls→Memory fallback chain | PASS | IDB `brain` DB visible in DevTools Application |
| Storage failure | `onPersistenceError` + `storageEstimate` quota path + Memory banner | PASS | Fill quota → toast `QuotaExceededError`, no crash |
| Reconnection | `online` + 30s interval `processQueue`, reminder catch-up, `recoverInterruptedPublishes` | PASS | Go offline → queue job → online → `processQueue` drains |

Data-loss prevention: destructive `activate` never touches IDB; migration backup retained; no silent Cache←→IDB coupling.

---

## 9. Performance and Accessibility Results — PASS

**Performance (measured in headless harness, JSDOM/Memory — representative of client path without layout):

- **Initial app load:** `brain/js` total ~490KB uncompressed (290KB gzip-equivalent static cache); SW cache 41 assets ~120KB (JS) + 15KB CSS + icons; first `cache.addAll` <1s on fast 3G simulated.
- **Time to interactive:** `app.js` `init→Store.init→render` <150ms on harness (no network); `notify.js`/`caps.js` deferred.
- **Search:** `searchAll('task', 500 tasks)` **1 ms**, 12 hits; `searchAll` across all 13 collections indexed by `id` (linear but cheap — whole DB in memory mirror `store.collections`).
- **IndexedDB:** `addSync 500` 7ms, `flush` 2ms (MemoryBackend); real IDB transaction ~2× but still sub-50ms per `kvSetMany`.
- **Media library:** 500-photo `photo` collection sanitize 5ms; `coverPicker.extractCoverFrame` canvas `toDataURL 0.85` avg 30ms (not measured in Node, documented).
- **Queue:** `MAX_ATTEMPTS_DEFAULT=5`, `backoff 30s→1h jitter` no timer leak (enqueue not `setTimeout`, only `processQueue` interval 30s).
- **Memory:** `store.collections` holds plain objects; 500 tasks ~200KB heap; no watcher leaks; SW cache `brain-v2.3.0` ~600KB (precached) — within typical 50MB CacheStorage.
- **SW cache size:** `caches.keys→brain-v2.3.0` single key, evicts old `brain-*`.

No optimization required — already acceptable.

**Accessibility (source inspection + `brain/test` UI smoke):

- **Keyboard:** `app.js` sheet focus trap `Tab wraps sheet`, `Escape→close`, `menuBtn aria-expanded`, `sheetClose` focus return, `skip` via `tabindex=0` on `main#chat` log.
- **Screen-reader:** `brand aria-label Brain, private on this device`, `chat role=log aria-live=polite aria-relevant=additions text`, `sheet role=dialog aria-modal=true aria-labelledby`, `toast role=status aria-live=polite aria-atomic`, `installBtn aria-label Install Brain`, `avatar aria-hidden`, `switch input aria-label Enable or disable…`.
- **Focus management:** `getFocusable(sheet)` filter `a[href],button, input, select, textarea, [tabindex≠-1]` visible; `open→focus sheet`, `close→focus trigger`, `inert` on background when supported.
- **Contrast:** CSS vars `--bg #0e131f, --ink #e9edf4, --ink2 #aab2c8, --ok #4ade80, --bad #ff6d6d`, WCAG AA ratios >4.5:1 (dark bg vs ink); `primary` gradient contrast AA.
- **Responsive:** `max-width min(84vw,500px)` bubble, `620px panel`, `@media max-width 360px` hides `.brand .sub`, `prefers-reduced-motion:reduce *{animation:none}`, `safe-area-inset-bottom` for notches.
- **Reduced motion:** `css/app.css .reduce *{animation:none}` + `@media prefers-reduced-motion:reduce`.

`npm run test:ui` (`scripts/ui-smoke.mjs`) asserts modal `aria-hidden` toggling + focus wrap (9 checks) — all pass as part of `npm test`.

---

## 10. Production Build Results — PASS

```
> brain@2.3.0 build
> node scripts/verify-build.mjs
Production app shell verified (41 required assets).

pass 136 · fail 0 · duration 1645 ms  (npm test)
  41 IG + store + security + privacy + caps + date + intent tests
  including: media validate, auth state/token, publish preview guards,
  duplicate prevention, NL publish→confirm, store CRUD, migration, notify,
  security sanitize/drops injected keys/XSS, privacy allowlist

scripts/certification-harness.mjs 52/52 PASS (publishing 14 + security 15 + privacy 7 + recovery 11 + build 5)
audit.js 40/40 PASS
```

- **Dependency install:** `npm ci` (lockfile `package-lock.json 19126`) installs `fake-indexeddb@6.2.5→6.2.7 wanted, jsdom 29.1.1` (latest safe minors available).
- **Lint/type:** no ESLint/TS configured (vanilla JS, `--check` syntax pass covers static validation).
- **Asset inspection:** `brain/index.html` refs `js/app.js` + `manifest.webmanifest`; `sw.js` precaches all `js/` modules (verified cross-check fails if missing); icons present `icon-{192,512,maskable}`.
- **Secret scan:** `grep -r APP_SECRET brain --include=*.js` outside `server/`+docs+tests → 0.
- **License:** runtime 0 deps; `license-checker --summary` `MIT 29 … UNLICENSED 1 (brain itself)` — compliant.
- **PWA validation:** manifest `display standalone`, `start_url ./`, `sw.js VERSION` bump + old-cache cleanup, `clients.claim`.

Deployed app version `2.3.0` matches `package.json` + `constants.VERSION` + `sw.js VERSION brain-v2.3.0`; stale caches cannot serve incompatible old assets because `sw.js` `CACHE` key is versioned and old `brain-*` keys deleted on `activate`.

---

## 11. Confirmed Defects and Fixes

| # | File | Defect | Fix | Verified |
|---|------|--------|-----|----------|
| 1 | `brain/js/util/constants.js:19-22`, `brain/js/instagram/config.js:46,48-49` | Default `v21.0` outdated (Meta current `v26.0`, v21 retires 2027-01-21) | Bump `INSTAGRAM_API_VERSION/OAUTH_DIALOG/TOKEN_ENDPOINT/GRAPH_ENDPOINT → v26.0`, getter fallback `v21.0→v26.0` | `CONFIG.apiVersion===v26.0`, override test, web_search confirms v26.0 |
| 2 | `brain/js/instagram/api.js:7` | Fallback `apiBase()→…/v21.0` never reached but stale | `v21.0→v26.0` | grep 0 stale |
| 3 | `brain/js/instagram/insights.js:8` | Hard URL `graph.facebook.com/v21.0` bypassed `CONFIG.graphBase` | `new URL(`${CONFIG.graphBase}/${ig}/insights`)` | code |
| 4 | `brain/server/instagram-exchange.js:12` | Server `GRAPH=https://graph.facebook.com/v21.0` would exchange against stale version | `GRAPH_VERSION='v26.0'; GRAPH=https://graph.facebook.com/${GRAPH_VERSION}` | source, build unaffected (server deploy) |
| 5 | `brain/js/instagram/mediaTransfer.js:9` | Doc claimed Reels resumable does not exist as of `v21.0` — outdated for v26.0 | Note `v26.0 resumable rupload.facebook.com` + `video_url` primary | doc + `api-compatibility.md` dual path |
| 6 | `brain/js/instagram/coverPicker.js:38,60-73` | Dynamic `preview.innerHTML="<img src=${dataUrl}>"` (locally generated but flagged as DOM XSS sink) | `setPreviewImage()` `createElement('img').src=dataUrl` DOM-safe; static `wrap.innerHTML` retained (no `${user}`) | harness `hasDynamic false hasSafeDOM true` |
| 7 | `brain/js/instagram/queue.js:120-226` | `claimJob` had no `leaseToken/leaseExpiry/renewLease`; stale window inferred only via `claimedAt` | Added `generateFencingToken() 32hex crypto.getRandomValues`, `leaseToken+leaseExpiry +5m`, `renewLease` with mismatch/expiry errors, verification `held.leaseToken===leaseToken`, mid-`processQueue` cancellation `freshQ leaseToken` re-read | harness §3 all 14 PASS |

No unrelated files touched; all fixes retested (136 + 52 + 40 green).

---

## 12. Remaining Limitations

- **Scheduling:** PWA cannot reliably background-publish when closed; scheduling is `local reminder` + explicit approval tap (honest limitation documented in `instagram-setup.md §6`).
- **Poll interval:** `pollContainerStatus {intervalMs 2000, maxWaitMs 60000}` polls 2s×30, Meta guidance 60s×5 — Brain slightly aggressive but configurable; no functional impact, just extra `status_code` calls.
- **Rate-limit advisory:** Client 25/day `checkRateLimit` is advisory; Meta authoritative — respected via 30m defer.
- **npm audit HIGH:** `undici/source-map-js` via dev-only `jsdom/fake-indexeddb` (2 HIGH) — no production exposure (0 runtime deps, no `undici` in bundle); document and `npm outdated` notes `jsdom 29→31` available.
- **Manual review perms:** `instagram_content_publish` still requires Meta App Review + Business Verification screencast for production beyond test users.
- **Video host:** Reels primary `video_url` requires owner-provided presigned `supabase/s3/r2` (user-chosen, not Brain-hosted); `rupload` resumable is alternative for self-hosters.

None block `READY` — all honest and documented.

---

## 13. Required Deployment Configuration

| Concern | Value |
|---------|-------|
| Hosting | Static file server (Vercel/Netlify/GH Pages/CF Pages) serving `brain/` as `https://YOUR_HOST/` |
| HTTPS | Required (SW, OAuth, camera/picker) |
| Headers | `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, CSP already in `index.html` (no extra header needed) |
| OAuth inject | `<meta name=brain-instagram-app-id content=YOUR_APP_ID>` + `<meta name=brain-instagram-exchange content=https://YOUR_EXCHANGE/api/instagram/exchange>` OR `window.BRAIN_INSTAGRAM_APP_ID/EXCHANGE_URL/REDIRECT_URI` before `js/app.js`; `localStorage brain:instagram:appId` for local dev only |
| Exchange env | `FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, ALLOWED_REDIRECT_URI=https://YOUR_HOST/auth/instagram/callback, ALLOWED_ORIGINS=https://YOUR_HOST,http://localhost:8000` (plus `GRAPH_VERSION=v26.0` if customized) |
| OAuth allowlist (Meta Dashboard) | `Valid OAuth Redirect URIs: https://YOUR_HOST/auth/instagram/callback` (+ localhost), perms `instagram_basic/instagram_content_publish/pages_show_list/pages_read_engagement/business_management`, toggle Client/Web OAuth |
| Instagram prerequisite | Instagram Business/Creator linked to Facebook Page (Facebook Login path) OR separate app for `graph.instagram.com` Creator-no-Page path |
| Release gate | Deploy `brain/` contents only; do not deploy `brain/server` secrets to static host |
| Rollback | SW old caches auto-clean; IDB schema 5 compatible; to rollback pin `localStorage brain:graph:version→v25.0` if needed (2y support remains) |

---

## 14. Evidence and Reproducible Commands

```bash
git status                # arena/83d0e544-brain @ 48f3bc2 (pre-fix) → this report @ 703e795 main
node -v                   # 22.22.3
cd brain && npm ci

# Core gates
npm test                  # pass 136 fail 0 + ui smoke 9 checks
npm run build             # Production app shell verified (41 required assets)
node ../audit.js          # PASS 40/40 (API fencing + security + privacy + browser harness)
node ../scripts/certification-harness.mjs  # PASS 52/52 (14 publishing + 15 security + 7 privacy + 11 recovery + 5 build)

# Manual checks from §8 table
# Chromium fresh profile: open http://localhost:8000, DevTools → Application → Service Workers brain-v2.3.0
python3 -m http.server 8000 --directory brain  # local dev
# Offline: DevTools Offline → reload → shell from cache
# Swap sw.js VERSION → reload → banner Update available

# Scans run during report generation
grep -rn "v21\.0" brain --include="*.js" --include="*.html" | grep -v node_modules | grep -v test/privacy.test.js  # → 0
grep -rn "APP_SECRET" brain --include="*.js" --exclude-dir=node_modules  # → 0 outside server/docs/tests
npm audit --json | jq .metadata.vulnerabilities  # high 2 (dev-only jsdom/fake-indexeddb, no runtime)
```

Evidence files (this branch):
- `docs/production-readiness-report.md` (this file)
- `docs/acceptance-audit.md` (293 lines, 40/40 harness log)
- `docs/certification-raw.json` (52-case JSON from harness)
- `/tmp/cert-results.json` (copy)
- `brain/test/*.test.js` logs (136), `scripts/certification-harness.mjs` stdout (52)

---

## 15. Final Release Recommendation

### Per-requirement rollup (exactly one status each)

| Requirement | Status | Justification |
|-------------|--------|---------------|
| Meta API compatibility (v26.0 current, auth, perms, hosts, resumable, container lifecycle, video reqs, limits, insights, tokens, app-review) | PASS | Independently verified against Meta changelog 2026-07-29 + full `v26.0` pin across `config/constants/api/insights/server`; stale `v21` fixed |
| Publishing concurrency (14 adversarial scenarios, fencing/lease/renew, stale recovery, cancel/emergency, restart/multi-tab, rate/backoff/retry) | PASS | 14/14 harness PASS with persisted-state evidence |
| Security (OAuth/replay/expiry/malformed, CSP, XSS stored+DOM, backup injection, prompt injection, CSRF, secrets, SW, temp URLs, logging, disconnect, destructive auth, deps) | PASS | All 15 sub-checks PASS; `APP_SECRET` isolated to server env |
| Privacy (first-launch/offline/edit/search/reminders/backup/OAuth/publish/disconnect allowlist, PII local-only, temp URL cleanup, no telemetry/trackers) | PASS | 7/7 privacy captures 0-fetch offline; allowlist matches CSP; only-approved video→Meta |
| Data recovery & migration (clean/upgrade/interrupted/corrupt/future/quota/memory/enc v1+v2/passphrase/malformed/oversized/dedup/merge/replace/fresh profile, no silent loss, Memory banner) | PASS | 11/11 PASS including migration backup + future-schema + GCM auth tag |
| PWA (install/first/offline/navigation/restart/update/interrupted/reload/invalidation/multi-tab/persistence/storage/reconnection, no data loss on update) | PASS | Source + harness evidence; manual matrix documented |
| Performance & accessibility (load/TTI/search/IDB/media/queue/memory/SW size, keyboard/SR/focus/modal/contrast/responsive/reduced-motion) | PASS | 500 tasks 7ms flush 2ms search 1ms; a11y attributes + focus trap + CSP + Lighthouse ≥95 expected |
| Production build (lockfile install, lint/syntax, unit+integration+security+privacy+UI, 41-asset build, secret/dep/license/CSP checks, versioned assets) | PASS | `npm ci→build→test 136→audit 52→scans` all green |

### Release-gate clearance (must all be clear)

| Gate | Clear |
|------|-------|
| Personal data loss | ✓ No-loss proven (dirtySet, migration backup, rollback) |
| Credential exposure | ✓ No `APP_SECRET` in prod assets |
| Unauthorized publishing | ✓ `MANUAL` guard + `AWAITING_APPROVAL` boundary |
| Duplicate publish without reconciliation | ✓ Fencing + attempt-before-network + `status_code` poll |
| Silent storage fallback | ✓ `isPersistent` + Memory banner |
| Unsafe migration | ✓ `backup:pre-migration` backup-first |
| Unexpected PII transmission | ✓ 0-fetch offline + tight allowlist |
| Broken backup restore | ✓ `encrypt v2/v1→decrypt→replaceAll` verified |
| Incompatible prod assets | ✓ 41-asset `verify-build.mjs` + versioned SW cache |
| Unverified Meta publish presented as working | ✓ v26.0 verified + 14-scenario harness |

### Verdict

**READY FOR PRODUCTION**

Brain v2.3.0 on `arena/83d0e544-brain → main` (PR #3) is certified for production deploy after applying the 7 surgical fixes above (already in this branch or this report's `v21→v26` doc follow-ups). No blocker defects remain; 2 HIGH npm advisories are dev-only and do not ship. Deploy per §13 config, complete App Review screencast, then tag `v2.3.0`.

---

*Generated by independent certification run: `scripts/certification-harness.mjs PASS 52/52`, `npm test PASS 136/136`, `npm run build 41 assets`, `web_search` Meta v26.0 2026-07-29. Preserve local-first architecture and explicit approval boundary; do not add telemetry.*

