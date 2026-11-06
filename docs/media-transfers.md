# Media Transfers — Privacy Design · Brain v2.3.0

**Source:** `brain/js/instagram/mediaTransfer.js` `TRANSFER_DOC`, `brain/js/instagram/media.js`, `brain/js/instagram/publish.js`, Meta docs `developers.facebook.com/docs/instagram-api/reference/ig-user/media` (2026-11-06).

## Summary

Brain is offline-first. All personal records and your photo library stay in IndexedDB. For Instagram Reels, only the **Reel you explicitly approve** ever leaves the device — as a **URL** Meta fetches — and only after your **Publish** tap.

## 1. What Meta documents

Current Graph `v26.0` Reel publishing:

```
POST /{ig-user-id}/media { media_type: "REELS", video_url, caption, share_to_feed, cover_url|thumb_offset }
  → { id: containerId }
→ GET /{containerId}?fields=status_code  // poll FINISHED / ERROR / EXPIRED
→ POST /{ig-user-id}/media_publish { creation_id: containerId }
  → { id: mediaId, permalink }
```

Alternative now documented as of `v26.0` (see `docs/api-compatibility.md`): `upload_type: "resumable"` → `POST https://rupload.facebook.com/ig-api-upload/v26.0/{containerId}` with `offset`/`file_size` headers. Brain **investigated** all three:

| Path | Status in Brain | Note |
|------|-----------------|------|
| `video_url` (host a temporary HTTPS URL, Meta fetches) | **Current primary** | Official, documented, works with Supabase/S3/R2 presigned URLs. |
| App-server proxy (stream your upload through own server) | **Documented for self-hosters** (`server/instagram-exchange.js` `UPLOAD_PROXY=true`) — streams body to Meta, never writes/log URL. | Optional. |
| Direct browser `multipart/form-data` to `/media` | **Does not exist for Reels** — Brain does not invent a fake direct-upload. | Unlike legacy Facebook Video resumable, not supported for Reels Graph endpoint. |

`TRANSFER_DOC.directUploadInvestigation` now notes `v26.0 resumable` as the official alternative to `video_url`.

## 2. Isolation — where the URL lives

| Stage | Location | Sent to |
|-------|----------|---------|
| You pick video | `File` in memory → validated → `createObjectURL` preview (revoked on dismiss) | — |
| You supply temp URL | Your presigned `https://…supabase.co / amazonaws.com / r2.cloudflarestorage.com/...` (with signature) typed/pasted into editor | Stored only as `instagramDraft.tempVideoUrl` in IDB `brain:v2:instagramDraft` |
| Preview | `preparePublishPreview` shows `videoUrl, caption, coverUrl, share_to_feed` | No network (guard returns `{ok:false, needsHosting:true}` if missing) |
| Publish tap | `POST graph.facebook.com/v26.0/{ig}/media {video_url, caption…}` | `graph.facebook.com` only — never analytics, never other proxy |
| Meta processing | Meta fetches your `video_url` from your host | Your host → Meta |
| Success | `fetchPermalink` → store `permalink, igMediaId, publishedAt`, set `tempVideoUrl:null, videoUrl:null` | — |
| Failure/retry | `isContainerExpired()` check → recreate if 24h-5m expired | Same isolated path |

Heuristic privacy: `isPrivateUrl(url)` true if `x-amz-signature|signature|sv|sig|token|expiry|expires` or `search.length>20` or raw len>120 — used to avoid logging. `grep console.log video_url` → 0.

## 3. Lifetime & cleanup

| Item | Lifetime | Cleanup |
|------|----------|---------|
| Presigned `video_url` | Recommend 1 h (your Supabase/S3/R2 config) | You set expiry; Brain cannot revoke a signed URL, only warn. |
| `instagramDraft.tempVideoUrl` | Until publish success or 48 h idle | `shouldCleanupVideoUrl(draft, now)` → true if `status PUBLISHED` or `now-updatedAt>48h`; cleared on success (`tempVideoUrl:null`). |
| Draft after publish | Retained as `PUBLISHED` with `permalink` for history | You may delete card; `instagramPublication` history remains. |
| Graph container `id` | 24 h (`isContainerExpired` check 24h-5m buffer) | Expired → `FAILED lastError Container expired — creating fresh one`, cleared `igContainerId:null`, next publish creates fresh. |
| Cover `dataUrl` | Canvas JPEG `data:` preview only (local) | Hosted `cover_url` follows same temp-host + cleanup as video. |
| Object URLs | Per preview | `revokeVideoObjectUrl` on dismiss/navigate. |

## 4. Your control

- Editor shows the exact `video_url` that will be sent — you confirm the host.
- **No background upload:** `executePublish` runs only on your tap (or on a valid `AUTOMATED` rule’s explicit `eligibleDraftIds` — still your prior allowlisting).
- `Pause automation` / `Disconnect Instagram` immediately block next `processQueue`; `EMERGENCY_STOP` + per-rule disable.
- Interrupted upload → `recoverInterruptedPublishes` polls `pollContainerStatus` on next boot; ambiguous network loss → `FAILED` with `lastError` + retry guidance (no silent duplicate).

## 5. Self-host proxy (optional)

For operators who prefer no presigned host:

```
env: UPLOAD_PROXY=true
Run: node server/instagram-exchange.js
Behaviour: streams request body → Meta rupload/graph, discards, returns {containerId|mediaId} only; never writes to disk nor logs video_url beyond containerId.
```

Stateless, CORS-limited (`ALLOWED_ORIGINS`), logs only `containerId` per privacy doc.

See [`instagram-integration.md`](instagram-integration.md) §10 for resumable protocol and [`threat-model.md`](threat-model.md) for threat boundaries.
