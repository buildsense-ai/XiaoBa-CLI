## Parent

#84

## What to build

Reuse the production xurl reader from #85 for one-provider continuous Heartbeat Log Distillation. The selected external provider must enter the existing Runtime source work lane without becoming a second heartbeat or a full transcript mirror.

Continuous enablement is future-only. The first enablement records a metadata-only activation boundary, then later wakes use separate durable discovery and event cursors to read only bounded new resources and stable event ranges. Branch identity, source-bound continuity, and the existing source work budgets remain visible through the normal heartbeat result and status path.

## Acceptance criteria

- [ ] External continuous processing is disabled by default and, when enabled, processes only the one configured provider for that wake.
- [ ] First enablement performs metadata-only discovery and persists a source-level activation watermark or per-resource activation baseline without reading historical content.
- [ ] Restart recovery restores activation state, discovery pagination state, resource cursors, and processed-event deduplication without replaying pre-enable history.
- [ ] Discovery progress is durable and separate from per-resource event progress; bounded pages continue across wakes without starving later resources.
- [ ] Resource reads use incremental provider position/event identity and hard limits; the reader never requires fetching an unbounded complete conversation for ordinary heartbeat work.
- [ ] Each branch has isolated resource identity, cursor, stability state, and source-bound continuity; sibling branches never share continuity.
- [ ] Stable complete events advance their branch cursor only after the existing ingestion and Evidence Capsule ordering succeeds.
- [ ] Pending or mutable ranges remain unacknowledged; event identity or content conflicts fail closed without overwriting existing evidence.
- [ ] Thread revision is treated as a stability hint, not a mandatory whole-thread snapshot lock; event-level immutable ranges remain the hard requirement.
- [ ] Continuity is limited to the same branch and the configured bounded tail; missing parent context is recorded as incomplete rather than filled with unbounded history.
- [ ] Disabling and re-enabling a provider pauses and resumes its existing state without deleting local Episodes, Capsules, Capabilities, Audits, or redefining the historical boundary.
- [ ] Internal heartbeat discovery and due-work processing remain healthy when the external provider is unavailable or unsupported.
- [ ] Public `wake` tests cover future-only enablement, discovery pagination, incremental continuation, branch isolation, pending stability, restart recovery, and internal-lane independence.

## Blocked by

- #85
