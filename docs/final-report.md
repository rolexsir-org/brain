# Brain — Instagram Business Integration — Final Report

**Branch:** `arena/a1e04bed-brain` (from `d55a74d6b8c74710a35888c1009b46140de46524`)  
**Version:** 2.2.0 (schema 4)  
**Date:** 2026-11-06

---

## 1. Files Inspected

- `index.html`, `manifest.webmanifest`, `sw.js`, `css/app.css`
- `js/app.js` (63390 bytes, central dispatcher, ~1200 lines)
- `js/store/store.js`, `db.js`, `validate.js` (22053 / 5791 / 11274 bytes)
- `js/store/migrate.js`, `js/util/constants.js`, `js/util/util.js`, `js/util/date.js`
- `js/engine/intent.js` (76702 bytes, rule-based NL), `actions.js`, `context.js`, `search.js`
- `js/actions/external.js` (25933), `system.js` (9817), `caps.js`
- `js/ui/cards.js` (9924), `js/notify.js` (9249), `js/install.js`
- `scripts/verify-build.mjs`, `scripts/ui-smoke.mjs`
- All tests in `test/` (100 original, + new `instagram.test.js`)
- `package.json` (2.1.2 → 2.2.0)

**Audit Outcome:** Static PWA, no backend, IndexedDB with write queue + sanitization, capability-gated actions, XSS-safe rendering. No cloud sync to preserve.

---

## 2. Files Changed

| File | Change |
|------|--------|
| `brain/js/util/constants.js` | Bumped `SCHEMA_VERSION` 3→4, `VERSION` 2.1.1→2.2.0, added Instagram constants (`INSTAGRAM_MEDIA_REQUIREMENTS`, scopes, API version) |
| `brain/js/store/validate.js` | Added `COLLECTIONS` entries `instagramDraft`, `instagramPublication`; added sanitizers `makeInstagramDraft`, `makeInstagramPublication`, `makeInstagramConnection`, helpers `cleanCaption`, `cleanHashtags`, extended `sanitizeRecord` dispatch |
| `brain/js/store/store.js` | Extended `defaultSettings` with `instagram` connection object, added `cleanInstagramSettings`, bumped fingerprint handling for new collections, preserved all existing persistence/repair logic |
| `brain/js/actions/system.js` | Added 11 Instagram `ACTION` constants, extended `canOffer` (IG actions gated on `settings.instagram.connected` + file picker), extended `availableActions` for `instagramDraft`/`instagramPublication` cards |
| `brain/js/ui/cards.js` | Extended `kindIcon` (🎬/📸), added renderers for `instagramDraft` (status emoji, video meta, caption, hashtags, permalink, schedule) and `instagramPublication` |
| `brain/js/engine/intent.js` | Injected `_instagramIntent` (14 patterns, never auto-publishes, honors `automate` guard), added help entry, fixed open-Instagram ambiguity, added Instagram to NL pipeline before meta/external |
| `brain/js/app.js` | Added suggestions entry, menu Instagram hub (13 collections + hub row), `handleInstagramCallback` (OAuth code → exchange → discovery), 9 IG action handlers (`openInstagramHub`, `disconnect`, `check`, `draftCreate/Preview/Delete`, `publishPreview/Publish`, `schedule`), updated `listKind` for IG, `openMenu` banner, lifecycle integration |
| `brain/js/instagram/config.js` | **NEW** — public config (App ID via meta/global/localStorage), OAuth URL builder, media requirements constants |
| `brain/js/instagram/media.js` | **NEW** — `validateFileBasics`, `probeVideoMetadata` (via video element, 15s timeout), `validateCaption/Hashtags`, `buildCaptionWithHashtags`, helpers for object URLs/duration |
| `brain/js/instagram/auth.js` | **NEW** — CSRF `state` via `crypto.getRandomValues`, `validateState` (10m expiry, single-use), `parseCallbackParams`, token expiry/refresh helpers, `exchangeCodeForToken`/`refreshLongLivedToken` via exchange service, `revokePermissions`, `buildConnected/DisconnectedConnection` |
| `brain/js/instagram/api.js` | **NEW** — Graph API wrappers: `fetchUserPages`, `fetchInstagramBusinessAccount`, `fetchInstagramProfile`, `discoverInstagramAccount`, `createReelContainer`, `pollContainerStatus`, `publishContainer`, `publishReel` (2-step), auth/rate error mapping |
| `brain/js/instagram/publish.js` | **NEW** — `preparePublishPreview` (requires `tempVideoUrl`, builds caption), `executePublish` (idempotency via `publishing` lock, debounce, failure → `failed` + `lastError`), `suggestHashtags`/`generateCaptionTemplate` (local, no cloud AI) |
| `brain/js/instagram/ui.js` | **NEW** — Hub (connection card, draft library, published history), manual token entry fallback, video picker, draft editor (caption/hashtags/smart buttons, temp URL), publish confirmation card (ABSOLUTE RULE), progress reporting |
| `brain/css/app.css` | Added `.ig-conn-card`, `.ig-draft-list`, `.ed` styles |
| `brain/index.html` | Added `brain-instagram-app-id`/`brain-instagram-exchange` meta tags + CSP (`connect-src` → `graph.facebook.com`, `media-src` → `blob:`/`https:`) |
| `brain/sw.js` | Bumped `VERSION` to `brain-v2.2.0`, precached 6 new IG modules |
| `brain/package.json` | Version 2.2.0 |
| `brain/scripts/verify-build.mjs` | Added 6 IG modules to required assets |
| `brain/scripts/ui-smoke.mjs` | Updated srow expectation 11→≥13 to include IG collections |
| `brain/test/store.test.js` | Updated schema upgrade expectation 3→4 |
| `brain/test/sw.test.js` | Updated cache removal expectation to include v2.1.2 |
| `brain/test/instagram.test.js` | **NEW** (23 tests) — media validation, caption/hashtag, state/CSRF, token lifecycle, publish preview, store CRUD, connection persistence, 8 NL intents, duplicate prevention, offline retention |
| `brain/server/instagram-exchange.js` | **NEW** — minimal stateless exchange (code→token + long-lived, refresh), CORS, example deploy wrappers |
| `docs/instagram-architecture.md` | **NEW** — audit summary, architecture diagram, OAuth lifecycle, media handling, storage design, security |
| `docs/instagram-setup.md` | **NEW** — Meta App setup, hosting config (meta tag vs global), exchange service deploy, connect steps, exact publish workflow, scheduling limitation, security checklist, App Review notes |
| `brain/manifest.webmanifest` | Unchanged (standalone) |

