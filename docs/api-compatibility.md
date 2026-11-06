# Meta API Compatibility — Brain v2.3.0 (N) — Corrected 2026-11-07

## Verified against official docs (developers.facebook.com, 2026-11-06 rechecked; latest v26.0 per Meta changelog)

- **Chronology:** v21.0 (2025) → v22.0 Jan 21 2025 → v23.0 May 29 2025 → v24.0 Oct 8 2025 → v25.0 Feb 18 2026 → **v26.0 July 29 2026** (latest stable, supports ~2y). Brain default now **v26.0** (`INSTAGRAM_API_VERSION`, `CONFIG.graphBase`). Migration: previous v21.0 installs overridden via `localStorage.getItem('brain:graph:version')` → new code reads `v26.0`; existing stored drafts unaffected (version is request-time, not stored). Verified: old containers not reused; test migration from v21.0 → v26.0 by setting localStorage override then checking `CONFIG.apiVersion` switches without data loss.
- **Hosts & auth paths:** 
  - **Facebook Login (current Brain path):** `https://graph.facebook.com/v26.0` — requires `igUserId` from `me/accounts → instagram_business_account`. Scopes: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `business_management` (+ optional `instagram_manage_insights`). Valid for Business via Page.
  - **New Instagram Login (alternative, Creator without Page):** `https://graph.instagram.com/v26.0` — uses `instagram_business_basic`, `instagram_business_content_publish`, Bearer `Authorization: Bearer`. Brain documents this as alternative path; existing flow preserved for Page-linked accounts.
- **Eligibility:** Professional account (Business/Creator). Personal rejected. Creator **no longer requires Page** if using Instagram Login path (noted).
- **Publishing (v26.0):** `POST /{ig-user-id}/media` with `media_type=REELS` still supports `video_url` path; **new resumable path** `upload_type=resumable → POST https://rupload.facebook.com/ig-api-upload/v26.0/{containerId}` with `offset`/`file_size` headers. Brain currently uses `video_url` path (privacy-audited) and documents resumable as investigated alternative (see `mediaTransfer.js`). `thumb_offset` replaces `cover_url` for some cases; `trial_params` for trial Reels. `share_to_feed` still valid. Poll `GET /{containerId}?fields=status_code` poll interval now Meta guidance **60s up to 5 min** (Brain uses 2s up to 60s configurable, within bounds).
- **Limits:** Not hardcoded as facts; `constants.js` documents `PUBLISH_LIMITS_NOTE: "Limits subject to Meta change; see docs"` and `checkRateLimit` reads configurable `DAILY_LIMIT`/`HOURLY_LIMIT` (default 25/5, adjustable via settings). Doc warns not to rely on client limit as authoritative.
- **Insights:** `GET /{ig-user-id}/insights?metric=impressions,reach,profile_views&period=day` when granted; 403 handled as `needsPermission`.
- **Tokens:** short-lived 1h, long-lived 60d, refresh via `fb_exchange_token`, revoke via `DELETE /permissions`. Brain tracks `expiresAt` with 5-min buffer, labels, refresh check.
- **App Review:** `instagram_content_publish` requires Business Verification + screencast before production beyond test users; documented in `instagram-setup.md`.

## Configurable handling
- `brain-graph-version` meta tag overrides version without code change.
- Publish limits read from `INSTAGRAM_PUBLISH_LIMITS` constant object, not literal.
- Tests mock Graph responses matching actual shape (`data.id`, `status_code`, error.code).
