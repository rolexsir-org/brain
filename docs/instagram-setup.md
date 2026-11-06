# Instagram Business Integration — Setup & Production Guide

## Overview

Brain's Instagram integration is **local-first and isolated**: personal data stays in IndexedDB, only an explicitly approved Reel (video + caption) is sent to Meta via the official Graph API. Publishing always requires your final tap.

---

## 1. Meta Developer App Setup (5–10 min)

1. **Create App** at https://developers.facebook.com → My Apps → Create App → Type: **Business** → Name: `Brain (private)` → Contact email.
2. **Add Product:** In the app dashboard, add **Instagram Graph API** (or Facebook Login).
3. **Configure OAuth:**
   - In **Facebook Login → Settings**, add **Valid OAuth Redirect URIs**:
     - `https://YOUR_BRAIN_HOST/auth/instagram/callback` (production)
     - `http://localhost:8000/auth/instagram/callback` (local dev)
   - Enable **Client OAuth Login**, **Web OAuth Login**.
4. **Permissions:** Request review for:
   - `instagram_basic` — read profile
   - `instagram_content_publish` — publish Reels
   - `pages_show_list`, `pages_read_engagement`, `business_management` — discover Business account
   > **Note:** Without App Review, publishing works only for test users (App Roles → add your FB account as Tester/Admin). Add the owner's FB account as **Tester** to publish immediately.
5. **App Credentials:** Note **App ID** and **App Secret**. The secret **never** goes in the client.

6. **Instagram Business Requirement:** The owner's Instagram must be a **Business or Creator** account linked to a Facebook Page. In Instagram → Settings → Account → Switch to Business, then link Page.

## 2. Hosting Configuration

Brain is static; it needs two deploy-time values:

### Option A — Meta tag (simplest, no build)
In `index.html` `<head>`:
```html
<meta name="brain-instagram-app-id" content="YOUR_APP_ID">
<meta name="brain-instagram-exchange" content="https://YOUR_EXCHANGE_SERVICE/api/instagram/exchange">
```

### Option B — Global
In hosting inject before `js/app.js`:
```html
<script>window.BRAIN_INSTAGRAM_APP_ID="YOUR_APP_ID"; window.BRAIN_INSTAGRAM_EXCHANGE_URL="https://.../exchange"; window.BRAIN_INSTAGRAM_REDIRECT_URI="https://YOUR_HOST/auth/instagram/callback";</script>
```

### Local dev (no server)
Brain allows a per-browser override: open Instagram section → field *Meta App ID* → paste App ID → Save. It stores in `localStorage` for that browser only.

## 3. Token Exchange Service (Required for Production)

The client **must not** hold `App Secret`. Deploy the minimal exchange at `brain/server/instagram-exchange.js`.

### Env Vars
```
FACEBOOK_APP_ID=...
FACEBOOK_APP_SECRET=...
ALLOWED_REDIRECT_URI=https://YOUR_BRAIN_HOST/auth/instagram/callback
ALLOWED_ORIGINS=https://YOUR_BRAIN_HOST,http://localhost:8000
```

### Deploy Targets
- **Cloudflare Workers:** copy handler, set vars in `wrangler.toml`.
- **Netlify/Vercel Function:** wrap `handleRequest` as shown in file.
- **Simple Node:** run with `express` or native `http`.

The service is stateless (no DB) and handles:
- `POST /exchange` {code, redirect_uri} → FB token + long-lived exchange (60 days)
- `POST /exchange/refresh` {access_token} → refresh before expiry

Without this service, Brain falls back to **manual long-lived token entry** (testing only, noted in UI).

## 4. Connecting the Owner's Account

1. Open Brain → Menu → **Instagram**.
2. Tap **Connect Instagram** → Meta OAuth prompt → Allow `instagram_basic` + `instagram_content_publish`.
3. Brain validates `state` (CSRF), exchanges `code`, discovers `igUserId` via `me/accounts → instagram_business_account`, and stores connection in IndexedDB (`instagram: {...}`).
4. Status shows `✅ Connected as @username · expires in 59 days`.

