# Deploying Brain

Brain is a static PWA plus one optional service (the Instagram token exchange).
Nothing else is required: there is no database, no account system, and no
telemetry.

- **App shell:** `brain/` — `index.html`, `manifest.webmanifest`, `sw.js`,
  `css/`, `js/`, `icons/`.
- **Optional service:** `brain/server/instagram-exchange.js` — swaps an OAuth
  `code` for an Instagram token using the App Secret. Deploy it only if you want
  Instagram publishing; Brain works fully without it.

Never deploy `brain/server/`, `brain/test/`, `brain/package.json`, or
`node_modules/` to the public origin. The bundled static server enforces this
allowlist; the CDN configs below rely on the `brain/` directory itself.

---

## 1. Which files go where

| Path | Public? | Purpose |
|------|---------|---------|
| `brain/index.html`, `brain/sw.js`, `brain/manifest.webmanifest` | yes | app shell |
| `brain/css/`, `brain/js/`, `brain/icons/` | yes | assets |
| `brain/_headers` | deploy config | headers for Netlify / Cloudflare Pages |
| `brain/vercel.json` | deploy config | headers + rewrites for Vercel |
| `brain/server/*` | no | static server + token exchange |
| `brain/test/*`, `brain/scripts/*` | no | tests/build checks |
| `docs/*`, `audit.js` | no | engineering records |

`brain/vercel.json` and `brain/_headers` are harmless if served, but keep them
out of the public tree when your host lets you exclude files.

---

## 2. Option A — bundled static server (VPS, Docker, Fly, Railway)

```bash
cd brain
npm ci --omit=dev          # dev deps are only needed for tests
PORT=8000 node server/static-server.mjs
```

- Binds `0.0.0.0` by default (`HOST` overrides).
- Serves only `index.html`, `manifest.webmanifest`, `sw.js`, `css/`, `js/`,
  `icons/`; everything else is `404` (including `/package.json` and traversal
  attempts).
