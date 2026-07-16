# Multi-Provider External Session Log Distillation Through Official xURL

Status: implemented

This PRD follows the completed [External Session Log Distillation Through xurl](./external-session-log-xurl.md) tracer bullet. It preserves the source-neutral adapter, provider lock, durable cursor, bounded backfill, Evidence Capsule, failure isolation, quarantine, and ordinary Skill Evolution pipeline delivered by #75–#87. It replaces only the earlier one-selected-provider scope and private `session-log-v1` process contract.

The architectural decisions are recorded in:

- [ADR-0042: External Provider Reads Use Bounded Concurrency](../adr/0042-external-provider-reads-use-bounded-concurrency.md)
- [ADR-0043: Official xURL Rendered Timeline Is the External Reader Contract](../adr/0043-official-xurl-rendered-timeline-is-the-reader-contract.md)

The implemented [Automatic External History Catch-Up Through Heartbeat](./automatic-external-history-catch-up.md) extension and [ADR-0044](../adr/0044-automatic-external-history-catch-up-uses-per-thread-targets.md) add an opt-in persistent history policy. They preserve this PRD's implemented future-only default, official xURL contract, bounded concurrency, and serialized admission architecture.

## Problem Statement

The Runtime can currently construct only one configured continuous external source, and its xURL reader invokes a XiaoBa-specific `session-log-v1` command that the official xURL CLI does not provide. The deterministic tests validate the intended source protocol, but an operator cannot install unmodified xURL, enable several providers, and run the continuous path end to end.

Users commonly work across Codex, Claude Code, and Pi on the same machine. Provider state is already isolated, so a global single-provider selection unnecessarily prevents independent enablement. Conversely, allowing every provider to write the shared Episode, Capsule, provenance, and cursor stores concurrently would weaken the existing crash-safety invariants.

The Runtime therefore needs multiple independently controlled provider lanes, concurrent source reads, serialized durable admission, and a thin adapter over official xURL's existing `agents://` interface.

## Goals

1. Run the unmodified official xURL CLI without a XiaoBa-specific bridge, fork, or provider parser.
2. Allow any number of provider identities to be configured and independently enabled or paused.
3. Overlap external xURL reads with bounded concurrency while preserving a single writer for local evidence admission.
4. Keep Internal Session Log Source processing first and independent from every external failure.
5. Preserve future-only continuous admission with a complete, resumable activation baseline.
6. Preserve provider-local cursor, backoff, quarantine, lifecycle, and audit state across disable, restart, scope changes, and compatible xURL upgrades.
7. Provide a durable CLI operator surface for status, enable, disable, reset, and explicit rebaseline.
8. Prove the integration through public Runtime seams and an environment-gated smoke test against official xURL.

## Non-Goals

- Reimplementing Codex, Claude Code, Pi, or other provider log parsers in XiaoBa.
- Adding or requiring a new command or output mode in xURL.
- Automatically installing or upgrading xURL.
- Running multiple writes to Episode, Capsule, provenance, Registry, or cursor stores concurrently.
- Turning external evidence into a separate review or promotion path.
- Importing historical threads during ordinary provider enablement without an explicit catch-up policy.
- Adding Dashboard write controls in the first release; Dashboard remains a read-only status surface.
- Cloud scheduling, remote transcript upload, or cross-machine cursor ownership.
- Provider-specific trust weights or provider-specific Skill Evolution policy.

## Product Model

### Enabled External Provider Set

Continuous external admission is controlled by a set, not a selected value. Provider IDs are normalized opaque identifiers supplied to xURL; XiaoBa does not encode an enum of known agents. Official xURL may reject an unsupported identifier, which remains a source-local support failure.

Each provider has a durable External Provider Admission Gate. Closing the gate pauses new admission without deleting cursor, Capsule, Episode, quarantine, or audit state. Reopening it resumes from the preserved cursor and admits events produced while paused.

An explicit rebaseline is the only operation that skips unread events. It advances watermarks to the current stable Timeline without admitting the skipped interval and writes an operator audit record.

### External Source Scope

The default scope is all threads visible to xURL for that provider. An operator may narrow one provider to a project path supported by xURL's path-scoped query.

