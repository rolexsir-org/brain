// Instagram Graph API — account discovery & publishing helpers
// Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing
// All methods handle the 2-step Reel publishing plus permission / token errors.

import { CONFIG } from './config.js';

function apiBase() { return CONFIG.graphBase || 'https://graph.facebook.com/v26.0'; }

function authErrorFrom(body, status) {
  if (!body) return `Request failed (${status})`;
  const err = body.error || {};
  const code = err.code;
  const sub = err.error_subcode;
  const msg = err.message || body.error_description || '';
  // OAuthException 190 = invalid/expired token
  if (code === 190) return 'Instagram access expired or revoked. Please reconnect.';
  if (code === 4 || status === 429) return 'Meta API rate limit reached. Please try again in a few minutes.';
  if (code === 10) return 'Missing permission. Reconnect and allow Instagram publishing access.';
  if (code === 200) return msg || 'Permission denied. Check that your Instagram is a Business/Creator account.';
  return msg || `Meta error ${code || status}`;
}

async function graphFetch(path, { accessToken, method = 'GET', params = {}, body = null } = {}) {
  const url = new URL(`${apiBase()}/${String(path).replace(/^\//, '')}`);
  if (accessToken) params.access_token = accessToken;
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  }
  const opts = { method, headers: {} };
  if (method !== 'GET' && body) {
    // Graph API expects application/x-www-form-urlencoded for most calls
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (v != null) form.set(k, String(v));
    for (const [k, v] of Object.entries(params)) if (k !== 'access_token') form.set(k, String(v));
    // access_token in body for POST is also accepted; keep in query for simplicity
    if (accessToken && !form.has('access_token')) form.set('access_token', accessToken);
    opts.body = form.toString();
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (method !== 'GET' && Object.keys(params).length) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) form.set(k, String(v));
    opts.body = form.toString();
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  let res;
  try { res = await fetch(url.toString(), opts); }
  catch (e) { return { ok: false, error: e && e.message ? e.message : 'Network error', rateLimited: false, authExpired: false }; }
  let data;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const code = data && data.error ? data.error.code : null;
    return {
      ok: false,
      error: authErrorFrom(data, res.status),
      raw: data,
      status: res.status,
      code,
      authExpired: code === 190,
      rateLimited: code === 4 || res.status === 429
    };
  }
  return { ok: true, data, status: res.status };
}

// ── Account discovery ──────────────────────────────────────────────────────

export async function fetchUserPages(accessToken) {
  return graphFetch('me/accounts', { accessToken, params: { fields: 'id,name,access_token' } });
}

export async function fetchInstagramBusinessAccount(pageId, accessToken) {
  return graphFetch(pageId, { accessToken, params: { fields: 'instagram_business_account' } });
}

export async function fetchInstagramProfile(igUserId, accessToken) {
  return graphFetch(igUserId, {
    accessToken,
    params: { fields: 'id,username,name,profile_picture_url,followers_count,follows_count,media_count,account_type' }
  });
}

export async function discoverInstagramAccount(accessToken) {
  const pagesRes = await fetchUserPages(accessToken);
  if (!pagesRes.ok) return pagesRes;
  const pages = pagesRes.data && Array.isArray(pagesRes.data.data) ? pagesRes.data.data : [];
  if (!pages.length) return { ok: false, error: 'No Facebook Pages found. Link your Instagram Business account to a Page first.', code: 'no_pages' };

  for (const page of pages) {
    const igRes = await fetchInstagramBusinessAccount(page.id, accessToken);
    if (!igRes.ok) continue;
    const igId = igRes.data && igRes.data.instagram_business_account ? igRes.data.instagram_business_account.id : null;
    if (!igId) continue;
    const profile = await fetchInstagramProfile(igId, accessToken);
    if (!profile.ok) return { ok: false, error: profile.error, raw: profile.raw, authExpired: profile.authExpired };
    return {
      ok: true,
      igUserId: igId,
      pageId: page.id,
      pageName: page.name,
      profile: profile.data
    };
  }
  return { ok: false, error: 'No Instagram Business/Creator account linked to your Pages. Convert to Business in Instagram settings first.', code: 'no_ig_account' };
}

// ── Media publishing (2-step) ─────────────────────────────────────────────

/**
 * Step 1: Create a media container for a Reel.
 * Requires video_url to be a public HTTPS URL Meta can fetch.
 * Returns { ok, containerId, error }
 */
export async function createReelContainer(igUserId, { videoUrl, caption, coverUrl, shareToFeed, accessToken }) {
  if (!videoUrl) return { ok: false, error: 'Missing video_url for container.' };
  const body = {
    media_type: 'REELS',
    video_url: videoUrl,
    caption: caption || '',
    share_to_feed: shareToFeed !== false ? 'true' : 'false',
    access_token: accessToken
  };
  if (coverUrl) body.cover_url = coverUrl;
  const res = await graphFetch(`${igUserId}/media`, { accessToken, method: 'POST', body });
  if (!res.ok) return res;
  return { ok: true, containerId: res.data.id, data: res.data };
}

/**
 * Check container status until FINISHED or FAILED.
 * Polls every 2s up to ~60s (Meta processing).
 */
export async function pollContainerStatus(containerId, accessToken, { maxWaitMs = 60000, intervalMs = 2000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await graphFetch(containerId, { accessToken, params: { fields: 'status_code,status' } });
    if (!res.ok) return res;
    const code = res.data.status_code || res.data.status;
    if (code === 'FINISHED') return { ok: true, status: 'FINISHED', data: res.data };
    if (code === 'ERROR' || code === 'EXPIRED') return { ok: false, error: `Container ${code}: ${res.data.status || ''}`, status: code };
    // IN_PROGRESS / PUBLISHED etc — wait
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { ok: false, error: 'Timeout waiting for video processing. Try again shortly.', status: 'TIMEOUT' };
}

/**
 * Step 2: Publish the container.
 */
export async function publishContainer(igUserId, containerId, accessToken) {
  const res = await graphFetch(`${igUserId}/media_publish`, {
    accessToken,
    method: 'POST',
    body: { creation_id: containerId }
  });
  if (!res.ok) return res;
  return { ok: true, mediaId: res.data.id, data: res.data };
}

/**
 * Fetch permalink for a published media.
 */
export async function fetchPermalink(mediaId, accessToken) {
  const res = await graphFetch(mediaId, { accessToken, params: { fields: 'id,permalink,media_url,thumbnail_url,caption,timestamp' } });
  if (!res.ok) return res;
  return { ok: true, permalink: res.data.permalink || '', data: res.data };
}

// High-level publish with polling
export async function publishReel(igUserId, { videoUrl, caption, coverUrl, shareToFeed, accessToken }) {
  const container = await createReelContainer(igUserId, { videoUrl, caption, coverUrl, shareToFeed, accessToken });
  if (!container.ok) return container;
  const status = await pollContainerStatus(container.containerId, accessToken);
  if (!status.ok) return { ok: false, error: status.error, containerId: container.containerId, stage: 'processing' };
  const published = await publishContainer(igUserId, container.containerId, accessToken);
  if (!published.ok) return { ...published, containerId: container.containerId, stage: 'publish' };
  return { ok: true, mediaId: published.mediaId, containerId: container.containerId, stage: 'done' };
}

// ── Token validation helper ────────────────────────────────────────────────

export async function validateToken(accessToken) {
  const res = await graphFetch('me', { accessToken, params: { fields: 'id,name' } });
  if (!res.ok) return res;
  return { ok: true, data: res.data };
}
