# Signal-Bounded Skill Evolution

## Status

This document defines the current acceptance policy for generated Current Skills. It replaces the earlier progressive-trust assumption that a silently settled, single Learning Episode could create a Skill.

The implementation keeps the existing Reader, Author, Verifier, Evidence Review Job, commit fence, atomic transition journal, audit, immutable history, and restart recovery. It removes unsupported success inference and narrows the authority of ordinary Episodes.

## First-principles decision

Skill Evolution learns only from observable signals.

- Silence is not success. A settlement deadline only says that no contradiction was observed in that window.
- Explicit user acceptance or artifact validation is evidence about one execution.
- An explicit correction is negative evidence about the generated Skill loaded in that same AgentTurn and runtime session.
- One observation cannot justify creating a new reusable behavior.
- Runtime-owned identity and deterministic transition gates bound what model review may commit.

The system therefore distinguishes evidence accumulation from behavior change instead of adding confidence scores, lifecycle states, or an evaluation arena.

## Bayesian interpretation

The prior probability that one completed execution is a reusable preference or workflow is low and domain-dependent. Silence has a likelihood ratio close to one, so treating it as success creates unjustified posterior confidence.

Explicit acceptance has a stronger likelihood ratio, but still supports only the observed execution. It may add evidence to a Current Skill that was actually loaded for that Episode. It does not create, replace, migrate, merge, or retire a Skill.

An explicit correction has a strong negative likelihood ratio for the affected Skill. It triggers correction-bound reassessment. That reassessment may append evidence, replace the affected guidance with a narrower correction, or retire the affected Skill. It may not create a Skill, migrate a route, merge Skills, or target another capability.

## Admission policy

### Ordinary Learning Episodes

An ordinary `v3:learning-episode:*` bundle enters review only when all of the following are true:

- The Episode is `eligible`.
- Completion evidence contains explicit `user-acceptance` or `artifact-validation`.
- A runtime-owned `GeneratedSkillLoadFact` matches both `agentTurnEpisodeId` and `runtimeSessionId`.
- The loaded Skill identity matches the current `capabilityHandle`, `routingName`, and `guidanceHash`.

At commit, the only mutating transition allowed is `append_evidence`, and its target must be one of those authenticated loaded Skills. `defer` and `reject_candidate` remain non-mutating dispositions. Every behavior-changing transition is converted to an audited rejection.

The append may persist bounded evidence metadata, including authenticated dependency snapshots and semantic observations. It must not change the active guidance body, route, handle, or guidance hash.

### Corrections

The Skill Usage Ledger writes an outcome only for an explicit contradiction. It does not synthesize `verified-success` from settlement and does not feed legacy success or defer outcomes back into reassessment.

The Curator selects only unreviewed contradiction facts. Routine cadence exists only to recover a missed expedited wake; it is not a passive success threshold.

A `usage-curation:*` transition must target the capability handle named by the correction bundle. Allowed mutating transitions are:

- `append_evidence`
- `replace_current_skill`
- `retire_capability`

`create_current_skill`, `migrate_skill_route`, `merge_into_capability`, and every cross-Skill target fail closed as audited rejections.

### Non-production evidence

Smoke, synthetic, and replay logs do not create Learning Episodes. Exact smoke, test, synthetic, and replay session types are also excluded. The filter is applied at Episode extraction so excluded input can still advance its source cursor without entering later learning stages.

## Discovery policy

Generated Skills are Registry-owned.

- An empty or unreadable Registry admits no generated Skill file.
- Orphan files under `generated-distilled` remain undiscoverable.
- Manual Skills remain filesystem-discovered.
- Generated Skills are omitted from the every-turn transient Skill list.
- Active generated Skills remain available through `/skills` and explicit Skill tool invocation.

This keeps accumulated experience available without automatically injecting mutable generated guidance into every prompt.

## Evidence and dependency identity

`EvidenceBundle.referencedSkills` means dependencies proven by runtime-owned facts. It is not the global Skill catalog and is not populated from untrusted semantic content.

Bundle construction joins a load fact to an Episode using both `agentTurnEpisodeId` and `runtimeSessionId`, then verifies the exact `capabilityHandle`, `routingName`, and `guidanceHash`. Missing identities, stale guidance, route reuse, handle reuse, and cross-session Episode ID collisions fail closed.

`relatedCurrentSkills` remains bounded recall context. It does not authorize a dependency or a transition target. Specialized bundle builders may continue to pin dependencies under their own validation contract.

## Safety boundaries

The following controls remain unchanged:

- Evidence Bundle validation and payload bounds.
- External evidence redaction and capsule integrity.
- Source-instruction and prompt-injection defenses.
- Evidence-reference allowlisting.
- Privilege-expansion checks.
- Manual Skill and route collision checks.
- Independent Author and Verifier branches.
- Review Basis freshness and commit fencing.
- Atomic transition journal, audit log, immutable history, restoration, and restart recovery.

Verification remains necessary because model execution demonstrates that one task ran; it does not prove the generalized Skill draft is correctly scoped. The deterministic commit gates constrain what can be written, while the Verifier checks the semantic proposal inside those bounds.

## Non-goals

This policy does not add a provisional Registry state, confidence score, promotion threshold, evaluation arena, HTTP API, Dashboard surface, Provider timeout change, or new command.

It also does not allow an ordinary single Episode to create a Skill. New Skill creation remains available only to non-ordinary evidence families under their own evidence contracts.

## Acceptance tests

Tests must verify these public boundaries:

- Silence creates no success outcome and no review work.
- Explicitly accepted ordinary Episodes can append evidence only to a Skill loaded in the same Episode and session.
- Ordinary create, replace, retire, and append-to-unloaded-target proposals are audited rejections.
- A correction triggers exactly one reassessment.
- Correction-bound replace or retirement can affect only the contradicted capability.
- Correction-bound create, merge, route migration, and cross-Skill append are rejected.
- Cross-session Episode ID collisions never join load or outcome facts.
- Smoke, synthetic, and replay input produces no Episode.
- Empty Registry and orphan generated files fail closed.
- Active generated Skills remain explicitly invocable but are absent from automatic transient injection.
- Existing audit, commit-fence, recovery, and safety tests continue to pass.

## Rollout

The versioned prompt and Evidence Review policy applies to new work and to active jobs that safely create a successor Review Basis. Existing audit history remains immutable. Terminal rejections are not silently reopened; later bounded evidence or explicit operator action requires a new audited transition.
