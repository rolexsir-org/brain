# Release Checklist — Brain v2.3.0 (S)

**Criteria:** all must pass.

- [ ] `npm test` — 123 unit + UI smoke pass, security tests pass
- [ ] `npm run build` — 40 assets verified, SW precache complete
- [ ] `npm audit` — 0 high/critical (allow low for dev deps, document)
- [ ] Secret scan — `grep -r APP_SECRET|PRIVATE_KEY|TOKEN` finds only docs/examples, no real secret
- [ ] License check — runtime has 0 bundled deps (only dev: fake-indexeddb MIT, jsdom MIT) — `npx license-checker --production` confirms
- [ ] Accessibility — `npm run test:ui` asserts modal, aria, focus trap pass; manual Lighthouse a11y ≥95
- [ ] Manual: PWA install, offline reload, reminder, Instagram connect (test user), publish with explicit tap
- [ ] Manual: backup export (plain+encrypted), import on clean profile, verify counts
- [ ] Manual: storage full simulation (fill quota, expect warning, no data loss)
- [ ] Diagnostics panel shows correct versions, no token leak in copy

**Evidence:** attach `npm test` log, `npm run build` log, audit log.

**Blockers:** any fail = do not release.
