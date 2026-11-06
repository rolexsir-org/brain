# Brain — Final Engineering Report — v2.3.0

**Branch:** `arena/78b9b050-brain` (derived from `main@6f70c21` Merge PR #3)  
**Version:** `2.3.0` · **Schema:** `5` · **DB:** `brain` v1 · **Service Worker:** `brain-v2.3.0` · **Graph API:** `v26.0` (configurable)  
**Date:** 2026-11-06 (Asia/Calcutta) — docs synchronized against source (`brain/js/**`)  
**Build:** `41` assets verified (`scripts/verify-build.mjs`) · **Tests:** `136/136` unit (`npm run test:unit`) · **Harnesses:** `40/40` audit (`audit.js`) · `52/52` certification (`scripts/certification-harness.mjs`)

---

## 1. Architecture summary

Local-first static ES-module PWA (`brain/`). Zero runtime npm deps. See [`architecture.md`](architecture.md) for diagram.

- **Store:** `brain/js/store/store.js` (`_queueWrite` + `_dirtySet` 120 ms debounced 5-pass) → `brain/js/store/db.js` `IdbBackend → LsBackend (brain:v2:) → MemoryBackend` → `brain` v1 `kv` (`MAX_RECORDS 10k`, `MAX_BACKUP_CHARS 25 MB`). Migration writes `backup:pre-migration:*`, `corruptionReport`, `storageReport`/`mediaIntegrityReport`, `isPersistent` banner.
- **Engine:** `brain/js/engine/intent.js` pipeline `INTENT→ENTITY→VALIDATION→PERMISSION→PREVIEW→APPROVAL→EXECUTION→VERIFICATION→AUDIT` (+ `context.js` pronoun, `actions.js` mutation, `search.js` `searchAll` 13 collections).
- **UI:** `brain/js/app.js` dispatcher + undo, `brain/js/ui/cards.js` + `commandCentre.js` + `automationCentre.js` + `diagnostics.js` (10-field redacted copy).
- **Instagram boundary:** `brain/js/instagram/{config,auth,api,media,publish,queue,stateMachine,automation,coverPicker,insights,mediaTransfer,ui}.js` — only this touches `graph.facebook.com v26.0` (and your exchange + presigned host).
- **PWA:** `brain/sw.js v2.3.0` 41 assets `install→skipWaiting`, `activate→delete brain-*`, fetch cache-first + network-then-cache, `notificationclick` → `brain:reminder-*`, `install.js` banner without silent reload.

## 2. Publishing states & history

**Nine states** (`stateMachine.js:STATES`): `DRAFT → READY → AWAITING_APPROVAL → SCHEDULED → UPLOADING → PROCESSING → PUBLISHED | FAILED | CANCELLED` (legacy `published/draft/pending…` mapped via `LEGACY_MAP`).

- **Transitions** `ALLOWED_TRANSITIONS` enforce: `DRAFT→READY|CANCELLED`, `READY→AWAITING_APPROVAL|SCHEDULED|UPLOADING|CANCELLED`, etc.; `canTransition/normalizeStatus/nextStates` guard all writes.
- **History:** Every `store.update` of `instagramDraft` appends `{at, action, fromStatus, details(≤500), actor, containerId, mediaId}` (≤100 entries). `automation.history` (≤200) parallels.
- **Container expiry:** `isContainerExpired(createdAt)` 24 h−5 m; `publish.js` clears stale `igContainerId` before re-create; `FAILED` with `lastError` guides manual retry.

## 3. Queue — atomic claimJob, fencing, renewal, recovery, dedup, backoff, stop

`brain/js/instagram/queue.js` — durable `instagram:queue` (KV), version 1.

| Feature | Implementation |
|---------|----------------|
| **Make & enqueue** | `makeQueueEntry(draftId,{status SCHEDULED,scheduledAt,attempts, maxAttempts 3, ruleId, actor})` → `enqueue()` checks `EMERGENCY_STOP`, draft exists, `status∈{READY,AWAITING_APPROVAL,SCHEDULED,FAILED}`, `MAX_QUEUE_SIZE 100`, `existing SCHEDULED|UPLOADING|PROCESSING|CLAIMED→Already in queue`, appends then re-reads duplicate count → rollback if >1, updates draft `→ SCHEDULED + history queued`. |
| **Atomic claimJob** | Finds `SCHEDULED` only, writes `CLAIMED + claimedAt + leaseToken (32 hex crypto.getRandomValues) + leaseExpiry +5m + updatedAt`, `saveQueue`, re-read verifies `status CLAIMED && leaseToken match` else `null` (race lost). Returns `{entry, leaseToken}`. |
| **Lease renewal** | `renewLease(id, leaseToken)` checks token match then `leaseExpiry>now`, extends `+5m`. Failure `fencing token mismatch` or `lease expired`. |
| **Stale recovery** | `recoverStaleJobs()` scans `CLAIMED && now-claimedAt>5m → SCHEDULED`. Called at top of `processQueue` and on `online/visibility`. |
| **Cancellation** | `cancelQueueForDraft(draftId)` / `dequeue(id)` + `processQueue` fresh-read after claim `still.status!==CLAIMED||still.leaseToken!==claim leaseToken → continue`; mid-flight `qNow.find==null → continue`; draft `CANCELLED/PUBLISHED → dequeue`. |
| **Duplicate detection** | `isDuplicatePublish(draft)` (stateMachine) blocks `publishing|UPLOADING|PROCESSING|PUBLISHED` + 3-s double-tap window; `executePublish` lock `UPLOADING→PROCESSING` before network; queue duplicate guard above. |
| **Retry/backoff** | `classifyRetry(msg)` → `rate-limited 10m / transient null / permanent false / auth false`; `processQueue` marks `attempts+1 before network`, on transient+not-last-attempt reschedules `status SCHEDULED @ now+ (backoff||backoffMs(attempts))`, `backoffMs= jitter(min(1h, 30s*2^(n-1)))` cap 1 h +30% jitter. |
| **Rate & per-rule limits** | `checkRateLimit(pubs) DAILY 25 HOURLY 5` defer `30m` if hit (advisory, `constants.js:INSTAGRAM_PUBLISH_LIMITS NOTE`); `perRuleCounts` caps `maxPerDay 1–10`. |
| **Emergency stop** | `EMERGENCY_STOP` global, `setEmergencyStop(v)`, checked at `enqueue` and top/each cycle of `processQueue → {stopped:true}`. UI Diagnostics/Automation Centre exposes control. |
| **Interrupted recovery** | `recoverInterruptedPublishes()` on boot: `UPLOADING|PROCESSING` with `igContainerId` → `pollContainerStatus` → `PUBLISHED/FAILED`, else `FAILED` guidance. |

Verified by `scripts/certification-harness.mjs` 14 adversarial scenarios (dual-worker, crash-after-claim/upload, lost response, lease expiry, stale recovery by second worker, cancel during UPLOADING/PROCESSING, emergency stop, restart durability, two tabs, rate, timeout retry, network resume) — all `PASS`.

## 4. Automation & diagnostics

- `sanitizeAutomation` enforces `enabled(bool), mode(MANUAL|AUTOMATED), paused, rules≤50` each `{filters{tags≤20,namePattern≤200,allowedDays,allowedHours,eligibleDraftIds≤100}, schedule{freq,time,days}, limits{maxPerDay 1–10}}`, `history≤200`.
- `isEligibleForAutomation` requires explicit `eligibleDraftIds` or at least one tag/pattern, plus day/hour window — no silent “all”.
- `diagnostics.js` panel: `BRAIN version 2.3.0, schema current/active, DB name, storageMode/isPersistent, pending migrations, quota, photo/media health, integrity report, last backup, failed ops`.

## 5. Media & cover

`validateFileBasics` (MIME whitelist `video/mp4, video/quicktime, video/mov, video/x-m4v`, ext, 0-byte, ≤1 GB / warn 250 MB) + `probeVideoMetadata` (`HTMLVideoElement createObjectURL, 15 s timeout` → width/height/duration 3–900 s, ≥320×480 warn, aspect 9:16/4:5/1:1). `validateCaption ≤2200`, `validateHashtags ≤30/80`, `buildCaptionWithHashtags` truncates base to fit. `coverPicker.extractCoverFrame(videoUrl,time)` canvas → `dataUrl`; UI `setPreviewImage(createElement('img'))` DOM-safe (no dynamic `innerHTML`).

## 6. Vulnerabilities fixed (K–S history, still relevant)

| # | Location | Fix |
|---|----------|-----|
| V1 | `index.html` CSP | `frame-ancestors 'none', object-src 'none', worker-src 'self'` |
| V2 | `auth.js` OAuth state | Strict format `^[a-z0-9]+-[0-9a-f]{64}$`, expiry 10 m, skew −1 s, single-use clear on format fail |
| V3 | `crypto.js` | Added `v2 600k` (OWASP 2023) `ITERATIONS_V2`, versioned `brain-enc-v1/v2.*` decrypt both |
| V4 | `queue.js` blind retry | Atomic CLAIMED+fencing, attempts before net, classifyRetry, container check |
| V5 | `constants/stateMachine` | `INSTAGRAM_PUBLISH_LIMITS NOTE` configurable, imported |
| V6 | `config.js` | Graph version dynamic getter `meta→localStorage→window→v26.0` |
| V7 | `store.js/app.js` | `storageMode/isPersistent` banner + `onPersistenceError` quota path |
| V8 | tests | `security.test.js` XSS/CSP/state-format guards |

## 7. Functional defects fixed

| F2 Queue race | `claimJob` + duplicateCount rollback |
| F3 Stale CLAIMED stuck | `recoverStaleJobs 5m` |
| F4 No undo | `app.js` undo stack post-delete |
| F5 Encrypted size unchecked | `app.js file.size>25 MB` before decrypt |
| F6 SW silent | `install.js` banner Reload/Later |

## 8. Remaining risks (accepted, disclosed)

- Browser storage ≠ hardware vault — encrypted backup recommended.
- Presigned URL security is host policy (recommend 1 h).
- Extension can read DOM but cannot bypass explicit tap + allowlist without token.
- PWA cannot guarantee closed-app publish (reminder catch-up instead).
- Private browsing → Memory ephemeral (warned).

## 9. Data-loss mitigations

Interrupted `kvSetMany` → `_reportPersistenceError` + dirtySet 5-pass retry; `sanitizeRecord` repair, `corruptionReport`; migration `backup:pre-migration:*`; `isQuotaError` toast; `previewImport`/`replaceAll` rollback; SW never touches IDB.

## 10. API compatibility (verified N)

`v26.0` (2026-07-29 latest stable per `production-readiness-report.md` web_search) configured. All scopes/endpoints, container `status_code FINISHED/ERROR/EXPIRED`, limits advisory `25/5`, 60-d token via `fb_exchange_token`, `DELETE /permissions` — see `api-compatibility.md` endpoint table and `instagram-integration.md` §4. App Review required beyond test users — screencast guide in `instagram-setup.md:9`.

## 11. Verification (actual output, 2026-11-06)

```
$ cd brain && npm run test:unit
# pass 136 fail 0  (sanitize, store, intent, instagram, security, privacy, migrate…)
$ cd brain && npm run test:ui  (requires npm install)
# 9 focus-trap/modal/aria checks — pass in harness
$ cd brain && npm run build
Production app shell verified (41 required assets).
$ node audit.js
PASS 1a Graph version default is v26.0 — default v26.0
…
PASS 40/40, FAIL 0
$ node scripts/certification-harness.mjs
PASS 52/52 — 14 publishing scenarios, 15 security, 7 privacy, 11 recovery, 5 build
```

| Area | Result | Scope/Limit |
|------|--------|-------------|
| 40/40 harness | PASS | `audit.js` API v26.0/default+override, fencing, stale, quota, XSS (coverPicker DOM-safe), OAuth replay, private URL, offline, PWA 41 assets |
| 136/136 unit | PASS | `test/*.test.js` + `test:unit` — full suites above |
| Publishing 7 races (harness) | PASS | Dual-worker fence, stale, crash-after-upload, lost-response, lease renew/expiry, stale recovery, cancel, e-stop, restart, two tabs |
| Security regression | PASS | `security.test.js` 8 tests (XSS/state/CSP/no APP_SECRET) |
| Privacy | PASS | `privacy.test.js` 3 tests (allowlist, backup no fetch, no log private URL) |
| Migration | PASS | `migrate.test.js` legacy v1 + `store.test.js` sanitize + harness corrupt/migration/quota |
| PWA | PASS | `sw.test.js` + harness cache invalidation / update / offline / multi-tab |
| Secret scan | PASS | `grep APP_SECRET` outside `server/` =0 |
| License | PASS | Dev-only `fake-indexeddb MIT, jsdom MIT` — runtime 0 deps |
| Accessibility | PASS | `test` ui-smoke modal `aria-hidden/back` + focus wrap, reduced-motion in CSS |

Manual (not automatable, disclosed): real OAuth with test user on device, presigned URL fetched by Meta, iOS install, private-browsing banner, notification timing.

## 12. Files (cumulative A–S, current)

- `brain/index.html` CSP, `brain/sw.js 41`, `brain/scripts/verify-build.mjs` 41, `brain/js/**` 8 Instagram + 4 store + 4 engine + 4 UI + 4 util + 3 actions.
- `brain/test/*.test.js` (15 suites), `audit.js`, `scripts/certification-harness.mjs`.
- Docs: this report + `architecture.md`, `instagram-integration.md`, `api-compatibility.md`, `threat-model.md`, `privacy-audit.md`, `media-transfers.md`, `backup-recovery.md`, `command-centre.md`, `automation-centre.md`, `pwa-lifecycle.md`, `release-checklist.md`, `production-readiness-report.md` (15-section certification), `acceptance-audit.md`, `final-report.md`, `instagram-setup.md`.

## 13. Production blockers

None blocking code. External: Meta App Review for `instagram_content_publish` beyond test users; deploy config `brain-instagram-app-id + brain-instagram-exchange` via meta tags. See `release-checklist.md` — all automated checks must pass.

*All criteria evidenced without fabrication; Brain is usable offline-first: connect via test user, pick video, edit caption/hashtags/cover, preview, explicit Publish → permalink, revoke, encrypted backup/restore.*

