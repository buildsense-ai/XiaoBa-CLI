## Parent

#84

> GitHub Issue #87 is the authoritative tracker. This repository document is its versioned completion snapshot.

## What to build

Harden the xurl-backed External Source Work Lane after the reader and future-only path are available. Make source state single-writer and operator-visible, distinguish recoverable source outages from protocol or integrity problems, and provide an explicit durable recovery path for events that cannot be safely admitted.

The operational layer must remain isolated from Capability review accounting. It must preserve local evidence when an upstream resource disappears, keep internal heartbeat work independent, and drain without creating review retries for source work that was never admitted.

## Acceptance criteria

- [x] A provider-scoped lock serializes heartbeat reads and explicit backfills for the same provider, including competing Runtime processes; different providers remain isolated.
- [x] Source failures have durable classes for transient, pending, protocol, permission/auth, integrity conflict, and quarantine states, with class-appropriate backoff or operator action.
- [x] External source failures never increment Operational Review Retry or Branch Promotion Reviewer failure counters.
- [x] Oversized, unsafe, or otherwise unadmittable events enter durable quarantine with bounded diagnostics and do not advance the cursor automatically.
- [x] An explicit quarantine retry reprocesses the same event, while an explicit skip writes a durable tombstone before allowing the cursor to cross it; neither operation silently rewrites evidence.
- [x] Runtime status and durable heartbeat diagnostics show selected provider, reader support, cursor progress, last successful read, quota/backoff/drain state, next retry, and redacted last error.
- [x] Missing, unsupported, or failing xurl does not degrade internal heartbeat readiness or create a review queue entry.
- [x] Deleted or archived external resources close locally after confirmation while preserving their cursor, Capsules, Episodes, Capabilities, and Transition Audits.
- [x] Disabling external ingestion does not delete source state or local evidence; graceful drain stops new reads and leaves unacknowledged work resumable.
- [x] Capsule and branch-transcript cleanup remain separate, and active audit-linked external evidence is retained according to its lifecycle policy.
- [x] Status, lock contention, failure classification, quarantine recovery, resource closure, and graceful drain have deterministic public-seam tests with normal process exit.
- [x] Existing heartbeat scheduler, source scheduling, backfill, Evidence Capsule, and skill-evolution suites continue to pass.

## Completion evidence

Issue #87 is complete. Commits `91cfa8b` and `76add1c`, merged through PR #88 as `20ca1d0`, implement and close the xURL source-operation and recovery scope.

PR #88 records the original completion verification:

- focused #75-#87 chain: 240 passed, 1 platform skip, 0 failed;
- full runtime suite: 1629 passed, 7 skipped, 0 failed;
- `pnpm exec tsc --noEmit`: passed;
- `git diff --check`: passed.

The current focused recovery regression is reproducible with:

```bash
./node_modules/.bin/tsx --test \
  tests/runtime-learning-xurl-operations-recovery.test.ts \
  tests/external-source-provider-lock-process.test.ts \
  tests/distillation-heartbeat-scheduler.test.ts \
  tests/runtime-learning-source-scheduling.test.ts \
  tests/session-log-backfill.test.ts \
  tests/runtime-learning-backfill.test.ts \
  tests/runtime-learning-xurl-backfill.test.ts \
  tests/evidence-capsule.test.ts \
  tests/skill-evolution-v3.test.ts \
  tests/branch-transcript-contract.test.ts
```

Current result: 182 passed, 0 failed, 0 skipped. This command covers the scheduler, source scheduling, continuous recovery, cross-process provider locking, backfill, Evidence Capsule lifecycle, Skill Evolution, and branch-transcript retention. The acceptance checkboxes describe implemented behavior; deterministic runs do not prove compatibility with an installed official xURL executable.

## Production release condition

Before production release, run `tests/official-xurl-smoke.test.ts` with `XIAOBA_OFFICIAL_XURL_SMOKE=1` and `XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND` set to the candidate installed xURL executable, and record an executed pass in #94. A prerequisite skip does not satisfy this condition.

This is a real-executable compatibility canary, not a live-provider or recovery E2E. It verifies discovery from synthetic Codex, Claude, and Pi roots; a future-only baseline without historical admission; overlapping external reads; serialized durable admission involving multiple providers; creation of a Learning Episode and Evidence Capsule; and drain without active read, admission, or xURL child-process handles.

Provider-lock contention, explicit backfill, failure and quarantine recovery, Runtime restart replay, and exact read-concurrency limits remain deterministic regression requirements. The real-xURL canary is not evidence for provider locking or restart recovery. It is tracked separately by #94 and does not reopen #87's completed implementation scope.

## Dependencies

- #85 and #86 provide the source reader and future-only lane consumed by this completed operations and recovery layer.
