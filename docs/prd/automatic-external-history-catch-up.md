# Automatic External History Catch-Up Through Heartbeat

Status: implemented

This PRD extends the implemented [Multi-Provider External Session Log Distillation Through Official xURL](./multi-provider-external-session-log-xurl.md) architecture. It preserves the official xURL reader, future-only default, provider controls, bounded concurrent reads, External Admission Coordinator, explicit backfill, Evidence Capsule, failure isolation, and ordinary Skill Evolution pipeline. [ADR-0044](../adr/0044-automatic-external-history-catch-up-uses-per-thread-targets.md) records the core consistency decision.

Issues #98-#102 implement this PRD. Deterministic Runtime, source, scheduler, recovery, diagnostics, and active-handle tests remain the CI authority. On 2026-07-16, both opt-in installed-xURL Canaries passed against official `xurl 0.0.27`: future-only established a non-admitting baseline, while catch-up admitted sanitized historical evidence for two providers through ordinary Runtime wakes with overlapping reads, serialized durable admission, released provider locks, and no remaining child-process handles.

## Problem Statement

The current external lane deliberately establishes a future-only activation baseline. That behavior prevents surprise imports, but it also means a user who wants XiaoBa to learn from existing Codex, Claude Code, Pi, or future xURL-supported conversations must construct and trigger explicit bounded backfill operations.

That operator model does not match the normal intent. Users usually want to enable one provider, let the local Heartbeat inspect all completed in-scope conversations over time, and allow the existing learning agent to discover useful topics. They should not select semantic topics, calculate ordinal ranges, or trigger every batch.

An unbounded startup scan would create a different failure. It could delay internal work, multiply cost with each provider, promote evidence before later corrections in the same thread arrive, and duplicate the scheduling, cursor, review, and recovery mechanisms that already exist.

XiaoBa therefore needs an opt-in historical policy that turns the existing Heartbeat into a bounded, resumable catch-up worker without creating another scheduler or evidence path.

## Goals

1. Add a durable `future-only` or `catch-up` history mode for each enabled external provider.
2. Keep `future-only` as the default so an upgrade never imports history without operator intent.
3. Let Heartbeat automatically scan every in-scope thread and canonical completed turn when catch-up is enabled.
4. Bound every wake by existing source, byte, elapsed-time, concurrency, and review budgets.
5. Prevent historical review before the Runtime has admitted the complete fixed thread range on which that review depends.
6. Reuse the existing provider locks, xURL adapter, cursor state, External Admission Coordinator, Learning Episode, Evidence Capsule, Author, Verifier, and promotion path.
7. Keep Internal Session Log Source work first and continuous external work timely while guaranteeing eventual historical progress.
8. Make pause, resume, scope change, restart, quarantine, skip, and rebaseline behavior durable and operator-visible.
9. Keep explicit bounded backfill available for repair, replay, and precise ranges.

## Non-Goals

- Enabling historical import by default.
- Asking users to select topics, threads, ordinal ranges, or batch operation IDs for ordinary catch-up.
- Building a second Heartbeat, cron process, historical reviewer, semantic summarizer, or promotion policy.
- Creating an atomic provider-wide snapshot that xURL cannot supply.
- Detecting arbitrary semantic contradictions outside the existing bounded Continuity Context, Source Ref Window, and Settlement Evidence Window.
- Mirroring complete external transcripts or provider catalogs into a new local store.
- Changing the official xURL rendered Timeline contract or adding provider-specific parsers to XiaoBa.
- Allowing parallel writers for Episode, Capsule, provenance, Registry, cursor, or target state.
- Changing privacy or retention policy; the existing bounded Evidence Capsule remains authoritative.
- Replacing explicit backfill recovery or quarantine retry and skip operations.
- Adding cloud scheduling or cross-machine ownership.

## Product Model

### External History Mode

Each provider has one durable External History Mode:

- `future-only` establishes or preserves activation baselines and admits only events after those baselines.
- `catch-up` automatically admits stable historical events from every in-scope thread through bounded Heartbeat work.

The mode controls historical discovery and admission. It does not change provider identity, trust, review policy, or the continuous cursor. The global default is `future-only`, and a durable provider override takes precedence over the environment default.

