# Backup & Recovery — Brain v2.3.0

**Authority:** `brain/js/store/store.js` (`exportState, previewImport, mergeBackup, replaceAll, wipe, storageReport, mediaIntegrityReport, safeDeleteCollection`), `brain/js/util/crypto.js`, `brain/js/store/db.js`. Tested: `test/store.test.js`, `test/validate.test.js`, `test/migrate.test.js`.

## 1. Storage before backup

| Key | What | Persistence |
|-----|------|-------------|
| `task, reminder, note, person, money, debt, stockItem, habit, journal, event, photo, instagramDraft, instagramPublication` | 13 collections, each ≤10 000 records, sanitized | `db.js` `brain` v1 `kv` (IDB → `brain:v2:*` localStorage → memory) |
| `settings` | `name, currency, locale, countryCode, notifEnabled, reducedMotion, onboarded, briefDate, lastBackupAt, instagram:{connected, igUserId, username, …, accessToken, automation{enabled,mode,paused,rules[≤50],history[200]}}` | Same KV |
| `schema` | `5` | KV `schema` |
| `instagram:queue` | Publishing queue (see `docs/api-compatibility.md`) | KV |
| `backup:pre-migration:*` | Migration safety copy `backup:pre-migration:old->5:ts` | KV (never auto-deleted) |
| `instagramVideoBlob:*` | Transient video blob handle (if used) | KV |

Non-durable mode (`Store.isPersistent==false` → `db.name !== indexeddb`, e.g. private browsing) shows banner **Temporary storage (Memory) — data will disappear when you close this tab.** Use `onPersistenceError(isQuotaError)` + `flush()` 5-pass retry to mitigate blips.

## 2. Export

```js
// Unencrypted JSON (plaintext — keep private)
const state = await store.exportState();
// { app:"brain", schema:5, exportedAt:"2026-11-06T…", settings:{…}, collections:{…}, meta:{counts} }

 // Encrypted (recommended) — via UI Settings → Export with passphrase ≥4 chars
const { blobText, encrypted:true } = await store.exportStateEncrypted("correct horse battery");
// → "brain-enc-v2.<saltB64>.<ivB64>.<cipherB64>"  // or brain-enc-v1.* if version='v1'
```

- `exportState()` calls `flush()` first (drains `_dirtySet`, 5 passes). Returns shallow-cloned snapshot.
- File saved via `File System Access API` → fallback `Blob` download (`external.js`) — never uploaded.
- `meta.counts` is for preview; not used to enforce import.

**Size:** `MAX_BACKUP_CHARS = 25 * 1024 * 1024` (25 MB raw text). Oversize → `backup-too-large` before parse.

## 3. Encryption — exact format

| Field | Value |
|-------|-------|
| Key derivation | PBKDF2-HMAC-SHA256, password `importKey(raw, PBKDF2)`, salt = stored `saltB64` (16 B), iterations `120000` (`v1`) / `600000` (`v2` OWASP 2023), hash SHA-256 → AES-GCM 256, extractable false. |
| Encrypt | `salt=random 16 B, iv=random 12 B, tag=brain-enc-v1|v2, cipher=crypto.subtle.encrypt({AES-GCM, iv}, key, utf8(json))`, packed as `tag.saltB64.ivB64.cipherB64`. |
| Decrypt | Split 4 parts, validate `tag` iterations, base64→bytes (salt 16 B, iv 12 B), `deriveKey(password,salt,iterations)` → `decrypt` → UTF-8 json. Wrong password/corrupt → `Decryption failed — wrong password or corrupted backup (authentication failed)` (GCM `auth tag` failure, not timing leak). Also rejects truncated/invalid base64/unknown version. |
| Helpers | `isEncryptedBackup(text)`, `encryptedVersion(text)→v1|v2|null`, `deriveKey`, `ITERATIONS_V1/V2`. |

**Commands:**

```bash
# In Brain (DevTools console) — encrypt then verify
await encryptBackup(JSON.stringify(await store.exportState()), "my-pass")
await decryptBackup("brain-enc-v2.…", "my-pass")  # throws if wrong password
```

Both versions decryptable; v2 is 600k default. No hardcoded key, no plaintext temp file (Blob only).

## 4. Import preview

```js
import { previewImport } from "./js/store/store.js";

const summary = previewImport(rawTextOrObject);
// { ok:true, schema, counts:{task:3,…}, total, fromSchema, errors:["photo"] }
```

