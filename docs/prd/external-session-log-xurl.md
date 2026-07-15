# External Session Log Distillation Through xurl

> Historical tracer-bullet PRD: #84–#87 implemented the source-neutral external lane, one-provider configuration, fixed test protocol, future-only cursor state, and operational recovery. The one-selected-provider scope and private `session-log-v1` process contract are superseded by [Multi-Provider External Session Log Distillation Through Official xURL](./multi-provider-external-session-log-xurl.md), [ADR-0042](../adr/0042-external-provider-reads-use-bounded-concurrency.md), and [ADR-0043](../adr/0043-official-xurl-rendered-timeline-is-the-reader-contract.md). The remaining evidence, review, cursor, failure-isolation, and audit decisions continue to apply.

## Problem Statement

XiaoBa can already distill Internal Session Log Source evidence through its local Heartbeat Log Distillation Agent. The Runtime also owns source-neutral adapters, bounded external backfill, source work lanes, Evidence Capsules, and the ordinary Learning Episode and Capability review pipeline, but the external lane still has no production reader.

Users who work across Pi, Codex, or Claude Code cannot safely admit those completed delivery attempts into local Capability learning. A useful solution must preserve provider and branch provenance, avoid importing history when a source is enabled, tolerate an unavailable external tool, and prevent mutable or malformed external data from advancing a cursor or bypassing the existing review gates.

## Solution

Add one generic xurl-backed `ExternalSourceReader` that consumes a fixed, machine-readable xurl protocol and presents provider-neutral thread/message data to the existing Runtime source boundary. The reader supports one explicitly selected provider at a time, with external ingestion disabled by default.

The first vertical slice is an explicit, bounded External Session Log Backfill for one provider. It invokes xurl non-interactively, normalizes complete external turns into canonical Distillation Units, persists source identity and Evidence Capsules before acknowledging source progress, and reuses the existing maturation, Branch Promotion Reviewer, Capability Registry, and Transition Audit path.

The second slice enables the same reader for continuous future-only heartbeat processing. It adds durable activation watermarks, discovery pagination state, per-resource event cursors, branch-aware source identity, bounded continuity, and the External Source Stability Gate without turning the Runtime into a full transcript mirror.

The final slice hardens operations with provider-scoped locking, failure classification, quarantine and explicit recovery, source health reporting, resource lifecycle handling, and retention behavior. Internal heartbeat learning remains independent of external availability throughout.

## User Stories

