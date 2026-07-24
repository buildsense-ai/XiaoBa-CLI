# Progressive Trust for Skill Evolution

## Status

This document defines the acceptance policy for generated Current Skills. The policy keeps recall broad and removes only candidates that observable evidence shows cannot become useful, safe Skills.

The implementation retains the Reader, Author, Verifier, Evidence Review Job, commit fence, atomic transition journal, audit, immutable history, restart recovery, and contradiction-bound correction path. It does not add scores, thresholds, lifecycle states, or an evaluation arena.

## First-principles objective

Skill Evolution exists to improve future work by retaining transferable experience and preferences. Its objective is expected future utility, not maximum precision and not maximum Skill count.

- A false positive consumes routing and context attention and may give bad guidance.
- A false negative discards information permanently and cannot collect later usage feedback.
- Narrow guidance, independent verification, immutable revisions, correction, retirement, and restoration bound the cost of a false positive.
- Missing positive feedback, one observed instance, or absence of a prior Skill load says that a candidate is uncertain. None says that it is useless.

The runtime therefore separates uncertainty from garbage. Uncertainty narrows or defers a candidate. Rejection requires affirmative evidence that no safe, transferable Skill can be written from the fixed bundle.

## Bayesian interpretation

An executed Episode is an observation about a possible reusable behavior. Explicit acceptance or artifact validation raises confidence in the observed result. A correction lowers confidence and identifies a boundary. Silence has little value as outcome evidence, but it does not erase the actions, decisions, or artifacts already observed in the Episode.

The posterior should change the scope of the hypothesis before it changes admission:

- One bounded observation can support a narrow, reversible Current Skill.
- More aligned observations can append evidence or justify clearer guidance.
- Ambiguity or consequential risk can defer the proposal.
- Contradiction can narrow the affected capability through evidence append.
  Replacement still requires a review basis containing the prior guidance
  body; retirement remains an explicit operator action.

The Skill Usage Ledger does not manufacture `verified-success` from settlement. Settlement only moves an Episode to its review decision point.

## Admission policy

### Ordinary Learning Episodes

Every unreviewed `eligible` Learning Episode may enter review. Internal production AgentTurns with a non-empty assistant response can form Episodes even without artifact or tool activity, so explicit preferences and decisions use this same path. A narrow two-sided social filter excludes only turns where both user and assistant text are anchored greetings or acknowledgements; additional task content remains reviewable. Prior generated-Skill use, explicit user acceptance, artifact validation, and independent repetition are evidence available to the reviewer, not admission prerequisites.

The ordinary Episode interface is deliberately narrower than the full Registry transition vocabulary. A single observation may:

- `create_current_skill` when the Registry has no matching capability.
- `append_evidence` to a related Current Skill without changing its active guidance.
- `defer` or `reject_candidate` without changing Registry state.

Recall through `relatedCurrentSkills` is enough to append evidence but not to overwrite guidance: Author and Verifier do not receive the old generated Skill body needed to compare behavior. Replacement, route migration, merge, and retirement are therefore deferred rather than semantically rejected. This restriction narrows write authority, not candidate recall: every eligible Episode still reaches Author/Verifier review.

Accept a mutating transition only when all of the following hold:

- The evidence contains a recognizable user-facing trigger and a transferable preference, action, or decision rule.
- The draft stays within facts supported by the fixed Evidence Bundle.
- Applicability, boundaries, and claims are narrowed to the observed evidence.
- No unresolved contradiction applies to the proposed pattern.
- The transition does not expand authority, privileges, data access, or external side effects beyond the evidence.
- Every review obligation has an explicit resolved disposition with valid source spans.

Defer when missing evidence or operator review could materially change a plausible proposal, especially for destructive, privileged, financial, privacy-sensitive, or irreversible behavior.

Reject only when the evidence affirmatively shows that bounded revision cannot produce a useful Skill, including these cases:

- The proposal repeats contradicted behavior.
- It conflicts with its cited evidence or requires unsupported authority.
- It follows source instructions, prompt injection, or unsafe content.
- It contains no transferable user preference or capability.
- It duplicates an existing capability but refuses a safe evidence append.

Sample scarcity, missing positive feedback, and absence of a prior Skill load are not rejection reasons by themselves.

### Corrections

Only explicit contradiction outcomes bound to a loaded Skill's stable identity drive usage reassessment. A correction binds by exact capability handle, routing name, or requested routing alias; when exactly one generated Skill was loaded and the correction contains no loaded Skill identity, that single load may safely inherit the correction. With multiple loaded Skills, an unbound correction remains durable Episode evidence and does not turn every Skill in the Episode into a causal target. Routine Curator cadence exists to recover a missed expedited wake, not to infer passive success.

A `usage-curation:*` transition must target the capability handle bound by the correction bundle. With the current fixed bundle, automatic reassessment may only:

