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

## Autonomous branch and CatsLog seam (thin v1)

The memory branch is an autonomous cerebellum, not a synchronous subroutine of the main agent.
The main runner starts it and may consume a queued observation on a later turn; it does not pass
CatsLog tokens or wait for a remote result. The division of labor is fixed:

- **The branch owns query policy** — whether to query at all (chitchat finishes immediately with
  `delivery:discard`), which local log refs to read, how to compose the remote `query_text` and
  scope hints, when to spend the single allowed refine, and how to write the task-aware summary
  and choose delivery. This is model work: the branch sees the input plus recent messages.
- **The server owns retrieval execution** — the fused `/catsco/agent/branch` endpoint performs
  multi-source fan-out (agent memory, session graph, skills), scope fencing, and reranking in
  roughly ten milliseconds. Client-side multi-step exploration across per-source endpoints
  duplicates server work and is deliberately gone.

The principle: tools are for *acting*; retrieval is a *query*. The branch stays an agent loop,
but a thin one. A typical trace is: read context → either finish immediately (discard) or make
one `catslog_branch` call → write the summary → finish.

The branch tool surface in `MemorySearchBranchSession.buildTools()` is exactly:

- `memory_search`, `memory_read_turn`, `memory_neighbors` — local log recency lane;
- `catslog_branch` — the only remote tool (server-side fused probe);
- `finish_memory_search` — the output contract.

The former fat surface (per-source catalog/graph/skill-memory/session recall/query tools plus
outcome and note writes) is deleted from the branch. The Skills catalog and outcome routes
remain available to the explicit `catsco catslog` CLI commands through the same provider.

`CatsLogObservedRefsTracker` is the one remaining guard at the tool seam (anti-hallucination):
it collects the citation-shaped refs that actually appeared in this run's tool results, and a
`finish_memory_search` delivery of `context` may only cite refs from that set. A fabricated or
unseen ref fails closed to `delivery:audit`, which preserves the claim in the branch audit log
without influencing the parent agent. Active-head version checks, receipt-eligibility, route
attribution, graph lineage, outcome status, and catalog-revision tracking are gone: the server
owns evidence freshness, and outcome settlement belongs to the main-turn runtime.

Delivery is explicit:

- `context` queues a synthetic observation for asynchronous carryover;
- `audit` writes the observation details to the branch audit log only;
- `discard` records the branch's intentional suppression.

The memory branch is retrieval-only and never reports Skill outcomes. Every branch also has
finite turn, pass, deadline, and prompt-token budgets;
the defaults and bounded Dashboard update seam are documented in
`docs/memory-branch-evaluation-notes.md`.
