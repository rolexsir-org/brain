# Backup & Recovery — v2.3.0

## Export
- `Store.exportState()` flushes dirty sets, returns `{ app:"brain", schema:5, exportedAt, settings, collections, meta:{counts} }`.
- Optional **encrypted** backup: `Store.exportStateEncrypted(password)` uses `PBKDF2 120k + AES-GCM 256` via `crypto.subtle`; format `brain-enc-v1.<salt>.<iv>.<cipher>` (base64). Prompted on export.
- File saved via File System Access API or download fallback via `external.js`.

## Import
- `Store.previewImport(raw)` validates `app=="brain"` and sanitizes each record; reports `counts, total, fromSchema, errors`.
- Encrypted backups prompt for password → `decryptBackup` → then preview.
- **Merge** adds only new records (deduplicates by `id` + fingerprint). **Replace** requires explicit `confirm("Replace all")` and validates every record — no silent overwrite.
- Migration: `Store.init()` upgrades schema 0→5, sanitizes, repairs journal photo refs, and re-persists.

## Safe deletion
- `Store.safeDeleteCollection(type, confirmToken)` requires token `delete-${type}` to avoid accidental bulk delete.
- `wipe()` clears all via `replaceAll(emptyCollections(), defaultSettings())`.

## Storage reporting & media integrity
- `Store.storageReport()` returns `estimate` (navigator.storage), `counts`, `jsonChars`, `photoChars`, `mediaIntegrity`.
- `Store.mediaIntegrityReport()` counts `byStatus`, `missingUrl`, `expiredContainer` (container >24h).
- UI: Menu → Storage & media health, or Command Centre.
- Service worker precaches all modules for offline launch.

## Disaster recovery
- If IndexedDB is unavailable, MemoryBackend holds session data (warns via `onPersistenceError`).
- Interrupted publishes are recovered on next boot via `recoverInterruptedPublishes` (poll container or mark FAILED with retry guidance).
- Rate limits tracked locally (25/day, 5/hour) before publish attempt.