- `append_evidence`

It may not retire or replace guidance because the usage bundle does not contain a bounded correction snapshot or the prior guidance body needed to preserve unaffected behavior. Full retirement remains an explicit operator action. It also may not create a Skill, migrate a route, merge Skills, or target another capability. A separately completed corrected retry is an ordinary Episode and may teach the supported corrected pattern.

### Non-production evidence

Smoke, synthetic, and replay logs do not create Learning Episodes. Exact smoke, test, synthetic, and replay session types are also excluded. The filter runs during extraction so excluded input still advances its source cursor without consuming review work.

These sources are excluded because they are artifacts of testing the learning machinery, not observations of user work. An ordinary production session whose name merely contains a word such as `test` remains eligible.

## Discovery policy

Generated Skills are Registry-owned.

- An empty or unreadable Registry admits no orphan generated Skill file.
- Manual Skills remain filesystem-discovered.
- Active, user-invocable generated Skills expose their name and description in the transient Skill list.
- Skill bodies remain progressively disclosed and load only through the Skill tool.

Hiding generated metadata would make accumulated experience undiscoverable and prevent the use-correction loop that can improve it.

Generated Current Skills have one audited operator control: `skill retire`. It
removes the active Registry entry and routable artifact while retaining
immutable history and the transition audit. Repeating the command is a durable
no-op; this is retirement, not privacy purge. `skill remove` keeps its existing
manual-Skill deletion behavior but rejects Registry-owned generated Skills and
points the operator to `skill retire`.

## Evidence and dependency identity

`EvidenceBundle.referencedSkills` contains only dependencies proven by runtime-owned generated-Skill load facts. It is not the global Skill catalog and is not populated from untrusted semantic content.

Bundle construction joins a load fact to an Episode using both `agentTurnEpisodeId` and `runtimeSessionId`, then verifies `capabilityHandle`, `routingName`, and `guidanceHash`. Missing identities, stale guidance, route reuse, handle reuse, and cross-session Episode ID collisions fail closed.

This identity rule governs dependency claims. It is not a prerequisite for reviewing an Episode or creating a new Skill. `relatedCurrentSkills` contains only an active revision proven by a runtime load or named exactly by stable handle/route in frozen evidence; Registry membership alone is not relevance. An ordinary Episode may append only to a handle in that bounded set.

## Safety boundaries

The following controls remain unchanged:

- Evidence Bundle validation and payload bounds.
- Explicit typed bundle authority at new review admission and every mutation;
  bundle-ID inference exists only at the persisted-Job migration boundary.
- External evidence redaction and capsule integrity.
- Source-instruction and prompt-injection defenses.
- Evidence-reference allowlisting.
- Privilege-expansion checks.
- Manual Skill and route collision checks.
- Independent Author and Verifier branches.
- Review Basis freshness and commit fencing.
- Atomic transition journal, audit log, immutable history, restoration, and restart recovery.

Verification remains necessary because executing a task and generalizing an instruction are different claims. Execution supplies evidence; verification checks whether the proposed reusable instruction is necessary, supported, and no broader than that evidence.

## Non-goals

This policy does not add a provisional Registry state, confidence score,
promotion threshold, evaluation arena, HTTP API, Dashboard surface, or Provider
timeout change. The small Registry-aware retirement command is an operator
control, not a new learning lifecycle or promotion path.

It also does not treat every Episode as a Skill. The existing Author and Verifier must still find a coherent transferable delta, and deterministic commit gates continue to fail closed.

## Acceptance tests

Tests must verify these public boundaries:

- An eligible Episode without explicit acceptance or a prior Skill load can enter review and create a narrow Skill.
- A reviewed Episode may append evidence to a related Current Skill; replacement, route migration, merge, and retirement remain deferred to dedicated correction or semantic-maintenance paths.
- Missing transferable content is deferred or rejected by semantic review, not a provenance proxy.
- A correction triggers exactly one target-bound reassessment.
- Correction-bound create, merge, route migration, and cross-Skill writes are rejected.
- Cross-session Episode ID collisions never authorize dependencies or outcomes.
- Smoke, synthetic, and replay input produces no Episode.
- Empty Registry and orphan generated files fail closed.
- Active generated Skill metadata is discoverable while its body remains on demand.
- Existing audit, commit-fence, recovery, and safety tests continue to pass.

## Rollout

The bumped prompt and Evidence Review policy versions apply to new work and
force stale active jobs to create a successor Review Basis before committing.
Legacy Learning Episode jobs without a frozen source snapshot are instead
left dormant as explicit defers; they never re-read mutable logs. Existing
pre-authority jobs whose family cannot be proven are likewise left dormant;
unknown provenance is never promoted to a family-specific write authority. Existing
audit history remains immutable. Terminal rejections are not silently
reopened; later bounded evidence or explicit operator action requires a new
audited transition.
