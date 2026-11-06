# Release Checklist — Brain v2.3.0

Pass all; any fail blocks release.

## Automated (CI-equivalent)

| Check | Command | Expected | Last run (2026-11-06) |
|-------|---------|----------|-----------------------|
| Unit | `cd brain && npm run test:unit` | 136/136 pass, 0 fail | `tests 136 pass 0` |
| UI smoke | `cd brain && npm run test:ui` (after `npm install`) | 9 focus-trap/modal/aria checks pass (collection count, inert) | `JSDOM` modal `aria-hidden` toggle + Tab wrap pass |
| Full + smoke | `npm test` | `node --test test/*.test.js && node scripts/ui-smoke.mjs` all green | 136 OK (ui-smoke needs `npm install`) |
| Harness | `node audit.js` | 40/40 PASS (API, fencing, security, privacy, browser) | `40/40 PASS` in report |
| Certification | `node scripts/certification-harness.mjs` | 52/52 PASS (publishing 14, security 15, privacy 7, recovery 11, build 5) | `52/52 PASS` (2026-11-06) |
| Build | `cd brain && npm run build` | `Production app shell verified (41 required assets)` + `--check` syntax per `verify-build.mjs` | Verified 2026-11-06 |
| Secret scan | `grep -r APP_SECRET brain --include="*.js" --exclude-dir=node_modules \| grep -v server/` | 0 leaks (only `server/` env) | 0 (docs/tests excluded) |
| Audit | `cd brain && npm audit --production` | Runtime 0 HIGH (dev-only `undici`/`source-map-js` HIGH via `jsdom` disclosed) | 2 HIGH dev-only |
| License | `npx license-checker --summary --production` | `MIT` etc., runtime 0 bundled deps | runtime 0, dev MIT |

## Manual (HTTPS, on target devices)

- [ ] Android Chrome — browse + PWA installed: add task, photo import, voice if available, offline reload, reminder fires.
- [ ] iOS Safari + A2HS — browse + Add to Home Screen, same checklist (camera/voice variance noted).
- [ ] Desktop keyboard-only — Tab through composer, menu sheet focus trap (Tab wraps, Escape closes), `aria-expanded` toggles.
- [ ] Instagram test user (not live account): **Connect** (`facebook.com/v26.0/dialog/oauth` consent) → status `@username expires in …` → **Check** valid → pick MP4 → validate → **Preview** → **Publish** (tap) → `Published: permalink` → library + queue empty → **Disconnect** → `disconnected` + revoked.
- [ ] Automation (if used): enable `AUTOMATED`, tick 1 eligible draft, rule `maxPerDay=1`, verify auto-publishes once, disable → stops.
- [ ] Backup: export plaintext (`25 MB` limit) then encrypted with 6-char pass → preview counts → **Merge** adds, **Replace** with `delete-{type}` token → verify counts via `storageReport()`; clear site data → restore on clean profile succeeds.
- [ ] Storage pressure: fill quota → `QuotaExceeded` toast + `Temporary storage` banner, `flush()` retry, data intact.
- [ ] Diagnostics: Menu → *Diagnostics* shows `VERSION 2.3.0, SCHEMA 5, Storage: indexeddb (persistent)`, `Copy report` token redacted `••••`.

## Version coherence (block if mismatch)

- `package.json 2.3.0` = `constants.js VERSION 2.3.0` = `sw.js VERSION brain-v2.3.0` = `api-compatibility.md v26.0` = `instagram-integration.md v26.0`.
- Graph version default `v26.0` not hard-coded elsewhere (scan `grep -r v21 brain --include=*.js --include=*.html` outside test+docs chronology → 0).

## Evidence to attach

`npm test` log, `npm run build` log, `audit.js` log (40/40), `certification-harness.mjs` log (52/52), manual screencast of Connect→Publish→Insights, DevTools Network (allowlist check).

## Known limitations acknowledged

Scheduling is reminder-based, not background publish; presigned host expiry is yours; `2s×60s` poll stricter than Meta `60s×5`; dev-audit HIGH are not shipped. Document before release.

No release with a failing automated check.
