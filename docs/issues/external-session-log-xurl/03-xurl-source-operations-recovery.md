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

## Production release verification

The opt-in Canaries were executed on 2026-07-16 against the installed official `xurl 0.0.27` executable. Both ran rather than skipping and passed with 2 tests passed, 0 failed, and 0 skipped:

```bash
XIAOBA_OFFICIAL_XURL_SMOKE=1 \
XIAOBA_OFFICIAL_XURL_CATCH_UP_SMOKE=1 \
XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND=/absolute/path/to/xurl \
./node_modules/.bin/tsx --test tests/official-xurl-smoke.test.ts
```

These are real-executable compatibility Canaries, not live-provider or recovery E2E tests. The future-only case verifies discovery from synthetic Codex, Claude, and Pi roots, a non-admitting baseline, later continuous admission, overlapping reads, and serialized durable writes. The catch-up case starts with sanitized Codex and Claude history, drives ordinary Runtime wakes to `caught_up`, creates ordinary Learning Episodes and Evidence Capsules, and verifies overlapping provider reads with serialized admission. Both cases drain cleanly, prove provider locks are released, and reject remaining non-ambient or xURL child-process handles.

Provider-lock contention, explicit backfill, failure and quarantine recovery, Runtime restart replay, and exact read-concurrency limits remain deterministic regression requirements. The real-xURL Canaries are not evidence for restart recovery. Together with the deterministic recovery and Catch-Up suites, they satisfy the xURL production release verification for version 0.0.27. `future-only` remains the default; historical import requires `XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE=catch-up` or a durable provider history override.

## Dependencies

- #85 and #86 provide the source reader and future-only lane consumed by this completed operations and recovery layer.
