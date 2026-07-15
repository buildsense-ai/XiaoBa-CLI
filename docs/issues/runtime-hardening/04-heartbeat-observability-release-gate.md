## Parent

[#68](https://github.com/pi-dal/XiaoBa-CLI/issues/68)

## What to build

Expose the minimum durable operational state needed to inspect bounded review and wake behavior, then establish the release verification gate. Extend heartbeat records with recent status, duration, pending reasons, and review timeout/failure counters while keeping the Operational Review Retry queue as the retry authority. Add integrated restart and canary checks for the hardened runtime path.

## Acceptance criteria

- [x] Heartbeat durable state records recent run status, duration, pending wake reasons, and review timeout/failure counters.
- [x] An operator can distinguish a quiet heartbeat, a coalesced wake, a timed-out review, a queued operational retry, and a clean graceful drain from local state and branch audit logs.
- [x] Restart inspection preserves queue deadlines, transcript references, heartbeat state, and no-duplicate behavior.
- [x] The focused reliability suite, relevant existing branch/runtime tests, and typecheck pass.
- [x] A canary checklist covers timeout rate, operational retry rate, pending wake handling, transcript health, and transition audit links.
- [x] The issue records that formal production release requires the full runtime suite to be green; existing unrelated PDF/CatsCo/shell failures are not modified by this slice.

## Canary checklist (runtime release gate)

- [x] **Heartbeat health**: inspect `$XIAOBA_RUNTIME_ROOT/data/distillation-heartbeat-record.json`. Confirm mode `0600`, no sibling `*.tmp` files, a recent `lastRunAt`, bounded `lastRunDurationMs`, and one of the documented `lastRunStatus` values.
- [x] **Timeout and retry**: force one canary reviewer past its configured deadline. Confirm `lastReviewTimeoutCount` and `cumulativeReviewTimeoutCount` increase, no transition is emitted for that bundle, and `$XIAOBA_RUNTIME_ROOT/data/skill-evolution-review-queue.json` contains one `operational` entry with `failureKind = branch_timeout`, its fixed bundle, transcript paths, and an unchanged `nextRetryAt` after read-only inspection.
- [x] **Pending wake handling**: request a targeted wake while another wake is active. Confirm `pendingWakeReasons` becomes non-empty before the active wake completes, clears only when the follow-up wake consumes it, and retains any reason that arrives during that follow-up for the next cycle.
- [x] **Transcript health**: inspect files referenced by queue entries and `$XIAOBA_RUNTIME_ROOT/data/transition-audit.jsonl`. Confirm they are under `$XIAOBA_RUNTIME_ROOT/logs/branches`, mode `0600`, include start/deadline and terminal outcome events, and contain no unredacted credentials.
- [x] **Transition audit links**: for one healthy canary candidate, recompute SHA-256 for both Author and Verifier transcript paths and compare them with the aligned `branchTranscriptHashes` in its Transition Audit entry.
- [x] **Restart inspection**: stop and restart the canary without making new session-log input. Confirm heartbeat inspection does not change Registry, Review Queue, Learning Episodes, or Transition Audit content, and persisted pending reasons are replayed once without duplicate transition IDs.
- [x] **Graceful drain**: stop the runtime during an admitted review. Confirm no new review is admitted, the active attempt completes or reaches its own deadline, any timeout retry is durable before exit, and the next owner resumes without parallel heartbeat execution.
- [x] **Release gate**: run `pnpm test:runtime` and `pnpm exec tsc --noEmit --pretty false`. Do not mark production-ready unless the full runtime suite is green or unrelated failures have an explicit, separately approved release isolation decision.

## Blocked by

- [#80](https://github.com/pi-dal/XiaoBa-CLI/issues/80) - bound Promotion Review Attempts with deadlines and operational retry.
- [#81](https://github.com/pi-dal/XiaoBa-CLI/issues/81) - enforce runtime-owned, audit-safe Branch transcripts and retention.
- [#82](https://github.com/pi-dal/XiaoBa-CLI/issues/82) - coalesce Runtime Learning wakes and drain active work on shutdown.