Direct enablement in catch-up mode has no provider-wide activation barrier. Known future-only resources continue their continuous cursor while inventory runs. Their already-admitted episodes retain their existing settling, eligible, deferred, queued, reviewed, or contradicted state; creating a target never adds a retroactive historical gate. A newly discovered resource admits nothing until it has a stable target; after that point, events through the target use catch-up and later complete events use continuous admission.

Switching from catch-up to future-only pauses new historical page claims. A page that has already entered the coordinator's committing state finishes atomically, while ready or reading pages remain replayable and unacknowledged. The Runtime preserves every target, cursor, Episode, Capsule, quarantine record, and audit so a later switch back to catch-up resumes the same work.

### Per-Thread Catch-Up Target

The external thread is the smallest consistency domain that contains ordered conversation corrections. When a catch-up catalog pass discovers an eligible thread, the Runtime records an immutable boundary containing:

- provider, source, resource, conversation, and branch identity;
- the end position of the highest complete stable event, or an explicit empty boundary;
- a cumulative prefix digest over the ordered canonical event identities and content hashes through that position;
- the generation and scope fingerprint that created the boundary; and
- the observation time.

Mutable state remains on the resource record rather than inside the target. It includes the latest observed catalog generation, historical cursor, pending sample, progress counts, retry state, quarantine linkage, and terminal lifecycle.

Catalog metadata discovers a resource but does not define its target. The Runtime samples the rendered Timeline through the existing Stability Gate and records the highest complete User-to-Assistant event only after two bounded observations produce the same normalized prefix. An empty or incomplete-only thread receives an explicit empty boundary and empty-prefix digest. Its first later completed event therefore belongs to continuous admission. A changing sample remains pending and creates no target.

The Runtime persists the target before admitting its first historical page. It then reads from the earliest canonical event not already proven admitted through stable event identity and exact deduplication. Existing future-only evidence, prior catch-up evidence, and explicit backfill evidence are not duplicated.

Events whose completion position is at or below the target belong to historical catch-up. Events above it belong to the continuous lane and never extend the target. Each read recomputes the relevant cumulative prefix, so mutation of any earlier event at or below the target fails closed even when xURL supplies no universal thread revision.

### Catch-Up Catalog Pass

xURL does not expose a provider-wide atomic snapshot or a portable cursor-paginated catalog. The Runtime therefore performs bounded, durable expanding-limit passes rather than claiming global snapshot consistency.

A pass starts with a bounded xURL catalog limit. If the result count reaches that limit, the Runtime persists the next larger limit and repeats the query on a later wake. The pass completes only when one bounded observation returns fewer resources than the requested limit. If the configured maximum catalog, output, or duration cap cannot establish that condition, the provider enters `catch_up_blocked`; it never claims completion from a truncated catalog.

A pass stores only its generation ID, provider, scope fingerprint, requested limit, start and completion times, and aggregate counts. Each resource record stores the latest generation that observed it, which makes pass membership reconstructable without copying a full provider manifest. Repeated expanding queries are idempotent because known resources update their observed generation without changing an existing target.

Only one catch-up generation is active per provider. The Runtime does not start the next generation until the current generation reaches a terminal caught-up or explicitly blocked state, and it persists the completed generation summary before resource records can advance to a later generation. The latest observed generation is therefore sufficient for active membership; Transition Audits retain completed-generation summaries rather than historical catalog copies.

The provider reports `caught_up` only when:

1. one catalog observation has returned fewer resources than its requested limit for the current scope;
2. every thread observed by that generation has reached its fixed target or has an explicit terminal-exclusion tombstone; and
3. no previously opened in-scope target remains pending, failed without a retry time, missing without explicit closure, or quarantined without operator resolution.

A thread discovered after the pass closes joins a later pass. A catalog that changes during expansion may move a resource between observations, but the final under-limit observation is the pass boundary and the next pass repairs any omission. Catch-up remains a persistent policy, so Heartbeat starts later passes automatically while the mode stays enabled.

### Historical Episode Eligibility

Catch-up uses the same canonical turn normalization and source-neutral ingestion pipeline as continuous evidence. The Runtime marks each admitted historical Learning Episode as `historical-pending` and links it to the source target.