Scope is an admission filter, not provider identity:

- Narrowing scope pauses out-of-scope resources while preserving their state.
- Expanding scope resumes known resources from their cursors.
- Existing resources newly entering scope establish an activation baseline before admission.
- Changing scope never deletes local evidence or creates a duplicate provider namespace.

### xURL Rendered Timeline

The adapter invokes only documented official commands:

```text
xurl agents://<provider>?limit=<n>
xurl agents://<provider>/<thread-id>
xurl -I agents://<provider>/<thread-id>
xurl --version
```

For a scoped provider it uses xURL's documented path query with a provider filter. Child or branch URIs returned by xURL remain distinct resources.

The adapter validates the rendered document rather than parsing provider files:

- Frontmatter URI must match the requested provider and thread.
- The document must contain the expected Thread and Timeline structure.
- Numbered Timeline entries must be contiguous and use only User, Assistant, or Context Compacted roles.
- A canonical external event is one complete User-to-Assistant ordinal range with bounded compacted context.
- Event identity is derived from provider ID, thread ID, branch/child identity when present, and the normalized ordinal range.
- Event content hash is computed over normalized roles and content, not xURL frontmatter or local paths.
- A prior ordinal range whose normalized hash changes is an integrity conflict.
- Unrecognized or ambiguous rendering fails closed as a provider-local protocol failure.

The adapter ignores and never persists `thread_source` or another raw local path from xURL output. Rendered content remains untrusted evidence and passes through the existing external sanitization, Evidence Capsule, fixed Evidence Bundle, Author, and Verifier gates.

### Known Renderer Limitation

Official xURL emits Markdown rather than a machine event stream. Message text can itself contain heading-shaped Markdown. The adapter must use a strict contiguous parser, reject duplicate/non-monotonic headings and malformed frontmatter, and include adversarial heading-content fixtures. A structurally valid heading sequence embedded at the tail of a message cannot be proven distinguishable without a machine-readable xURL contract; this residual risk is accepted in preference to forking xURL or duplicating provider parsers. External evidence remains untrusted and cannot bypass review.

## Activation and Future-Only Admission

### Complete Activation Baseline

The first enablement of a provider enters `activating`. The Runtime discovers every existing in-scope thread and records, without evidence admission:

- provider and resource identity;
- branch or child identity when exposed by xURL;
- highest normalized Timeline ordinal;
- normalized fingerprints needed to detect later mutation;
- xURL version and observation time for diagnosis.

Baseline work is bounded and resumable across wakes. The adapter expands xURL's query limit until it proves that the complete in-scope catalog fits below the requested limit. It then baselines thread bodies in bounded slices. Newly created threads discovered after the complete catalog boundary may be admitted from their first stable completed turn.

If the catalog, rendered output, or activation duration exceeds configured limits, the provider enters durable `activation_blocked`. It does not partially activate. Existing baseline progress is retained so an operator may narrow scope or raise an explicit cap and continue.

### Stability Sampling

xURL's rendered Timeline does not expose a universal provider completion flag. A newly observed tail therefore satisfies the existing External Source Stability Gate only when it forms a complete User-to-Assistant range and two bounded observations produce the same normalized ordinal range and hash. A changed observation resets the pending sample. Pending stability never advances the durable cursor and is not a provider failure.

The scheduler may request a source-targeted follow-up wake rather than waiting for the full discovery cadence. Stability sampling remains bounded by the provider lane and global discovery budgets.

## Scheduling and Concurrency

One wake has three ordered phases:

```text
Internal discovery
  → bounded concurrent external reads
  → serialized external admission
  → existing settlement/review/promotion work
```

Internal discovery completes before any external process is started. External availability, timeout, malformed output, backoff, or lock contention cannot change the Internal result.

### Bounded Read Concurrency

Eligible external providers read and normalize concurrently. The configured concurrency range is 1–8 with a default of 3. Actual concurrency is the smaller of the configured limit and the count of enabled, due, non-paused, non-backed-off providers.

