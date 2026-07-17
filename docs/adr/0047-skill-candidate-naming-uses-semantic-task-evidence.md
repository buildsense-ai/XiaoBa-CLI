# Skill Candidate Naming Uses Semantic Task Evidence

Status: accepted

Implemented by the Learning Episode candidate builder and Skill Author naming constraints that stop lifecycle/generic routing names from being induced and then deferred. Regression coverage lives in `tests/learning-episode.test.ts` and `tests/skill-evolution-v3.test.ts`. This decision complements [ADR-0046](./0046-verification-folds-into-open-delivery-attempt.md), which fixed episode boundaries for create → verify → accept.

## Context

After ADR-0046, a sticker create → verify → accept session correctly folded into one Learning Episode with:

- `artifact-delivery`
- verification assistant response
- user acceptance
- durable semantic observations such as user-intent and artifact-operation

Promotion still failed. The Skill Author returned:

```text
routingName = settled-artifact-delivery-workflow
```

Runtime correctly deferred that envelope through `validateDraft()` because `isLifecycleOrGenericRoutingName()` rejects names containing lifecycle or generic process tokens such as `settled`, `episode`, `candidate`, and `artifact-delivery`.

Root cause analysis showed a self-defeating loop:

1. `buildLearningEpisodeCandidate()` hard-coded:
   - title: `Capability: Settled artifact delivery workflow`
   - action pattern: `Use the settled artifact workflow with ...`
2. Author was told to use the fixed Evidence Bundle, and the candidate title looked like the canonical answer.
3. Author copied the lifecycle/generic wording into `routingName`.
4. Runtime banned that class of name and deferred without giving a same-attempt naming revise for this specific issue.

The evidence was already specific enough to support a user-facing capability such as `create-chat-sticker-svg`. The failure was naming input quality and recovery, not admission, settlement, or episode folding.

## Decision

### 1. Candidate text must describe the user task, not process state

`buildLearningEpisodeCandidate()` derives title, applicability, action pattern, and solved-loop problem from durable semantic observations, preferring:

- `user-intent`
- `artifact-operation`
- `workflow-tool`
- `verification`

It no longer emits hard-coded “Settled artifact delivery workflow” language. Candidate narrative is sanitized to strip lifecycle/process words that push Author toward banned routing names. Runtime still does **not** assign the final public routing name; the candidate remains a bounded hint.

### 2. Author naming constraints are explicit

The Skill Author Branch prompt requires:

- `routingName` names the user-facing capability, not delivery mechanics or process state;
- banned tokens include `settled`, `settling`, `eligible`, `episode`, `candidate`, `artifact-delivery`, `artifact-workflow`, `generic-workflow`, `default-workflow`, `general-workflow`, and `misc-workflow`;
- tool names such as `write_file` may appear as means in guidance, but must not become the whole public capability name;
- semantic observations are the preferred naming evidence over generic candidate titles.

### 3. Lifecycle/generic routing names get one same-attempt revise

If `validateDraft()` returns only `lifecycle-routing-name` issues and review rounds remain, Runtime feeds those issues back to Author for one revise round inside the same review attempt. This is treated as recoverable naming quality, not as an operational schema failure and not as a permanent accept.

If the revised name is still lifecycle/generic, or other non-retryable issues remain, Runtime continues to defer or reject according to existing severity rules. Runtime never invents a replacement routing name.

### 4. Keep the blacklist

`isLifecycleOrGenericRoutingName()` remains a hard create/migrate gate. The fix improves the inputs and recovery path; it does not relax the ban on process-state skill routes.

## Alternatives Considered

### A. Keep the hard-coded settled-artifact candidate title

Rejected. It systematically induces banned names and turns a correct safety gate into an avoidable promotion dead-end.

### B. Let Runtime auto-rename bad routing names

Rejected. Runtime must not invent public capability identity. Auto-renaming would blur Author/Verifier responsibility and weaken auditability.

### C. Remove or weaken the lifecycle/generic blacklist

Rejected. Names such as `settled-artifact-delivery-workflow` pollute the skill route space with process state rather than reusable user capability.

### D. Only strengthen Author prompt text

Rejected as insufficient alone. While prompt constraints help, the hard-coded candidate title remained the strongest nearby “standard answer.” Candidate construction had to change with the prompt.

### E. Queue lifecycle-routing-name as operational schema retry only

Rejected. That path is for malformed completions. A lifecycle/generic name is a semantic naming defect; the correct recovery is an Author revise with the issue text, not an operational invalid-schema classification.

## Consequences

Positive:

- create → verify → accept can promote a concrete capability such as `create-chat-sticker-svg`;
- Author is steered by task evidence rather than process jargon;
- the blacklist continues to protect the public route space;
- one same-attempt revise absorbs occasional model drift without discarding an otherwise valid episode.

Negative / accepted costs:

- candidate derivation depends on observation quality; sparse observations fall back to neutral delivery wording, still without banned lifecycle tokens;
- one extra Author round may run when the first routing name is lifecycle/generic;
- this does not solve unrelated external-source contamination; external providers must still be disabled when isolating an internal learning smoke.

## Invariants

1. Runtime never chooses the public Skill Routing Name for the Author.
2. Candidate text may hint, but must not instruct with lifecycle/generic process names.
3. `create_current_skill` and `migrate_skill_route` require semantic, lifecycle-neutral kebab-case routing names.
4. Lifecycle/generic routing names remain invalid for create/migrate.
5. A pure lifecycle/generic naming miss may revise once in-attempt; repeated failure defers.
6. Episode folding (ADR-0046) and naming quality are separate concerns; both are required for create→check→accept promotion.

## Validation

Required coverage:

- candidate builder prefers user-intent over “settled artifact delivery workflow”;
- `isLifecycleOrGenericRoutingName('settled-artifact-delivery-workflow') === true`;
- `isLifecycleOrGenericRoutingName('create-chat-sticker-svg') === false`;
- create → verify → accept still yields one episode after ADR-0046;
- end-to-end sticker smoke with external sources disabled can create `create-chat-sticker-svg` and persist `SKILL.md`.

Observed verification fixture:

- `xiaoba-sim-runs/sticker-skill-smoke-20260717e`
- one episode, transition `create_current_skill`, routing name `create-chat-sticker-svg`, skill file present.

## References

- `CONTEXT.md` → **Learning Episode**, **Capability Candidate**, **Distilled Knowledge Candidate**, **Candidate Evidence Summary**, **Skill Author Branch**, **Skill Routing Name**, **Semantic Skill Name**, **Skill Naming Authority**, **Naming Safety Gate**, **Naming Deferral**, **User Intent Observation**
- [ADR-0046: Verification Folds Into The Open Delivery Attempt](./0046-verification-folds-into-open-delivery-attempt.md)
- `src/utils/learning-episode.ts` → `buildLearningEpisodeCandidate`, `deriveCandidateTaskSummary`, `sanitizeCandidateNarrative`
- `src/utils/skill-evolution.ts` → Author prompt, `validateDraft`, `isLifecycleOrGenericRoutingName`, lifecycle-routing-name revise path
- `tests/learning-episode.test.ts`
- `tests/skill-evolution-v3.test.ts`
- Observed fixture: `xiaoba-sim-runs/sticker-skill-smoke-20260717e` → `create-chat-sticker-svg`
