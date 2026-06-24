# Memory Branch Evaluation Notes

This document records the current memory branch behavior, known issues, and
evaluation checks used while tuning the branch-session memory search flow.

## Lifecycle Terms

- `published`: the memory branch finished with `inject:true` and pushed a
  synthetic observation into the main runner queue.
- `injected`: the main runner drained a queued observation before a provider
  call and inserted the synthetic tool pair into the model-visible messages.
- `suppressed`: the memory branch deliberately finished with `inject:false`
  because it judged that no extra memory was worth showing to the main agent.
- `dropped`: an observation was already published, but no provider call drained
  it before the observation lifecycle expired.
- `cancelled`: the branch was stopped before it produced a finish payload.

`dropped` is a lifecycle outcome, not a branch judgment. Branch self-suppression
is represented by `finish_memory_search({ inject:false, refs: [] })`.

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
