## Parent

#84

## What to build

Harden the xurl-backed External Source Work Lane after the reader and future-only path are available. Make source state single-writer and operator-visible, distinguish recoverable source outages from protocol or integrity problems, and provide an explicit durable recovery path for events that cannot be safely admitted.

The operational layer must remain isolated from Capability review accounting. It must preserve local evidence when an upstream resource disappears, keep internal heartbeat work independent, and drain without creating review retries for source work that was never admitted.

## Acceptance criteria

- [ ] A provider-scoped lock serializes heartbeat reads and explicit backfills for the same provider, including competing Runtime processes; different providers remain isolated.
- [ ] Source failures have durable classes for transient, pending, protocol, permission/auth, integrity conflict, and quarantine states, with class-appropriate backoff or operator action.
- [ ] External source failures never increment Operational Review Retry or Branch Promotion Reviewer failure counters.
- [ ] Oversized, unsafe, or otherwise unadmittable events enter durable quarantine with bounded diagnostics and do not advance the cursor automatically.
- [ ] An explicit quarantine retry reprocesses the same event, while an explicit skip writes a durable tombstone before allowing the cursor to cross it; neither operation silently rewrites evidence.
- [ ] Runtime status and durable heartbeat diagnostics show selected provider, reader support, cursor progress, last successful read, quota/backoff/drain state, next retry, and redacted last error.
- [ ] Missing, unsupported, or failing xurl does not degrade internal heartbeat readiness or create a review queue entry.
- [ ] Deleted or archived external resources close locally after confirmation while preserving their cursor, Capsules, Episodes, Capabilities, and Transition Audits.
- [ ] Disabling external ingestion does not delete source state or local evidence; graceful drain stops new reads and leaves unacknowledged work resumable.
- [ ] Capsule and branch-transcript cleanup remain separate, and active audit-linked external evidence is retained according to its lifecycle policy.
- [ ] Status, lock contention, failure classification, quarantine recovery, resource closure, and graceful drain have deterministic public-seam tests with normal process exit.
- [ ] Existing heartbeat scheduler, source scheduling, backfill, Evidence Capsule, and skill-evolution suites continue to pass.

## Blocked by

- #85
- #86
