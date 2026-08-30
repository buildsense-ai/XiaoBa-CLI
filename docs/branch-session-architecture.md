# Branch Session Architecture

## Context lanes

XiaoBa currently has two model-visible transient context lanes:

- Text transient context: short system-like/user-like hints built by `TurnContextBuilder`.
  This includes runtime rules, runner hints, plan status, runtime feedback, and sub-agent status.
- Synthetic observation context: branch-produced results injected as a synthetic
  `runtime_observation` tool call/tool result pair.

Keep these lanes separate for now. They have different provider-shape requirements and
different lifecycles:

- Text transient context is turn-scoped guidance and is stripped from durable history.
- Synthetic observation context is queue-based, can be carried for one extra turn, and
  records injected/dropped lifecycle events.

The common boundary is semantic rather than physical: both are transient runtime context and
must not be treated as durable user input.

## Branch sessions

`BranchSession` owns the isolated agent loop mechanics:

- independent messages
- branch-local tools
- branch-local logs
- cancellation through an abort signal
- no durable write-back into the parent session transcript

`ObservationBranchSession<TFinishPayload>` is the reusable base for branches that publish
synthetic observations back to the parent runner. A concrete branch only needs to provide:

- initial system/user messages
- branch tools
- a finish tool that calls `complete(payload)`
- a disposition function that decides whether to inject or suppress
- a payload-to-`SyntheticObservation` formatter

`MemorySearchBranchSession` is the first concrete implementation. Future observation-producing
branches should extend `ObservationBranchSession` instead of reimplementing publish, suppress,
drop, and cancel bookkeeping.

## Autonomous branch and CatsLog seam

The memory branch is an autonomous cerebellum, not a synchronous subroutine of the main agent.
The main runner starts it and may consume a queued observation on a later turn; it does not pass
CatsLog tokens or wait for a remote result. CatsLog catalog, graph, memory, session, and optional
write tools are constructed only in the branch's tool surface.

`CatsLogSkillEvidenceTracker` is an internal seam between that tool surface and observation
delivery. It observes projected tool results (never raw receipts) and emits bounded provenance:
candidate refs, active-head checks, body-read/receipt eligibility, route metadata, lineage, and
outcome status. A Skill citation that was not observed, points at a stale revision, or lacks an
active-head check cannot enter parent context; it is retained as audit evidence instead.

If the model does not choose `delivery:audit` before the finite branch budget expires, a
previously deferred unsafe citation is automatically retained as audit-only; it is never
promoted to parent context. Branch audit logs also redact capability tokens, receipts, and
tenant selectors at the logging boundary.

Delivery is explicit:

- `context` queues a synthetic observation for asynchronous carryover;
- `audit` writes the observation details to the branch audit log only;
- `discard` records the branch's intentional suppression.

When receipt-bound outcome writes are enabled, a body-read Skill citation must report its real
`succeeded`, `failed`, or `corrected` outcome before `context` delivery. The runtime never
guesses success. Every branch also has finite turn, pass, deadline, and prompt-token budgets;
the defaults and bounded Dashboard update seam are documented in
`docs/memory-branch-evaluation-notes.md`.
