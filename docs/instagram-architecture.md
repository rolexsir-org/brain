# Brain Instagram Business Integration — Architecture & Implementation Plan

**Date:** 2026-11-06  
**Branch:** arena/a1e04bed-brain  
**Status:** Approved for implementation

---

## 1. Repository Audit Summary

### Current Architecture
- **Type:** Static ES-module PWA — no build step, no backend, no cloud sync
- **Storage:** IndexedDB (`brain` v1) → `localStorage` fallback → in-memory fallback; single `Store` class with write queue, sanitization via `validate.js`, schema versioning (v3), backup/restore with dedup fingerprints
- **State Management:** In-memory `collections` object + async `Store` persistence; `Brain` intent engine reads store; UI renders via `app.js` centralized `runAction` dispatcher
- **Natural Language:** Deterministic, rule-based `intent.js` (~1300 lines) with `Context` for pronoun resolution and pending clarifications; `actions.js` for domain mutations
- **UI:** `index.html` → `app.css` → `app.js` + `cards.js` + `caps.js`; conversation as log + bottom sheet with menu, settings, editors; PWA manifest + service worker precache
- **Security Boundaries:** XSS-safe DOM builder (`nodes`), input sanitization, MIME+header validation for photos, capability-gated actions, no analytics, no external sync
- **Tests:** 100 unit tests (domain, store, intent, caps, external) + UI smoke via JSDOM; build verification checks precache completeness

### Existing Capabilities to Preserve
Tasks, reminders, notes, people/contacts, expenses/debts, inventory, habits, journal, events, photos, NL interaction — all offline-first.

### Integration Points Identified
- `Store` `COLLECTIONS` and `sanitizeRecord` dispatch — extend for Instagram drafts/publications
- `Store.settings` — add Instagram connection metadata (not collection)
- `intent.js` `_create` / `_query` / `_externalAction` — add Instagram NL intents
- `system.js` `ACTION` registry + `availableActions` + `canOffer` — add Instagram actions
- `cards.js` `entityCard` + `kindIcon` — render Instagram entities
- `app.js` menu, sheet editors, `runAction`, lifecycle — wire Instagram section
- `sw.js` precache list — add new modules
- `external.js` — reference for handoff patterns; Instagram publish will not use it (needs Graph API)

---

## 2. Instagram Integration Architecture

### 2.1 Privacy-Preserving Local-First Design

```
┌─────────────────────────────────────────────────┐
│  Brain PWA (browser, offline-first)              │
│  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Local Data   │  │ Instagram Module         │  │
│  │ (IndexedDB)  │◄─┤ • Connection (kv: insta) │  │
│  │ All personal │  │ • Drafts (collection)    │  │
│  │ collections  │  │ • Publications (collect) │  │
│  └──────────────┘  └────────────┬─────────────┘  │
│                                 │ approved video │
│                                 │ + caption only │
│                    ┌────────────▼─────────────┐  │
│                    │ Token Exchange Service   │  │
│                    │ (minimal, stateless)     │  │
│                    │ • Holds App Secret       │  │
│                    │ • Exchanges code → token │  │
│                    │ • Refreshes long-lived   │  │
│                    └────────────┬─────────────┘  │
│                                 │ Graph API     │
│                                 ▼               │
│                    Meta Instagram Graph API      │
└─────────────────────────────────────────────────┘
```

**Principles:**
1. Personal data (tasks, notes, etc.) **never** leaves device
2. Only **explicitly approved** Reel video + caption is sent to Meta
3. Token vault is isolated: connection metadata in IndexedDB with expiry tracking; long-lived token refresh via minimal exchange service OR direct long-lived token when App Secret not needed for client
4. No Brain accounts, no analytics, no cloud DB for personal data
5. Instagram is **optional** — Brain works fully offline without it

### 2.2 OAuth Lifecycle

**Official Flow:** Facebook Login for Business → Instagram Graph API

1. **Initiation:** User taps "Connect Instagram" → Brain generates cryptographically random `state` (32 bytes, `crypto.getRandomValues`), stores in `sessionStorage` with timestamp, redirects to `https://www.facebook.com/v21.0/dialog/oauth?client_id=APP_ID&redirect_uri=...&scope=instagram_basic,instagram_content_publish,pages_show_list,business_management&state=...&response_type=code`

2. **Callback:** Redirect URI `https://brain.example/auth/instagram/callback` (or `window.location.origin + /auth/callback` for dev) receives `?code=&state=`:
   - Validate `state` matches stored value and not expired (>10 min)
   - CSRF protection: single-use, then deleted
   - Exchange `code` for short-lived token via token-exchange service (App Secret never in client)

3. **Token Exchange (server-assisted):**
   ```
   Client → POST /api/instagram/exchange { code, redirect_uri }
            → Server calls FB token endpoint with app_secret
            → Returns { access_token, token_type, expires_in }
   ```
   - If no exchange service configured, fall back to **client-side long-lived token input** with clear UI explaining limitation (for testing)

4. **Account Discovery:**
   ```
   GET /me/accounts?access_token=... → pages
   GET /{page-id}?fields=instagram_business_account&access_token=...
   GET /{ig-user-id}?fields=username,name,profile_picture_url,followers_count
   ```
   - Verify account is Business/Creator
   - Store: `igUserId`, `username`, `pageId`, `tokenExpiry`, `connectedAt`

