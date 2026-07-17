# Verification Folds Into The Open Delivery Attempt

Status: accepted

Implemented by the Learning Episode extraction change that folds non-redelivering verification and acceptance into the open predecessor delivery attempt, with regression coverage in `tests/learning-episode.test.ts`. The domain definition lives in `CONTEXT.md` → **Learning Episode**.

## Context

XiaoBa learns from completed delivery attempts, not whole chat sessions. That boundary is correct: a long session may contain multiple real deliveries, corrections, and retries, and those must not silently share settlement or promotion fate.

The previous extractor over-applied independence. It treated every turn with delivery-shaped evidence as a new Learning Episode. In particular, an internal verification turn with only:

- assistant text confirming a prior artifact, and/or
- validation-style tool results, and/or
- a following user acceptance

could mint a second episode even when no new artifact was delivered.

This produced a false split for ordinary create → check → accept work:

1. Turn 1 delivers an artifact (`write_file` / `send_file` / similar).
2. Turn 2 verifies the same artifact without creating another one.
3. Turn 3 accepts the result (`Thanks, works perfectly.`).

The old rule created episode A for creation and episode B for verification, then attached acceptance to B. Author/Verifier therefore preferred a verify-shaped capability such as `verify-artifact-delivery`, while the create-shaped candidate deferred as generic or lifecycle-bound. Operators observed this as “one human task became two competing skills.”

The failure mode was confirmed by the sticker smoke run under `xiaoba-sim-runs/sticker-skill-smoke-20260717c`: one session, one sticker file, two internal episodes, acceptance stolen by the verify episode.

## Decision

Keep **delivery attempt** as the learning unit, but define a delivery attempt as:

- the turn that first delivers an artifact, plus
- later same-runtime-session verification and acceptance that do **not** deliver a new artifact.

Extraction rule:

1. A turn with new `artifact-delivery` evidence starts or continues as its own Learning Episode.
2. A later turn in the same runtime session folds into the open predecessor when all of the following hold:
   - the predecessor is not `contradicted`;
   - the predecessor already has `artifact-delivery` evidence;
   - the later turn has no new `artifact-delivery`;
   - the later turn contributes verification-shaped evidence such as `assistant-response`, `artifact-validation`, `user-acceptance`, `verified-tool-result`, or a contradiction signal.
3. Folding merges completion evidence and semantic observations into the predecessor. Contradiction still marks the predecessor `contradicted`.
4. True redeliveries remain independent:
   - another `write_file` / `send_file` / delivery tool success;
   - a corrected retry after contradiction;
   - a second product in the same session.
5. Acceptance still does not fabricate delivery. Internal text-only turns without tool delivery or following acceptance remain non-episodes. External complete finals keep their existing candidate-admission rule and still receive no promotion privilege.

This decision does **not** make “one session = one episode.” Session remains a conversation container. Episode remains a delivery attempt. The change only stops verification-only turns from competing with the delivery they inspect.

## Alternatives Considered

### A. Keep pure turn independence

Rejected. It preserves simple extraction but systematically mis-attributes acceptance and promotes verify-shaped capabilities for create→check→accept tasks.

### B. Make the whole session one episode

Rejected. A session may contain multiple independent deliveries, corrections, and topic changes. Session-level episodes would reintroduce multi-attempt contamination and weak settlement boundaries.

### C. Merge only when acceptance text mentions the prior artifact path

Rejected as too brittle. Users commonly accept with short phrases such as `Thanks, works perfectly.` The durable signal is “no new artifact delivery in the same open attempt,” not lexical path mention.

### D. Delay episode creation until acceptance

Rejected. Delivery must still be durable before acceptance arrives so heartbeat cursors, contradiction attachment, and settlement windows remain well-defined. Folding later evidence into an open delivery preserves that.

## Consequences

Positive:

- create → verify → accept becomes one Learning Episode.
- Acceptance attaches to the delivery that produced the artifact.
- Author/Verifier sees the full settled task rather than a verification-only fragment.
- Existing retry/correction independence remains intact.

Negative / accepted costs:

- Extraction is slightly more stateful inside one Distillation Unit.
- A poorly instrumented “verification” that secretly writes a new artifact will still open a new episode, because new `artifact-delivery` always wins.
- Cross-unit folding still relies on existing continuity/acceptance closure paths for deliveries that left the current unit before acceptance arrived.

Operational notes:

- External source contamination is orthogonal. Unrelated external episodes can still be admitted if external providers are enabled in the runtime under test; disable external sources when isolating an internal learning smoke.
- Folding improves the evidence boundary; it does not by itself choose a public Skill Routing Name. Candidate and Author naming quality are covered by [ADR-0047](./0047-skill-candidate-naming-uses-semantic-task-evidence.md).

## Invariants

1. Session ≠ Learning Episode.
2. New artifact delivery ⇒ new or independent delivery attempt.
3. Verification/acceptance without new artifact delivery ⇒ fold into open same-session delivery attempt.
4. Contradiction still prevents promotion of the affected delivery attempt.
5. External evidence never gains promotion authority from this change.

## Validation

Required regression coverage:

- create sticker / artifact → verify reply → `Thanks, works perfectly.` yields exactly one episode whose delivery turn is the create turn and whose evidence includes delivery + verification + acceptance.
- two successive artifact deliveries in one session still yield two episodes.
- direct correction and verified retry remain independent.
- validation-only activity still does not create an episode by itself.
- `read_file` inspection still does not count as artifact delivery.

## References

- `CONTEXT.md` → **Learning Episode**
- [ADR-0047: Skill Candidate Naming Uses Semantic Task Evidence](./0047-skill-candidate-naming-uses-semantic-task-evidence.md)
- `src/utils/learning-episode.ts` → `extractLearningEpisodes`, `shouldFoldIntoOpenDelivery`
- `tests/learning-episode.test.ts` → create→verify→accept fold and second-delivery independence
