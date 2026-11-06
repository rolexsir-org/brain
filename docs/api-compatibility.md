# Meta API Compatibility — Brain v2.3.0 (N)

## Verified against official docs (developers.facebook.com, 2026-11-06)
- **Graph version:** v21.0 is latest stable (21.0 documented, v22 not yet GA). Brain uses `CONFIG.graphBase = https://graph.facebook.com/v21.0` and allows override via meta `brain-graph-version`. Upgrade path: change meta tag or `localStorage brain:graph:version` and re-test.
- **Auth:** Facebook Login for Business → OAuth code → exchange via backend (APP_SECRET required). Scopes: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `business_management`. All listed in `constants.js`.
- **Eligibility:** Professional account (Business/Creator) linked to Page; personal accounts rejected with message from `discoverInstagramAccount`.
- **Publishing:** `POST /{ig-user-id}/media` with `media_type=REELS, video_url, caption, cover_url, share_to_feed` → poll `GET /{containerId}?fields=status_code` until `FINISHED/ERROR/EXPIRED` → `POST /{ig-user-id}/media_publish {creation_id}`. Video: MP4/MOV, H.264, AAC, 9:16/4:5/1:1, 720p min, 3s–900s (90s recommended),≤1 GB. Tested against real Meta error codes 190/4/10/200 in `api.js`.
- **Limits:** Not hardcoded as facts; `constants.js` documents `PUBLISH_LIMITS_NOTE: "Limits subject to Meta change; see docs"` and `checkRateLimit` reads configurable `DAILY_LIMIT`/`HOURLY_LIMIT` (default 25/5, adjustable via settings). Doc warns not to rely on client limit as authoritative.
- **Insights:** `GET /{ig-user-id}/insights?metric=impressions,reach,profile_views&period=day` when granted; 403 handled as `needsPermission`.
- **Tokens:** short-lived 1h, long-lived 60d, refresh via `fb_exchange_token`, revoke via `DELETE /permissions`. Brain tracks `expiresAt` with 5-min buffer, labels, refresh check.
- **App Review:** `instagram_content_publish` requires Business Verification + screencast before production beyond test users; documented in `instagram-setup.md`.

## Configurable handling
- `brain-graph-version` meta tag overrides version without code change.
- Publish limits read from `INSTAGRAM_PUBLISH_LIMITS` constant object, not literal.
- Tests mock Graph responses matching actual shape (`data.id`, `status_code`, error.code).
