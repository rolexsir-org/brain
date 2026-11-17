# Brain personal agent — Phase 0 audit

Audit of branch `arena/6e1d2b85-brain`, based on the existing 2.5.0 PWA and PR #5. This is a point-in-time engineering assessment, not a security certification or a claim that the proposed agent is implemented.

## Existing architecture

```text
Browser/PWA: index.html → app.js → Brain.handle (rule-based intent + session Context)
                               ↘ runAction → domain/device/Instagram actions
                                  ↕
                         Store → IndexedDB kv snapshots
                               → localStorage / memory fallback
Service worker → app-shell cache + notification-click routing
Optional Instagram exchange service → Meta OAuth exchange (stateless)
Browser Instagram modules → Meta API + local queue while app is running
```

The static server serves an allowlisted public tree; an optional separate service holds the Meta app secret for OAuth exchange. No general authenticated backend, cloud AI gateway, server-side task worker, account system, sync service, or Android application exists in this repository. The service worker is not a reliable closed-device scheduler.

## Preservation inventory and regression checklist

Preserve the 13 local record collections: tasks, reminders, notes, people, money, debts, stock, habits, journal, events, photos, Instagram drafts and publications. Preserve settings, local intent handling, action dispatch and device handoffs, scheduler, PWA installation/offline shell, diagnostics, import/export and Instagram connection, queue and publishing behavior. Explicitly test old records, all collection CRUD, recurrence, notification actions, import/export (including failed import), settings, service-worker upgrades, offline reload, media and external actions before release. Browser/device and real Meta tests remain outstanding.

Conversation transcript and recent-reference context currently exist only in the running session. The current queue persists locally, but only runs when the PWA runs and is not a reliable cross-tab or distributed scheduler. Automation, retries and API code exist but are not evidence of live Meta publishing.

## Database and migration assessment

`brain/js/util/constants.js` defines IndexedDB name `brain`, database version 1 and logical schema version 5. `store/db.js` has one `kv` object store; collections and settings are stored as snapshots. `store/store.js` validates records, uses a serialized write queue and creates pre-migration backups when upgrading older logical schemas. `store/migrate.js` reads a legacy localStorage format. This is not a complete reversible version-by-version migration framework. The queue and video blobs have separate keys, not ordinary collections; JSON backup does not represent the entire media/queue state. Plain backups include settings and can include Instagram access tokens.

No migration is performed by this phase. Any future schema change requires fixtures from deployed versions, a tested idempotent upgrade, a durable pre-upgrade backup, rollback/recovery instructions, and explicit compatibility tests for plain/encrypted exports and restores. Never silently upload existing data.

## Security and privacy assessment

- Instagram access tokens currently reside in browser settings; the optional exchange keeps the Meta app secret server-side but returns access tokens to the browser. Do not describe this as a server-side token vault.
- Current queue operations use independent read/write operations; re-reading a lease is not an atomic compare-and-swap or a cross-tab/distributed lock. Queue processing may race and cannot establish exactly-once external publication. Retrying an ambiguous publish without verified reconciliation can duplicate an irreversible action.
- The exchange service's rate limit is in-process and cannot enforce a shared account quota. The new gateway must authenticate users and devices, enforce authorization and budgets, and never log private prompts, token material or signed media URLs.
- Existing CSP, DOM text rendering, import validation and explicit user handoffs must remain enforced. Existing browser local data is not encrypted by default. A future cloud consent mechanism must default off and authorize each data category and external tool scope.
- Provider outputs are untrusted. Tool schemas, authorization, confirmation and audit enforcement must be server-owned, not delegated to model text.

## Proposed target and dependencies

Keep local deterministic commands operational without a network or account. Introduce an optional, authenticated backend as a modular service: identity/device registration, consent and data-scope policy; provider-independent AI adapter and gateway; validated tool services; encrypted server-side credential vault; durable task store/outbox and workers; sync and notification delivery. Put authorization, idempotency, budgets and audit enforcement on the server. Irreversible API operations require scoped approval and external reconciliation; exactly-once results cannot be assumed where a provider lacks idempotency.

1. Preserve/harden current flows and test a local orchestration seam.
2. Design and implement authenticated gateway, provider adapters and explicit consent before transmitting data.
3. Design versioned memory/task storage and migration/rollback, including deletion and export.
4. Implement transactional scheduling, leases, retries, cancellation and cross-device synchronization; test worker crash and ambiguous external results.
5. Build native Android with device registration, WorkManager for device-side sync, share intents, notifications and offline behavior.
6. Verify current official Meta documentation, account eligibility and actual publishing with a test account; migrate credentials only with explicit consent.
7. Upgrade the PC workspace, then perform independent security, performance, recovery, accessibility and device testing.

No external provider, deployment, auth or database vendor is selected by this audit. Provider and hosting selection requires a separate threat model, operational plan, credentials provisioning and user approval. Never put provider secrets in the client.

## Baseline and remaining gates

At audit: `npm test` passed 217 unit tests and the UI smoke suite; `npm run build` verified 44 assets; `npm run audit` passed 40/40; `npm audit` reported no vulnerabilities. The test command uses `--test-force-exit`. No real Android/desktop device, deployed worker, cross-device sync, real Meta account, or production AI provider was tested. No CI workflow was found under `.github` in this checkout. See `docs/release-checklist.md` for existing PWA release gates.
