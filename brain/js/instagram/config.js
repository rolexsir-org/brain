// Instagram Business Integration — Configuration
// This file contains only public configuration. Never store App Secret here.
// The exchange service holds secrets; the client only knows its redirect URI.

export const CONFIG = Object.freeze({
  // Meta App ID is injected at deploy time via window.BRAIN_INSTAGRAM_APP_ID
  // or via meta tag. Hardcoding is avoided to prevent leaking across forks.
  get appId() {
    try {
      if (typeof window !== 'undefined' && window.BRAIN_INSTAGRAM_APP_ID) return String(window.BRAIN_INSTAGRAM_APP_ID).trim();
      const meta = typeof document !== 'undefined' ? document.querySelector('meta[name=\"brain-instagram-app-id\"]') : null;
      if (meta && meta.content) return String(meta.content).trim();
      // Fallback: allow localhost dev via stored setting
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem('brain:instagram:appId');
        if (stored) return String(stored).trim();
      }
    } catch {}
    return '';
  },
  get redirectUri() {
    try {
      if (typeof window !== 'undefined' && window.BRAIN_INSTAGRAM_REDIRECT_URI) return String(window.BRAIN_INSTAGRAM_REDIRECT_URI).trim();
      if (typeof window !== 'undefined' && window.location) {
        // Default: /auth/instagram/callback on same origin — must be allowlisted in Meta dashboard
        return `${window.location.origin}/auth/instagram/callback`;
      }
    } catch {}
    return '';
  },
  get exchangeEndpoint() {
    try {
      if (typeof window !== 'undefined' && window.BRAIN_INSTAGRAM_EXCHANGE_URL) return String(window.BRAIN_INSTAGRAM_EXCHANGE_URL).trim();
      const meta = typeof document !== 'undefined' ? document.querySelector('meta[name=\"brain-instagram-exchange\"]') : null;
      if (meta && meta.content) return String(meta.content).trim();
    } catch {}
    return '';
  },
  get apiVersion() {
    try {
      const meta = typeof document !== 'undefined' ? document.querySelector('meta[name="brain-graph-version"]') : null;
      if (meta && meta.content) return String(meta.content).trim();
      if (typeof localStorage !== 'undefined') { const s=localStorage.getItem('brain:graph:version'); if(s) return String(s).trim(); }
      if (typeof window!=='undefined' && window.BRAIN_GRAPH_VERSION) return String(window.BRAIN_GRAPH_VERSION).trim();
    } catch {}
    return 'v21.0';
  },
  get graphBase() { return `https://graph.facebook.com/${this.apiVersion}`; },
  get oauthDialog() { return `https://www.facebook.com/${this.apiVersion}/dialog/oauth`; },
  // Minimum permissions for publishing Reels
  scopes: [
    'instagram_basic',
    'instagram_content_publish',
    'pages_show_list',
    'pages_read_engagement'
  ],
  // Optional extended scope when Business Management features needed
  optionalScopes: ['business_management']
});

export function isConfigured() {
  return !!CONFIG.appId && !!CONFIG.redirectUri;
}

export function getAuthorizeUrl(state, extraScopes = []) {
  if (!CONFIG.appId) throw new Error('Instagram App ID not configured');
  const scopes = [...CONFIG.scopes, ...extraScopes].join(',');
  const params = new URLSearchParams({
    client_id: CONFIG.appId,
    redirect_uri: CONFIG.redirectUri,
    scope: scopes,
    response_type: 'code',
    state
  });
  return `${CONFIG.oauthDialog}?${params.toString()}`;
}

// Media requirements — must match Meta docs (2025)
export const MEDIA_REQUIREMENTS = Object.freeze({
  formats: ['mp4', 'mov', 'quicktime'],
  mimeTypes: ['video/mp4', 'video/quicktime', 'video/mov', 'video/x-m4v'],
  minDurationSec: 3,
  maxDurationSec: 900, // 15 min hard max; Reels UI recommends ≤90s
  recommendedMaxDurationSec: 90,
  minWidth: 320,
  minHeight: 480,
  maxFileSizeBytes: 1_000 * 1024 * 1024,
  clientMaxFileSizeBytes: 250 * 1024 * 1024,
  captionMaxLength: 2200,
  hashtagMaxCount: 30
});

export const CAPTION_LIMIT = 2200;
export const HASHTAG_LIMIT = 30;
