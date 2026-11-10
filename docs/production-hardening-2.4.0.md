# Brain 2.4.0 — Production Hardening Pass

This release fixes defects that were invisible to the existing 2.3.0 test suite
and adds the pieces a deployment actually needs: hardened servers, deploy-time
security headers, dependency hygiene, and release gates that fail the build when
they regress.

Nothing here changes Brain's data model or local-first design. Schema stays 5;
no record is migrated, and no telemetry is added.

---

## 1. Defects fixed

| # | Severity | Where | Defect | Fix | Regression test |
|---|----------|-------|--------|-----|-----------------|
| 1 | **Critical (data recovery)** | `js/app.js` restore flow | Encrypted backups were only recognised when they started with `brain-enc-v1.`, but the exporter writes `brain-enc-v2.`. Every encrypted backup made by Brain was rejected as "not a valid Brain backup" — the only backup form that protects secrets was unrestorable. | Use `isEncryptedBackup()` (accepts v1 and v2) and decrypt before preview. | `scripts/ui-smoke.mjs`: builds a v2 backup, restores it through Settings → Restore, asserts the record appears in the app |
| 2 | High | `server/instagram-exchange.js` | CORS failed **open** (`*`) when `ALLOWED_ORIGINS` was unset; a misconfigured deploy let any site call the token service. | Fail closed: unlisted/absent Origin gets no CORS grant and an explicit `403 origin_not_allowed`. `*` must be opted into. | `test/exchange.test.js` |
| 3 | High | `server/instagram-exchange.js` | No body limit; `request.json()` accepted unbounded payloads. | 4 KB cap (`Content-Length` fast reject + post-read check) and JSON content-type enforcement (`413`/`415`). | `test/exchange.test.js` |
| 4 | High | `server/instagram-exchange.js` | Token responses were cacheable, and upstream URLs (which contain `client_secret`) had no timeout. | `Cache-Control: no-store`, `Pragma: no-cache`, plus a 10 s abortable upstream timeout mapped to `502`. Errors never echo the secret or the URL. | `test/exchange.test.js` |
| 5 | High | `server/instagram-exchange.js` | Missing App Secret produced a call to Meta with `client_secret=undefined` instead of an operator-visible failure; no abuse guard. | Config check before touching the body (`500 service_misconfigured`), per-IP token bucket (`429` + `Retry-After`), `GET /health`. A missing `ALLOWED_REDIRECT_URI` also fails closed. | `test/exchange.test.js` (17 cases) |
| 6 | Medium | `js/store/db.js` | A browser-closed IndexedDB connection (another tab upgrading the schema) made every later read/write throw for the rest of the session. There was also no `versionchange` handler and concurrent opens leaked connections. | `versionchange`/`close` handlers drop the handle; `_withRetry` reopens once on `InvalidStateError`; concurrent `openDb` calls share one promise; a 4 s open timeout replaces an indefinite block. | `test/db.test.js` |
| 7 | Medium | `js/store/db.js` | localStorage has no transaction: a quota error midway through `kvSetMany` left a half-updated snapshot. | Track written keys and restore their previous values on failure. | `test/db.test.js` |
| 8 | Medium | `js/app.js` boot | If the very first IndexedDB save failed (quota, blocked storage), `Store.init()` threw and the app replaced the whole document with one sentence — no retry, no path to a backup. | First-run save failure degrades to a persistence warning instead of a boot failure; a fatal screen now explains that data was not deleted and offers retry. | `test/store.test.js` / manual |
| 9 | Medium | `js/app.js` | Unhandled promise rejections (background queue, brief bookkeeping) failed silently; the conversation array grew without bound in long sessions. | Global `unhandledrejection`/`error` reporting through the existing toast, `.catch()` on brief bookkeeping, queue failures logged, transcript capped at 400 blocks. | `test/release.test.js`, UI smoke |
| 10 | Medium | `js/app.js` restore | (Superseded by 1.) Restore preview re-parsed raw text and assumed unencrypted input. | Same fix path; preview now always runs on decrypted JSON. | UI smoke |
| 11 | Low | `js/install.js`, `js/instagram/coverPicker.js` | Blocking `window.alert()` for iOS install help and "preview a frame first" lost focus and is announced inconsistently. | In-page dialog for iOS instructions (Escape/backdrop close, focus restored) and inline `role=status` feedback for covers. | manual |
| 12 | Low | `sw.js` | Navigation responses were cached per query string (launch URLs with reminder ids/OAuth params), growing CacheStorage; a flaky network could stall app start; one missing precache asset aborted the whole install. | Cache only the shell URL, 8 s navigation timeout with cached fallback, per-asset precache with a warning, background refresh of cached assets. | `test/sw.test.js`, audit |
| 13 | Low | `js/store/store.js` | Migration captured `beforeCounts` but never compared it — a migration that emptied a collection would go unnoticed. Dead no-op `_migrateInstagramStatuses`. | Compare counts after migration and record the loss in the corruption report (pre-migration backup already retained); remove the no-op. | `test/migrate.test.js`, manual |
| 14 | Low | `audit.js`, `scripts/certification-harness.mjs` | Both harnesses assumed the repo root as cwd: 16 `ENOENT` failures and a Phase 9 `TypeError` when run from `brain/`, and nonzero exits were not propagated. | Resolve paths from `import.meta.url`, guard missing child-process output, exit nonzero on failure. | run from any cwd (evidence below) |
| 15 | Low | dependencies | `npm audit`: 2 high advisories (`undici`, `source-map-js`) through dev-only `jsdom`/`fake-indexeddb`. | `jsdom` 29 → 31, `fake-indexeddb` 6.2.5 → 6.2.8; `npm audit` is clean. | `npm audit` |
| 16 | **High (feature broken)** | `js/app.js` menu → panels | Command Centre, Automation Centre, Diagnostics, and the Instagram hub were opened by first calling `closeSheet()`, which schedules `history.back()`. The resulting `popstate` closed the panel that had just opened, so these entry points frequently flashed and disappeared; when they did stay open, the background was not marked inert because panel modules bypassed the shell's modal state. | Panels open in place; they ask the shell to open the sheet through a `brain:sheet-open` event so focus trapping, background inertness, and the history entry stay correct. | `scripts/ui-smoke.mjs` (opens all four panels, asserts dialog state + background hidden + Escape close) |
| 17 | Medium | `js/actions/external.js` | WhatsApp links for numbers stored with a national trunk zero produced unreachable numbers (`09876500011` + `91` → `9109876500011`). | Strip leading zeros before applying the country code. | `test/external.test.js` |
| 18 | Low | `js/store/validate.js` | An Instagram draft's `coverUrl` (hosted URL) was copied into `coverDataUrl` (inline image field), and a `data:text/html` cover survived as `coverUrl`. | `coverDataUrl` now only ever holds a validated raster data URL; `coverUrl` only ever holds a non-data URL. | `test/validate.test.js` |
| 19 | Low | release process | Nothing verified that `package.json`, `constants.VERSION`, and the service-worker cache name agree, or that every precached asset exists. | `test/release.test.js` gates version coherence, manifest/icons, CSP, precache existence, secret scan, deploy headers, docs. | `npm test` |

