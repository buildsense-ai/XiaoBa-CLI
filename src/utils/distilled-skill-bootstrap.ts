import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CapabilityTransitionKind, EvidenceBundle, SkillEvolutionRuntime } from './skill-evolution';
import type { ReferencedSkillSnapshot } from './skill-evolution';
import { SkillParser } from '../skills/skill-parser';
import type { LearningEpisodeStore } from './learning-episode';
import type { EvidenceReviewJob } from './evidence-review-types';
import {
  SemanticReassessmentManifestStore,
  semanticDependencyFingerprint,
  semanticObservationHash,
  semanticReassessmentTaskId,
  shouldReassessCurrentSkill,
} from './semantic-reassessment';
import { semanticPriorGuidanceEvidenceRef } from './evidence-bundle-authority';

export interface SemanticReassessmentBootstrapOptions {
  skillEvolution: SkillEvolutionRuntime;
  manifestPath: string;
  learningEpisodeStore?: LearningEpisodeStore;
}

export interface SemanticReassessmentBootstrapResult {
  taskId: string;
  capabilityHandle: string;
  status: 'pending' | 'succeeded' | 'deferred' | 'failed' | 'superseded';
  transition?: CapabilityTransitionKind;
  errorMessage?: string;
}

/**
 * Discover active generated capabilities that predate semantic observations
 * or still use lifecycle-bound names. Each task is durable and keyed by the
 * capability handle plus current guidance/observation hashes, so a restart
 * cannot replay an obsolete revision blindly.
 */