The async seam ends at a ready External Evidence Page. Each provider may prefetch at most one uncommitted page, bounding memory and replay work. Provider reads receive the remaining global discovery deadline through an AbortSignal. xURL is launched without a shell, with ignored stdin, bounded stdout/stderr, validated arguments, and a process-group cancellation path.

### Serialized Admission

A single External Admission Coordinator owns local commits. Ready providers receive work-conserving round-robin turns, one page per provider per round. A durable `nextProvider` marker prevents a stable provider ordering from starving later providers across wakes. Slow, pending, paused, locked, backed-off, or quarantined lanes are skipped without blocking ready work.

The commit order remains:

```text
normalize stable event
→ ingest Learning Episode
→ persist redacted Evidence Capsule
→ persist external provenance
→ acknowledge provider cursor last
```

No source read result is acknowledged merely because it reached memory. Replay after a crash or discarded ready page remains idempotent.

### Cancellation and Drain

An External Evidence Page has three lifecycle states: Reading, Ready, and Committing.

At global deadline, shutdown, or provider disable:

- stop claiming new reads;
- abort Reading xURL processes and reap them;
- discard Ready pages without acknowledgement;
- allow only the single page already Committing to finish;
- release provider locks after process cleanup and commit settlement.

Scheduler cancellation is reported as `quota_reached` or `drained`; it does not increment provider failures, backoff, quarantine, Operational Review Retry, or Branch Review failure counts.

## Continuous and Backfill Arbitration

The existing provider-scoped single-writer lock remains authoritative across processes. Within one Runtime, continuous work and explicit backfill for the same provider are arbitrated at page boundaries:

- neither operation interrupts a page already Committing;
- an explicit backfill receives the next provider turn;
- subsequent backfill and continuous pages alternate while both remain ready;
- backfill retains its separate operation cursor, caps, deduplication, and audit state;
- work for different providers may read concurrently.

## Configuration and Operator Controls

### Environment Defaults

The environment remains the startup-default layer:

```env
XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED=true
XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS=codex,claude,pi
XIAOBA_EXTERNAL_SESSION_LOG_MAX_CONCURRENCY=3
XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND=xurl
XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE=future-only
```

- The master switch defaults to false and pauses every external lane when false.
- The enabled-provider list is normalized, deduplicated, and order-independent.
- The command defaults to `xurl` and may be overridden with an executable path.
- History mode defaults to `future-only`; `catch-up` is an explicit startup default or durable per-provider override.
- The legacy selected-provider setting is accepted as a one-item list only when the new provider list is absent, and is reported as deprecated.
- Baseline thread/output/time caps and xURL read timeout/output caps must be bounded and explicitly configurable; production defaults must fit inside the existing discovery wake budget.

### Durable Runtime Overrides

Online provider state is durable. Precedence is:

```text
global master switch off
  > durable provider override
  > environment startup default
```

Once an operator explicitly enables or disables a provider, restart preserves that decision. `reset` removes the durable override and returns the provider to its environment default.

### CLI Surface

The first operator surface is:

```text
xiaoba external-source status [--json]
xiaoba external-source enable <provider> [--scope <path|global>] [--history <future-only|catch-up>]
xiaoba external-source history <provider> <future-only|catch-up>
xiaoba external-source disable <provider>
xiaoba external-source reset <provider>
xiaoba external-source rebaseline <provider> --skip-to-now
```

Commands modify the same durable provider state consumed by Runtime Learning. A running Runtime observes changes at the next scheduling boundary. Dashboard readiness remains read-only but surfaces the same status.

`status --json` reports the scope kind but does not expose an unsanitized local scope path. Human and machine status keep admission gate, activation, history mode, catch-up progress, source health, and work/drain state as separate fields.

## Failure and Compatibility Behavior

Each provider reports its own state, including:

- admission state: activating, active, paused, or activation_blocked;
- support and reader version;
- scope and baseline progress;
- active/closed resource counts and cursor position;
- pending stability samples;
- last successful read and next retry;
- lock, backoff, quarantine, protocol failure, integrity conflict, and drain state;
- redacted diagnostic and required operator action.

xURL version is diagnostic metadata, not the compatibility decision. On a version change, the provider continues only when the strict parser succeeds and existing normalized event fingerprints remain unchanged. Structural incompatibility becomes `protocol_failure`; historical content mutation becomes `integrity_conflict`. Both pause only the affected provider until repaired or explicitly rebaselined.