- Adds HSTS, CSP (with `frame-ancestors 'none'`), `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, COOP/CORP.
- gzip for text assets, `ETag`/`304`, `Cache-Control: no-cache` for the shell and
  service worker, `max-age=300` for assets.
- `GET /healthz` → `{"ok":true,"app":"brain"}` for uptime checks.
- Deep links without a file extension (for example
  `/auth/instagram/callback?code=…`) return the shell; the client cleans the URL.
- Graceful `SIGTERM`/`SIGINT` shutdown.

Put TLS in front of it (Caddy, nginx, or your platform). HSTS assumes HTTPS.

## 3. Option B — Netlify / Cloudflare Pages

Publish directory: `brain`. Headers come from `brain/_headers`:

- CSP, HSTS, `nosniff`, `Referrer-Policy`, COOP/CORP, `Permissions-Policy`;
- `no-cache` for `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest`;
- 5-minute revalidation for `/js/*` and `/css/*`, 1 day for `/icons/*`.

No rewrite rules are needed: `/auth/instagram/callback` has no file extension,
and both platforms serve `index.html` for unknown paths. If your host uses a
strict 404 page instead, add a rewrite of `/auth/*` and `/` to `/index.html`.

## 4. Option C — Vercel

`brain/vercel.json` sets the same headers, `cleanUrls`, and a rewrite from
`/auth/(.*)` to `index.html`. Set the project root to `brain`.

## 5. Instagram token exchange (optional)

Deploy `server/instagram-exchange.js` somewhere that can hold secrets — a
Cloudflare Worker, a Lambda/Netlify/Vercel function, or Node:

```bash
FACEBOOK_APP_ID=… \
FACEBOOK_APP_SECRET=… \
ALLOWED_REDIRECT_URI=https://brain.example/auth/instagram/callback \
ALLOWED_ORIGINS=https://brain.example \
PORT=8787 \
node server/instagram-exchange.js
```

| Variable | Required | Meaning |
|----------|----------|---------|
| `FACEBOOK_APP_ID` | yes | Meta app id |
| `FACEBOOK_APP_SECRET` | yes | Meta app secret — server-side only |
| `ALLOWED_REDIRECT_URI` | yes | exact redirect URI(s), comma-separated. The service refuses to exchange without it |
| `ALLOWED_ORIGINS` | strongly recommended | exact browser origin(s), comma-separated. With none set, browsers cannot call the service cross-origin |
| `GRAPH_VERSION` | no | defaults to `v26.0` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | no | per-IP budget, default 30 requests / 60 s |
| `UPSTREAM_TIMEOUT_MS` | no | Meta timeout, default 10 s |

Behaviour worth knowing:

- `POST /exchange` `{code, redirect_uri}` → `{access_token, token_type, expires_in}`.
- `POST /exchange/refresh` `{access_token}` → refreshed long-lived token.
- `GET /health` → `{ok, configured, graph}` (no secrets); 200 even when
  unconfigured, with `configured:false` so monitoring can distinguish "down"
  from "not set up".
- A deployment prefix such as `/api/instagram/exchange` works.
- Fail-closed: missing credentials → `500 service_misconfigured`; unlisted
  `Origin` → `403` with no CORS grant; unlisted redirect URI → `403`; body over
  4 KB → `413`; Meta timeout → `502`; rate limit → `429` with `Retry-After`.
- Token responses carry `Cache-Control: no-store`; upstream URLs (which contain
  the client secret) are never echoed or logged.

### CSP must allow the exchange origin

`index.html` ships `connect-src 'self' https://graph.facebook.com …`. If the
exchange lives on another origin (for example `https://exchange.example.com`),
add it to **both** the meta tag in `index.html` and the deployment header
(`_headers`, `vercel.json`, or `BRAIN_PUBLIC_ORIGIN` for the bundled server).
Otherwise the browser blocks the exchange. Same origin (a reverse proxy under
`https://brain.example/api/instagram/exchange`) needs no CSP change.

### Meta dashboard

- Valid OAuth Redirect URIs: `https://brain.example/auth/instagram/callback`
  (plus `http://localhost:8000/...` for development).
- Permissions: `instagram_basic`, `instagram_content_publish`,
  `pages_show_list`, `pages_read_engagement` (and `business_management` only if
  you need it). Producing for real users requires App Review and Business
  Verification.

---

## 6. Configuration of the client

Two deploy-time values are read from the document (or `window`):

```html
<meta name="brain-instagram-app-id" content="YOUR_APP_ID">
<meta name="brain-instagram-exchange" content="https://brain.example/api/instagram/exchange">
```

Optional overrides: `window.BRAIN_INSTAGRAM_APP_ID`,
`window.BRAIN_INSTAGRAM_REDIRECT_URI`, `window.BRAIN_INSTAGRAM_EXCHANGE_URL`,
`window.BRAIN_GRAPH_VERSION`. `localStorage['brain:instagram:appId']` exists for
local development only — do not rely on it in production.

---

## 7. Release procedure

```bash
cd brain
npm ci
npm test                  # unit + exchange + server + release gates + UI smoke
npm run build             # verifies every precached asset exists
node ../audit.js          # 40 independent acceptance checks
node ../scripts/certification-harness.mjs   # 52 certification checks
```

Bump all three version sources together — `package.json`, `VERSION` in
`js/util/constants.js`, and `VERSION` in `sw.js` (`brain-vX.Y.Z`). A release test
fails if they disagree. The service worker cache name is versioned, and old
`brain-*` caches are deleted on activation, so installed clients pick up new
assets on the next load.

Deploy only the public tree, then verify:

```bash
curl -sI https://brain.example/ | grep -i -E 'content-security-policy|strict-transport|nosniff|cache-control'
curl -s https://brain.example/healthz        # bundled server only
curl -s https://brain.example/sw.js | head -n 8   # cache name matches release
```

## 8. Rollback

- Redeploy the previous build. The old service worker cache is recreated under
  its own versioned name; installed clients activate it on next load.
- Data is not touched by deploys: records live in the browser's IndexedDB
  (`brain`, schema 5). Before any risky migration Brain writes a
  `backup:pre-migration:*` entry inside the same database.
- If a Meta Graph version has to be rolled back, set
  `localStorage['brain:graph:version']` to the previous version; v26.0 is the
  current default.

## 9. Operational notes

- **No server state:** tokens never reach the exchange service's storage. Rate
  limiting is in-process; on serverless platforms each isolate keeps its own
  budget, so treat it as a blunt abuse guard, not a quota system.
- **Logs:** the static server logs only unexpected errors. Neither service logs
  request bodies, tokens, or full URLs.
- **Health checks:** `/healthz` (static server) and `/health` (exchange).
- **Backups:** Brain is local-first. Users export an encrypted or plain JSON
  backup from Settings → Back up my data. Nothing is recoverable server-side.
