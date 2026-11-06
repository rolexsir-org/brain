# Automation Centre — Brain v2.3.0

**Source:** `brain/js/ui/automationCentre.js`, `brain/js/instagram/automation.js`, `brain/js/instagram/queue.js`, `brain/js/store/store.js` (`defaultAutomationSettings`). Opt-in only.

## Goal

Show **what Brain can do on your behalf, why, and where to stop it** — never grant “publish all” silently.

Default: **MANUAL** — automation disabled. No rule → no auto-publish.

## Services & permissions view

| Service | State shows | Purpose | Boundary | Stop |
|---------|-------------|---------|----------|------|
| Notifications | `notifEnabled` toggle + browser prompt gate | Reminders/briefings via `notify.js` | Foreground only; no push server | Turn off in Settings → Notifications + browser permission |
| Instagram connection | `connected / expired / disconnected` + `tokenExpiryLabel` | Publish *only* drafts you approve | `MANUAL` blocks `actor=automation` | *Disconnect Instagram* → `DELETE /permissions` + local wipe |
| Instagram Automation | `enabled false/true, mode MANUAL/AUTOMATED, paused` | Auto-publish *only* `eligibleDraftIds` per rule | See rules below; `isEligibleForAutomation` re-validates at `processQueue` | *Pause automation* immediate, per-rule Disable, or Disconnect |
| Location / Contacts / Camera/Files | Capability report from `caps.js` (per-tap if exposed) | Your single-tap imports/handoffs | Never background tracking | Browser permission revoke / pickers per-tap |
| Queue | `instagram:queue` count + `EMERGENCY_STOP` flag | Pending timed jobs | `MAX_QUEUE_SIZE 100`, atomic claim | *Emergency stop* in Diagnostics or Automation Centre |

## How a rule works

Each rule (`makeRule(raw)` ≤50 rules, `eligibleDraftIds ≤100`):

```json
{
  "id": "rule-abc123",
  "name": "Client Reels — weekday mornings",
  "enabled": true,
  "filters": {
    "tags": ["client","launch"],
    "namePattern": "client",
    "allowedDays": [1,2,3,4,5],
    "allowedHours": {"start":9,"end":17},
    "eligibleDraftIds": ["instagramDraftId_1","..."]
  },
  "schedule": {"freq":"daily","time":"09:00","days":[1,2,3,4,5]},
  "limits": {"maxPerDay":2, "requireApprovalAfterFailures":2}
}
```

**Eligibility (`isEligibleForAutomation(draft, rule, automation)`):**

1. `automation.enabled && !paused && rule.enabled`
2. `draft.status ∈ {READY, AWAITING_APPROVAL, SCHEDULED}` (not DRAFT/FAILED/CANCELLED/PUBLISHED)
3. If `eligibleDraftIds` non-empty → `draft.id` must be listed. Else at least one `tags` or `namePattern` must match (`tags` any overlap with `draft.hashtags`, pattern substring of `videoName`).
4. Time window: `now.getDay() ∈ allowedDays && now.getHours() ∈ [start, end)`.
5. Fails → `{eligible:false, reason}` shown in UI (“Day 0 not allowed”, etc.).

Empty allowlist + no tag/pattern → *not eligible* (you must tick drafts or set a filter). This prevents “publish everything.”

`limits.maxPerDay` 1–10 enforced per `processQueue` batch via `perRuleCounts` (resets each batch). `requireApprovalAfterFailures` is stored but advisory — failed drafts already move to `FAILED` and need manual retry.

## What happens when a rule fires

```
Browser interval (~30s) + catch-up on online/visibility
  → processQueue(store, connection, {onPublish})
    → recoverStaleJobs(5m)
    → checkRateLimit(pubs 25/5 advisory) else defer 30m
    → claimJob(id) atomic (→CLAIMED + leaseToken + leaseExpiry +5m + re-read verification)
    → verify still CLAIMED+leaseToken (cancel race) else skip
    → re-validate isEligibleForAutomation (rule may have been disabled)
    → attempt count +1 before network (idempotent)
    → onPublish(draft) → classifyRetry + backoffMs jitter else FAILED
    → dequeue on ok + recordAutomationExecution(ruleId, published/failed)
```

- **Pause** (`pauseAutomation()`) sets `automation.paused=true`; next `processQueue` cycle sees `paused` and releases claim `→SCHEDULED` without counting attempt.
- **Per-rule Disable** → rule filtered out of `canAutomationPublish` — existing queued `ruleId` jobs skip via eligibility.
- **Emergency Stop** (`setEmergencyStop(true)`) short-circuits entire `processQueue` (`{stopped:true}`) — used when queue misbehaving.

History: `automation.history[200]` + per-draft `history[100]` entries (`at, draftId, ruleId, action, result, error, actor`) visible in Automation Centre → *Recent activity* (redacted token). Never sent off-device.

## Pending / failed / activity

- **Awaiting approval:** `READY`/`AWAITING_APPROVAL` drafts — open to confirm.
- **Failed:** `FAILED` `{lastError}` — *Retry* re-enqueues; `isContainerExpired`/`checkRateLimit` checked before re-create.
- **Activity:** last 200 executions, who triggered, error if any.

## Security note

Automation cannot elevate: `actor=automation` is blocked in `executePublish` when `mode !== AUTOMATED` and re-blocked in `canTransition`/`isEligibleForAutomation`. External prompt-injected captions never become rules (rules are constructed only via Automation Centre UI, not NL).

See [`instagram-integration.md`](instagram-integration.md) §15–16 for production Review and allowlisting.
