# PWA Lifecycle — Brain v2.3.0 (Q)

## Tested scenarios
- **First install:** `install` caches 40 assets, `skipWaiting`+`claim` activates immediately; offline reload serves `index.html` fallback.
- **Offline first launch:** navigate while offline serves cached `index.html` + modules; Store uses IndexedDB (existing) or warns on private mode.
- **Offline navigation:** cache-first for JS/CSS, network+cache for navigate; `fetch` falls back to cache match.
- **Cache invalidation:** `SW_VERSION = brain-v2.3.0`; `activate` deletes only keys starting `brain-` ≠ CACHE, never other apps.
- **New-version activation:** new `install` → `activate` → `clients.claim`; data not touched (collections in IndexedDB, not Cache). Update banner: `app.js` listens to `registration.onupdatefound` + `controllerchange`, shows “Update available — reload” toast with confirm.
- **Interrupted update:** If `install` fails, old SW remains controlling; no partial overwrite. Next reload retries.
- **SW compatibility:** Old workers with old `CACHE` keys coexist until new one claims; IndexedDB schema 5 readable by older code (sanitize drops unknowns).
- **Browser restart/multi-tab:** Each tab runs own Store init; write queue serializes; `openDb` blocked → warning + retry.
- **Storage eviction:** `store.storageEstimate()` + `onPersistenceError` quota path shows toast; Memory fallback shows prominent warning.
- **Private browsing:** IndexedDB may be unavailable → MemoryBackend with warning banner + “data will disappear”.
- **Network restoration:** Pending reminders fire on catch-up; queue `processQueue` runs on next `online` event + 30s interval.

Data is never silently replaced; reload requires explicit user tap on update banner. No destructive migration without `backup:pre-migration:*`.