## 5. Publishing a Reel — Exact Steps

1. **Select video:** Instagram section → **Select Reel video** → pick MP4/MOV (H.264, 3–15 min, 9:16 ideal, ≤1 GB).
2. Brain validates locally (format, duration, resolution) and shows warnings.
3. **Caption/hashtags:** Type caption (≤2200 chars) or **✨ Generate**; **# Suggest hashtags** uses local templates (no cloud AI).
4. **Temporary URL:** Paste a public HTTPS `video_url` where Meta can fetch the video. This is required by Meta's API.
   - Use your own hosting, S3 pre-signed URL, or the exchange service's temporary upload endpoint (if you add one).
   - Brain explains: *“Meta must fetch your approved video — this is not private from Meta.”* Only the approved video is ever uploaded.
5. **Save draft:** Stored locally as `instagramDraft`; you can **Remove draft**.
6. **Preview:** Tap **Eye Preview publishing…** → shows account, video meta, full caption, video URL.
7. **Publish:** Tap **✅ Publish Reel to Instagram** → Brain calls `POST /{ig-user-id}/media` → polls `status_code` until `FINISHED` → `POST /media_publish` → records `permalink`.
8. **Result:** Draft becomes `published` with `publishedAt` and `permalink`; also saved to `instagramPublication` history. Failures show `lastError` and `failed` status without duplicate retries (idempotency via `publishing` lock).

**Anti-rules enforced:**
- “Prepare this Reel” → prepares only, no publish.
- “Publish this Reel” / “post on Instagram” → still shows preview + requires tap.
- Double-tap is debounced; `publishing` status blocks duplicates.

## 6. Scheduling (Honest Limitation)

PWAs cannot reliably run code when closed. Scheduling is implemented as **local reminders**: “Prepare this Reel for tomorrow” → creates a 9 am reminder *“Publish Reel: X”* → you confirm publishing when it fires. Auto-publish would require a trusted server scheduler (future, out of scope for local-first design).

## 7. Security & Privacy Checklist

- [ ] App Secret only in exchange service, never in client/logs/git
- [ ] `state` via `crypto.getRandomValues`, single-use, 10 min expiry
- [ ] CSP: `connect-src` limited to `graph.facebook.com` + your exchange
- [ ] `CORS` on exchange restricted to Brain origin
- [ ] Inputs sanitized: caption ≤2200, hashtags ≤30, video MIME whitelist
- [ ] XSS: all IG text via `textContent` / `escHtml`
- [ ] Rate limit: publish button disabled + `publishing` lock
- [ ] No personal data leaves device except approved video+caption to Meta
- [ ] Test revocation: disconnect → `DELETE /me/permissions` + local wipe

## 8. Testing

```bash
cd brain
npm test        # 100 existing + new IG tests
npm run build   # verifies all IG modules are precached
```

- Use Meta **Graph API Explorer** with a **Test User** to verify token scopes.
- Use a second Instagram Test User as publish target, never the owner's live account for destructive tests.
- Verify with DevTools Network: only `graph.facebook.com` and exchange host calls appear; no personal collections are transmitted.

## 9. App Review Submission

When ready to go live beyond test users, submit in **App Review → Permissions and Features** with:
- Screencast showing Connect → Select video → Edit caption → Preview → Publish (explicit approval)
- Explanation that Brain is local-only, no cloud DB, user approves each publish

## 10. Deployment Requirements

- HTTPS (required for Service Workers, OAuth, camera/picker)
- Headers: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`
- Backup strategy: owner exports JSON; video blobs not in JSON — re-select after restore (documented in UI)
- No secrets in repo; inject via hosting env

---

**Status Key:** `draft` → `ready` → `publishing` → `published` | `failed` (tracked locally, visible in Instagram section).