The Runtime does not run Author or Verifier review for that episode until the source thread reaches its fixed target. Once the target is complete, an idempotent reconciliation evaluates every already-linked contradiction signal, marks contradicted episodes accordingly, and makes the remaining pending episodes eligible. Target completion replaces an additional wall-clock Settlement Window for that fixed historical range; old source timestamps do not bypass the gate or start another wait.

This rule guarantees admission ordering, not unbounded semantic understanding. The reviewer still receives only the existing bounded Continuity Context, Source Ref Window, Settlement Evidence Window, and fixed Evidence Bundle. A distant correction that those contracts do not relate remains later evidence, and ordinary Skill Evolution may defer, reject, merge, replace, or otherwise revise the capability when that evidence becomes reviewable.

The Runtime does not force a skill from every historical thread. The existing prefilter and review path may conclude that no reusable candidate exists.

### Scope Changes

History mode determines how scope expansion treats newly included resources:

- In future-only mode, newly included resources establish a current activation baseline and do not admit older events.
- In catch-up mode, newly included resources start from their earliest canonical event and receive a fixed target.

Scope narrowing pauses out-of-scope targets without deleting their progress or evidence. Re-expansion resumes known targets at their preserved cursor. Events appended after the old target continue through the continuous lane rather than redefining historical work.

A scope change invalidates the active catalog-pass generation and starts a new pass with a new scope fingerprint. Reading and ready pages claimed under the old scope are canceled or discarded without acknowledgement. A page already committing finishes atomically under the scope that admitted it, after which out-of-scope targets remain paused.

Previously promoted skills remain installed after scope narrowing. Scope controls future source discovery; it does not rewrite local evidence or Transition Audits.

## Scheduling and Cost Bounds

### Discovery and Admission Order

One eligible discovery wake follows this order:

```text
Internal discovery
  → timely continuous external work
  → at least one global bounded catch-up quantum when backlog exists
  → work-conserving use of remaining discovery budget
  → settlement and review
```

An eligible discovery wake is a startup, scheduled, or manual discovery wake that reaches the external phase before drain or deadline and has at least one due, lockable provider. One catch-up quantum performs the next bounded action for a provider: expand catalog inventory once, take one target-stability observation, or read and admit one historical page. Preparation and admission use the same durable due order, so continuous ready-page pressure cannot starve inventory or target creation.

The historical guarantee is global, not one quantum per provider. A durable provider round-robin selects the next catch-up lane, so adding providers does not multiply the minimum cost of every wake. If `P` providers remain continuously due and lockable, each receives a catch-up quantum within at most `P` eligible external phases. A paused, locked, backed-off, drained, or not-due provider does not consume the turn.

External reads may overlap through the existing bounded read pool, with at most one uncommitted page per provider lane. The External Admission Coordinator remains the only writer. It serializes continuous, catch-up, and explicit backfill pages through the existing page-boundary arbitration and cursor-last commit order.

An explicit backfill request retains its existing guarantee to receive the next available page turn for that provider. After that turn, the coordinator rotates durably among every ready continuous, catch-up, and backfill lane and does not select the same lane twice while another lane is ready. Inventory and stability work finish before catch-up offers a page to the coordinator. Empty or blocked lanes donate their turn immediately.

The Runtime does not promise a historical page after a shutdown or deadline has already started draining the external phase. It records the unfinished turn as resumable work for the next eligible wake instead of treating cancellation as failure.

### Review Fairness

Historical catch-up can release many eligible episodes at a target boundary. The shared review budget must therefore rotate durably among three non-empty work classes:

1. due deferred and operational review entries;
2. internal and continuous eligible episodes; and
3. historical-ready episodes.

The rotation persists across wakes and remains work-conserving. With one candidate per wake, each continuously non-empty class receives a candidate within three review wakes. Each class uses a durable continuation cursor over a deterministic order, so newly arriving work cannot repeatedly restart iteration and starve later providers or episodes. The implementation must not create a historical-only reviewer or duplicate an episode into another queue.

All classes share the configured Author and Verifier concurrency, candidate count, prompt-token budget, attempt deadline, and shutdown signal.

