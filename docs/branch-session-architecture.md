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

## Autonomous local-log Memory (opt-in)

This branch restores the Saturday behavior pinned to
`a4e4757184569e2677e9255d80113a7e5d92315b`, with the finish argument renamed
from `refs` to `evidence`. It replaces the server-first two-stage Memory pipeline;
the independent CatsLog APIs, CLI and model configuration are unchanged.

The model chooses searches, time ranges, reads and neighboring turns using
`memory_search`, `memory_read_turn`, `memory_neighbors` and
`finish_memory_search`. Sources are the configured runtime's historical
`logs/sessions` JSONL files, including raw history no longer in current context.
This is local, bot-owned history, **not** the server's per-user permission filter.
Do not enable it on a shared log root whose history must be isolated between users.
It has the old path containment, explicit read truncation and continuation controls.

Finish takes `{summary, evidence: string[], inject: boolean}`. Empty evidence
is a valid non-injecting finish. Read tools still take singular `ref: string`;
internal observations retain `refs` for compatibility. Invalid finish calls
receive specific correction hints; the original three-invalid-call stop remains.
There is no implicit string-to-array conversion, 45-second deadline, 16K context
cap, 4-turn/2-pass pipeline, or new 400/800-character summary limit.

Within a long parent episode, a completed branch may refresh after 15 minutes
when new parent content exists. Each activation is a short independent model
session receiving the original task, new parent content and prior injections.
No new content means no new call. Reusing a citation for a new fact is allowed;
the model is instructed to avoid duplicate conclusions. The original observation
queue/carryover and cancellation semantics remain.

Memory is off by default. An existing explicit enablement in
`branch-agents.json` is honored; upgrading does not enable it. The Dashboard's
legacy budget response is now `budget: null, budgetPolicy: "model_context"`;
writing retired pipeline budgets returns 409 rather than implying they are active.
Legacy persisted budget fields are not deleted, but are not passed to this Memory runtime.

## Asynchronous checkpoint Summary (independent opt-in)

Set `XIAOBA_CHECKPOINT_CANDIDATES_ENABLED=true` to enable. Absent/false keeps
main's synchronous checkpoint and manual `/compact` unchanged.

The old candidate path starts above 75% of the model's physical context window.
At a safe boundary it installs a completed candidate immediately; above 85% it
waits for the current candidate. Existing output-fit guards can require an earlier
stop for models with large output reservations. Snapshot prefix/revision/episode
checks prevent stale commits; completed tool exchanges and the live suffix are
preserved. Atomic checkpoint persistence precedes live context replacement.

Generation uses the current summary service/checkpoint prompt, with the old
three-attempt transient-error retry policy and 15-minute candidate deadline.
Failed/unusable candidates fall back to ordinary checkpoint compaction; an unsafe
uncompressed request is not sent. Interrupt, clear, destroy and manual compact
cancel/invalidate candidates. Candidate logs and summary usage metrics distinguish
background generation from foreground model usage. No deployment is part of this PR.

## Branch model override (memory branch)

The memory branch can run on a cheaper model than the primary agent. The contract lives in the
device config `branch-agents.json` (`BranchAgentConfig`, see `src/core/branch-agent-config.ts`):

- `branches.memorySearch.model` is the only runtime-effective field. `kind: "inherit"` (the
  default) shares the primary agent's `AIService`; a `catalog` or `custom` runtime is resolved by
  `resolveMemoryBranchModelOverride` into a dedicated branch `AIService` (`RuntimeFactory`),
  leaving the primary agent's service untouched.
- `branches.memorySearch.customDraft` is a Dashboard form draft only. It is never read at
  runtime; the Dashboard persists it alongside `model`, never instead of it, so a draft without
  a saved runtime model never changes branch behavior.
- The override covers every autonomous search/read/finish call in the branch; no per-pass model split is introduced.
- Tool calling is mandatory. The branch's only tool surfaces are `assess_memory_need` and
  `finish_memory_search`; the sidecar gate fails closed when the branch model cannot call tools
  (visible warn, branch skipped), the Dashboard catalog apply rejects non-tool-calling models,
  and the Dashboard custom-model probe (`POST /branch-agents/memory/model/test`) exercises tool
  calling before pointing the branch at a custom endpoint.
- No default cheaper model exists: unset means inherit. Invalid or unsafe model material in the
  config fails safe back to `inherit` at load time. The override is resolved once per service
  construction, so Dashboard model changes take effect after the runtime restart the Dashboard
  requests.