---

## 3. Features Implemented

### Account Connection
- [x] Official Meta OAuth (Facebook Login for Business) via `https://www.facebook.com/v21.0/dialog/oauth`
- [x] `state` CSRF (32-byte `crypto.getRandomValues`, 10m expiry, single-use, `sessionStorage`)
- [x] Callback handling (`?code&state` or `?error`), validation, single-use cleanup, URL sanitization
- [x] Token exchange via minimal service (App Secret never in client); documented fallback to manual long-lived token for testing
- [x] Account discovery: `me/accounts` → `instagram_business_account` → profile fetch (verifies Business/Creator)
- [x] Permission management (minimum: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`)
- [x] Token expiry detection (5m buffer), `tokenExpiryLabel`, `needsRefresh` (<24h), disconnect, permission revocation (`DELETE /permissions`), status `connected`/`expired`/`disconnected`/`incomplete`
- [x] Clear connected/disconnected banner, profile picture, ID snippet, expiry label, re-check button

### Reels Management
- [x] Video picker (`<input accept="video/*">`, local only)
- [x] Validation: formats `mp4/mov`, MIME whitelist, size ≤1 GB (client cap 250 MB warning), duration 3–900s (recommends ≤90s), resolution ≥320×480, aspect warnings (9:16/4:5/1:1), `probeVideoMetadata` via `HTMLVideoElement`
- [x] Preview (object URL, revoke on dismiss), original never modified
- [x] Caption editor (≤2200, live counter), hashtag editor (≤30, regex, dedup lowercased)
- [x] Caption generation (`✨ Generate` templates) and hashtag suggestions (local templates + caption keywords, no cloud)
- [x] Draft storage (`instagramDraft` collection, `status: draft|ready|pending|publishing|published|failed|scheduled`, `videoName/Size/Width/Height/Duration/Mime`, `caption`, `hashtags`, `tempVideoUrl`, `igContainerId/MediaId`, `permalink`, `lastError`, `retryCount`)
- [x] Draft library (sorted by updatedAt, status emoji, size/duration, hashtags, error), remove drafts (confirm)
- [x] Publishing status tracking, published URL display (`permalink`), published history (`instagramPublication` collection, separate, retains even after draft delete)
- [x] Remove drafts, view published post URLs (clickable), disconnect keeps drafts

### Publishing Workflow (Absolute Rule Enforced)
1. Owner selects video → local validation → draft `draft`
2. Enters/reviews caption → `validateCaption` → `ready` on save
3. Browser prepares preview → `preparePublishPreview` (requires `tempVideoUrl`, builds `caption + hashtags`, shows igUserId, video meta, caption, videoUrl)
4. **Preview displayed** → banner “No Reel is sent until you tap Publish”
5. Owner taps **✅ Publish Reel** → `executePublish` locks `publishing`, checks `publishing` idempotency, debounce 3s, verifies `connected` & not expired
6. Sends container request (`POST /{ig-user-id}/media` with `media_type=REELS`, `video_url`, `caption`, `cover_url`)
7. Polls container status (`status_code` every 2s up to 60s → `FINISHED`/`ERROR`)
8. Publishes (`POST /media_publish` with `creation_id`) → records `mediaId`/`permalink`
9. Stores locally (`publishedAt`, `permalink`, `igMediaId`, history entry)
- **No Reel publishes without explicit final tap** — verified in code (`prepare…` never calls API) and tests (`publish this Reel` → `preview` action, not auto-publish).

### Natural-Language Commands
- [x] `connect my Instagram account` → `instagram.connect`
- [x] `Prepare this video as an Instagram Reel` → `instagram.draft.create`
- [x] `Create a caption for this Reel` → latest draft → `instagram.draft.preview`
- [x] `Add relevant hashtags` → suggest → same
- [x] `Show my Instagram drafts` → lists drafts (up to 8 cards)
- [x] `Show the Reel I published yesterday/today` → filters by `publishedAt` date
- [x] `Prepare this Reel for tomorrow` → reminder (not auto-publish, explains limitation)
- [x] `Connect my Instagram account`, `Disconnect Instagram`, `Instagram status` all handled
- [x] Never invents publish results; if ambiguous asks clarification; respects `automate` guard (defers to honest limitation message)

### Scheduling
- [x] Investigated: PWA cannot reliably auto-publish when closed (no push server, OS suspends).
- [x] Implemented: **local scheduled reminder** (`Domain.createReminder` for tomorrow/next week/2h) with text “Publish Reel: X” + toast explaining limitation.
- [x] Documented server-based option as future (requires exchange service extension).

### Security
- [x] No App Secret in client/logs/git (exchange service holds it)
- [x] Strict state validation (random, timestamp, single-use), CSRF protection
- [x] Input validation (caption ≤2200, hashtags ≤30/80, video MIME whitelist, URL validation, `cleanText`/`cleanInstagram`/`finiteNumber`)
- [x] Output encoding (all IG text via `textContent`/`escHtml`, no `innerHTML`)
- [x] CSP (`default-src 'self'`, `connect-src` limited, `media-src blob:`/`https:`)
- [x] Restricted CORS (exchange allows only Brain origin)
- [x] Rate limiting (client debounce, `publishing` lock blocks duplicates)
- [x] Idempotency (draft `publishing` prevents double `media_publish`)
- [x] Error handling via `authErrorFrom` maps codes 190/4/10/200 to honest messages, never claims success before Meta confirms, no silent retries
- [x] Browser storage is not vault — documented, exchange recommended, manual token flagged as testing-only

### Media Handling
- [x] Inspected Meta requirements (MP4/MOV H.264 AAC, 9:16, ≥720p, 3s–900s, ≤1 GB, ≤2200 caption, ≤30 hashtags)
- [x] Validates formats/aspect/resolution/duration/size/audio implied, upload completion via polling, container status
- [x] Only approved video (`tempVideoUrl`) goes to Meta, explains temporary hosting not private from Meta, cleans object URLs

### UI/UX
- [x] Extended existing dark design system (no theme replacement)
- [x] Connection status (banner, avatar, expiry), account info, Reel library (emoji status, meta), draft management, video preview (`<video controls>`), caption/hashtag editor, publishing confirmation (card with preview + warnings), progress, success/failure (permalink / `lastError` red), disconnect controls
- [x] Consistent spacing/typography, responsive, mobile PWA, accessibility (sheet modal, focus trap, `aria-hidden`)

---

## 4. Architecture Decisions

- **Local-first preserved:** Personal collections never leave device; IG drafts/publications are local (IndexedDB). Video blobs stored as `igVideoBlob:{id}` KV (not in JSON backup, re-select needed — documented).
- **Why minimal exchange service:** Browser cannot safely hold App Secret; Graph token exchange requires `client_secret`. Isolated stateless service is smallest cloud surface (no personal DB), deploy separately. Client falls back to manual token for pure-static dev.
- **Why not full backend:** Would violate no-cloud-DB rule; IG publish needs only temporary video hosting + token exchange, not personal data migration.
- **Schema bump 3→4:** Added 2 collections; existing data migrates via sanitized load + persisted snapshot; no destructive schema.
- **Intent placement:** IG intents before `external` but guarded against `automate` hijack; `open Johnny's instagram` still resolves via person flow.

---

## 5. Security Improvements

Beyond prior app (sanitization, XSS-safe `nodes`, photo header checks):
- CSRF state with crypto, expiry, single-use
- Token lifecycle (expiry, refresh detection, revocation)
- CSP tightening, CORS restriction
- Input allowlists (video MIMEs, caption/hashtag limits)
- Output encoding for IG text
- Rate/idempotency guards
- Honest error mapping (190 expired, 4 rate, 10 permission)

---

## 6. Tests Executed & Results

```bash
npm install   # 40 packages, 2 high severity (inherited, not blocking)
npm test      # 123 tests (100 original + 23 new), 123 pass, 0 fail
npm run build # Production app shell verified (31 assets)
```

**New tests (`test/instagram.test.js`):**
- Media basics, oversized, unsupported MIME, caption/hashtag validation, build caption
- Auth state gen/validate (single-use), expiry detection, disconnected status
- Publish preview requires connection/videoUrl, succeeds with valid
- Store CRUD (trim caption 2200, hashtags 30), connection persistence
- NL: connect, show drafts, disconnect, publish needs confirmation, prepare video
- Duplicate prevention (publishing lock), offline draft retention after disconnect

**Existing suites still passing:** caps, date, action-system, device-intent (8/8), domain-actions, external, intent, migrate, notify/sw (5/5 after update), store (8/8), util, validate

**Manual checks required (not automatable):** HTTPS PWA install, iOS/Android share, actual Meta OAuth with test user, video probe on real device, permission prompt, offline reload.

---

## 7. Remaining Limitations

- **Token vault:** Browser storage is not secure; exchange service required for production long-lived tokens (documented, manual token is testing-only).
- **Video hosting:** Meta requires public HTTPS `video_url`; Brain cannot publish from `blob:`/`data:`; user must supply hosting or service must add upload endpoint (explained, not silent).
- **Scheduling:** No reliable background publish; implemented as reminder (documented).
- **App Review:** `instagram_content_publish` beyond test users needs Meta review (screncast + privacy explanation required).
- **Storage:** Video blobs not in JSON backup; restore requires re-select (documented in hub note).
- **Browser APIs:** Video probing needs `URL.createObjectURL` + `HTMLVideoElement`; falls back to warnings in restricted runtimes.

---

## 8. Meta Developer Setup Instructions

See `docs/instagram-setup.md` Section 1 (App creation, Login product, redirect URIs, `instagram_basic`/`instagram_content_publish`/`pages_show_list`, Business account link) + Section 2 (meta tag or global injection of App ID/exchange URL).

---

## 9. Exact Steps to Connect Owner's Instagram Business Account

1. Ensure Instagram is **Business/Creator** linked to a Facebook Page.
2. Deploy Brain with `meta brain-instagram-app-id = YOUR_APP_ID` (and exchange URL).
3. Add owner’s FB as **Tester** in App Roles (publish works without review for testers).
4. Owner: Brain → Menu → **Instagram** → **Connect Instagram** → Meta consent → **Allow**.
5. Brain validates `state`, exchanges code, discovers `igUserId`, stores `connected` with 60-day expiry.
6. Verify: banner shows `@username` + expiry; **Check connection** → “valid”.

Sections 4–5 detail publishing 9-step flow with explicit approval.

---

## 10. Production Deployment Requirements

- **HTTPS** (SW, OAuth, pickers), headers `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`
- **CSP** as in `index.html`; `connect-src` must allow `graph.facebook.com` + exchange host
- **Exchange service** deployed with env `FACEBOOK_APP_ID/SECRET`, `ALLOWED_REDIRECT_URI`, `ALLOWED_ORIGINS`
- **No secrets in repo** — inject via hosting env/meta
- **Backup strategy:** owner exports JSON; video blobs excluded (documented)
- **No analytics, no personal cloud DB**

---

### Status

| Requirement | Status |
|-------------|--------|
| Existing Brain functionality | ✅ Fully implemented & passing (123 tests) |
| Local-first, no personal cloud | ✅ Preserved |
| Secure OAuth (state, CSRF, no secret) | ✅ Implemented, pending Meta config |
| Select/preview local Reels | ✅ Implemented |
| Captions/hashtags | ✅ Implemented (local) |
| Explicit final approval | ✅ Absolute rule enforced |
| Meta responses handled | ✅ Container poll + publish + permalink |
| Drafts/history locally | ✅ `instagramDraft`/`instagramPublication` in IndexedDB |
| Disconnect works | ✅ Local wipe + revoke attempt |
| No credentials exposed | ✅ Verified via CSP + exchange separation |
| No unrelated upload | ✅ Only approved video via `video_url` |
| Production build passes | ✅ 31 assets verified |
| Remaining limitations documented | ✅ This report + setup guide |

**Fully implemented** (local): store, validation, media checks, draft CRUD, caption/hashtags, publish workflow (code), NL intents, UI, security guards, tests, docs.  
**Implemented but awaiting Meta config:** OAuth redirect, token exchange (needs App ID + exchange service), account discovery, actual Graph publish (code ready, needs live token).  
**Requires Meta App Review:** `instagram_content_publish` beyond test users.  
**Requires real-device testing:** OAuth flow, video probe, camera/picker, install, offline, permission prompts.
