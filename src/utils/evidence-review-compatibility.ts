/**
 * Evidence Review compatibility migration helpers (#110).
 *
 * Convert legacy Operational Review Retry and prompt-budget-blocked records
 * into durable Evidence Review Job projection seeds without dropping evidence,
 * attempts, backoff, provenance, or transcripts.
 *
 * Pure + dependency-light: no RuntimeLearning, scheduler, or dashboard wiring.
 * Integrators later materialize full graph jobs via #105–#109 createEvidenceReviewJob
 * using the preserved evidence + candidate snapshots carried in MigrationSeed.
 */

import type {
  EvidenceReviewProjectionInput,
  ProjectionQuantum,
} from './evidence-review-diagnostics';

// ---------------------------------------------------------------------------
// Legacy record shapes (structural — match skill-evolution-review-queue + #104)
// ---------------------------------------------------------------------------

export type LegacyOperationalFailureKind =
  | 'branch_timeout'
  | 'branch_failure'
  | 'invalid_completion_schema'
  | string;

/**
 * Legacy Operational Review Retry entry (skill-evolution-review-queue).
 * Fields mirror SkillEvolutionOperationalReviewFailureEntry.
 */
export interface LegacyOperationalReviewRetryRecord {
  readonly entryId: string;
  readonly candidateCapabilityId: string;
  readonly bundleId: string;
  readonly bundle: unknown;
  readonly candidate: unknown;
  readonly failureKind: LegacyOperationalFailureKind;
  readonly failureMessage: string;
  readonly failureTranscripts: readonly string[];
  readonly attempts: number;
  readonly currentDelayMs: number;
  readonly nextRetryAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Optional provenance refs preserved when present on older snapshots. */
  readonly provenance?: readonly unknown[];
  readonly evidenceFingerprint?: string;
  readonly reviewerVersion?: string;
}

/**
 * Historical prompt-budget-blocked admission record (#104 era).
 * Estimated prompt size blocked Review Admission before Context Overflow
 * Escalation existed. Migration must re-admit as active coverage work, never
 * discard the candidate or evidence.
 */
