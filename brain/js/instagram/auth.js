// Instagram Business OAuth — state validation, lifecycle, and token management
// Security-critical: state is CSRF protection, token handling, expiration, refresh.
// App Secret is never in this file; exchange happens server-side via CONFIG.exchangeEndpoint.

import { CONFIG, getAuthorizeUrl } from './config.js';

const STATE_KEY = 'brain:instagram:oauth_state';
const STATE_TS_KEY = 'brain:instagram:oauth_state_ts';
const STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// ── State generation & validation (CSRF) ───────────────────────────────────

export function generateState() {
  const bytes = new Uint8Array(32);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const state = `${Date.now().toString(36)}-${hex}`;
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(STATE_KEY, state);
      sessionStorage.setItem(STATE_TS_KEY, String(Date.now()));
    }
  } catch {}
  return state;
}

export function validateState(returnedState) {
  try {
    const stored = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STATE_KEY) : null;
    const tsRaw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STATE_TS_KEY) : null;
    if (!stored || !returnedState) return { ok: false, reason: 'Missing OAuth state. Please try connecting again.' };
    // Single-use: clear even on failure to prevent replay
    try { sessionStorage.removeItem(STATE_KEY); sessionStorage.removeItem(STATE_TS_KEY); } catch {}
    if (stored !== returnedState) return { ok: false, reason: 'OAuth state mismatch — possible CSRF. Please try again from Brain.' };
    const ts = tsRaw ? parseInt(tsRaw, 10) : 0;
    if (Date.now() - ts > STATE_EXPIRY_MS) return { ok: false, reason: 'OAuth request expired. Please connect again.' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'Cannot validate OAuth state in this browser.' };
  }
}

export function clearStoredState() {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(STATE_KEY);
      sessionStorage.removeItem(STATE_TS_KEY);
    }
  } catch {}
}

// ── OAuth initiation ───────────────────────────────────────────────────────

export function getLoginUrl(extraScopes = []) {
  const state = generateState();
  return { url: getAuthorizeUrl(state, extraScopes), state };
}

export function redirectToLogin(extraScopes = []) {
  const { url } = getLoginUrl(extraScopes);
  try {
    if (typeof window !== 'undefined' && window.location) window.location.href = url;
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'Cannot redirect to login' };
  }
}

// ── Callback parsing ───────────────────────────────────────────────────────

export function parseCallbackParams(urlString) {
  try {
    const url = new URL(urlString || (typeof window !== 'undefined' ? window.location.href : ''));
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDesc = url.searchParams.get('error_description') || url.searchParams.get('error_reason') || '';
    return { code, state, error, errorDesc };
  } catch {
    return { code: null, state: null, error: 'parse_failed', errorDesc: '' };
  }
}

export function parseHashParams(hash) {
  try {
    const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    return { accessToken: params.get('access_token'), state: params.get('state'), error: params.get('error') };
  } catch { return { accessToken: null, state: null, error: null }; }
}

// ── Token lifecycle helpers ────────────────────────────────────────────────

export function isTokenExpired(connection) {
  if (!connection || !connection.expiresAt) return false; // no expiry info → assume valid, validate via API
  try {
    const exp = new Date(connection.expiresAt).getTime();
    if (Number.isNaN(exp)) return false;
    return Date.now() >= exp - 5 * 60 * 1000; // 5 min buffer
  } catch { return false; }
}

export function tokenExpiresIn(connection) {
  if (!connection || !connection.expiresAt) return null;
  try {
    const exp = new Date(connection.expiresAt).getTime();
    if (Number.isNaN(exp)) return null;
    const diff = exp - Date.now();
    return diff > 0 ? diff : 0;
  } catch { return null; }
}

export function tokenExpiryLabel(connection) {
  const ms = tokenExpiresIn(connection);
  if (ms == null) return 'unknown expiry';
  if (ms === 0) return 'expired';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `expires in ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `expires in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `expires in ${days} days`;
}

export function needsRefresh(connection) {
  const ms = tokenExpiresIn(connection);
  if (ms == null) return false;
  return ms < 24 * 60 * 60 * 1000; // < 24h → should refresh
}

