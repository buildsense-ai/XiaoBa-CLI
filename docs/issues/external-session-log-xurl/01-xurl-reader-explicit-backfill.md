## Parent

#84

## What to build

Deliver the first production tracer bullet for one explicitly selected external provider: a generic xurl-backed `ExternalSourceReader` that runs a fixed JSON protocol v1 and completes an explicit bounded External Session Log Backfill through the existing Runtime Learning path.

xurl remains responsible for provider-specific parsing. The reader must expose provider-neutral thread/message data, normalize one complete user-to-assistant delivery turn with completed tool calls into the canonical session-log shape, preserve explicit conversation and branch identity, and keep source event identity separate from the xurl resource locator. The backfill must persist the bounded Evidence Capsule and external provenance before acknowledging a source page, and reruns must be idempotent.

The slice must include a deterministic fake xurl process at the process boundary so it can verify the real public Runtime seam without requiring provider credentials or a live external account.

## Acceptance criteria

- [ ] xurl protocol v1 is fixed and machine-readable; Markdown fallback, protocol negotiation, and unknown schema versions are rejected as source-level protocol failures.
- [ ] xurl runs non-interactively with validated argv, bounded stdout/stderr, closed or ignored stdin, and a per-read deadline; timeout and non-zero exit do not create Operational Review Retry entries.
- [ ] The Runtime can explicitly select one provider and run a bounded backfill through the existing public backfill seam.
- [ ] The reader maps only complete user-to-assistant final turns and completed tool calls into canonical external evidence; incomplete streams, system/developer messages, and malformed events do not advance source progress.
- [ ] Event identity includes stable source/provider, conversation, branch, event, position, and revision-or-content-hash information; ephemeral URI and array index are not used as durable identity.
- [ ] One read page is acknowledged only after every event in that page has been normalized, ingested, capsule-persisted, and provenance-persisted.
- [ ] A crash or failure before acknowledgement causes a safe idempotent replay without duplicate Learning Episodes or Evidence Capsules.
- [ ] Evidence Capsules preserve the sanitized external identity needed for retry and audit, including conversation/branch identity and revision or content hash.
- [ ] The backfill reuses the ordinary Learning Episode, Evidence Bundle, Branch Promotion Reviewer, Capability Transition, and Transition Audit gates; it cannot directly promote external content.
- [ ] A fake xurl executable covers successful backfill, invalid protocol, timeout, oversized output, non-zero exit, page failure, restart replay, and idempotent rerun.
- [ ] Existing internal heartbeat, source-neutral adapter, Evidence Capsule, backfill, and skill-evolution tests continue to pass.

## Blocked by

None - can start immediately.