export interface LegacyPromptBudgetBlockedRecord {
  readonly entryId: string;
  readonly candidateCapabilityId: string;
  readonly bundleId: string;
  readonly bundle: unknown;
  readonly candidate: unknown;
  /** Estimated token count that caused the false rejection, when known. */
  readonly estimatedPromptTokens?: number;
  /** Configured maxPromptTokens ceiling that blocked admission. */
  readonly maxPromptTokens?: number;
  readonly blockedReason?: string;
  readonly blockedAt: string;
  readonly failureTranscripts?: readonly string[];
  readonly attempts?: number;
  readonly provenance?: readonly unknown[];
  readonly evidenceFingerprint?: string;
  readonly reviewerVersion?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export type LegacyReviewRecord =
  | { readonly kind: 'operational_retry'; readonly record: LegacyOperationalReviewRetryRecord }
  | { readonly kind: 'prompt_budget_blocked'; readonly record: LegacyPromptBudgetBlockedRecord };

// ---------------------------------------------------------------------------
// Migration seed — preserved material for later full job materialization
// ---------------------------------------------------------------------------

export type MigrationSourceKind = 'operational_retry' | 'prompt_budget_blocked';

/**
 * Preserved evidence + retry metadata. Integrators must not drop any field
 * when materializing a full Evidence Review Job.
 */
export interface EvidenceReviewMigrationSeed {
  readonly schemaVersion: 1;
  readonly sourceKind: MigrationSourceKind;
  readonly sourceEntryId: string;
  readonly proposedJobId: string;
  readonly workClass: 'operational_recovery' | 'live_learning';
  readonly durableDisposition: 'active';
  /** Opaque Evidence Bundle snapshot — never dropped. */
  readonly bundle: unknown;
  /** Opaque candidate snapshot — never dropped. */
  readonly candidate: unknown;
  readonly candidateCapabilityId: string;
  readonly bundleId: string;
  /** Completed attempt count carried forward. */
  readonly attempts: number;
  /** Active backoff delay in ms. */
  readonly currentDelayMs: number;
  /** ISO next-retry deadline (operational); undefined for prompt-budget re-admit. */
  readonly nextRetryAt?: string;
  /** Failure / blocked messages preserved for audit. */
  readonly messages: readonly string[];
  /** Transcript paths preserved across migration. */
  readonly transcriptPaths: readonly string[];
  /** Optional provenance payload preserved when present. */
  readonly provenance?: readonly unknown[];
  readonly evidenceFingerprint?: string;
  readonly reviewerVersion?: string;
  readonly failureKind?: LegacyOperationalFailureKind;
  readonly estimatedPromptTokens?: number;
  readonly maxPromptTokens?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly migratedAt: string;
  /**
   * Projection-ready job input so operators can observe the migrated work
   * before full graph materialization lands.
   */
  readonly projectionInput: EvidenceReviewProjectionInput;
}

export interface MigrationResult {
  readonly seeds: readonly EvidenceReviewMigrationSeed[];
  readonly skipped: readonly MigrationSkip[];
  readonly preservedFieldCounts: {
    readonly evidenceBundles: number;
    readonly candidates: number;
    readonly transcripts: number;
    readonly attempts: number;
  };
}

export interface MigrationSkip {
  readonly sourceKind: MigrationSourceKind | 'unknown';
  readonly sourceEntryId?: string;
  readonly reason: string;
}

export interface MigrateLegacyReviewOptions {
  readonly now?: Date;
  /**
   * Optional job-id factory. Defaults to a stable content-derived id that
   * preserves source entry identity for idempotent re-migration.
   */
  readonly jobIdFor?: (source: LegacyReviewRecord) => string;
}

// ---------------------------------------------------------------------------
// Validation / normalization
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Structural parse of an Operational Review Retry entry.
 * Returns undefined when required identity/evidence fields are missing —
 * never invents empty evidence.
 */
export function parseLegacyOperationalRetry(value: unknown): LegacyOperationalReviewRetryRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.entryId !== 'string' || value.entryId.length === 0) return undefined;
  if (typeof value.candidateCapabilityId !== 'string') return undefined;
  if (typeof value.bundleId !== 'string') return undefined;
  if (value.bundle === undefined || value.bundle === null) return undefined;
  if (value.candidate === undefined || value.candidate === null) return undefined;
  if (typeof value.failureKind !== 'string') return undefined;
  if (typeof value.failureMessage !== 'string') return undefined;
  if (typeof value.nextRetryAt !== 'string') return undefined;
  if (typeof value.createdAt !== 'string') return undefined;
  if (typeof value.updatedAt !== 'string') return undefined;

  const attempts = typeof value.attempts === 'number' && Number.isFinite(value.attempts)
    ? Math.max(0, Math.floor(value.attempts))
    : 0;
  const currentDelayMs = typeof value.currentDelayMs === 'number' && Number.isFinite(value.currentDelayMs)
    ? Math.max(0, Math.floor(value.currentDelayMs))
    : 0;

  return {
    entryId: value.entryId,
    candidateCapabilityId: value.candidateCapabilityId,
    bundleId: value.bundleId,
    bundle: value.bundle,
    candidate: value.candidate,
    failureKind: value.failureKind,
    failureMessage: value.failureMessage,
    failureTranscripts: asStringArray(value.failureTranscripts),
    attempts,
    currentDelayMs,
    nextRetryAt: value.nextRetryAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    provenance: Array.isArray(value.provenance) ? value.provenance : undefined,
    evidenceFingerprint: typeof value.evidenceFingerprint === 'string'
      ? value.evidenceFingerprint
      : undefined,
    reviewerVersion: typeof value.reviewerVersion === 'string'
      ? value.reviewerVersion
      : undefined,
  };
}

/**
 * Structural parse of a prompt-budget-blocked admission record.
 * Evidence + candidate are mandatory; token counts are optional audit fields.
 */
