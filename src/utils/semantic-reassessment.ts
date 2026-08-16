import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SemanticObservation } from './learning-episode';
import { isLifecycleOrGenericRoutingName } from './skill-evolution';
import type { CurrentSkillRecord } from './skill-evolution';

export const SEMANTIC_REASSESSMENT_SCHEMA_VERSION = 1 as const;

export type SemanticReassessmentStatus = 'pending' | 'succeeded' | 'deferred' | 'failed' | 'superseded';

export interface SemanticReassessmentManifestEntry {
  taskId: string;
  capabilityHandle: string;
  routingName: string;
  guidanceHash: string;
  semanticObservationHash: string;
  /** Fingerprint of the bounded source evidence refs used for reassessment. */
  sourceEvidenceHash?: string;
  /** Registry revision observed when this reassessment was scheduled. */
  capabilityRevision?: number;
  /** Fingerprint of referenced generated-Skill guidance supplied to review. */
  dependencyFingerprint?: string;
  /** Source refs retained with the task so reassessment remains auditable. */
  sourceRefs?: string[];
  status: SemanticReassessmentStatus;
  attemptCount: number;
  nextRetryAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SemanticReassessmentManifestState {
  schemaVersion: typeof SEMANTIC_REASSESSMENT_SCHEMA_VERSION;
  entries: Record<string, SemanticReassessmentManifestEntry>;
}

export function emptySemanticReassessmentManifest(): SemanticReassessmentManifestState {
  return { schemaVersion: SEMANTIC_REASSESSMENT_SCHEMA_VERSION, entries: {} };
}

export function semanticObservationHash(observations: readonly SemanticObservation[] | undefined): string {
  const normalized = (observations ?? []).map(observation => ({
    kind: observation.kind,
    value: observation.value,
    sourceRefs: [...observation.sourceRefs].sort(),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function semanticSourceEvidenceHash(
  evidenceRefs: readonly { ref: string }[] | undefined,
): string | undefined {
  if (!evidenceRefs || evidenceRefs.length === 0) return undefined;
  const refs = [...new Set(evidenceRefs.map(item => item.ref).filter(ref => typeof ref === 'string'))].sort();
  if (refs.length === 0) return undefined;
  return crypto.createHash('sha256').update(JSON.stringify(refs)).digest('hex');
}

export function semanticDependencyFingerprint(
  references: readonly { name: string; capabilityHandle?: string; guidanceHash?: string; guidanceContentHash?: string; contentFingerprint?: string }[] | undefined,
): string | undefined {
  if (!references || references.length === 0) return undefined;
  const normalized = references.map(reference => ({
    name: reference.name,
    capabilityHandle: reference.capabilityHandle,
    guidanceHash: reference.guidanceHash,
    guidanceContentHash: reference.guidanceContentHash,
    contentFingerprint: reference.contentFingerprint,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function semanticReassessmentTaskId(
  capabilityHandle: string,
  guidanceHash: string,
  observations: readonly SemanticObservation[] | undefined,
): string {
  return `semantic-reassessment:${capabilityHandle}:${guidanceHash}:${semanticObservationHash(observations)}`;
}

export function shouldReassessCurrentSkill(record: Pick<CurrentSkillRecord, 'routingName' | 'semanticObservations'>): boolean {
  return isLifecycleOrGenericRoutingName(record.routingName)
    || !record.semanticObservations
    || record.semanticObservations.length === 0;
}

export class SemanticReassessmentManifestStore {
  constructor(private readonly filePath: string) {}

  load(): SemanticReassessmentManifestState {
    if (!fs.existsSync(this.filePath)) return emptySemanticReassessmentManifest();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<SemanticReassessmentManifestState>;
      if (parsed.schemaVersion !== SEMANTIC_REASSESSMENT_SCHEMA_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
        throw new Error('Unsupported semantic reassessment manifest schema.');
      }
      return {
        schemaVersion: SEMANTIC_REASSESSMENT_SCHEMA_VERSION,
        entries: Object.fromEntries(Object.entries(parsed.entries).filter(([, entry]) => isManifestEntry(entry))),
      };
    } catch (error) {
      throw new Error(`Semantic reassessment manifest read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  save(state: SemanticReassessmentManifestState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  upsertForRecord(
    record: Pick<CurrentSkillRecord, 'handle' | 'routingName' | 'guidanceHash' | 'semanticObservations'>
      & Partial<Pick<CurrentSkillRecord, 'evidenceRefs' | 'revision'>>
      & { dependencyFingerprint?: string },
    now = new Date(),
    force = false,
  ): SemanticReassessmentManifestEntry | undefined {
    return this.upsertInternal(record, now, force, false);
  }

  /**
   * Schedule reassessment for a generated dependent without treating the
   * dependency relationship itself as an explicit retry request. In
   * particular, this preserves a deferred entry across routine wakes.
   */
  ensureForRecord(
    record: Pick<CurrentSkillRecord, 'handle' | 'routingName' | 'guidanceHash' | 'semanticObservations'>
      & Partial<Pick<CurrentSkillRecord, 'evidenceRefs' | 'revision'>>
      & { dependencyFingerprint?: string },
    now = new Date(),
  ): SemanticReassessmentManifestEntry {
    return this.upsertInternal(record, now, false, true)!;
  }

  private upsertInternal(
    record: Pick<CurrentSkillRecord, 'handle' | 'routingName' | 'guidanceHash' | 'semanticObservations'>
      & Partial<Pick<CurrentSkillRecord, 'evidenceRefs' | 'revision'>>
      & { dependencyFingerprint?: string },
    now: Date,
    force: boolean,
    allowUnflagged: boolean,
  ): SemanticReassessmentManifestEntry | undefined {
    if (!force && !allowUnflagged && !shouldReassessCurrentSkill(record)) return undefined;
    const state = this.load();
    const observationHash = semanticObservationHash(record.semanticObservations);
    const sourceEvidenceHash = semanticSourceEvidenceHash(record.evidenceRefs);
    const taskId = semanticReassessmentTaskId(record.handle, record.guidanceHash, record.semanticObservations);
    const existing = state.entries[taskId];
    const inputChanged = !!existing && (
      existing.routingName !== record.routingName
      || existing.guidanceHash !== record.guidanceHash
      || existing.semanticObservationHash !== observationHash
      || existing.sourceEvidenceHash !== sourceEvidenceHash
      || existing.capabilityRevision !== record.revision
      || existing.dependencyFingerprint !== record.dependencyFingerprint
    );
    for (const prior of Object.values(state.entries)) {
      if (prior.capabilityHandle === record.handle
        && prior.taskId !== taskId
        && prior.status !== 'superseded'
        && (prior.routingName !== record.routingName || prior.guidanceHash !== record.guidanceHash || prior.semanticObservationHash !== observationHash
          || prior.sourceEvidenceHash !== sourceEvidenceHash || prior.capabilityRevision !== record.revision
          || prior.dependencyFingerprint !== record.dependencyFingerprint)) {
        prior.status = 'superseded';
        prior.updatedAt = now.toISOString();
      }
    }
    const entry: SemanticReassessmentManifestEntry = {
      taskId,
      capabilityHandle: record.handle,
      routingName: record.routingName,
      guidanceHash: record.guidanceHash,
      semanticObservationHash: observationHash,
      ...(sourceEvidenceHash ? { sourceEvidenceHash } : {}),
      ...(record.revision !== undefined ? { capabilityRevision: record.revision } : {}),
      ...(record.dependencyFingerprint ? { dependencyFingerprint: record.dependencyFingerprint } : {}),
      sourceRefs: [...new Set((record.semanticObservations ?? []).flatMap(observation => observation.sourceRefs))],
      status: force
        ? 'pending'
        : existing?.status === 'succeeded' && !inputChanged
          ? 'succeeded'
          : existing?.status === 'deferred' && !inputChanged
            ? 'deferred'
            : existing?.status === 'failed' && !inputChanged
              ? 'failed'
              : 'pending',
      attemptCount: existing?.attemptCount ?? 0,
      ...(existing?.nextRetryAt ? { nextRetryAt: existing.nextRetryAt } : {}),
      ...(existing?.lastError ? { lastError: existing.lastError } : {}),
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    };
    state.entries[taskId] = entry;
    this.save(state);
    return entry;
  }
}

function isManifestEntry(value: unknown): value is SemanticReassessmentManifestEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<SemanticReassessmentManifestEntry>;
  return typeof entry.taskId === 'string'
    && typeof entry.capabilityHandle === 'string'
    && typeof entry.routingName === 'string'
    && typeof entry.guidanceHash === 'string'
    && typeof entry.semanticObservationHash === 'string'
    && (entry.sourceEvidenceHash === undefined || typeof entry.sourceEvidenceHash === 'string')
    && (entry.capabilityRevision === undefined || Number.isInteger(entry.capabilityRevision))
    && (entry.dependencyFingerprint === undefined || typeof entry.dependencyFingerprint === 'string')
    && (entry.sourceRefs === undefined || (Array.isArray(entry.sourceRefs)
      && entry.sourceRefs.every(ref => typeof ref === 'string')))
    && ['pending', 'succeeded', 'deferred', 'failed', 'superseded'].includes(entry.status ?? '')
    && Number.isInteger(entry.attemptCount)
    && typeof entry.createdAt === 'string'
    && typeof entry.updatedAt === 'string';
}
