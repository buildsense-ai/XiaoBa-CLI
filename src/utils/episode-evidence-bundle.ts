/**
 * Episode Evidence Bundle Builder
 *
 * Focused responsibility extracted from RuntimeLearning: assemble the
 * fixed Evidence Bundle that the Skill Author / Verifier branches consume for
 * one Learning Episode. This module holds only the pure assembly logic —
 * RuntimeLearning decides *when* to build a bundle and *when* to admit it for
 * review. Structured data (completion evidence, settlement evidence, related
 * current skills, capsule reconstruction) stays here; the calling class still
 * owns wake coordination, scheduling, and persistence.
 *
 * Behavior is preserved exactly: the public function signature and return
 * shape match the private `buildEpisodeEvidenceBundle` that previously lived at
 * the bottom of `runtime-learning.ts`.
 */

import type { LearningEpisode, LearningEpisodeStatus } from './learning-episode';
import type { DistilledKnowledgeCandidate } from './capability-distiller';
import type { SkillEvolutionRuntime } from './skill-evolution';
import type {
  BoundedSourceEvidence,
  EvidenceBundle,
  ReferencedSkillSnapshot,
  RelatedCurrentSkill,
  RuntimeOwnedReferencedSkillProvenance,
  SkillEvidenceRef,
  TrustedReferencedSkillIdentity,
} from './skill-evolution';
import type { EvidenceCapsuleStore } from './evidence-capsule';
import { reconstructBundleFromCapsule } from './evidence-capsule';
import type { GeneratedSkillLoadFact } from './skill-usage-ledger';

// Re-export the bundle-related types that RuntimeLearning previously
// re-exported from its tail, so external consumers can still reach them through
// either module without changing import sites.
export type {
  BoundedSourceEvidence,
  EvidenceBundle,
  RelatedCurrentSkill,
  SkillEvidenceRef,
};

/** A settlement-evidence entry before durable redaction. */
export interface EpisodeSettlementEvidence {
  readonly ref: string;
  readonly content: string;
  readonly sourceFilePath: string;
  readonly turn: number;
}

/**
 * Build honest settlement evidence for a Learning Episode.
 *
 * Settlement evidence is runtime-owned maturation metadata, not external
 * source content. It must never label a non-settled episode as settled, and the
 * ref and content must agree on whether the episode has settled.
 *
 * The ref is a lifecycle-neutral, stable identifier — it never claims
 * `settled` or `settling` — so it stays valid across maturation updates. The
 * content carries the honest, status-derived assertion: only a matured
 * episode (`eligible` or `contradicted`) is labeled `settled at <deadline>`;
 * every other status (`settling`, `historical-pending`, `historical-abandoned`)
 * is recorded honestly as `not settled`.
 *
 * At admission an episode is still `settling` (or `historical-pending`), so the
 * durable capsule records the non-settled state truthfully. After maturation
 * the caller re-derives this evidence from the authoritative matured status so
 * the durable capsule and the reconstructed review bundle never expose a
 * `settled` label alongside a `settling` (or other non-settled) status — the
 * material settlement contradiction that previously caused the Verifier to
 * defer fail-closed.
 */
export function buildEpisodeSettlementEvidence(
  episode: Pick<
    LearningEpisode,
    'episodeId' | 'sourceFilePath' | 'settlementDeadline' | 'deliveryTurn' | 'status'
  >,
): EpisodeSettlementEvidence {
  const ref = `${episode.sourceFilePath}#episode-${episode.episodeId}:settlement-${episode.settlementDeadline}`;
  const settled = isSettledStatus(episode.status);
  const content = settled
    ? `Episode ${episode.episodeId} settled at ${episode.settlementDeadline} (status: ${episode.status})`
    : `Episode ${episode.episodeId} not settled; status: ${episode.status} (settlement deadline: ${episode.settlementDeadline})`;
  return {
    ref,
    content,
    sourceFilePath: episode.sourceFilePath,
    turn: episode.deliveryTurn,
  };
}

function isSettledStatus(status: LearningEpisodeStatus): boolean {
  return status === 'eligible' || status === 'contradicted';
}