## Durability and Recovery

### Commit Ordering

The Runtime preserves the existing external admission order:

```text
persist fixed thread target before first historical admission
→ normalize stable event
→ ingest or deduplicate Learning Episode
→ persist redacted Evidence Capsule
→ persist external provenance
→ acknowledge source cursor last
```

When the cursor reaches the target, an idempotent reconciliation marks linked historical episodes ready for ordinary maturation and review. A crash before the cursor acknowledgement replays the page. A crash after the target cursor but before episode release reruns reconciliation without duplicating evidence or review bundles.

Stable Source Event Identity is the cross-lane deduplication key. One canonical event has one Episode and Capsule even when continuous, catch-up, and explicit backfill all observe it. Provenance may record multiple admission observations, but a later lane cannot weaken or retroactively add a historical gate to an episode that has already completed ordinary review. Conversely, deduplicating a normal backfill against a historical-pending episode does not bypass its target gate.

### Failures and Quarantine

Transient and pending failures back off only the affected source or resource. Other providers and threads continue.

Oversized, unsafe, or otherwise unadmittable events use the existing resource quarantine path. Episodes that depend on that target remain historical-pending, while other healthy resources may continue. A protocol failure or integrity conflict makes the provider's normalized identity untrustworthy and therefore preserves the implemented provider-level pause until repair or explicit recovery. Already completed targets can continue through local review, but the provider reports `attention_required` or `blocked` rather than `caught_up`.

An event retry reprocesses the same quarantined stable identity. An event skip writes an exact-event tombstone before the historical cursor crosses it. A confirmed delete or archive closes one missing resource and records the unresolved target as an audited exclusion. Rebaseline abandonment writes a range tombstone for every unread interval rather than pretending that each missing event was observed. Catch-up status reports all exclusions and never claims that XiaoBa learned skipped evidence.

External source failures remain isolated from Operational Review Retry and Branch Promotion Reviewer failure accounting unless evidence has already entered ordinary review and that review independently fails.

### Pause and Explicit Abandonment

A mode switch to future-only pauses catch-up but does not abandon it. Completed thread targets may continue through review; incomplete targets and their historical-pending episodes remain durable and ineligible.

The existing command provides the explicit abandonment boundary:

```text
xiaoba external-source rebaseline <provider> --skip-to-now
```

When unfinished catch-up exists, rebaseline requires the provider to be in future-only mode. It closes unfinished targets, writes `abandoned/skip-to-now` tombstones and an operator audit, marks affected historical-pending episodes permanently ineligible, and advances the continuous baseline to the current stable head. It preserves Episodes, Capsules, provenance, and audits for traceability.

Ordinary catch-up and ordinary backfill respect those tombstones. An operator who later needs the excluded interval must run explicit bounded backfill with an audited tombstone-reopen option that names the affected skip or abandonment record. The reopened operation has its own fixed range boundary. Episodes created or deduplicated from that range remain historical-pending until the complete reopened range reaches that boundary or another explicit terminal exclusion. Only then may reconciliation restore eligibility; reopening never creates a duplicate Episode or erases the original audit.

## Configuration and Operator UX

### Environment Default

The environment defines one startup default for all providers:

```env
XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE=future-only
```

Accepted values are `future-only` and `catch-up`. Missing or invalid values fail safely to `future-only` with a bounded diagnostic. Existing provider enablement does not change mode implicitly.

Control precedence remains:

```text
global external master switch off
  > durable provider history-mode override
  > environment history-mode default
```

### CLI

The human-facing surface extends the existing command family:

```text
xiaoba external-source enable <provider> --history catch-up
xiaoba external-source history <provider> catch-up
xiaoba external-source history <provider> future-only
xiaoba external-source status [--json]
```

The first command enables a provider and records its history policy in one action. The `history` command changes the policy for an existing provider at the next scheduling boundary. Neither command asks for a topic, range, operation ID, or batch cap.

Explicit backfill retains its bounded operator API for repair and exact replay. It is not the normal UX for learning an existing provider history.

The existing `external-source reset <provider>` command removes all durable overrides for that provider, including its history-mode override, and returns to environment defaults. It preserves cursor, target, Episode, Capsule, quarantine, tombstone, and audit state.

