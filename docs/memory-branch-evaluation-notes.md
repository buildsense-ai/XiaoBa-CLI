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
  a valid finish payload. No partial context observation is published; if the
  branch had already submitted evidence that was explicitly deferred for a
  version/outcome guard, it is retained as an `audited_observation` only.

`dropped` is a lifecycle outcome, not a branch judgment. The legacy
`inject` flag remains accepted for compatibility, but new callers should use
the explicit `delivery` field.

## CatsLog evidence contract

The branch records a bounded `catslog.branch.provenance.v1` projection from the
actual tool seam. It contains candidate/active/body-read Skill refs, route
metadata, graph lineage, catalog revision, receipt eligibility, and outcome
status. Raw bearer values and retrieval receipts never enter branch messages,
observations, or logs.

When a branch cites a Skill for parent context:

1. the cited ref must have been observed in a CatsLog result;
2. a concrete adapter must expose an active-head graph observation, and every
   cited revision must match that head;
3. when outcome writes are enabled and the body was read, the branch must send a
   receipt-bound `catslog_skill_outcome` before publishing. A rejected outcome
   is retained as audit-only evidence.

Stale, unseen, or unverified Skill citations fail closed to `delivery:audit`.

## Resource budget

The autonomous memory branch defaults to 8 model turns per pass, 3 passes,
45 seconds wall-clock, and a 16,000-token prompt budget. Dashboard clients can
read and update these bounded values through `/api/branch-agents/memory` and
`PUT /api/branch-agents/memory/budget`; persisted values are normalized to safe
limits on load.

## Observed Issues

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