/**
 * Select referenced-skill snapshots proven by runtime-owned
 * `GeneratedSkillLoadFact` entries tied to the same episode.
 *
 * Progressive Trust policy: `EvidenceBundle.referencedSkills` means actual
 * dependencies proven by a runtime-owned Skill load fact, not untrusted
 * semantic observations from external/capsule content or the complete runtime
 * Skill catalog. A `GeneratedSkillLoadFact` is the smallest typed,
 * runtime-owned dependency fact: it is recorded by the SkillTool when a
 * generated Current Skill is actually loaded during an AgentTurn, and it
 * carries the canonical `episodeId` correlation.
 *
 * Fail-closed exact-load identity: a snapshot is authorized only when a
 * runtime-owned load fact joins the episode by BOTH `agentTurnEpisodeId` AND
 * `runtimeSessionId`, AND the snapshot's `capabilityHandle`, `routingName`
 * (`snapshot.name`), and `guidanceHash` ALL agree with the fact's
 * `skill` identity. A stale load fact (e.g. an older `guidanceHash`) must not
 * authorize the current successor snapshot — route-reuse, handle-reuse, and
 * stale-hash reuse all fail closed. Legacy episodes without the canonical
 * AgentTurn correlation receive no dependencies (never join by timestamp or
 * session proximity). External/capsule episodes default to empty unless an
 * existing authenticated runtime-owned fact matches the same episode.
 *
 * `relatedCurrentSkills` remains the bounded recall context for merge, append,
 * replacement, and routing decisions and is populated separately by callers.
 *
 * Returns a new array (possibly empty) of snapshots drawn from `allSnapshots`.
 */
export function selectRuntimeOwnedReferencedSkills(
  skillLoadFacts: readonly GeneratedSkillLoadFact[] | undefined,
  episode: Pick<LearningEpisode, 'agentTurnEpisodeId' | 'runtimeSessionId'>,
  allSnapshots: readonly ReferencedSkillSnapshot[],
): ReferencedSkillSnapshot[] {
  const provenIdentities = collectRuntimeOwnedLoadIdentities(skillLoadFacts, episode);
  if (provenIdentities.size === 0) return [];
  return allSnapshots.filter(snapshot =>
    !!snapshot.capabilityHandle
    && !!snapshot.guidanceHash
    && !!snapshot.name
    && provenIdentities.has(loadIdentityKeyFromSnapshot(snapshot)),
  );
}

export function buildRuntimeOwnedReferencedSkillProvenance(
  skillLoadFacts: readonly GeneratedSkillLoadFact[] | undefined,
  episode: Pick<LearningEpisode, 'agentTurnEpisodeId' | 'runtimeSessionId'>,
  referencedSkills: readonly ReferencedSkillSnapshot[],
): RuntimeOwnedReferencedSkillProvenance | undefined {
  const episodeId = episode.agentTurnEpisodeId;
  const sessionId = episode.runtimeSessionId;
  if (!episodeId || !sessionId) return undefined;
  const provenIdentities = collectRuntimeOwnedLoadIdentities(skillLoadFacts, episode);
  if (provenIdentities.size === 0) return undefined;
  const identities: TrustedReferencedSkillIdentity[] = referencedSkills.flatMap(snapshot => {
    if (!snapshot.capabilityHandle || !snapshot.guidanceHash || !snapshot.name) return [];
    const identity = {
      capabilityHandle: snapshot.capabilityHandle,
      routingName: snapshot.name,
      guidanceHash: snapshot.guidanceHash,
    } satisfies TrustedReferencedSkillIdentity;
    return provenIdentities.has(loadIdentityKey(identity)) ? [identity] : [];
  });
  if (identities.length === 0) return undefined;
  return {
    kind: 'runtime-owned-generated-skill-load-v1',
    runtimeSessionId: sessionId,
    agentTurnEpisodeId: episodeId,
    referencedSkills: identities,
  };
}

/**
 * Canonical join key for a runtime-owned generated Current Skill load identity.
 * Combines `capabilityHandle`, `routingName`, and `guidanceHash` so that any
 * single-field drift (route reuse, handle reuse, or stale guidance) produces a
 * different key and fails closed.
 */
function loadIdentityKey(skill: {
  capabilityHandle: string;
  routingName: string;
  guidanceHash: string;
}): string {
  return `${skill.capabilityHandle}\u0000${skill.routingName}\u0000${skill.guidanceHash}`;
}

function loadIdentityKeyFromSnapshot(snapshot: ReferencedSkillSnapshot): string {
  return `${snapshot.capabilityHandle}\u0000${snapshot.name}\u0000${snapshot.guidanceHash}`;
}