## Readiness and Diagnostics

The Runtime preserves the implemented activation lifecycle and reports catch-up as additional orthogonal dimensions:

- `admissionGate`: `open`, `closed`, or `draining`;
- `activationState`: `activating`, `active`, `paused`, or `activation_blocked`;
- `historyMode`: `future-only` or `catch-up`;
- `catchUpState`: `idle`, `inventory`, `catching_up`, `caught_up`, `paused`, or `catch_up_blocked`;
- `sourceHealth`: `healthy`, `waiting`, `attention_required`, or `blocked`.

Future-only providers use the existing activation state and keep `catchUpState=idle`. A catch-up provider with unfinished targets reports `catchUpState=paused` while its mode is temporarily future-only or its admission gate is closed. The human summary applies admission gate first, then blocked activation or source health, then waiting source health, and finally catch-up progress.

The Runtime distinguishes normal progress from degraded source health:

- `activating`, `active`, `inventory`, `catching_up`, `caught_up`, and `paused` are healthy operational states.
- Ordinary historical backlog does not degrade Internal Runtime readiness.
- Transient or pending backoff reports `waiting` and a `nextRetryAt` value.
- Quarantine, integrity conflict, long-lived missing resources, and incompatible xURL output report provider-local `attention_required` or `blocked`.
- A blocked external provider produces an overall `ready_with_external_attention` state while Internal learning and healthy providers remain ready.
- Only a failure of the Internal learning core or required single-writer persistence boundary makes the complete Runtime not ready.

CLI, Dashboard, and durable heartbeat records consume one diagnostic builder. Each provider exposes:

- history mode and scope;
- activation state and baseline progress;
- catalog generation, requested limit, scope fingerprint, and target progress;
- historical pending, ready, complete, skipped, and quarantined counts;
- last successful historical progress;
- retry deadline, redacted failure class, and next operator action;
- read, ready-page, committing, and drain state where applicable.

Status payloads never include raw transcript text, raw xURL stderr, or unsanitized local paths.

## User Stories

1. As an operator, I can opt one provider into catch-up once and let Heartbeat drain its in-scope history without manually triggering batches.
2. As an operator, I can leave other providers in future-only mode and change each provider independently.
3. As an operator, I can pause catch-up without losing targets, cursors, evidence, or audit history.
4. As an operator, I can narrow or expand provider scope and receive mode-consistent behavior without duplicate admission.
5. As an operator, I can see whether a provider is scanning, caught up, waiting, paused, quarantined, or blocked.
6. As an operator, I can retry or explicitly skip one bad event without blocking unrelated historical learning.
7. As an operator, I can deliberately abandon unfinished history through an audited rebaseline rather than deleting state.
8. As a maintainer, I can prove that historical admission uses the same crash-safe commit boundary and review authority as live evidence.
9. As a maintainer, I can add future xURL providers without changing catch-up semantics or introducing provider enums.

## Acceptance Criteria

