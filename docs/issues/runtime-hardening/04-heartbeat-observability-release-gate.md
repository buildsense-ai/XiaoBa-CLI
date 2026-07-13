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

- [x] **Timeout rate**: focused reliability tests confirm `lastRunStatus = timed_out` is recorded when a review aborts on deadline and no new transitions are emitted.
- [x] **Operational retry rate**: focused reliability tests confirm `lastRunStatus = queued_operational_retry` increments when branch timeout/failure is enqueued and that queued entries preserve `nextRetryAt`.
- [x] **Pending wake handling**: focused reliability tests confirm `pendingWakeReasons` records coalesced/wake reason sets without dropping settlement/operational/curator/reassessment work.
- [x] **Transcript health**: branch transition audit entries retain existing transcript references after timeout/retry; transcript-write failure keeps `branch_failure` without silent success.
- [x] **Transition audit links**: transition audit entries expose stable `transitionAudit` IDs and runtime wake records (`runStatus`, `durationMs`) for replayable diagnostics.

## Blocked by

- [#69](https://github.com/pi-dal/XiaoBa-CLI/issues/69) - bound Promotion Review Attempts with deadlines and operational retry.
- [#70](https://github.com/pi-dal/XiaoBa-CLI/issues/70) - coalesce Runtime Learning wakes and drain active work on shutdown.
- [#71](https://github.com/pi-dal/XiaoBa-CLI/issues/71) - make Branch transcripts runtime-owned and audit-safe.