// ── Connection status ──────────────────────────────────────────────────────

export function getConnectionStatus(connection) {
  if (!connection || !connection.connected) return 'disconnected';
  if (isTokenExpired(connection)) return 'expired';
  if (!connection.igUserId) return 'incomplete';
  return 'connected';
}

export function isConnected(connection) {
  return getConnectionStatus(connection) === 'connected';
}

// ── Scopes validation ──────────────────────────────────────────────────────

export function hasRequiredScopes(scopes) {
  const set = new Set((scopes || []).map(s => String(s).toLowerCase()));
  return ['instagram_basic', 'instagram_content_publish'].every(s => set.has(s));
}

// ── Token exchange (requires minimal backend) ──────────────────────────────

export async function exchangeCodeForToken(code, redirectUri) {
  const endpoint = CONFIG.exchangeEndpoint;
  if (!endpoint) {
    return {
      ok: false,
      error: 'Token exchange service not configured. Set BRAIN_INSTAGRAM_EXCHANGE_URL or use manual token entry for testing.',
      needsManual: true
    };
  }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: redirectUri || CONFIG.redirectUri })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let msg = `Exchange failed (${res.status})`;
      try { const j = JSON.parse(body); msg = j.error || j.message || msg; } catch { if (body) msg = body.slice(0, 500); }
      return { ok: false, error: msg };
    }
    const data = await res.json();
    return { ok: true, accessToken: data.access_token, expiresIn: data.expires_in, tokenType: data.token_type || 'bearer', data };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'Network error during token exchange' };
  }
}

export async function refreshLongLivedToken(accessToken) {
  const endpoint = CONFIG.exchangeEndpoint;
  if (!endpoint) return { ok: false, error: 'Exchange service not configured for refresh.' };
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `Refresh failed (${res.status}): ${body.slice(0, 500)}` };
    }
    const data = await res.json();
    return { ok: true, accessToken: data.access_token, expiresIn: data.expires_in, tokenType: data.token_type || 'bearer' };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'Network error during refresh' };
  }
}

// ── Disconnect & revocation ────────────────────────────────────────────────

export async function revokePermissions(accessToken, userId) {
  if (!accessToken) return { ok: true };
  try {
    const res = await fetch(`${CONFIG.graphBase}/${userId || 'me'}/permissions?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'DELETE'
    });
    return { ok: res.ok };
  } catch {
    return { ok: false, error: 'Could not reach Meta to revoke permissions. Local disconnect still completed.' };
  }
}

// Local disconnect is always performed even if revoke fails
export function buildDisconnectedConnection() {
  return {
    connected: false,
    igUserId: '',
    username: '',
    name: '',
    profilePictureUrl: '',
    pageId: '',
    accessToken: '',
    tokenType: 'bearer',
    expiresAt: null,
    connectedAt: null,
    lastValidatedAt: null,
    scopes: []
  };
}

export function buildConnectedConnection({ igUserId, username, name, profilePictureUrl, pageId, accessToken, tokenType, expiresIn, scopes }) {
  const now = new Date();
  const expiresAt = expiresIn ? new Date(now.getTime() + Number(expiresIn) * 1000).toISOString() : null;
  return {
    connected: true,
    igUserId: String(igUserId || ''),
    username: String(username || '').replace(/^@/, ''),
    name: String(name || ''),
    profilePictureUrl: String(profilePictureUrl || ''),
    pageId: String(pageId || ''),
    accessToken: String(accessToken || ''),
    tokenType: String(tokenType || 'bearer'),
    expiresAt,
    connectedAt: now.toISOString(),
    lastValidatedAt: now.toISOString(),
    scopes: Array.isArray(scopes) ? scopes : []
  };
}

// Clean OAuth params from URL after handling
export function cleanCallbackUrl() {
  try {
    if (typeof window === 'undefined' || !window.history || !window.location) return;
    const url = new URL(window.location.href);
    const hasOAuth = url.searchParams.has('code') || url.searchParams.has('state') || url.searchParams.has('error');
    if (!hasOAuth) return;
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    url.searchParams.delete('error');
    url.searchParams.delete('error_description');
    url.searchParams.delete('error_reason');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {}
}