- `parseBackup` guards `raw.length>MAX_BACKUP_CHARS` → `backup-too-large`, `JSON.parse` fail → `not-a-backup`.
- Validates `parsed.app==="brain"`, `collections` is object, then per-collection `sanitizeRecord` (drops unknown keys, control chars, duplicate `id`, `photo` without `dataUrl`). Invalid items contribute to `errors` (collection names), not silent drop without report. Preview never mutates live store.

## 5. Import — Merge vs Replace

| Mode | Call | Behaviour | When to use |
|------|------|-----------|-------------|
| **Merge** | `await store.mergeBackup(parsed)` | Adds only new records: dedup by `id` + `fingerprint(type, record)` (`stableJson(copy without id/createdAt/updatedAt/…)`), per-collection `MAX_RECORDS`, `photo` remaps `journal.photoId` via `photoIdMap` when deduped by content, returns `{added, duplicates, invalid}`. | Keep current + add from another device. Safe — never silently duplicate same backup twice. |
| **Replace all** | `await store.replaceAll(collections, settings)` | Sanitizes all + `_repairReferences()` + bumps `schema=5` + `clear _dirtySet` → `_saveSnapshot(kvSetMany)`. On throw → restores `beforeCollections/Settings/Schema` and reports `{ok:false, error}`. | Full restore. Requires UI confirm token `delete-${type}` for single-collection delete, Replace confirmation dialog separately. |

Encrypted flow: `decryptBackup(packed, password)` → `JSON.parse` → `previewImport` → `mergeBackup`/`replaceAll`. Wrong password never mutates.

## 6. Corruption detection

`Store.init()` after `openDb`:

- `read failed (msg)` if `kvGet(collection)` throws.
- `expected array, got <type>` if stored value not array.
- `removed N invalid/duplicate records` if `sanitize` shrinks array (dedup by `id`, invalid `photo`, unknown key drop).
- `Future schema X > current 5` if downgrade attempt.
- `migration backup failed (msg)` if `kvSet(backup:*)` throws (quotas).

All in `store.corruptionReport.issues[]` shown in **Menu → Storage & media health** / diagnostics panel. `mediaIntegrityReport()` adds `total/missingUrl/expiredContainer/byStatus`.

## 7. Quota & memory fallback

```mermaid
flowchart TD
  Write[add/update/remove] --> Queue[_queueWrite → kvSetMany]
  Queue -->|quota| Error[onPersistenceError isQuotaError true]
  Error --> Toast[Toast: QuotaExceeded toast + Temporary storage banner]
  Queue -->|unavailable| Memory[MemoryBackend _m:{} + flush 5-pass still runs]
```

- Recreate by: test fill IDB → expect toast + `Temporary storage` banner, no crash.
- Mitigate: export backup early, reduce photos (biggest chars), delete `photoChars` via **Storage report**.

## 8. Safe deletion

```js
await store.safeDeleteCollection("task", "delete-task"); // token must match delete-${type}
await store.wipe(); // replaceAll(emptyCollections(), defaultSettings())
```

Both require explicit confirmation in UI; cannot be invoked by NL without intent confirm.

## 9. Reproducible recovery procedures

**A — New phone / clean profile:**

```js
// On old device (or backup file): Settings → Export (with passphrase) → brain-backup-2026-11-06.json or brain-enc-v2.*
// On new device:
const text = await backupFile.text();
const json = isEncryptedBackup(text) ? await decryptBackup(text, "your-pass") : text;
const summary = previewImport(json);   // inspect counts/errors
await store.replaceAll(JSON.parse(json).collections, JSON.parse(json).settings);
// or for Merge: await store.mergeBackup(JSON.parse(json))
```

**B — Interrupted migration:** On next `init()`, a `backup:pre-migration:old->5:ts` key retains prior state. If `Migration save failed`, restore: `kvGet(that key)` → `replaceAll(backup.collections, backup.settings)`.

**C — Encrypted v1 compat:** `decryptBackup` accepts both `brain-enc-v1.*` (120k) and `v2` (600k) — no migration needed, old backups remain readable.

**D — Portability:** JSON contains `schema` — older `schema 3/4` imports are auto-sanitized (legacy `publishing→PROCESSING` etc.) and repaired; photos re-validated for header+MIME.

**E — Verify after restore:** `store.storageReport()` → `counts` vs `summary.counts` vs backup `meta.counts`.

Do not store backup JSON on shared drives without passphrase — it contains all personal data in plaintext.
