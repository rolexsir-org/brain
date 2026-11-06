// Minimal Instagram token-exchange service — keeps App Secret off the client.
// Deploy separately from Brain's static hosting. This is stateless and stores nothing.
// Required env: FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, ALLOWED_REDIRECT_URI (or comma list), ALLOWED_ORIGINS
//
// Usage (Node/CF/Netlify function):
//   POST /api/instagram/exchange { code, redirect_uri }
//   POST /api/instagram/exchange/refresh { access_token }
//   DELETE /api/instagram/permissions?access_token=...&user_id=...
//
// See docs/instagram-setup.md for deployment.

const GRAPH_VERSION = 'v26.0'; // keep in sync with constants INSTAGRAM_API_VERSION
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

function corsHeaders(origin, allowed) {
  const list = (allowed || '').split(',').map(s=>s.trim()).filter(Boolean);
  const open = !list.length;
  const allowedOrigin = open ? (origin || '*') : (list.includes(origin) ? origin : list[0]);
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
}

function jsonResponse(body, status=200, headers={}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type':'application/json', ...headers }});
}

// Cloudflare Workers / Node-like adapter
export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  const cors = corsHeaders(origin, env.ALLOWED_ORIGINS || '');

  if (request.method === 'OPTIONS') return new Response(null, { status:204, headers: cors });

  if (url.pathname.endsWith('/exchange') && request.method === 'POST') {
    let body; try { body = await request.json(); } catch { return jsonResponse({ error:'Invalid JSON' },400,cors); }
    const { code, redirect_uri } = body;
    if (!code || !redirect_uri) return jsonResponse({ error:'Missing code or redirect_uri' },400,cors);
    const allowedRedirects = (env.ALLOWED_REDIRECT_URI||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (allowedRedirects.length && !allowedRedirects.includes(redirect_uri)) return jsonResponse({ error:'redirect_uri not allowlisted' },403,cors);

    const tokenUrl = new URL(`${GRAPH}/oauth/access_token`);
    tokenUrl.searchParams.set('client_id', env.FACEBOOK_APP_ID);
    tokenUrl.searchParams.set('client_secret', env.FACEBOOK_APP_SECRET);
    tokenUrl.searchParams.set('redirect_uri', redirect_uri);
    tokenUrl.searchParams.set('code', code);

    const res = await fetch(tokenUrl.toString());
    const data = await res.json().catch(()=> ({}));
    if (!res.ok) return jsonResponse({ error: data.error?.message || `Token exchange failed (${res.status})`, details: data }, res.status, cors);

    // Optionally exchange for long-lived (60 days)
    if (data.access_token) {
      const llUrl = new URL(`${GRAPH}/oauth/access_token`);
      llUrl.searchParams.set('grant_type', 'fb_exchange_token');
      llUrl.searchParams.set('client_id', env.FACEBOOK_APP_ID);
      llUrl.searchParams.set('client_secret', env.FACEBOOK_APP_SECRET);
      llUrl.searchParams.set('fb_exchange_token', data.access_token);
      const llRes = await fetch(llUrl.toString());
      const llData = await llRes.json().catch(()=>null);
      if (llRes.ok && llData && llData.access_token) return jsonResponse(llData,200,cors);
    }
    return jsonResponse(data,200,cors);
  }

  if (url.pathname.endsWith('/exchange/refresh') && request.method === 'POST') {
    let body; try { body = await request.json(); } catch { return jsonResponse({ error:'Invalid JSON' },400,cors); }
    const token = body.access_token;
    if (!token) return jsonResponse({ error:'Missing access_token' },400,cors);
    const refreshUrl = new URL(`${GRAPH}/oauth/access_token`);
    refreshUrl.searchParams.set('grant_type', 'fb_exchange_token');
    refreshUrl.searchParams.set('client_id', env.FACEBOOK_APP_ID);
    refreshUrl.searchParams.set('client_secret', env.FACEBOOK_APP_SECRET);
    refreshUrl.searchParams.set('fb_exchange_token', token);
    const res = await fetch(refreshUrl.toString());
    const data = await res.json().catch(()=>({}));
    if (!res.ok) return jsonResponse({ error: data.error?.message || `Refresh failed (${res.status})` }, res.status, cors);
    return jsonResponse(data,200,cors);
  }

  return jsonResponse({ error:'Not found' },404,cors);
}

// Node http example (for simple VPS)
if (typeof process !== 'undefined' && process.env) {
  // Express-like minimal handler if run directly
  // Usage: node server/instagram-exchange.js (expects env vars)
}

// Example Netlify Function wrapper:
// exports.handler = async (event) => {
//   const req = new Request(`https://example.com${event.path}`, { method:event.httpMethod, headers:event.headers, body:event.body });
//   const res = await handleRequest(req, process.env);
//   return { statusCode: res.status, headers: Object.fromEntries(res.headers.entries()), body: await res.text() };
// }