Also fixed along the way: `mediaIntegrityReport` had a duplicated condition, and
the service worker no longer risks a `waitUntil` call after its dispatch window.

---

## 2. New production surface

### `server/static-server.mjs` (zero dependencies)

A deployable static server with an explicit public allowlist
(`index.html`, `manifest.webmanifest`, `sw.js`, `css/`, `js/`, `icons/`).
It returns `404` for `/package.json`, `/test/*`, `/server/*`, dotfiles, and every
traversal variant; adds CSP/HSTS/nosniff/Referrer-Policy/COOP/CORP/
Permissions-Policy; gzips text assets; implements ETag/`304`; sets
`no-cache` on the shell and worker; exposes `/healthz`; handles `HEAD` and
`405`; shuts down gracefully.

Verified by `test/server.test.js` (10 cases), including a traversal matrix and a
regression for a relative-path bug (`/` resolved against cwd instead of the
module root).

### Deploy-time headers

- `brain/_headers` — Netlify / Cloudflare Pages.
- `brain/vercel.json` — Vercel headers, cache policy, `/auth/*` rewrite.

Both carry the same CSP as `index.html` plus `frame-ancestors 'none'` (which a
meta tag cannot enforce) and HSTS. `docs/deployment.md` explains where the
Instagram exchange origin must be added to `connect-src`.

### `docs/deployment.md`

Hosting options, the exact exchange-service environment, OAuth/Meta dashboard
values, CSP implications, release commands, verification curls, rollback, and
operational limits.

---

## 3. Verification (this branch)

```
cd brain && npm ci
npm test                      # 178 tests pass, 0 fail + 44 UI smoke checks
npm run build                 # Production app shell verified (41 required assets)
npm audit                     # found 0 vulnerabilities
cd .. && node audit.js        # PASS 40/40, FAIL 0
node scripts/certification-harness.mjs   # PASS 52/52, FAIL 0
```

Cross-directory runs (the cwd bug that motivated fix 14):

```
cd brain && node ../audit.js                            # PASS 40/40
cd brain && node ../scripts/certification-harness.mjs   # PASS 52/52
cd /tmp  && node /path/to/brain/audit.js                 # PASS 40/40
```

Version coherence: `package.json` 2.4.0, `constants.js VERSION` 2.4.0,
`sw.js` cache `brain-v2.4.0`. The service-worker cache name changed with the
release, so installed clients fetch the corrected modules instead of serving
2.3.0 code from cache.

---

## 4. Remaining limitations (honest)

- **Background alarms:** a PWA cannot guarantee a reminder after the OS suspends
  it. Brain catches up when reopened and says so in its copy; this release does
  not pretend otherwise.
- **Rate limiting is per process.** On Cloudflare Workers or Lambda each isolate
  has its own bucket, so it is an abuse brake, not a global quota. Put a WAF or
  platform rate limit in front for hard guarantees.
- **CSP is duplicated** in `index.html` and the header configs. A browser
  enforces the intersection, so all copies must be updated together when adding
  an origin; `test/release.test.js` checks the header files still carry the
  security directives but cannot infer your exchange host.
- **`ALLOWED_REDIRECT_URI` is now mandatory** for `/exchange`. Deployments that
  previously omitted it will get `500 service_misconfigured` until it is set —
  intentional, because the alternative is accepting any redirect URI.
- **Instagram publishing** still needs Meta App Review and Business
  Verification; testers must be added to the app. Nothing in Brain can shortcut
  that.
- **No end-to-end browser test** (Playwright/WebDriver) is included: the UI smoke
  test runs under jsdom, which does not exercise layout, real service-worker
  registration, or file pickers. Those remain manual checks in the release
  checklist.
- **jsdom's `atob` cannot be transplanted** into the Node realm used by the
  smoke harness, so the harness supplies Buffer-backed equivalents. That is a
  test-environment shim, not a change to app behaviour.
