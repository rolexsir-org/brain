# Privacy Audit — Brain v2.3.0 (P)

## Classification of network traffic
1. **Required infrastructure:** `GET` of app shell (index.html, css, js, icons, manifest, sw.js) from hosting origin; `GET` of `https://graph.facebook.com` only after explicit Publish tap (video_url + caption).
2. **Explicitly authorized Meta:** OAuth dialog `https://www.facebook.com/v21.0/dialog/oauth` (redirect with state/code), token exchange `POST` to configured `brain-instagram-exchange` endpoint (code→token), publishing `POST {ig-user-id}/media` + `/media_publish` + polling, revoke `DELETE /permissions`, validate `GET /me`, insights `GET /{id}/insights` when requested. All contain only `access_token`, `igUserId`, `caption`, `video_url`.
3. **Optional:** hosting provider analytics if self-hosted (not in Brain code); Supabase/S3/R2 presigned URL fetch by Meta (user-provided URL).
4. **Prohibited:** No fetch/XHR/WebSocket to analytics, fonts, error reporters, ad networks, or any third-party from ordinary Brain use (tasks, notes, search). Verified via CSP `connect-src` and grep.

## Inspection
- `fetch`/`XMLHttpRequest` only in `js/instagram/api.js`, `auth.js` (exchange), `insights.js`, `sw.js` (cache). Grep confirms no other `fetch(` in app.js/domain.
- `WebSocket` — none.
- `Service worker` fetches only same-origin `GET` (navigate → network+cache, other → cache-first).
- `Dependencies` — runtime zero; dev deps `fake-indexeddb`/`jsdom` not bundled.
- `Fonts/scripts` — self only; CSP blocks CDN.
- `Error reporting` — none; errors go to console + toast.
- `Browser storage` — IndexedDB `brain` v1, localStorage fallback, memory; keys: collections, settings, schema, queue, backup pre-migration, igVideoBlob. No cookie.
- `Temp media` — `instagramDraft.tempVideoUrl` short-lived, sent only to `graph.facebook.com`, deleted post-publish.
- `API logs` — Brain never logs private URLs; exchange service only logs containerId, not video_url (per docs).
- `Backup` — JSON or `brain-enc-v1/v2` local file via Save Blob; never uploaded.

## Test
`test/privacy.test.js` asserts no fetch to unexpected hosts (mock fetch, check URL allowlist).

## Data-leaving-device table
| Data | When | Where | Why |
|------|------|-------|-----|
| `video_url` + caption | Explicit Publish tap | `graph.facebook.com` | Create Reel |
| `code` + `redirect_uri` | Connect | exchange service | Token exchange |
| Shell `GET` | Launch | hosting origin | Load PWA |
| Nothing else | — | — | — |

Diagnostics never transmit personal info; `navigator.clipboard.writeText` redacted, no telemetry.