function collectRuntimeOwnedLoadIdentities(
  skillLoadFacts: readonly GeneratedSkillLoadFact[] | undefined,
  episode: Pick<LearningEpisode, 'agentTurnEpisodeId' | 'runtimeSessionId'>,
): Set<string> {
  const episodeId = episode.agentTurnEpisodeId;
  const sessionId = episode.runtimeSessionId;
  if (!episodeId || !sessionId) return new Set<string>();
  const provenIdentities = new Set<string>();
  for (const fact of skillLoadFacts ?? []) {
    if (fact.kind !== 'generated-skill-load') continue;
    if (fact.episodeId !== episodeId || fact.runtimeSessionId !== sessionId) continue;
    provenIdentities.add(loadIdentityKey(fact.skill));
  }
  return provenIdentities;
}

/**
 * Build the fixed Evidence Bundle for one Learning Episode.
 *
 * For external-origin episodes that have a persisted Evidence Capsule, the
 * entire bundle is reconstructed from the capsule so Author/Verifier never see
 * raw external detail leaked through the fallback candidate's actionPattern
 * or solvedLoop fields. External-origin episodes without a capsule fail fast.
 *
 * @param episode           The matured Learning Episode to assemble evidence for.
 * @param candidate         The distilled knowledge candidate describing the episode.
 * @param skillEvolution     The SkillEvolutionRuntime providing the current registry and referenced-skill snapshots.
 * @param capsuleStore      Optional capsule store; when present, external-origin episodes are reconstructed from their capsule.
 * @param isExternalEpisode Optional predicate marking an episode as external-origin (requires a persisted capsule).
 * @param skillLoadFacts    Optional runtime-owned `GeneratedSkillLoadFact` entries from the SkillUsageLedger. Only facts whose `episodeId` matches the episode's `agentTurnEpisodeId` authorize a dependency. External/capsule semantic observations are never used for dependency authorization.
 */
export function buildEpisodeEvidenceBundle(
  episode: LearningEpisode,
  candidate: DistilledKnowledgeCandidate,
  skillEvolution: SkillEvolutionRuntime,
  capsuleStore?: EvidenceCapsuleStore,
  isExternalEpisode?: (episodeId: string) => boolean,
  skillLoadFacts?: readonly GeneratedSkillLoadFact[],
): EvidenceBundle {
  const completionEvidence: readonly SkillEvidenceRef[] = episode.completionEvidence
    .filter(evidence => evidence.kind !== 'contradiction')
    .map(evidence => ({
      ref: evidence.ref,
      sourceFilePath: evidence.sourceFilePath,
      turn: evidence.turn,
    }));
  const settlementEntry = buildEpisodeSettlementEvidence(episode);
  const settlementEvidence: readonly SkillEvidenceRef[] = [{
    ref: settlementEntry.ref,
    sourceFilePath: settlementEntry.sourceFilePath,
    turn: settlementEntry.turn,
  }];
  const registry = skillEvolution.getRegistry();
  const relatedCurrentSkills: readonly RelatedCurrentSkill[] = Object.values(registry.capabilities).map(
    record => ({
      handle: record.handle,
      revision: record.revision,
      routingName: record.routingName,
      description: record.description,
      guidanceHash: record.guidanceHash,
    }),
  );

  const bundleId = `v3:learning-episode:${episode.episodeId}`;
  const allReferencedSkillSnapshots = skillEvolution.getReferencedSkillSnapshots();
  const referencedSkills = selectRuntimeOwnedReferencedSkills(
    skillLoadFacts,
    episode,
    allReferencedSkillSnapshots,
  );
  const referencedSkillProvenance = buildRuntimeOwnedReferencedSkillProvenance(
    skillLoadFacts,
    episode,
    referencedSkills,
  );

  if (capsuleStore) {
    const capsule = capsuleStore.findByBundleId(bundleId);
    if (capsule) {
      return reconstructBundleFromCapsule(
        capsule,
        referencedSkills,
        registry,
        referencedSkillProvenance,
      );
    }
    if (!capsule && isExternalEpisode?.(episode.episodeId)) {
      throw new Error(
        `External-origin Learning Episode ${episode.episodeId} requires a persisted Evidence Capsule before review.`,
      );
    }
  }

  return {
    bundleId,
    episode: candidate,
    completionEvidence,
    settlementEvidence,
    boundedContinuity: [],
    semanticObservations: episode.semanticObservations,
    referencedSkills,
    relatedCurrentSkills,
    referencedSkillProvenance,
  };
}