1. `future-only` remains the default after upgrade, and ordinary enablement imports no historical evidence unless catch-up is explicitly selected.
2. Environment configuration provides a global history-mode default, while durable per-provider overrides survive restart and follow existing control precedence.
3. CLI commands enable catch-up, switch back to future-only, and report the effective mode without exposing range or operation internals.
4. Catch-up runs only through ordinary Heartbeat wakes and resumes automatically after restart; it does not create another timer or scheduler owner.
5. A bounded catalog pass persists its generation, requested limit, and scope fingerprint, and blocks instead of claiming completion when the official xURL catalog reaches configured limits.
6. Each in-scope thread receives an immutable completed-event or empty target with a cumulative prefix digest before its first historical page is admitted; mutable progress remains separate resource state.
7. Historical admission begins at the earliest canonical event not already proven admitted and deduplicates evidence shared with continuous or explicit backfill paths.
8. Events above a target continue through the continuous lane and do not extend or restart historical work.
9. Historical episodes remain ineligible while their source target is incomplete, even when old source timestamps would otherwise make settlement immediately due.
10. Reaching a target idempotently applies already-linked contradictions and releases only the remaining linked historical episodes into ordinary review without starting another wall-clock Settlement Window.
11. Internal discovery finishes first; continuous external work remains timely; one global catch-up quantum advances inventory, target sampling, or page admission per eligible wake, and `P` continuously due providers receive quanta within `P` eligible external phases.
12. Additional historical work uses remaining source, byte, time, and admission budgets without exceeding configured limits.
13. Due review retries, internal or live episodes, and historical-ready episodes receive durable fair service under one shared review budget; with a candidate limit of one, each continuously non-empty class receives service within three review wakes.
14. Read concurrency remains bounded, and all continuous, catch-up, and explicit backfill admissions remain serialized through the External Admission Coordinator.
15. Switching to future-only pauses unfinished targets; switching back resumes them without redefinition or duplicate evidence.
16. Scope expansion baselines new resources in future-only mode and starts them from history in catch-up mode; narrowing preserves out-of-scope progress, invalidates the old catalog generation, and drains only an already-committing page.
17. Resource quarantine blocks only the affected target; protocol or integrity failure preserves the existing provider-level pause; neither failure affects Internal learning or another provider.
18. A provider cannot report caught up while a target remains unresolved without an explicit event-skip, resource-closure, or abandonment tombstone.
19. Rebaseline requires future-only mode when unfinished catch-up exists and writes durable abandonment tombstones and audit records before advancing baselines.
20. Internal readiness remains healthy during ordinary catch-up, backlog, external backoff, or one blocked provider; diagnostics preserve activation state and expose separate admission, history mode, catch-up progress, and source-health dimensions.
21. Crash tests at target persistence, Episode, Capsule, provenance, cursor acknowledgement, and target completion boundaries prove replay without loss, duplication, or premature review.
22. Deterministic tests cover multiple providers, expanding-limit catalog passes, long threads, incomplete tails, moving catalogs, scope changes, mode changes, restart, drain, backoff, quarantine, skip, rebaseline, and active-handle cleanup.
23. The installed-xURL Canary continues to pass in future-only mode and gains an opt-in catch-up case that proves historical admission without touching private user roots.
24. TypeScript, focused Runtime tests, the repository test gate, and diff checks pass.

## Test Strategy

- Test configuration parsing, precedence, invalid-value fallback, CLI persistence, and status through public seams.
- Use deterministic official-xURL fixtures with expanding-limit catalogs, multiple providers, long threads, incomplete tails, revisions, and resources that appear between catalog passes.
- Assert that catch-up records an immutable empty or completed-event target with a cumulative prefix digest before admission and never changes it when live events append.
- Exercise exact deduplication and eligibility precedence across prior future-only admission, automatic catch-up, ordinary backfill, and an audited reopened tombstone.
- Hold historical episodes behind incomplete targets, then prove idempotent release after the target cursor settles.
- Configure one review candidate per wake and prove durable rotation among retries, live work, and historical work.
- Instrument external reads and coordinator commits to prove bounded overlap and one serialized writer.
- Inject crashes between every durable write and verify target, cursor, Capsule, provenance, and review recovery.
- Test narrowing, expansion, pause, resume, abandon, retry, skip, deleted resources, and restart without deleting traceability.
- Keep deterministic CI independent of installed xURL and private logs. Extend the existing opt-in official-xURL smoke with sanitized fixture roots only.

## Delivery Slices

1. **History policy and target state** — add configuration, durable provider overrides, CLI controls, target schema, catalog-pass progress, migrations, and diagnostics without admitting history.
2. **Heartbeat catch-up tracer bullet** — admit one provider's historical pages through the existing coordinator, hold episodes behind one thread target, release them at completion, and prove restart-safe deduplication.
3. **Bounded multi-provider scheduling and review fairness** — add global catch-up quanta, provider round-robin, work-conserving budget use, and durable review-class rotation.
4. **Scope, recovery, and abandonment** — complete mode and scope transitions, quarantine retry and skip, rebaseline tombstones, resource lifecycle, and readiness behavior.
5. **Release gate and documentation** — expand deterministic matrices, extend the opt-in installed-xURL Canary, update operator guidance, and verify full repository gates.

Each slice must keep future-only behavior green, preserve Internal learning when xURL is absent, and avoid introducing a second scheduler or reviewer.