5. **Token Management:**
   - Short-lived: 1 hour; Long-lived: 60 days
   - Detection: `expires_at` computed at receipt; background check on app boot + before publish
   - Refresh: `GET /oauth/access_token?grant_type=fb_exchange_token&fb_exchange_token=...` via exchange service
   - Disconnect: `DELETE /{user-id}/permissions` + local wipe + clear `state` artifacts
   - Revocation handling: Graph API `190` error → mark disconnected, prompt reconnect

6. **Permissions (Minimum Viable):**
   - `instagram_basic` — read profile to verify connection
   - `instagram_content_publish` — publish Reels
   - `pages_show_list` + `pages_read_engagement` — discover linked IG business account (required by Meta)
   - No messaging, ads, insights without feature justification

### 2.3 Media Transfer & Publishing Workflow

**Meta Requirements (v21.0, 2025):**
- Container: `POST /{ig-user-id}/media` with `media_type=REELS`, `video_url`, `caption`, `share_to_feed`, `cover_url` (optional)
- Publish: `POST /{ig-user-id}/media_publish` with `creation_id`
- Video: MP4/MOV, H.264, AAC audio, 9:16 aspect, 720p minimum (recommended 1080x1920), duration 3s–15min (Reels: up to 90s recommended), file size ≤ 1GB
- Caption: ≤ 2200 chars, hashtags ≤ 30
- Cover: optional thumbnail

**Local Handling:**
- Video selected via `<input type=file accept="video/*">` — original never modified
- Validation: format, duration, resolution, size, aspect ratio (via `HTMLVideoElement` metadata; no upload until approval)
- Preview: object URL, revoke on dismiss
- Caption/hashtags: local editor, generation helper (template-based, no cloud AI)
- Draft: stored as `instagramDraft` collection with `status: draft | pending | publishing | published | failed`
- Publishing: explicit two-tap confirmation → upload to **temporary public URL** (user-provided or exchange service) → Meta fetches → poll container status → publish → record URL

**Temporary Hosting Disclosure:**
User is shown: *"To publish, Meta must fetch your approved video from a public HTTPS URL. Brain will upload the selected video to your temporary hosting (or the minimal exchange service) only after you confirm. It is not private from Meta. The temporary copy is deleted after publishing."*

Scheduling: No reliable PWA background publish. Implemented as **local scheduled reminder** ("Post this Reel at 9am") that fires notification; user taps to confirm publish then. Optional server scheduling noted as future if exchange service adds it.

### 2.4 Storage Design

**New Collections (in `validate.js` / `store.js`):**
- `instagramDraft` — `{ id, videoName, videoSize, videoDuration, videoWidth/Height, videoMime, caption, hashtags, coverUrl?, status, createdAt, updatedAt, scheduledAt?, lastError? }` — video blob stored as IndexedDB `instagramVideoBlob:{id}` (not in backup JSON; re-select needed after restore)
- `instagramPublication` — `{ id, draftId, igMediaId, permalink, caption, publishedAt, status }` for history

**New KV Key:** `instagram_connection` → `{ connected, igUserId, username, name, profilePictureUrl, pageId, accessToken (stored; warning that browser storage is not secure vault), tokenType, expiresAt, connectedAt, lastValidatedAt }`

Settings extension: `instagramReminders` boolean (already in settings)

### 2.5 Security Improvements
- OAuth `state` via `crypto.getRandomValues` + timestamp + single-use
- No App Secret in client, logs, or git
- CSP tightening (new meta tag if needed)
- Input validation: caption length, hashtag regex, video MIME whitelist, URL validation for `video_url`
- Output encoding: all Instagram text via `escHtml` / text nodes
- Rate limiting: client-side publish debounce (publish button disabled during request + `publishing` status lock)
- Idempotency: `draft.status === publishing` blocks duplicate publish

---

## 3. Implementation Phases

### Phase 1 — Store & Validation
- Extend `validate.js` COLLECTIONS, add `makeInstagramDraft`, `makeInstagramPublication`
- Extend `constants.js` with Instagram constants
- Add `instagram/config.js` with API version, scopes, media requirements

### Phase 2 — Media & Auth Modules
- `instagram/media.js` — validation against Meta specs
- `instagram/auth.js` — OAuth state, callback, token lifecycle, disconnect
- `instagram/api.js` — Graph API helpers (account fetch, container create, publish, status poll)
- `instagram/drafts.js` — draft CRUD
- `instagram/publish.js` — 2-step workflow with idempotency

### Phase 3 — UI & NL Integration
- `instagram/ui.js` — connection card, draft library, editor, preview, publish confirmation
- Wiring in `app.js`: menu entry, sheet routing, `runAction` cases
- `intent.js`: 8 new NL patterns + query for drafts/publications
- `cards.js`: renderers for new kinds
- `css/app.css`: Instagram section styles

### Phase 4 — Verification
- `npm test`, `npm run build`, manual PWA checks
- New test suites: `instagram-media.test.js`, `instagram-auth.test.js`, etc.

---

## 4. Honest Limitations to Document
- Token storage in IndexedDB is not a secure vault; exchange service recommended for production
- Video must be available at public HTTPS URL for Meta to fetch — requires user hosting or exchange service
- PWA cannot reliably auto-publish when closed — reminders instead
- App Review required for `instagram_content_publish` beyond test users
- Test with Meta's Graph API Explorer + test users before production
