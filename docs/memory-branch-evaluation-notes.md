# Memory Branch Evaluation Notes

This document records the current memory branch behavior, known issues, and
evaluation checks used while tuning the branch-session memory search flow.

## Lifecycle Terms

- `published`: the memory branch finished with `delivery:context` and pushed a
  synthetic observation into the main runner queue. The parent still observes
  it asynchronously through the existing one-late-turn carryover; it never
  waits for the branch.
- `audited`: the branch finished with `delivery:audit`; the evidence is kept in
  the branch JSONL audit log and is not put into the parent prompt.
- `injected`: the main runner drained a queued observation before a provider
  call and inserted the synthetic tool pair into the model-visible messages.
- `suppressed`: the memory branch deliberately finished with
  `delivery:discard` because it judged that no extra memory was worth keeping.
- `dropped`: an observation was already published, but no provider call drained
  it before the observation lifecycle expired.
- `cancelled`: the branch was stopped before it produced a finish payload.
- `budget_exhausted`: the branch reached its bounded pass/deadline budget before
  a valid finish payload. No partial context observation is published.

`dropped` is a lifecycle outcome, not a branch judgment. The legacy
`inject` flag remains accepted for compatibility, but new callers should use
the explicit `delivery` field.

## CatsLog evidence contract (server-first)

Query policy lives in the branch; retrieval execution lives on the server. The mechanical stage
runs one fused `/catsco/agent/branch` fan-out and one device-bound
`/catsco/agent/query/v1/sessions` query in parallel (session query sends `search_any`: OR over
at most 8 distinct keywords; truncation beyond the cap is reported visibly in the evidence
pack). Historical sessions come only from the server: the local JSONL log tree is never read
by the branch, because local files have no trustworthy per-agent scope labels while the
device-bound query admits only shared + own-subject memory scopes. A failed session lane
degrades to a typed `unavailable` status in the evidence pack — never to a local-file fallback.

**Recency gap:** sessions that are not yet uploaded/projected server-side are invisible until
they sync. A successful query proves the returned records are complete for the device's visible
scopes at query time; it does not mean local files are authorized or indexed. Local replay of
unsynced sessions is intentionally absent until per-session scope provenance exists.

The branch keeps a single anti-hallucination guard, `CatsLogObservedRefsTracker`:
it records the citation-shaped refs that actually appeared in this run's projected results
(remote branch items and session records alike), and a `delivery:context` finish may only cite
refs from that observed set. An unobserved ref fails closed to
`delivery:audit` and is logged as `unobserved_refs_audit_only` with the cited
and observed refs. Bearer values and receipts never enter branch messages,
observations, or logs. Session records count as usable evidence even when the
`session_graph` branch verdict is `none`.

The former rich provenance projection (active-head version checks, receipt
eligibility, route attribution, graph lineage, outcome status, catalog
revision) was removed with the fat per-source tool surface: the server owns
evidence freshness, and outcome settlement belongs to the main-turn runtime,
not the retrieval branch.

## Resource budget

The autonomous memory branch defaults to 4 model turns per pass, 2 passes,
45 seconds wall-clock, and a 16,000-token prompt budget. One finish-only tail
pass is reserved beyond `maxPasses` so the run always converges to a finish
payload. Dashboard clients can read and update these bounded values through
`/api/branch-agents/memory` and `PUT /api/branch-agents/memory/budget`;
persisted values are normalized to safe limits on load.

## Observed Issues

- Production (v1.2): one run spent the full 90s deadline on 14 serial tool
  calls (3× `memory_search`, 9× `memory_read_turn`, 2× `catslog_branch`) over
  7 turns and never finished — the remote cap held, but the local lane and the
  serial execution model were unbounded. Fixes: per-turn parallel dispatch,
  the run-wide 8-non-finish-call bound with a finish-only tail, tightened
  default budgets (4 turns/pass, 2 passes), and read-discipline prompt
  guidance. The local lane itself was later removed entirely (server-first
  cutover): it had no trustworthy per-agent scope labels and read the
  process-wide log tree, which could surface sibling agents' private
  material the device-bound server query would correctly withhold.

- Production (v1.1): one bot's branch made four `catslog_branch` calls plus
  local reads and burned the full 90s deadline on two consecutive turns
  ("at-most-one-refine" was prompt-only), so no observation was injected. The
  mechanical two-call cap, the two-probe stop rule, and the early-exit bar for
  locally-answerable questions address this; the deadline itself stays 90s.

- Some near-neighbor memories repeat recent context that the main agent already
  saw. These should usually be suppressed unless they contain extra tool
  results, corrections, older decisions, or compression-prone facts.
- Some useful branch results can arrive after the last provider call opportunity
  and later become `dropped`. This is a timing/UX issue, not a search failure.
- When a user explicitly asks to resume prior context, the first reply can still
  be provisional if memory search finishes after the model call has started.
  Avoid claiming that memory search failed merely because no runtime observation
  has arrived yet.

## Prompt Tuning Goals

- Prefer injecting memories that add new value beyond the recent context:
  cross-session facts, older decisions, user corrections, tool results, stable
  constraints, or information likely to be lost after compression.
- Suppress memories that only restate the last one or two short turns.
- Preserve concrete anchors that help the current task: project names, files,
  errors, tools, places, people, counts, hard constraints, prior decisions, and
  rejected options when they are relevant.
- Do not force fixed domain slots. Keep summaries natural and task-shaped.

## Evaluation Checks

- Cross-session recovery: can a new session recover facts from another session
  without the user restating them?
- Low-value injection rate: how often an injected summary only repeats recent
  visible context.
- High-value drop rate: whether dropped observations contain useful older or
  cross-session information.
- Branch efficiency: finish ratio, rough finish time, and how many memory reads
  were needed before finish.
- Usefulness score for injected observations:
  - `0`: duplicate, stale, or distracting.
  - `1`: relevant but optional.
  - `2`: clearly provides older, cross-session, tool-result, or decision context.

## Deferred Ideas

- Revisit carryover TTL only after prompt tuning reduces low-value observations.
- Consider main-agent UX rules for explicit memory-resume requests, but avoid
  mechanical waiting or visible double replies until the behavior is tested.
- Keep lifecycle logs small; detailed summaries remain in branch logs.