export function parseLegacyPromptBudgetBlocked(value: unknown): LegacyPromptBudgetBlockedRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.entryId !== 'string' || value.entryId.length === 0) return undefined;
  if (typeof value.candidateCapabilityId !== 'string') return undefined;
  if (typeof value.bundleId !== 'string') return undefined;
  if (value.bundle === undefined || value.bundle === null) return undefined;
  if (value.candidate === undefined || value.candidate === null) return undefined;
  if (typeof value.blockedAt !== 'string') return undefined;

  return {
    entryId: value.entryId,
    candidateCapabilityId: value.candidateCapabilityId,
    bundleId: value.bundleId,
    bundle: value.bundle,
    candidate: value.candidate,
    estimatedPromptTokens: typeof value.estimatedPromptTokens === 'number'
      ? value.estimatedPromptTokens
      : undefined,
    maxPromptTokens: typeof value.maxPromptTokens === 'number'
      ? value.maxPromptTokens
      : undefined,
    blockedReason: typeof value.blockedReason === 'string' ? value.blockedReason : undefined,
    blockedAt: value.blockedAt,
    failureTranscripts: asStringArray(value.failureTranscripts),
    attempts: typeof value.attempts === 'number' && Number.isFinite(value.attempts)
      ? Math.max(0, Math.floor(value.attempts))
      : 0,
    provenance: Array.isArray(value.provenance) ? value.provenance : undefined,
    evidenceFingerprint: typeof value.evidenceFingerprint === 'string'
      ? value.evidenceFingerprint
      : undefined,
    reviewerVersion: typeof value.reviewerVersion === 'string'
      ? value.reviewerVersion
      : undefined,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : value.blockedAt,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : value.blockedAt,
  };
}

