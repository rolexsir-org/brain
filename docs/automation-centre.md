# Automation Centre — Permissions & Control (Brain v2.3.0)

## Purpose
Shows what Brain can do on your behalf, why, and where to pause/disable.

## Services & permissions
| Service | Current state | Purpose | Boundary | Pause/disable |
|---|---|---|---|---|
| Notifications | per browser | Reminders, briefings | Device-only, no push server | Toggle in Settings |
| Instagram connection | connected / not | Publish Reels you approve | Only explicit publish; automation needs rule opt-in | Disconnect |
| Location | per tap | Open Maps once | Never background tracking | Browser permission |
| Contacts | per tap | Import contacts you select | Read-only, never writes to system | Browser permission |
| Camera/Files | per tap | Choose photos/videos | Local until you publish | Browser permission |
| Instagram Automation Mode 2 | manual/automated per rules | Auto-publish only allowlisted drafts | Requires eligible IDs + time window | Pause/Disable + per-rule toggle |

## Scheduled & automations
- **Scheduled (timed)**: local `reminder` jobs with due times. Browser cannot guarantee fire when closed — Brain catches up on next launch.
- **Instagram rules**: each rule lists `eligibleDraftIds` (you tick each), plus optional hashtag/name filters, allowed days/hours, and schedule time. No rule = no auto-publish.
- **Queue**: `instagram:queue` in IndexedDB, ordered by `scheduledAt`, with `attempts` and `maxAttempts`.

## Pending approvals / failed
- **Awaiting approval**: `READY`/`AWAITING_APPROVAL` drafts. Open, review, confirm.
- **Failed**: `FAILED` with `lastError`. Use **Retry** — Brain checks expired containers/rate limits before re-creating.
- Failed count does not block other drafts; per-rule `requireApprovalAfterFailures`.

## Recent activity & history
- Automation `history` (last 200) records `at, draftId, ruleId, action, result, error, actor` (user/automation).
- Draft `history` array records transitions with actor.
- Never sent elsewhere; visible only in Automation Centre → Recent activity.

## Pausing
- **Pause automation** is immediate: next `processQueue` cycle checks `automation.paused` and skips. No race.
- **Per-rule Disable** stops that rule from matching.
- **Disconnect Instagram** revokes `permissions` via Graph API and wipes token locally.