1. As a Runtime operator, I want external session-log ingestion to be disabled by default, so that enabling XiaoBa does not unexpectedly read other agent logs.
2. As a Runtime operator, I want to select exactly one external provider for a wake or backfill operation, so that source work remains bounded and predictable.
3. As a Runtime operator, I want the existing internal heartbeat to continue when xurl is absent, unsupported, or failing, so that optional external learning cannot break local learning.
4. As a Runtime operator, I want xurl to run through a fixed non-interactive protocol, so that a background heartbeat cannot wait for authentication or user input.
5. As a Runtime operator, I want malformed or incompatible xurl output to be reported as source failure, so that the Runtime never guesses how to interpret a provider log.
6. As a Runtime operator, I want to run an explicit bounded backfill for one provider, so that historical conversations enter learning only when I request them.
7. As a Runtime operator, I want ordinary provider enablement to be future-only, so that old conversations are not silently imported when a source is turned on.
8. As a Runtime operator, I want a source-level activation watermark, so that future-only behavior remains correct across restarts and provider list scans.
9. As a Runtime operator, I want source discovery pagination to resume independently from event processing, so that a large provider catalog does not starve later resources.
10. As a Runtime operator, I want one provider’s continuous lane to process only bounded incremental ranges, so that long conversations are not re-read as full transcript mirrors.
11. As a Runtime operator, I want a conversation branch to have its own source identity and cursor, so that alternate agent attempts are not merged into false chronology.
12. As a Runtime operator, I want only complete user-to-assistant delivery turns to enter canonical learning evidence, so that streaming fragments and incomplete tool calls cannot create misleading Candidates.
13. As a Runtime operator, I want system/developer instructions from external logs excluded from canonical evidence, so that external source content cannot become Runtime control instructions.
14. As a Runtime operator, I want stable event identity, position, and version to survive source rereads, so that backfill and continuous ingestion are idempotent.
15. As a Runtime operator, I want an event whose content changes under the same identity to fail closed, so that an upstream edit cannot rewrite evidence already used for review or promotion.
16. As a Runtime operator, I want source progress acknowledged only after the complete read page is durably admitted, so that a crash cannot lose external evidence.
17. As a Runtime operator, I want external evidence to use the same Learning Episode, Settlement Window, Evidence Bundle, Author/Verifier, and Capability Transition gates as internal evidence, so that provider origin does not grant promotion authority.
18. As a Runtime operator, I want an Evidence Capsule to preserve enough sanitized source identity and selected evidence for retry, so that review does not depend on the upstream conversation remaining available.
19. As a Runtime operator, I want source failure, protocol failure, integrity conflict, and quarantine states to be distinguishable, so that transient outages do not look like data corruption.
20. As a Runtime operator, I want oversized or unsafe events to be quarantined rather than silently truncated or skipped, so that bounded processing never creates incomplete evidence without an explicit decision.
21. As a Runtime operator, I want to retry or explicitly skip a quarantined event, so that one irrecoverable source record cannot block the lane forever without leaving an audit trail.
22. As a Runtime operator, I want disabling external ingestion to pause admission without deleting local Episodes, Capsules, Capabilities, or Audits, so that configuration changes are reversible.
23. As a Runtime operator, I want deleted or archived upstream resources to close locally without deleting their evidence, so that external source lifecycle changes do not erase local traceability.
24. As a Runtime operator, I want source health, cursor progress, backoff, and next action visible in Runtime status, so that an enabled but unavailable source is not a silent failure.
25. As a Runtime operator, I want concurrent heartbeat and backfill operations for the same provider serialized, so that source cursors and provenance have one writer.
26. As a Runtime operator, I want different providers to remain isolated, so that one provider’s outage or quarantine does not block another provider when it is selected later.
27. As a maintainer, I want a deterministic fake xurl process at the command boundary, so that the full external path is testable without requiring real provider credentials or network state.
28. As a maintainer, I want fixed protocol and identity semantics, so that xurl upgrades cannot silently change historical source meaning.

## Implementation Decisions

- The highest integration seam is the existing Runtime Learning public path: `runExternalBackfill` for the first slice and `wake` for continuous discovery. The xurl implementation is injected behind the existing `ExternalSourceReader` boundary rather than adding provider-specific logic to the learning pipeline.
- xurl owns provider-specific log parsing. XiaoBa consumes only a locked, provider-neutral structured protocol and never parses xurl-rendered Markdown.
- The initial xurl protocol is fixed at version 1. There is no schema negotiation, automatic migration, or Markdown fallback. Unknown versions and incompatible fields produce a source-level protocol failure without resetting durable state.
- xurl runs as a non-interactive child process with validated argv, bounded stdout/stderr, a per-read deadline, closed or ignored stdin, and no XiaoBa-managed credentials. Timeout, non-zero exit, output overflow, and invalid protocol output remain source failures and never become Operational Review Retry entries.
- External ingestion is controlled by one global opt-in and one selected provider. No automatic round-robin, multi-provider parallelism, or implicit provider mixing is introduced.
- A canonical external event represents one complete user request and final assistant response. Completed tool calls attach to that turn. Streaming fragments, incomplete tool calls, malformed messages, and system/developer/prompt-trace content do not enter canonical learning evidence.
- Branch identity is explicit. A provider thread, branch identity, and event identity form the source-bound continuity domain. Sibling branches never share continuity, and a provider that cannot expose a stable branch identity is unsupported for continuous processing.
- An external resource is read incrementally. Discovery metadata, activation watermark, discovery page state, per-resource event cursor, and processed-event deduplication state are separate durable concerns.
- First enablement records a metadata-only future boundary. It does not read historical content. Providers without a stable global watermark or per-resource activation baseline are limited to explicit bounded backfill.
- A source event must have stable provider-scoped identity and monotonic position within its resource, plus an immutable revision or canonical content hash. Array index, fetch time, display title, and ephemeral URI are not valid event identity.
- Thread-level revision pinning is optional. Event-level identity and immutable bounded ranges are mandatory. A thread revision is a stability hint and must not treat ordinary append activity as an integrity conflict.
- One read page is the cursor transaction boundary. Every event in the page must normalize, ingest, persist its Evidence Capsule and provenance, and become idempotently durable before the page cursor is acknowledged. Replays are expected and must be harmless.
- The durable order is: read stable event, normalize, ingest Learning Episode, persist Evidence Capsule, persist external provenance, and acknowledge source cursor last. Promotion success is not required for source acknowledgement because review retry is local and durable.
- Source content remains untrusted evidence. The existing source-neutral Learning Episode prefilter and the ordinary Evidence Bundle and Branch Promotion Reviewer gates decide whether any reusable Capability exists.
- Evidence Capsules preserve sanitized source identity, event identity, conversation/branch identity, position, revision or content hash, bounded evidence, and local audit linkage. The upstream resource locator is not a durable identity and is not retained unless an explicitly sanitized diagnostic locator is needed.
- Source content hash and local capsule evidence fingerprint have separate responsibilities. The source hash detects event mutation and deduplication; the capsule fingerprint detects local redacted-evidence consistency.
- External source failures are isolated from review failure accounting. Transient, pending, protocol, permission, integrity-conflict, and quarantine states have distinct operational behavior.
- Oversized or unsafe events fail closed into durable quarantine. Only explicit retry or skip can resolve them; skip writes a durable tombstone before the cursor crosses the event.
- External enablement is a reversible admission gate. Disabling a source pauses new reads and preserves all local learning and audit state. Re-enabling resumes the existing source state without redefining history.
- Resource deletion or archival closes the local resource after confirmation but does not delete its cursor, Capsules, Episodes, Capabilities, or Audits.
- A provider-scoped lock prevents concurrent heartbeat and backfill readers from writing the same source state. Different providers remain isolated.
- Source health is visible in Runtime status and durable heartbeat diagnostics. Raw xurl output, raw stderr, and complete external transcripts are not status payloads.
- Privacy mode is deliberately not part of this first protocol decision. It can later choose how much bounded external evidence is retained, without changing source identity, cursor, stability, or idempotency semantics.

