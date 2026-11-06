# Command Centre — Brain v2.3.0

**Source:** `brain/js/ui/commandCentre.js`, `brain/js/engine/search.js`, `brain/js/app.js` (menu entry). Local-only; no server query.

## Purpose

Single view of everything stored locally: upcoming work, money, inventory, notes, journal, and publishing. Open via Menu → *Command Centre* or NL “open command centre”.

## What it shows

| Section | Source | How it is built |
|---------|--------|-----------------|
| **Pending actions** | Open `task.status=open` + active `reminder.status=active` + Reel drafts `READY/AWAITING_APPROVAL/SCHEDULED/FAILED` | Merged, sorted by `due/at/scheduledAt` (earliest first). |
| **Tasks ↔ Events** | `task` with `due` + `event {at, end, location}` | Unified timeline by `at/due`, `task` shows `priority`/`recur`, `event` shows `.ics` action. |
| **Reminders ↔ Tasks** | `reminder {at, recur, status}` + open tasks | Active grouped; `lastFiredKey/lastSnoozeKey` dedup (recur uses anchor, not reload cadence). |
| **Money / debts / inventory** | `money` (expense/income, category), `debt` (they_owe_me/i_owe_them), `stockItem` (qty, lowThreshold, history -300) | Last 30 days totals, open debts only, low-stock highlighted. |
| **Notes / journal / content calendar** | `note {private/tags}`, `journal {mood, photoId}`, Reel drafts grouped by `scheduledAt` date | `note.private` is label only (not encryption); `journal.photoId` validated against existing `photo.dataUrl`. |
| **Upcoming plans** | Reminders+events for next 7 d | `date.js nextOccurrence` — recurring that would have fired today already passed is skipped (not shown as overdue). |

## Search

Universal `searchAll(query, store)` (`engine/search.js`):

- Tokenizes query, lower-cases, scores token hits across 13 collections (`task, reminder, note, person, money, debt, stockItem, habit, journal, event, photo, instagramDraft, instagramPublication`).
- Ranks by field weight + recency + collection. Returns `{id, collection, title, snippet, score}`.
- Triggered by NL “find … / show everything about John” and the Command Centre search box.
- Offline `suggest` chips reuse same NL examples; voice `mic` falls back to typed if `SpeechRecognition` unavailable.

## Interaction

- Each card row: icon + title + meta + `action` buttons (`open/edit/done/snooze/publish preview…`). Buttons are `canOffer`-gated (capability + record state).
- `show everything about John` → Command Centre deep-link `?q=John` — no external lookup.
- Visible chat “brain:reminder-open” from `notify.js` routes here.

## Privacy & offline

All data read from `store.collections` in memory; no fetch. Works offline after first load via `sw.js` cache. See [`architecture.md`](architecture.md) §7.

## Verification

- `test/intent.test.js` — “search everything about John” → `searchAll` mock not creating data.
- `test/store.test.js` — collections fixture + recount.
- Manual: Menu → Command Centre with 500+ records still responds <50 ms (harness `searchAll 500 ~1 ms`).
