// Media-transfer privacy documentation + utilities.
// Prefer official Meta direct upload; isolate temp storage usage.

export const TRANSFER_DOC = {
  preferred: 'Meta direct upload (video_url pointing to your own short-lived hosted URL) or resumable upload session (init → upload → finalize). See https://developers.facebook.com/docs/instagram-api/reference/ig-user/media#creating-reels',
  current: 'Brain uses a temporary hosted video_url you supply (e.g. Supabase Storage, S3 presigned URL, Cloudflare R2). The URL is stored only in the local draft (IndexedDB) and sent to Meta graph.facebook.com during create container. It is NEVER sent to any other host.',
  isolation: 'Temp video URLs are private, unguessable, and short-lived (expire in minutes/hours per your storage config). Brain deletes the draft.videoUrl after publish is confirmed or after 48h. No server logs private URLs.',
  lifetime: 'Recommended expiry: 1 hour for video_url presigned links. Draft cleanup job removes stale videoUrl after 24h if not published.',
  directUploadInvestigation: `Meta Instagram Graph API v26.0 now documents a resumable upload path (upload_type=resumable → rupload.facebook.com) as alternative to video_url. See docs/api-compatibility.md. Client direct multipart upload to /media is not used for Reels; video_url via temporary hosted link remains primary for local-first privacy. Alternatives: 1) Host video temporarily with signed URL (current), 2) Use your app server as lightweight streaming proxy for resumable bytes (no disk/log). Brain ships option 1; option 2 documented for self-hosters.`,
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
