# API Compatibility — Brain v2.3.0

**Verified:** 2026-11-06 against [`developers.facebook.com`](https://developers.facebook.com/docs/instagram-platform/content-publishing) + Meta Graph changelog + `docs/instagram-integration.md`. `graph.facebook.com/v26.0` is the configured default; see override note.

## Configured version

| Where | Value |
|-------|-------|
| `INSTAGRAM_API_VERSION` | `v26.0` (`constants.js:19`) |
| `CONFIG.apiVersion` fallback | `v26.0` (`config.js:46`) |
| `graphBase` | `https://graph.facebook.com/${apiVersion}` |
| `oauthDialog` | `https://www.facebook.com/${apiVersion}/dialog/oauth` |
| `tokenEndpoint/graphEndpoint` | `https://graph.facebook.com/v26.0/...` |
| Server `GRAPH_VERSION` | `v26.0` (`server/instagram-exchange.js:12`) |

**Override without code change:** `<meta name="brain-graph-version" content="v26.0">` → `localStorage brain:graph:version` → `window.BRAIN_GRAPH_VERSION` → fallback `v26.0`. Tested: set `localStorage brain:graph:version=v21.0` → `CONFIG.apiVersion` reads `v21.0`; remove → `v26.0`. Containers are not reused across versions (version is request-time).

## Chronology

`v21.0` (2025) → `v22.0 2025-01-21` → `v23.0 2025-05-29` → `v24.0 2025-10-08` → `v25.0 2026-02-18` → **`v26.0 2026-07-29 latest stable`**, support ≈2 y. `v21.0` retires **2027-01-21** — migration timely, not emergency.

## Endpoints (implemented)

| Call | Method / URL | Docs purpose |
|------|--------------|--------------|
| `fetchUserPages` | `GET graphBase/me/accounts?fields=id,name,access_token` | Pages owning IG account |
| `fetchInstagramBusinessAccount` | `GET graphBase/{pageId}?fields=instagram_business_account` | IG id |
| `fetchInstagramProfile` | `GET graphBase/{ig}?fields=id,username,name,profile_picture_url,followers_count,account_type` | Verify Business/Creator |
| `createReelContainer` | `POST graphBase/{ig}/media {media_type:REELS, video_url, caption, share_to_feed, cover_url}` | Container — `video_url` must be public HTTPS Meta can fetch |
| `pollContainerStatus` | `GET graphBase/{containerId}?fields=status_code,status` | Poll `FINISHED/ERROR/EXPIRED` (`2s×60s` default; Meta guidance `60s×5`) |
| `publishContainer` | `POST graphBase/{ig}/media_publish {creation_id}` | Final publish |
| `fetchPermalink` | `GET graphBase/{mediaId}?fields=id,permalink,media_url,thumbnail_url,caption,timestamp` | Link back |
| `fetchInsights` | `GET graphBase/{ig}/insights?metric=impressions,reach,profile_views&period=day` | Insights |
| `validateToken` | `GET graphBase/me?fields=id,name` | Token liveness |
| `revokePermissions` | `DELETE graphBase/{me|user}/permissions?access_token=…` | Revoke |
| `oauth/access_token` | `POST graphBase/oauth/access_token` (+ `fb_exchange_token` for long-lived) | Token exchange via exchange host |

**Auth host:** `graph.facebook.com/v26.0` for Facebook Login (IG-Business via Page) — scopes `instagram_basic, instagram_content_publish, pages_show_list, pages_read_engagement, business_management`. Alternative `graph.instagram.com/v26.0` (IG Login, Creator without Page) with `instagram_business_basic`/`content_publish` Bearer documented.

**Resumable:** `upload_type=resumable → POST https://rupload.facebook.com/ig-api-upload/v26.0/{id}` with `offset/file_size` — investigated as alternative to `video_url`; see `mediaTransfer.js` and `media-transfers.md`.

## Behaviour Brain handles

- **Error codes:** `190 expired/revoked → reconnect prompt`, `4/429 rate → rateLimited + defer 30 m`, `10 permission → missing permission`, `200 Personal account → permission denied` (`authErrorFrom`).
- **Auth expiry:** 5-min buffer, `tokenExpiryLabel`, `needsRefresh <24h`, `getConnectionStatus→connected/expired/incomplete/disconnected`.
- **Container expiry:** `24h-5m` → `isContainerExpired()` → clear `igContainerId` and recreate.
- **Limits:** `INSTAGRAM_PUBLISH_LIMITS {DAILY 25, HOURLY 5, NOTE: Configurable; Meta authoritative }` — advisory; `checkRateLimit` defer 30 m, not assumed truth.
- **Insights fallback:** 403 → `needsPermission` → local `byStatus/publishedThisMonth/queueLen`.

## Tests mock real shapes

`test/instagram.test.js` mocks `data.id`, `status_code`, `error.code` matching actual Graph JSON; not faked success-as-production.

## App Review gate

`instagram_content_publish` beyond test users (App Roles Tester/Admin works pre-Review) needs **Business Verification + screencast** (see `instagram-setup.md` §9, `instagram-integration.md` §17).

## Change safety

Bump `<meta brain-graph-version>` or `localStorage` to pin old version without redeploy. New `INSTAGRAM_API_VERSION` applies only to new containers; old published media unaffected.
