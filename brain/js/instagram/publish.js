// Instagram publishing workflow — enforces explicit approval, idempotency, and
// honest status reporting. Never publish without user confirmation.

import { publishReel, fetchPermalink } from './api.js';
import { buildCaptionWithHashtags } from './media.js';

const PUBLISH_DEBOUNCE_MS = 3000;

function nowISO() { return new Date().toISOString(); }

/**
 * Prepare a publish request from a draft + connection.
 * Does NOT call the network — returns a preview object for user confirmation.
 */
export function preparePublishPreview(draft, connection) {
  if (!draft) return { ok: false, error: 'No Reel draft selected.' };
  if (!connection || !connection.connected) return { ok: false, error: 'Instagram not connected. Connect your Business account first.' };
  if (!connection.accessToken) return { ok: false, error: 'No access token. Reconnect Instagram.' };
  if (!draft.caption && (!draft.hashtags || !draft.hashtags.length)) {
    // Not an error — caption is optional but we warn
  }
  const caption = buildCaptionWithHashtags(draft.caption || '', draft.hashtags || []);
  const videoUrl = draft.tempVideoUrl || '';
  if (!videoUrl) {
    return {
      ok: false,
      error: 'This draft needs a public video URL. Use “Upload video to temporary hosting” after confirming — Brain must send Meta a URL it can fetch.',
      needsHosting: true
    };
  }
  return {
    ok: true,
    preview: {
      igUserId: connection.igUserId,
      username: connection.username,
      videoName: draft.videoName,
      videoMeta: `${draft.videoWidth || '?'}×${draft.videoHeight || '?'} · ${draft.videoDuration ? Math.round(draft.videoDuration) + 's' : '—'} · ${(draft.videoSize / 1048576).toFixed(1)} MB`,
      caption,
      captionLength: caption.length,
      hashtags: draft.hashtags || [],
      videoUrl,
      coverUrl: draft.coverUrl || null,
      shareToFeed: true
    }
  };
}

/**
 * Execute publish after explicit user approval.
 * Enforces: no duplicate publish for same draft in publishing state,
 * caption/hashtag honesty, and failure reporting.
 */
export async function executePublish(store, draftId, connection, { onProgress } = {}) {
  const draft = store.get('instagramDraft', draftId);
  if (!draft) return { ok: false, error: 'Draft not found.' };
  if (draft.status === 'publishing') {
    return { ok: false, error: 'This Reel is already publishing. Please wait.', duplicate: true };
  }
  if (draft.status === 'published') {
    return { ok: false, error: 'This Reel is already published.', duplicate: true };
  }
  if (!connection || !connection.connected) return { ok: false, error: 'Instagram disconnected. Reconnect first.' };
  if (isExpired(connection)) return { ok: false, error: 'Instagram access expired. Reconnect to publish.', authExpired: true };

  const preview = preparePublishPreview(draft, connection);
  if (!preview.ok) return preview;

  // Idempotency lock: mark as publishing before network
  const locked = await store.update('instagramDraft', draftId, {
    status: 'publishing',
    lastError: '',
    retryCount: (draft.retryCount || 0) + 1
  });
  if (!locked) return { ok: false, error: 'Could not lock draft for publishing. Try again.' };

  const report = (stage, msg) => { if (onProgress) try { onProgress(stage, msg); } catch {} };

  report('container', 'Creating media container…');
  let result;
  try {
    result = await publishReel(connection.igUserId, {
      videoUrl: preview.preview.videoUrl,
      caption: preview.preview.caption,
      coverUrl: preview.preview.coverUrl || undefined,
      shareToFeed: true,
      accessToken: connection.accessToken
    });
  } catch (e) {
    result = { ok: false, error: e && e.message ? e.message : 'Network error during publish.' };
  }

  if (!result.ok) {
    const isAuth = result.authExpired || /expired|revoked|permission/i.test(result.error || '');
    await store.update('instagramDraft', draftId, {
      status: isAuth ? 'failed' : 'failed',
      lastError: result.error || 'Unknown error',
      igContainerId: result.containerId || draft.igContainerId || null
    });
    return { ok: false, error: result.error, stage: result.stage || 'unknown', authExpired: isAuth };
  }

  report('published', 'Reel published! Fetching link…');
  let permalink = '';
  try {
    const link = await fetchPermalink(result.mediaId, connection.accessToken);
    if (link.ok) permalink = link.permalink || '';
  } catch {}

  const updated = await store.update('instagramDraft', draftId, {
    status: 'published',
    publishedAt: nowISO(),
    igMediaId: result.mediaId,
    igContainerId: result.containerId,
    permalink,
    lastError: ''
  });

  // Also record in publication history
  try {
    await store.add('instagramPublication', {
      draftId: draftId,
      igMediaId: result.mediaId,
      igContainerId: result.containerId,
      permalink,
      caption: preview.preview.caption,
      hashtags: draft.hashtags || [],
      videoName: draft.videoName,
      publishedAt: nowISO(),
      status: 'published'
    });
  } catch {}

  report('done', permalink ? `Published: ${permalink}` : 'Published successfully.');
  return { ok: true, mediaId: result.mediaId, permalink, draft: updated };
}

function isExpired(conn) {
  if (!conn || !conn.expiresAt) return false;
  try { return new Date(conn.expiresAt).getTime() <= Date.now(); } catch { return false; }
}

/**
 * Guard wrapper for UI publish button: debounce + single caller
 */
export function createPublishGuard() {
  let lastCall = 0;
  return {
    canProceed() {
      const now = Date.now();
      if (now - lastCall < PUBLISH_DEBOUNCE_MS) return false;
      lastCall = now;
      return true;
    },
    reset() { lastCall = 0; }
  };
}

// Caption helpers (local, no cloud AI)
const HASHTAG_TEMPLATES = {
  lifestyle: ['life', 'daily', 'inspiration', 'mindfulness', 'wellness'],
  food: ['foodie', 'homemade', 'recipe', 'foodporn', 'yum'],
  travel: ['travel', 'wanderlust', 'explore', 'adventure', 'vacation'],
  fitness: ['fitness', 'workout', 'gym', 'health', 'motivation'],
  fashion: ['fashion', 'style', 'ootd', 'outfit', 'trend'],
  business: ['business', 'entrepreneur', 'success', 'motivation', 'growth'],
  default: ['reels', 'viral', 'trending', 'instadaily', 'explorepage']
};

export function suggestHashtags(caption, categoryHint) {
  const low = String(caption || '').toLowerCase();
  let pool = [];
  if (categoryHint && HASHTAG_TEMPLATES[categoryHint]) pool = HASHTAG_TEMPLATES[categoryHint];
  else {
    for (const [key, tags] of Object.entries(HASHTAG_TEMPLATES)) {
      if (low.includes(key)) { pool = tags; break; }
    }
    if (!pool.length) pool = HASHTAG_TEMPLATES.default;
  }
  // Mix in keywords from caption
  const words = low.split(/[^a-z0-9]+/).filter(w => w.length >= 4 && w.length <= 16).slice(0, 5);
  const out = [...words.map(w => w.toLowerCase()), ...pool];
  return [...new Set(out)].slice(0, 10);
}

export function generateCaptionTemplate(topic) {
  const templates = [
    `Living my best ${topic || 'day'} — grateful for these moments ✨`,
    `Just dropped: ${topic || 'something special'} 🎬 What do you think?`,
    `POV: ${topic || 'your daily dose of inspiration'} 💫`,
    `Behind the scenes: ${topic || 'creating'} — stay tuned for more! 🚀`
  ];
  return templates[Math.floor(Math.random() * templates.length)];
}
