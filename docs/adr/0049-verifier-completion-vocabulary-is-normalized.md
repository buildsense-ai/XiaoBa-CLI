# Verifier Completion Vocabulary Is Normalized

Status: accepted

Implemented by verifier completion normalization in `src/utils/skill-evolution.ts` and regression coverage in `tests/skill-evolution-v3.test.ts`. Production-shaped external backfill also injects `AIService` so Evidence Review Jobs can run outside the live connector process.

## Context

After Learning Episode folding (ADR-0046) and candidate naming (ADR-0047), clean-room Pi backfill admitted external episodes and the Skill Author proposed concrete routing names such as:

- `merge-origin-main-into-integration-branch`
- `create-heartbeat-architecture-document`

Promotion still stalled. Evidence Review Jobs reached `skill_verifier` and then entered `retry_wait` / operational recovery. Two independent completion-vocabulary failures were observed in live model output:

1. **Top-level transition field polluted by decision vocabulary**
   - Model returned `decision: "accept"` with `transition: "accept"` or `"accepted"`.
   - Runtime accepted only Capability Transition Kinds (`create_current_skill`, `append_evidence`, …).
   - Result: `OperationalReviewError: Verifier transition is invalid.`

2. **Obligation disposition decisions used present-tense aliases**
   - Durable obligation contract requires past-tense values:
     `accepted | mitigated | deferred | rejected`.
   - Model returned `accept` / `defer` / `reject`.
   - Result: `invalid_completion_schema: skill_verifier obligation dispositions invalid: Invalid decision for obligation …`
   - The quantum failed even when the model had already reasoned through the obligations.

A third, related production gap was found in the operator path:

3. **`external-source backfill` constructed `SkillEvolutionRuntime` without `AIService`**
   - Evidence readers failed immediately with:
     `Skill Evolution requires an AIService when no fixture branch is configured.`
   - Review jobs never reached a healthy Author/Verifier path from CLI backfill.

These failures made it look as if imported sessions could not become skills, even after admission and authoring succeeded.

## Decision

### 1. Normalize top-level verifier `transition`

In `normalizeVerifierResult()`:

- empty / missing transition remains omitted;
- decision-like values (`accept`, `accepted`, `approve`, `approved`, `revise`, `reject`, `rejected`, `deny`, `denied`) are treated as field pollution and cleared;
- valid Capability Transition Kinds are preserved;
- unknown non-decision strings remain fail-closed.

When transition is omitted after normalization, existing Runtime fallback remains:

```text
verifier.transition ?? draft.envelope.decision
```

Runtime still does not invent a transition that the Author did not propose.

### 2. Normalize obligation disposition decisions

Before durable obligation validation, disposition decisions are mapped:

| Model alias | Canonical value |
|---|---|
| accept / approve / approved | accepted |
| mitigate | mitigated |
| defer | deferred |
| reject / deny / denied | rejected |

Canonical past-tense values pass through unchanged. Unknown values still fail closed.

### 3. Make the dual vocabulary explicit in prompt and tool schema

Skill Verifier instructions now distinguish three vocabularies:

1. top-level `decision`: `accept | revise | defer | reject`
2. optional top-level `transition`: Capability Transition Kind
3. `obligationDispositions[].decision`: `accepted | mitigated | deferred | rejected`

The tool description forbids putting accept/accepted into `transition`.

### 4. Give CLI backfill the same AI path as production wakes

`buildBackfillRuntimeLearning()` injects `aiService: new AIService()` so explicit external history backfill can run Evidence Review Jobs without requiring a live `connect` owner process.

## Alternatives Considered

### A. Keep hard-failing on any non-enum transition string

Rejected. Live models repeatedly leak decision vocabulary into `transition`. Hard-fail turns a recoverable vocabulary mismatch into an operational stall after expensive reader/author work.

### B. Accept arbitrary transition strings

Rejected. Transition remains a typed Capability lifecycle verb and must stay audit-safe.

### C. Ignore obligation dispositions on non-accept outcomes only

Rejected as incomplete. Accept paths also need valid disposition vocabulary, and the observed failures were primarily vocabulary, not missing reasoning.

### D. Require operators to run backfill only under live `connect`

Rejected. Explicit backfill is an operator recovery/import tool; it should not depend on racing a connector owner lock or omitting AI configuration.

## Consequences

Positive:

- verifier completion no longer dies solely because the model wrote `transition: "accept"`;
- obligation dispositions survive present-tense aliases;
- CLI backfill can complete Author/Verifier work and commit skills in isolation;
- clean-room retest produced a real skill file:
  `create-heartbeat-architecture-document`.

Negative / accepted costs:

- normalization hides a class of model vocabulary mistakes; prompt/schema still need to teach the dual vocabulary so models improve;
- semantic reject/revise for thin external evidence remains common and is intentional;
- path-scoped xURL catalog selection can still fail independently (`provider` frontmatter missing) and is outside this decision.

## Invariants

1. Top-level verifier `decision` and Capability `transition` are different vocabularies.
2. Runtime may clear decision-like transition pollution; it may not invent Author transitions.
3. Obligation disposition decisions are past-tense and must cover every obligation before accept commit.
4. Explicit external backfill uses the same AI-backed review path as production wakes.
5. Unknown transition/disposition tokens remain fail-closed.

## Validation

Required coverage:

- `transition: "accept"` normalizes to omitted transition;
- `transition: "create_current_skill"` is preserved;
- unknown transition still throws;
- obligation decisions `accept/defer/reject` normalize to `accepted/deferred/rejected`;
- clean-room Pi backfill after the fix can complete review jobs without `Verifier transition is invalid` or `Invalid decision for obligation`.

Observed fixture:

- `xiaoba-sim-runs/cleanroom-learning-20260717d`
- admitted 2 external episodes
- jobs completed
- created skill: `create-heartbeat-architecture-document`
- one candidate rejected for thin/single-source evidence (semantic gate, not schema stall)

## References

- `src/utils/skill-evolution.ts` → `normalizeVerifierResult`, `normalizeOptionalVerifierTransition`, `normalizeObligationDispositionsInput`, Verifier prompt/tool schema, `buildBackfillRuntimeLearning` consumer path
- `src/commands/external-source.ts` → `aiService: new AIService()`
- `src/utils/evidence-review/obligations.ts` → obligation disposition contract
- `tests/skill-evolution-v3.test.ts`
- Related: ADR-0046 (episode fold), ADR-0047 (candidate naming)