## Testing Decisions

- Tests assert observable behavior at the Runtime Learning public seams, not private helper implementation details.
- A fake xurl executable emits deterministic protocol-v1 discovery and read responses. Tests cover process arguments, non-interactive behavior, timeout, invalid output, output limits, and exit failures.
- The explicit backfill path is tested end to end for one provider: source discovery, canonical turn normalization, bounded ingestion, capsule persistence, review/promotion linkage, cursor acknowledgement, restart recovery, and idempotent rerun.
- Continuous source tests cover first-enable future-only behavior, activation watermark recovery, discovery pagination, incremental resource reads, branch isolation, bounded continuity, stability sampling, event conflict, and deleted resources.
- Crash and failure tests place failures between every durable step and verify replay, deduplication, cursor safety, and absence of duplicate Learning Episodes.
- Operational tests cover provider lock contention, source-specific backoff, protocol and integrity classification, quarantine retry/skip, status reporting, graceful drain, and internal-lane independence.
- Existing source-neutral, Evidence Capsule, backfill, runtime-learning, heartbeat scheduler, and skill-evolution suites remain regression gates.
- A real xurl smoke test is optional and environment-gated. It must never be required for deterministic CI or for tests that verify source failure behavior.

## Out of Scope

- Cloud heartbeat ownership or remote source processing. The first implementation remains inside the local Runtime process.
- Provider-specific parsers in XiaoBa. Codex, Pi, and Claude Code parsing remains an xurl responsibility.
- Automatic xurl installation, package management, credential provisioning, or login UX.
- Markdown scraping or a full transcript mirror.
- Simultaneous multi-provider heartbeat processing or automatic provider rotation.
- A new conversation-snapshot domain model.
- Direct external promotion, external-specific reviewer authority, or bypassing Evidence Bundle and Branch Promotion Reviewer gates.
- A privacy-mode implementation beyond preserving the current bounded Evidence Capsule boundary.
- A general-purpose attachment downloader or binary artifact mirror.
- Migration of every internal `filePath` field to a new universal source-reference model.

## Further Notes

The source-neutral foundation, external source work lane, Evidence Capsule, and explicit backfill seams already exist in the closed #75–#79 work. This PRD completes the missing production xurl reader and the operational contracts around it; it does not reopen those decisions.

The first implementation should ship as a tracer bullet: one selected provider, one fixed protocol, one explicit bounded backfill, and deterministic fake-process tests. Continuous future-only heartbeat support can then reuse the same reader and identity semantics without introducing a second evidence pipeline.
