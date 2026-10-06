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

## Autonomous branch and CatsLog seam (server-first)

The memory branch is an autonomous cerebellum, not a synchronous subroutine of the main agent.
The main runner starts it and may consume a queued observation on a later turn; it does not pass
CatsLog tokens or wait for a remote result. The division of labor is fixed:

- **The branch owns query policy** — whether to query at all (chitchat finishes immediately with
  `delivery:discard`), how to compose the remote `query_text`, the session-query OR `keywords`,
  and optional `sources`, when the verdict gate should skip refine, and how to write the
  task-aware summary and choose delivery. This is model work: the branch sees the input plus
  recent completed turns.
- **Convergence is mechanical (two-call pipeline)** — pass 1 surfaces only `assess_memory_need`
  (`pause_turn`); a `recall` decision triggers the mechanical retrieval stage with no model
  calls; pass 2 surfaces only `finish_memory_search`. A reserved finish-only tail pass beyond
  `maxPasses` guarantees the run always converges to a finish payload; the wall-clock deadline
  stays the last-resort backstop.
- **The server owns retrieval execution** — one fused `/catsco/agent/branch` fan-out
  (agent memory, session graph, skills; scope fencing, reranking, per-branch evidence verdict)
  and one device-bound `/catsco/agent/query/v1/sessions` query run in parallel. The session
  query sends `search_any`: OR over at most 8 distinct literal keywords, each at most 64
  Unicode code points (validated as code points, not UTF-16 units; violations are structured
  errors, and any bounding/truncation is reported visibly in the evidence pack and telemetry).
  The server redacts records and binds
  them to the capability's visible memory scopes (shared + own subject); the wire type has no
  UID selector by construction. `latest: true, limit: 20` is a bounded newest-window read —
  the globally newest matching records across all scoped streams, not one per stream and not a
  cursor page; older history beyond the window is not reachable in a single recall pass.

**Historical sessions come only from the server.** The local JSONL log tree is never read by
the branch: local files carry no trustworthy per-agent scope labels, and the device-bound query
only admits shared + own-private scopes, so any local lane would widen capability relative to
the server (including a sibling agent's private material). The current conversational context
is already available to the branch via the assess prompt (`current_user_input` +
`recent_completed_turns`) — no disk I/O for that.

**Recency gap (deliberate, documented):** sessions not yet uploaded and projected on the server
are invisible to the branch until they sync. A successful session query means the returned
records are complete for the device's visible scopes at query time; it is **not** a claim that
local files are authorized, indexed, or safe to read. If a lane fails, the evidence pack carries
a typed `unavailable` status and the other lane's evidence still flows — there is no local-file
fallback. Local replay of unsynced sessions is intentionally absent until per-session scope
provenance exists.

The principle: tools are for *acting*; retrieval is a *query*. The branch stays an agent loop,
but a thin one. A typical trace is: read context → either finish immediately (discard) or let
the mechanical stage fetch remote evidence → write the summary → finish.

The branch tool surface in `MemorySearchBranchSession.buildTools()` is exactly:

- `assess_memory_need` — the pass-1 decision contract;
- `finish_memory_search` — the output contract.

The former fat surface (per-source catalog/graph/skill-memory/session recall/query tools plus
outcome and note writes) and the v1.3 local log lane (`memory_search`/`memory_read_turn`/
`memory_neighbors`) are all deleted from the branch. The Skills catalog and outcome routes
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
- The override covers the whole branch: both the assess pass and the refine pass of
  `MemorySearchBranchSession` run on it. A per-pass model split (cheaper model only for the
  generation-bound refine call) is deliberately unsupported — the config shape has no per-pass
  fields.
- Tool calling is mandatory. The branch's only tool surfaces are `assess_memory_need` and
  `finish_memory_search`; the sidecar gate fails closed when the branch model cannot call tools
  (visible warn, branch skipped), the Dashboard catalog apply rejects non-tool-calling models,
  and the Dashboard custom-model probe (`POST /branch-agents/memory/model/test`) exercises tool
  calling before pointing the branch at a custom endpoint.
- No default cheaper model exists: unset means inherit. Invalid or unsafe model material in the
  config fails safe back to `inherit` at load time. The override is resolved once per service
  construction, so Dashboard model changes take effect after the runtime restart the Dashboard
  requests.