export async function bootstrapSemanticReassessmentOnce(
  options: SemanticReassessmentBootstrapOptions,
): Promise<SemanticReassessmentBootstrapResult[]> {
  const manifest = new SemanticReassessmentManifestStore(options.manifestPath);
  const registry = options.skillEvolution.getRegistry();
  const results: SemanticReassessmentBootstrapResult[] = [];
  const records = Object.values(registry.capabilities);

  // First group stale references by dependent. The former implementation
  // accidentally used only staleDependents[0], silently leaving other
  // generated Skills with stale guidance snapshots.
  const dependentGroups = new Map<string, {
    candidate: typeof records[number];
    references: Array<{ source: typeof records[number]; reference: typeof records[number]['referencedSkills'][number] }>;
  }>();
  for (const source of records) {
    for (const candidate of records) {
      if (candidate.handle === source.handle) continue;
      const stale = candidate.referencedSkills
        .filter(reference => reference.capabilityHandle === source.handle
          && (reference.name !== source.routingName
            || referenceGuidanceContentHash(source, reference) !== currentGuidanceContentHash(source)));
      if (stale.length === 0) continue;
      const group = dependentGroups.get(candidate.handle) ?? { candidate, references: [] };
      group.references.push(...stale.map(reference => ({ source, reference })));
      dependentGroups.set(candidate.handle, group);
    }
  }

  // Route-only drift is metadata maintenance, but it must be applied once
  // for every affected dependent, not just the first one discovered.
  for (const group of dependentGroups.values()) {
    if (!group.references.every(item => referenceGuidanceContentHash(item.source, item.reference) === currentGuidanceContentHash(item.source))) continue;
    const refreshed = group.candidate.referencedSkills.map(reference => {
      const match = group.references.find(item => item.reference === reference);
      return match
        ? { ...reference, name: match.source.routingName, guidanceHash: match.source.guidanceHash, guidanceContentHash: currentGuidanceContentHash(match.source), contentFingerprint: match.source.guidanceHash }
        : reference;
    });
    try {
      const transition = options.skillEvolution.refreshReferencedSkillMetadata(group.candidate.handle, refreshed);
      results.push({
        taskId: transition.audit.bundleId ?? `refresh-references:${group.candidate.handle}`,
        capabilityHandle: group.candidate.handle,
        status: 'succeeded',
        transition: transition.audit.transition,
      });
    } catch (error) {
      results.push({
        taskId: `refresh-references:${group.candidate.handle}`,
        capabilityHandle: group.candidate.handle,
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Guidance drift requires a bounded Author/Verifier maintenance review for
  // each dependent. Route-only groups above never enter this path.
  for (const group of dependentGroups.values()) {
    if (group.references.every(item => referenceGuidanceContentHash(item.source, item.reference) === currentGuidanceContentHash(item.source))) continue;
    const references = group.candidate.referencedSkills.map(reference => {
      const match = group.references.find(item => item.reference === reference);
      return match
        ? { ...reference, name: match.source.routingName, guidanceHash: match.source.guidanceHash, guidanceContentHash: currentGuidanceContentHash(match.source), contentFingerprint: match.source.guidanceHash }
        : reference;
    });
    const result = await reassessRecord(group.candidate, {
      ...options,
      manifest,
      registry,
      references,
      forceSchedule: true,
    });
    if (result) results.push(result);
  }

  // Finally process capabilities whose own route still needs semantic
  // reassessment. This is independent of dependent maintenance above.
  for (const record of records) {
    if (!shouldReassessCurrentSkill(record)) continue;
    const result = await reassessRecord(record, { ...options, manifest, registry });
    if (result) results.push(result);
  }
  return results;
}

interface ReassessRecordOptions extends SemanticReassessmentBootstrapOptions {
  manifest: SemanticReassessmentManifestStore;
  registry: ReturnType<SkillEvolutionRuntime['getRegistry']>;
  references?: ReferencedSkillSnapshot[];
  forceSchedule?: boolean;
}

interface DurableBundleReviewMirror {
  status: SemanticReassessmentBootstrapResult['status'];
  errorMessage?: string;
  nextRetryAt?: string;
}

function durableBundleReviewMirror(
  skillEvolution: SkillEvolutionRuntime,
  bundleId: string,
): DurableBundleReviewMirror | undefined {
  const jobs = Object.values(skillEvolution.getEvidenceReviewEngine().loadStore().jobs)
    .filter(job => job.bundle.bundleId === bundleId && job.disposition !== 'superseded')
    .sort((left, right) => {
      const ownership = (job: EvidenceReviewJob) => (
        job.disposition === 'active' || job.disposition === 'deferred' ? 1 : 0
      );
      return ownership(right) - ownership(left)
        || right.updatedAt.localeCompare(left.updatedAt, 'en')
        || right.jobId.localeCompare(left.jobId, 'en');
    });
  const job = jobs[0];
  if (!job) return undefined;
  if (job.disposition === 'completed') return { status: 'succeeded' };
  if (job.disposition === 'terminal_failed') {
    const failed = Object.values(job.quanta).find(quantum => quantum.state === 'terminal_failed');
    return {
      status: 'failed',
      errorMessage: job.terminalReason ?? failed?.failureMessage,
    };
  }
  if (job.disposition === 'deferred') {
    return { status: 'deferred', errorMessage: job.deferState?.reason };
  }
  if (job.workClass === 'operational_recovery') {
    const retry = Object.values(job.quanta)
      .filter(quantum => quantum.state === 'retry_wait' || quantum.state === 'terminal_failed')
      .sort((left, right) => (left.nextRetryAt ?? '').localeCompare(right.nextRetryAt ?? '', 'en'))[0];
    return {
      status: 'failed',
      errorMessage: retry?.failureMessage ?? job.terminalReason,
      nextRetryAt: retry?.nextRetryAt ?? job.nextDueAt,
    };
  }
  return { status: 'pending' };
}

function currentGuidanceContentHash(record: { guidanceContentHash?: string; skillFilePath: string }): string | undefined {
  if (record.guidanceContentHash) return record.guidanceContentHash;
  try {
    return crypto.createHash('sha256').update(SkillParser.parse(record.skillFilePath).content.trim()).digest('hex');
  } catch {
    return undefined;
  }
}

function referenceGuidanceContentHash(
  source: { guidanceHash: string; guidanceContentHash?: string; skillFilePath: string },
  reference: { guidanceHash?: string; guidanceContentHash?: string },
): string | undefined {
  if (reference.guidanceContentHash) return reference.guidanceContentHash;
  if (!reference.guidanceHash) return undefined;
  if (reference.guidanceHash === source.guidanceHash) return currentGuidanceContentHash(source);
  // Legacy references only carried the full-file hash. A route migration
  // archives that exact file, allowing us to distinguish metadata drift from
  // executable guidance drift without weakening active-file integrity checks.
  const archive = path.join(path.dirname(source.skillFilePath), 'history', reference.guidanceHash, 'SKILL.md');
  if (!fs.existsSync(archive)) return reference.guidanceHash;
  try {
    return crypto.createHash('sha256').update(SkillParser.parse(archive).content.trim()).digest('hex');
  } catch {
    return reference.guidanceHash;
  }
}

async function reassessRecord(
  record: ReturnType<SkillEvolutionRuntime['getRegistry']>['capabilities'][string],
  options: ReassessRecordOptions,
): Promise<SemanticReassessmentBootstrapResult | undefined> {
  const observations = record.semanticObservations?.length
    ? record.semanticObservations
    : findEpisodeObservations(options.learningEpisodeStore, record.evidenceRefs.map(item => item.ref));
  const dependencyFingerprint = semanticDependencyFingerprint(options.references ?? record.referencedSkills);
  const input = { ...record, semanticObservations: observations, dependencyFingerprint };
  let entry = options.forceSchedule
    ? options.manifest.ensureForRecord(input)
    : options.manifest.upsertForRecord(input);
  if (!entry || entry.status === 'superseded') return undefined;
  if (observations.length > 0 && entry.semanticObservationHash !== semanticObservationHash(observations)) {
    const refreshed = options.manifest.upsertForRecord(input, new Date(), true);
    if (!refreshed) return undefined;
    entry = refreshed;
  }
  if (entry.status === 'succeeded' || entry.status === 'superseded' || entry.status === 'deferred') return undefined;
  if (entry.status === 'failed' && entry.nextRetryAt && Date.parse(entry.nextRetryAt) > Date.now()) return undefined;
  if (observations.length === 0) {
    const state = options.manifest.load();
    const current = state.entries[entry.taskId];
    if (current) {
      current.status = 'deferred';
      current.lastError = 'No persisted semantic observations are available for bounded reassessment.';
      current.updatedAt = new Date().toISOString();
      options.manifest.save(state);
    }
    return { taskId: entry.taskId, capabilityHandle: record.handle, status: 'deferred', errorMessage: current?.lastError };
  }
  const evidenceRefs = record.evidenceRefs.map(item => item.ref);
  const priorGuidanceBasis = freezeSemanticPriorGuidanceBasis(record, observations);
  const completionRef = priorGuidanceBasis?.completionEvidence[0]?.ref
    ?? evidenceRefs[0]
    ?? `registry:${record.handle}:guidance`;
  const settlementRef = priorGuidanceBasis?.settlementEvidence[0]?.ref
    ?? evidenceRefs[1]
    ?? `registry:${record.handle}:reassessment`;
  const reviewEvidenceRefs = [completionRef, settlementRef];
  const bundle: EvidenceBundle = {
    bundleId: semanticReassessmentTaskId(record.handle, record.guidanceHash, observations),
    authority: {
      kind: 'semantic-reassessment',
      targetCapabilityHandle: record.handle,
    },
    // Reassessment still enters the normal review/queue seam, which expects
    // a DistilledKnowledgeCandidate. Keep the capability handle alongside
    // the candidate fields so constrained fixtures and audit consumers can
    // identify the prior capability without introducing a second queue type.
    episode: {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId: record.handle,
      capabilityHandle: record.handle,
      title: record.routingName,
      applicability: record.description,
      actionPattern: record.description,
      boundaries: [],
      risks: [],
      solvedLoop: {
        problem: `Reassess the generated capability ${record.routingName}.`,
        action: record.description,
        verification: 'The bounded reassessment review completed.',
        noCorrection: 'Prior evidence remains the fixed source for reassessment.',
      },
      provenance: reviewEvidenceRefs.map((ref, index) => ({
        filePath: ref,
        turn: index + 1,
        role: index === 0 ? 'problem-action' as const : 'verification' as const,
        unitByteRange: { start: 0, end: 0 },
      })),
      generatedAt: new Date().toISOString(),
      sourceUnit: {
        filePath: `registry:${record.handle}`,
        byteRange: { start: 0, end: 0 },
        generatedAt: new Date().toISOString(),
      },
    } as import('./capability-distiller').DistilledKnowledgeCandidate & { capabilityHandle: string },
    completionEvidence: priorGuidanceBasis?.completionEvidence ?? [{ ref: completionRef }],
    settlementEvidence: priorGuidanceBasis?.settlementEvidence
      ?? [{ ref: settlementRef === completionRef ? `${settlementRef}:settlement` : settlementRef }],
    boundedContinuity: [],
    semanticObservations: observations,
    referencedSkills: options.references ?? record.referencedSkills,
    relatedCurrentSkills: [{
      handle: record.handle,
      revision: record.revision,
      routingName: record.routingName,
      description: record.description,
      guidanceHash: record.guidanceHash,
    }],
    ...(priorGuidanceBasis ? { sourceEvidence: priorGuidanceBasis.sourceEvidence } : {}),
  };
  // The Job store is authoritative. Rebuild the manifest mirror before any
  // submission so a crash after terminal Job persistence cannot re-admit the
  // same deterministic bundle on restart.
  const durableBeforeReview = durableBundleReviewMirror(options.skillEvolution, bundle.bundleId);
  if (durableBeforeReview) {
    const state = options.manifest.load();
    const current = state.entries[entry.taskId];
    if (current) {
      current.status = durableBeforeReview.status;
      current.lastError = durableBeforeReview.errorMessage;
      if (durableBeforeReview.status === 'failed' && durableBeforeReview.nextRetryAt) {
        current.nextRetryAt = durableBeforeReview.nextRetryAt;
      } else {
        delete current.nextRetryAt;
      }
      current.updatedAt = new Date().toISOString();
      options.manifest.save(state);
    }
    return {
      taskId: entry.taskId,
      capabilityHandle: record.handle,
      status: durableBeforeReview.status,
      ...(durableBeforeReview.errorMessage
        ? { errorMessage: durableBeforeReview.errorMessage }
        : {}),
    };
  }
  try {
    const result = await options.skillEvolution.reviewAndApply(bundle);
    const queuedState = options.skillEvolution.getQueuedReviewState(bundle.bundleId);
    const state = options.manifest.load();
    const current = state.entries[entry.taskId];
    if (current) {
      current.status = queuedState?.kind === 'deferred' || result.queued === 'deferred'
        ? 'deferred'
        : queuedState?.kind === 'operational' || result.queued === 'operational'
          ? 'failed'
          : 'succeeded';
      current.lastError = queuedState?.reason
        ?? (result.queued ? `Reassessment queued: ${result.queued}` : undefined);
      if (current.status === 'failed' && queuedState?.nextRetryAt) {
        current.nextRetryAt = queuedState.nextRetryAt;
      } else if (current.status === 'succeeded' || current.status === 'deferred') {
        delete current.nextRetryAt;
      }
      current.updatedAt = new Date().toISOString();
      options.manifest.save(state);
    }
    return { taskId: entry.taskId, capabilityHandle: record.handle, status: current?.status ?? 'succeeded', transition: result.transition };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const queuedState = options.skillEvolution.getQueuedReviewState(bundle.bundleId);
    const state = options.manifest.load();
    const current = state.entries[entry.taskId];
    if (current) {
      current.status = queuedState?.kind === 'deferred' ? 'deferred' : 'failed';
      current.attemptCount += 1;
      current.lastError = queuedState?.reason ?? message;
      if (queuedState?.nextRetryAt) current.nextRetryAt = queuedState.nextRetryAt;
      else if (current.status === 'deferred') delete current.nextRetryAt;
      else current.nextRetryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      current.updatedAt = new Date().toISOString();
      options.manifest.save(state);
    }
    return { taskId: entry.taskId, capabilityHandle: record.handle, status: 'failed', errorMessage: message };
  }
}

function freezeSemanticPriorGuidanceBasis(
  record: ReturnType<SkillEvolutionRuntime['getRegistry']>['capabilities'][string],
  observations: readonly import('./learning-episode').SemanticObservation[],
): Pick<EvidenceBundle, 'completionEvidence' | 'settlementEvidence' | 'sourceEvidence'> | undefined {
  try {
    const fileContent = fs.readFileSync(record.skillFilePath, 'utf8');
    if (crypto.createHash('sha256').update(fileContent).digest('hex') !== record.guidanceHash) {
      return undefined;
    }
    const guidanceBody = SkillParser.parse(record.skillFilePath).content.trim();
    if (!guidanceBody) return undefined;
    const guidanceContentHash = crypto.createHash('sha256').update(guidanceBody).digest('hex');
    if (
      record.guidanceContentHash !== undefined
      && record.guidanceContentHash !== guidanceContentHash
    ) return undefined;

    const guidanceRef = semanticPriorGuidanceEvidenceRef(record.handle, record.guidanceHash);
    const observationRef = `registry:${record.handle}:semantic-observations:${semanticObservationHash(observations)}`;
    const observationContent = JSON.stringify(observations);
    return {
      completionEvidence: [{
        ref: guidanceRef,
        sourceFilePath: record.skillFilePath,
        turn: 0,
      }],
      settlementEvidence: [{
        ref: observationRef,
        sourceFilePath: `registry:${record.handle}`,
        turn: 0,
      }],
      sourceEvidence: [
        {
          ref: guidanceRef,
          role: 'problem-action',
          content: guidanceBody,
          sourceFilePath: record.skillFilePath,
          turn: 0,
        },
        {
          ref: observationRef,
          role: 'verification',
          content: observationContent,
          sourceFilePath: `registry:${record.handle}`,
          turn: 0,
        },
      ],
    };
  } catch {
    return undefined;
  }
}

function findEpisodeObservations(
  store: LearningEpisodeStore | undefined,
  evidenceRefs: readonly string[],
): import('./learning-episode').SemanticObservation[] {
  if (!store) return [];
  const refs = new Set(evidenceRefs);
  try {
    return Object.values(store.load().episodes)
      .filter(episode => episode.completionEvidence.some(item => refs.has(item.ref)))
      .flatMap(episode => episode.semanticObservations);
  } catch {
    return [];
  }
}
