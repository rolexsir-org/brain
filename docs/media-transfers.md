# Media Transfers — Privacy Design (Brain v2.3.0)

## Summary
Brain is offline-first. Personal data (tasks, notes, people, journal, photos) never leaves the device. For Instagram Reels, only the **explicitly approved** video is sent to Meta, and only via a URL you approve.

## What is investigated
Meta Graph API v21.0 documents Reel publishing as:

```
POST /{ig-user-id}/media { media_type: "REELS", video_url, caption, share_to_feed }
→ container (poll status) → POST /{ig-user-id}/media_publish { creation_id }
```

There is **no client-side resumable/multipart upload for Reels** (unlike the legacy Facebook Video resumable API). Brain investigated:
1. `video_url` flow — host video at a temporary HTTPS URL Meta can fetch (official, documented).
2. App-server proxy — stream upload through your own server (`instagram-exchange.js` with `UPLOAD_PROXY=true`) which discards after forwarding, never writes to disk.
3. Direct browser upload — not supported for Reels in Graph API v21.0; Brain does not invent one.

**Preference:** (1) `video_url` with short-lived signed URLs you control. (2) is documented for self-hosters. Brain never claims a fake “direct upload”.

## Isolation
- The temp URL is stored only in the local draft (`IndexedDB` key `instagramDraft.tempVideoUrl`) and sent only to `graph.facebook.com`.
- It is **never sent** to any other host, analytics, or proxy unless you self-host the exchange service.
- Temp URLs should be **unguessable** (presigned S3/R2/Supabase URLs with signature) and **short-lived** (recommended 1 hour).
- Brain deletes `tempVideoUrl` after publish success and after 48 h of inactivity.
- The exchange service is stateless, CORS-limited, and never logs URLs beyond container ID.
- Brain never `console.log`s private URLs; grep the codebase — only `video_url` param is sent to Meta.

## Lifetime
- Presigned link: 1 h recommended.
- Draft cleanup: 24–48 h stale `tempVideoUrl` removed on next launch.
- Container expiry: 24 h per Meta; Brain checks `isContainerExpired()` before retrying and recreates if needed.

## Your control
In the Reel editor you see exactly which URL will be sent to Meta. Publish requires an explicit **Publish** tap; no background upload occurs. Automation Mode 2 requires separate opt-in and per-video allowlisting — general auth never grants publish-all.

## Self-host proxy (optional)
Set `UPLOAD_PROXY=true` in `server/instagram-exchange.js` — it streams the request body to Meta without disk write and returns only the container ID. No logs retained.