Missing xURL, unsupported provider, permission error, timeout, oversized output, malformed rendering, and process cancellation remain source-level outcomes. They never enter Operational Review Retry unless evidence had already crossed into the ordinary review pipeline and that review independently failed.

## Acceptance Criteria

1. Multiple provider IDs can be enabled simultaneously and independently paused, reset, or rebaselined.
2. Default continuous configuration constructs one lane per enabled provider; no `selectedProvider` bottleneck remains.
3. Internal discovery completes before external reads and remains successful when every xURL process fails.
4. External reads overlap up to the configured limit; setting the limit to 1 produces serial behavior.
5. Episode, Capsule, provenance, and cursor writes never overlap; observable admission order follows fair page-sized turns.
6. Global deadline and disable cancel xURL reads, discard uncommitted pages, drain only an active commit, and leave cursors replayable.
7. First enablement completes a non-admitting baseline for every existing in-scope thread before active admission.
8. An incomplete or oversized global baseline enters activation_blocked without admitting unknown history.
9. Re-enable resumes from the old cursor; explicit rebaseline skips to now and persists an operator audit.
10. Scope narrowing preserves out-of-scope state; expansion baselines only newly included historical resources.
11. The adapter invokes unmodified official xURL commands and never invokes `session-log-v1`.
12. Strict Timeline parsing, mutation detection, stability sampling, and adversarial Markdown cases fail closed at the provider lane.
13. A malformed, timed-out, or unsupported provider does not block other providers and does not increment OPR or Branch Review failure accounting.
14. Explicit backfill gets the next same-provider page turn, then alternates fairly with continuous work.
15. Runtime and Dashboard status expose provider-specific activation, progress, health, drain, and next-action diagnostics.
16. The legacy selected-provider environment setting remains a tested one-provider compatibility path.
17. Focused tests use deterministic fake processes; an environment-gated smoke invokes an installed official xURL binary against Codex, Claude, and Pi fixture roots.
18. At least two providers are exercised concurrently through the public Runtime wake seam, with baseline followed by a newly appended stable turn that creates an Evidence Capsule and Learning Episode.
19. TypeScript, focused Runtime tests, the full test suite, and diff checks pass with no live timer or child-process handles left behind.

## Test Strategy

- Unit-test strict rendered-Timeline parsing, canonical turn grouping, hash stability, heading injection rejection, process cancellation, and version compatibility.
- Test provider-state precedence and restart persistence only through public config/CLI/Runtime seams.
- Test activation with bounded catalogs, interrupted resume, new threads during activation, scope expansion, blocked activation, and no historical Episode creation.
- Test concurrency with controllable fake xURL processes that expose overlap and cancellation while instrumenting the Admission Coordinator to prove single-writer behavior.
- Test fair provider ordering under resource, episode, and elapsed-time quotas, including a slow provider and a continuously ready provider.
- Test disable/re-enable cursor continuation, audited rebaseline, same-provider backfill arbitration, and different-provider overlap.
- Keep deterministic CI independent of local credentials and user logs.
- Provide an opt-in official-xURL smoke that points xURL provider roots at synthetic Codex, Claude, and Pi fixtures, never at private user data by default.

## Delivery Slices

1. **Official xURL reader tracer bullet** — replace the private process protocol with strict official query/read parsing for one provider, activation baseline, and public-seam smoke coverage.
2. **Durable provider controls** — enabled set, precedence, scopes, online CLI operations, restart behavior, and diagnostics.
3. **Bounded multi-provider reads** — async process cancellation, concurrency limit, one-page prefetch, and Internal-first ordering.
4. **Serialized fair admission** — Admission Coordinator, durable round-robin marker, deadline semantics, and same-provider backfill arbitration.
5. **Compatibility and release gate** — xURL version diagnostics, renderer mutation handling, adversarial fixtures, official-xURL smoke, and full-suite verification.

Each slice must preserve the ordinary Evidence Capsule and Skill Evolution path and leave the Runtime usable when xURL is absent.