export function defaultMigratedJobId(source: LegacyReviewRecord): string {
  if (source.kind === 'operational_retry') {
    return `job:migrated:op:${source.record.entryId}`;
  }
  return `job:migrated:pbb:${source.record.entryId}`;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function buildRetryWaitQuantum(input: {
  jobId: string;
  attempts: number;
  currentDelayMs: number;
  nextRetryAt: string;
  failureMessage: string;
  transcriptPaths: readonly string[];
  updatedAt: string;
}): ProjectionQuantum {
  return {
    quantumId: `${input.jobId}:quantum:migrated_retry`,
    kind: 'skill_verifier',
    state: 'retry_wait',
    attempts: input.attempts,
    currentDelayMs: input.currentDelayMs,
    nextRetryAt: input.nextRetryAt,
    failureMessage: input.failureMessage,
    transcriptPaths: [...input.transcriptPaths],
    dependencyQuantumIds: [],
    updatedAt: input.updatedAt,
  };
}

function buildPendingCoverageQuantum(input: {
  jobId: string;
  attempts: number;
  transcriptPaths: readonly string[];
  updatedAt: string;
  note: string;
}): ProjectionQuantum {
  return {
    quantumId: `${input.jobId}:quantum:migrated_coverage`,
    kind: 'author_reader',
    state: 'pending',
    attempts: input.attempts,
    currentDelayMs: 0,
    failureMessage: input.note,
    transcriptPaths: [...input.transcriptPaths],
    dependencyQuantumIds: [],
    lane: 'author',
    shardId: 'migrated:pending-coverage',
    updatedAt: input.updatedAt,
  };
}

/**
 * Convert one Operational Review Retry record into a migration seed.
 * Preserves evidence, attempts, backoff, provenance, and transcripts.
 */
export function migrateOperationalReviewRetry(
  record: LegacyOperationalReviewRetryRecord,
  options: MigrateLegacyReviewOptions = {},
): EvidenceReviewMigrationSeed {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const source: LegacyReviewRecord = { kind: 'operational_retry', record };
  const jobId = options.jobIdFor?.(source) ?? defaultMigratedJobId(source);
  const transcripts = uniqueStrings(record.failureTranscripts);
  const quantum = buildRetryWaitQuantum({
    jobId,
    attempts: record.attempts,
    currentDelayMs: record.currentDelayMs,
    nextRetryAt: record.nextRetryAt,
    failureMessage: record.failureMessage,
    transcriptPaths: transcripts,
    updatedAt: record.updatedAt,
  });

  const projectionInput: EvidenceReviewProjectionInput = {
    jobId,
    disposition: 'active',
    workClass: 'operational_recovery',
    quanta: [quantum],
    nextDueAt: record.nextRetryAt,
    terminalReason: undefined,
    parentJobId: undefined,
  };

  return {
    schemaVersion: 1,
    sourceKind: 'operational_retry',
    sourceEntryId: record.entryId,
    proposedJobId: jobId,
    workClass: 'operational_recovery',
    durableDisposition: 'active',
    bundle: record.bundle,
    candidate: record.candidate,
    candidateCapabilityId: record.candidateCapabilityId,
    bundleId: record.bundleId,
    attempts: record.attempts,
    currentDelayMs: record.currentDelayMs,
    nextRetryAt: record.nextRetryAt,
    messages: [record.failureMessage],
    transcriptPaths: transcripts,
    provenance: record.provenance,
    evidenceFingerprint: record.evidenceFingerprint,
    reviewerVersion: record.reviewerVersion,
    failureKind: record.failureKind,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    migratedAt: nowIso,
    projectionInput,
  };
}

/**
 * Convert one prompt-budget-blocked record into a migration seed.
 *
 * #104 removed estimated prompt size as a Review Admission signal. Migrated
 * work becomes pending coverage under live_learning so the next wake can
 * admit it for semantic review. Evidence and transcripts are retained.
 */
export function migratePromptBudgetBlocked(
  record: LegacyPromptBudgetBlockedRecord,
  options: MigrateLegacyReviewOptions = {},
): EvidenceReviewMigrationSeed {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const source: LegacyReviewRecord = { kind: 'prompt_budget_blocked', record };
  const jobId = options.jobIdFor?.(source) ?? defaultMigratedJobId(source);
  const transcripts = uniqueStrings(record.failureTranscripts ?? []);
  const blockedNote = record.blockedReason
    ?? `legacy prompt-budget block` + (
      typeof record.estimatedPromptTokens === 'number' && typeof record.maxPromptTokens === 'number'
        ? ` (estimated ${record.estimatedPromptTokens} > max ${record.maxPromptTokens})`
        : ''
    );
  const quantum = buildPendingCoverageQuantum({
    jobId,
    attempts: record.attempts ?? 0,
    transcriptPaths: transcripts,
    updatedAt: record.updatedAt ?? record.blockedAt,
    note: blockedNote,
  });

  const projectionInput: EvidenceReviewProjectionInput = {
    jobId,
    disposition: 'active',
    workClass: 'live_learning',
    quanta: [quantum],
    nextDueAt: nowIso,
  };

  return {
    schemaVersion: 1,
    sourceKind: 'prompt_budget_blocked',
    sourceEntryId: record.entryId,
    proposedJobId: jobId,
    workClass: 'live_learning',
    durableDisposition: 'active',
    bundle: record.bundle,
    candidate: record.candidate,
    candidateCapabilityId: record.candidateCapabilityId,
    bundleId: record.bundleId,
    attempts: record.attempts ?? 0,
    currentDelayMs: 0,
    nextRetryAt: undefined,
    messages: [blockedNote],
    transcriptPaths: transcripts,
    provenance: record.provenance,
    evidenceFingerprint: record.evidenceFingerprint,
    reviewerVersion: record.reviewerVersion,
    estimatedPromptTokens: record.estimatedPromptTokens,
    maxPromptTokens: record.maxPromptTokens,
    createdAt: record.createdAt ?? record.blockedAt,
    updatedAt: record.updatedAt ?? record.blockedAt,
    migratedAt: nowIso,
    projectionInput,
  };
}

/**
 * Batch-migrate a heterogeneous list of legacy records.
 * Corrupt / incomplete records are skipped with reasons; valid evidence is never dropped.
 */
export function migrateLegacyReviewRecords(
  records: readonly unknown[],
  options: MigrateLegacyReviewOptions = {},
): MigrationResult {
  const seeds: EvidenceReviewMigrationSeed[] = [];
  const skipped: MigrationSkip[] = [];
  let transcripts = 0;
  let attempts = 0;

  for (const raw of records) {
    if (!isRecord(raw)) {
      skipped.push({ sourceKind: 'unknown', reason: 'not an object' });
      continue;
    }

    // Discriminate by explicit marker or structural shape.
    const markedKind = typeof raw.legacyKind === 'string'
      ? raw.legacyKind
      : typeof raw.sourceKind === 'string'
        ? raw.sourceKind
        : undefined;

    if (markedKind === 'prompt_budget_blocked' || 'blockedAt' in raw || 'estimatedPromptTokens' in raw || 'maxPromptTokens' in raw) {
      const parsed = parseLegacyPromptBudgetBlocked(raw);
      if (!parsed) {
        skipped.push({
          sourceKind: 'prompt_budget_blocked',
          sourceEntryId: typeof raw.entryId === 'string' ? raw.entryId : undefined,
          reason: 'missing required evidence, candidate, or identity fields',
        });
        continue;
      }
      const seed = migratePromptBudgetBlocked(parsed, options);
      seeds.push(seed);
      transcripts += seed.transcriptPaths.length;
      attempts += seed.attempts;
      continue;
    }

    if (
      markedKind === 'operational_retry'
      || 'failureKind' in raw
      || 'nextRetryAt' in raw
      || 'failureTranscripts' in raw
    ) {
      const parsed = parseLegacyOperationalRetry(raw);
      if (!parsed) {
        skipped.push({
          sourceKind: 'operational_retry',
          sourceEntryId: typeof raw.entryId === 'string' ? raw.entryId : undefined,
          reason: 'missing required evidence, candidate, backoff, or identity fields',
        });
        continue;
      }
      const seed = migrateOperationalReviewRetry(parsed, options);
      seeds.push(seed);
      transcripts += seed.transcriptPaths.length;
      attempts += seed.attempts;
      continue;
    }

    skipped.push({
      sourceKind: 'unknown',
      sourceEntryId: typeof raw.entryId === 'string' ? raw.entryId : undefined,
      reason: 'unrecognized legacy review record shape',
    });
  }

  return {
    seeds,
    skipped,
    preservedFieldCounts: {
      evidenceBundles: seeds.length,
      candidates: seeds.length,
      transcripts,
      attempts,
    },
  };
}

/**
 * Migrate the operational array from a Skill Evolution review-queue state file.
 */
export function migrateOperationalQueueEntries(
  operational: readonly unknown[],
  options: MigrateLegacyReviewOptions = {},
): MigrationResult {
  return migrateLegacyReviewRecords(
    operational.map(entry => (
      isRecord(entry) ? { ...entry, legacyKind: 'operational_retry' } : entry
    )),
    options,
  );
}

/**
 * Integrity check: migration seed still holds the same evidence identity and
 * transcript set as the source record.
 */
export function assertMigrationPreserved(
  source: LegacyReviewRecord,
  seed: EvidenceReviewMigrationSeed,
): { readonly preserved: boolean; readonly violations: readonly string[] } {
  const violations: string[] = [];
  const record = source.record;

  if (seed.bundle !== record.bundle) {
    violations.push('bundle reference dropped or replaced');
  }
  if (seed.candidate !== record.candidate) {
    violations.push('candidate reference dropped or replaced');
  }
  if (seed.bundleId !== record.bundleId) {
    violations.push('bundleId mismatch');
  }
  if (seed.candidateCapabilityId !== record.candidateCapabilityId) {
    violations.push('candidateCapabilityId mismatch');
  }

  if (source.kind === 'operational_retry') {
    const op = source.record;
    if (seed.attempts !== op.attempts) violations.push('attempts not preserved');
    if (seed.currentDelayMs !== op.currentDelayMs) violations.push('backoff not preserved');
    if (seed.nextRetryAt !== op.nextRetryAt) violations.push('nextRetryAt not preserved');
    if (seed.failureKind !== op.failureKind) violations.push('failureKind not preserved');
    const sourceTranscripts = new Set(op.failureTranscripts);
    for (const path of sourceTranscripts) {
      if (!seed.transcriptPaths.includes(path)) {
        violations.push(`transcript dropped: ${path}`);
      }
    }
    if (seed.transcriptPaths.length < op.failureTranscripts.length) {
      violations.push('transcript count reduced');
    }
  } else {
    const pbb = source.record;
    const sourceTranscripts = new Set(pbb.failureTranscripts ?? []);
    for (const path of sourceTranscripts) {
      if (!seed.transcriptPaths.includes(path)) {
        violations.push(`transcript dropped: ${path}`);
      }
    }
    if (seed.estimatedPromptTokens !== pbb.estimatedPromptTokens) {
      violations.push('estimatedPromptTokens not preserved');
    }
  }

  if (record.provenance && seed.provenance !== record.provenance) {
    violations.push('provenance not preserved');
  }

  return { preserved: violations.length === 0, violations };
}
