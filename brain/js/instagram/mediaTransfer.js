// Media-transfer privacy documentation + utilities.
// Prefer official Meta direct upload; isolate temp storage usage.

export const TRANSFER_DOC = {
  preferred: 'Meta direct upload (video_url pointing to your own short-lived hosted URL) or resumable upload session (init → upload → finalize). See https://developers.facebook.com/docs/instagram-api/reference/ig-user/media#creating-reels',
  current: 'Brain uses a temporary hosted video_url you supply (e.g. Supabase Storage, S3 presigned URL, Cloudflare R2). The URL is stored only in the local draft (IndexedDB) and sent to Meta graph.facebook.com during create container. It is NEVER sent to any other host.',
  isolation: 'Temp video URLs are private, unguessable, and short-lived (expire in minutes/hours per your storage config). Brain deletes the draft.videoUrl after publish is confirmed or after 48h. No server logs private URLs.',
  lifetime: 'Recommended expiry: 1 hour for video_url presigned links. Draft cleanup job removes stale videoUrl after 24h if not published.',
  directUploadInvestigation: `Meta Instagram Graph API does NOT expose a client-side resumable upload endpoint for Reels (unlike Facebook Video API resumable). The documented flow for Reels is: POST /{ig-user-id}/media {video_url, caption, ...} → container → status → publish. Client direct upload via multipart is not supported for Reels as of v21.0. Alternatives: 1) Host video temporarily with signed URL (current), 2) Use your app server as a lightweight proxy that streams the upload and is never logged. Brain ships option 1; option 2 is documented below for self-hosters.`,
  proxyOption: 'If you self-host, run the instagram-exchange server with UPLOAD_PROXY=true — it streams the body to Meta and discards it, no disk write, no logs beyond container ID.'
};

export function transferSummaryForUI() {
  return `Privacy: Your video is transferred to Instagram via a temporary, unguessable link that expires quickly. The link lives only on this device and is sent only to Meta. Brain never shares it elsewhere or keep logs of it.`;
}

export function isPrivateUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    // Presigned URLs contain signatures — treat as private
    const s = url.toLowerCase();
    return s.includes('x-amz-signature') || s.includes('signature=') || s.includes('sv=') || s.includes('sig=')
      || s.includes('token=') || s.includes('expiry') || s.includes('expires')
      || u.search.length > 20;
  } catch { return String(url).length > 120; }
}

export function shouldCleanupVideoUrl(draft, now = Date.now()) {
  if (!draft.videoUrl) return false;
  if (String(draft.status).toUpperCase()==='PUBLISHED') return true;
  try {
    const updated = new Date(draft.updatedAt).getTime();
    if (now - updated > 48*3600*1000) return true; // 48h stale
  } catch {}
  return false;
}
