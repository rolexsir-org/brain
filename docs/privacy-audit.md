# Privacy Audit — Brain v2.3.0

**Principle:** Brain is offline-first and local-only. No Brain backend, analytics, fonts, error-reporters, or bundled trackers. The only external destinations reachable by production code are your hosting origin, Meta Graph (`graph.facebook.com v26.0`), and the exchange host you configure. Everything else (tasks, notes, people, money, journal, photos, search) stays in this browser’s IndexedDB.

## 1. Network traffic classification

| Class | When | Where `fetch` goes | Payload |
|-------|------|--------------------|---------|
| **A — App shell** | First load & navigations | `self` (your hosting origin) `GET index.html, manifest.webmanifest, css/app.css, js/**, icons/*` | Static assets only. No PII. |
| **B — Instagram connect** | You tap *Connect* → Meta *Allow* → callback | `https://www.facebook.com/v26.0/dialog/oauth?client_id&scope&state` (302 redirect) + `POST https://YOUR_EXCHANGE/api/instagram/exchange {code, redirect_uri}` + `POST https://graph.facebook.com/v26.0/oauth/access_token` (via exchange) + `GET graph.facebook.com/v26.0/me/accounts` + `…/instagram_business_account` + `…/{ig}/?fields=username,…` | `code, redirect_uri, appId, igUserId, token`. Only the connected account. |
| **C — Reel publish** | You tap *Publish Reel* after preview | `POST graph.facebook.com/v26.0/{igUserId}/media {media_type:REELS, video_url, caption, cover_url, share_to_feed}` → poll `GET {containerId}?fields=status_code` → `POST {ig}/media_publish {creation_id}` (+ alternative `rupload.facebook.com/ig-api-upload/v26.0/{id}` if `upload_type=resumable`) | **Only** `video_url` (your presigned `supabase.co`/`amazonaws.com`/`r2.cloudflarestorage.com` link that Meta fetches) + caption/hashtags you typed, `cover_url` if you picked. No other collection. |
| **D — Insights / revoke** | You open Insights or Disconnect | `GET graph.facebook.com/v26.0/{ig}/insights`, `DELETE graph.facebook.com/v26.0/me|{user}/permissions?access_token=` + `POST {exchange}/refresh` | `access_token, igUserId, metrics`. |
| **None** | All other operations — creating tasks/notes/reminders/money/journal/events/photos, editing, completing, searching, calendar `.ics` export, backup create/restore | No `fetch`/`XHR`/`WebSocket`. Verified `grep fetch(` in `brain/js` → only `api.js, auth.js, insights.js` (Meta) + `sw.js` cache fetches (self). Grep `WebSocket` → 0. | — |

`privacy.test.js` asserts `mock fetch → check URL allowlist ['self, graph.facebook.com, facebook.com, supabase.co, amazonaws.com, r2.cloudflarestorage.com']` and no `google-analytics|fonts.googleapis` in `index.html`.

## 2. What leaves your device — exact table

| Data | When you trigger | Sent to | Why |
|------|------------------|---------|-----|
| `video_url` (presigned, unguessable, 1-h recommend) + caption + hashtags + optional `cover_url` | Explicit **Publish Reel** tap | `graph.facebook.com v26.0` (and Meta’s fetch of your `supabase/s3/r2` URL) | Create Reel container + publish. **This is not private from Meta — disclosed in UI.** |
| OAuth `code` + `state` + `redirect_uri` | Connect | `YOUR_EXCHANGE` then `graph.facebook.com` | Exchange `code→token`. `App Secret` never in client. |
| Minimal `access_token` + `igUserId` | Publish / Insights / Refresh / Revoke / Validate | `graph.facebook.com` | Auth each Graph call. |
| Shell `GET` | Launch | Your hosting origin | Load PWA. |
| Nothing else | — | — | All other records are never serialized to network. |

`navigator.clipboard.writeText` (copy actions) + diagnostics `Copy report` both redact `accessToken → ••••`. Exchange service docs: logs only `containerId`, never `video_url`.

## 3. What stays local

- `Store` (`task, reminder, note, person, money, debt, stockItem, habit, journal, event, photo, instagramDraft, instagramPublication, settings, schema`) lives in IDB `brain v1 kv`. `settings.instagram` (token etc.) never leaves except to Graph.
- `searchAll`, `commandCentre`, recurrence calculation — all in-memory.
- Backup JSON / `brain-enc-v2.*` files: created via `Blob` + Save Dialog, never uploaded. Encrypted backup opaque to anyone without your passphrase (AES-GCM, unique salt/IV/tag).
- `Diagnostics` panel preview is in tab; “Copy” uses clipboard but redacted.

## 4. Temporary media handling

| Property | Implementation |
|----------|----------------|
| **Selection** | `<input type=file accept=video/*>` + `validateFileBasics` (MIME/ext) + `probeVideoMetadata` (duration/resolution/aspect). Invalid rejected before draft. |
| **Storage** | `instagramDraft {tempVideoUrl, coverDataUrl, coverTimeSec, videoSize/Width/Height/Duration}` in IDB only. No copy to server. |
| **Isolation** | `TRANSFER_DOC.current` — sent only to `graph.facebook.com`; never to other host/analytics. `isPrivateUrl(url)` flags presigned (`x-amz-signature|signature|sv|sig|token|expiry|expires` or `search.length>20` or len>120). `grep console.log private` → 0. |
| **Lifetime** | Host-recommended 1 h expiry for presigned link. Brain `shouldCleanupVideoUrl(draft)` deletes `tempVideoUrl→null` on success and after 48 h stale (`now - updatedAt >48h`). Container `24h-5m` expiry `isContainerExpired`. Resumable alt streams without disk. |
| **Control** | Reel editor shows exact `video_url` that will be sent; no background upload. Pause/kill → `recoverInterruptedPublishes`/`recoverStaleJobs` on next boot. |

See `media-transfers.md` for investigation (`video_url` vs `rupload` resumable) and proxy option.

## 5. Temporary storage vs durable storage

| Mode | Indicator | Risk |
|------|-----------|------|
| **Durable** | `Store.isPersistent==true` (`db.name===indexeddb`) — default | Data survives restarts. |
| **Ephemeral** | `isPersistent==false` (private browsing / quota) → banner `Temporary storage (Memory) — data will disappear when you close this tab` + `storageMode` in diagnostics | Export backup before closing. `onPersistenceError` + `flush` 5-pass retry mitigates short blips. |

## 6. Third-party destinations

- Runtime: **none** bundled. Dev-only `fake-indexeddb`/`jsdom` not shipped.
- CSP `connect-src` allowlist is the network truth — any new host would be blocked and visible. `grep fetch(` + `sw.js` audit in test ensures no drift.
- Your choosen host for `video_url` (Supabase/S3/R2) is yours to audit; Meta fetches it, Brain never proxies unless you self-host `UPLOAD_PROXY`.
- Hosting provider’s own analytics (if you enable) is yours, not Brain’s.

## 7. Verification

- `test/privacy.test.js`: no fetch to unexpected hosts, backup has no `fetch(`, `publish.js` has no `console.log video_url`.
- Manual: DevTools Network while creating tasks/notes/search → zero external requests; Connect → see only `facebook.com/graph.facebook.com/YOUR_EXCHANGE`; Publish → see only `graph.facebook.com` + `rupload`/`your s3`.

*Brain cannot promise “absolute privacy” — Meta receives the Reel you approve, the OS/browser can inspect site data, and presigned URLs are guessable if leaked. This doc states what is and isn’t sent so you can decide.*
