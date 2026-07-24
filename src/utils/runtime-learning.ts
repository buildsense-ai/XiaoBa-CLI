/**
 * Runtime Learning — single production entry point for background learning
 * (issue #53).
 *
 * One deep module that encapsulates evidence ingestion, Learning Episode
 * maturation, Capability learning (Author/Verifier review), Skill curation,
 * and wake coordination. Runtime startup constructs exactly one instance and
 * starts it; the Distillation Heartbeat Scheduler is only a thin wake-loop
 * adapter that calls this.wake() on each timer tick.
 *
 * The scheduler is NOT a generic workflow/DAG framework. RuntimeLearning owns
 * the full coordination; the heartbeat is just the timer.
 */

import * as fs from 'fs';
import * as path from 'path';

import { EvidenceIngestor, EvidenceIngestionResult } from './evidence-ingestor';
import {
  DueWorkPlanner,
  DueWork,
  REVIEW_CONTINUATION_DELAY_MS,
  reviewContinuationPathForEpisodeStore,
} from './due-work-planner';
import { DistillationUnit } from './distillation-unit';
import { getDistillationHeartbeatConfig, DistillationHeartbeatConfig } from './distillation-heartbeat-config';
import type { ExternalHistoryMode } from './distillation-heartbeat-config';
import { LearningEpisodeStore, LearningEpisode, buildLearningEpisodeCandidate } from './learning-episode';
import { SkillEvolutionRuntime, CapabilityTransitionKind } from './skill-evolution';
import { SkillUsageCurator } from './skill-usage-curator';
import type { GeneratedSkillLoadFact } from './skill-usage-ledger';
import { Logger } from './logger';
import { bootstrapSemanticReassessmentOnce } from './distilled-skill-bootstrap';
import { SemanticReassessmentManifestStore } from './semantic-reassessment';
import { cleanupBranchTranscripts } from './branch-transcript-retention';
import { createReviewBudget, type ReviewBudget } from './review-budget';
import { advanceJobsFairly } from './evidence-review-engine';
import { listRunnableQuanta } from './evidence-review-graph-core';
import { XurlExternalSourceReader } from './xurl-session-log-source';
import { buildXurlSubprocessEnv } from './xurl-subprocess-env';
import {
  ExternalAdmissionCoordinator,
  type ExternalEvidencePage,
  type ExternalAdmissionCommitResult,
} from './external-admission-coordinator';
import type {
  ExternalCatchUpAction,
  ExternalSourceWorkLane,
} from './external-source-work';
import {
  acquireExternalSourceProviderLock,
  type ExternalSourceProviderLock,
} from './external-source-provider-lock';
import {
  ExternalProviderOverrideStore,
  resolveExternalProviderOverridePath,
  type ProviderStatus,
} from './external-provider-controls';
import {
  buildExternalSourceDiagnosticSnapshot,
  isExternalSourceDiagnosticSnapshot,
  type ExternalSourceDiagnosticSnapshot,
} from './external-source-diagnostics';
import {
  InternalSessionLogSourceAdapter,
  ExternalSessionLogSourceAdapter,
  SessionLogSourceAdapter,
  SessionLogSourceReadContext,
  SessionLogSourceReport,
  SessionLogSourceResource,
  SessionLogSourceIdentity,
  SessionLogSourceReadResult,
  SourceEventIdentity,
  SourceWorkBudget,
  SourceFailureState,
  SessionLogSourceStatus,
  ExternalSourceFailureClass,
  ExternalSourceAdmissionConfiguration,
  ExternalSourceQuarantineEntry,
  ExternalSourceRecoveryAuditEntry,
  ExternalSourceTombstoneEntry,
  ExternalCursorState,
  buildExternalEventDedupKey,
  listExternalSourceQuarantines,
  loadExternalCursorState,
  resolveExternalCursorStorePath,
  finalizeExternalDiscoveryCycleForStore,
  saveExternalCursorState,
  classifyExternalSourceFailureMessage,
  redactExternalSourceDiagnostic,
  DEFAULT_EXTERNAL_SOURCE_BUDGET,
  DEFAULT_INTERNAL_SOURCE_BUDGET,
} from './session-log-source';
import {
  closeExternalSourceResourceWithAudit,
  completeExternalTombstoneReopen,
  findBlockingExternalSourceTombstone,
  listExternalSourceRecoveryAudit,
  listExternalSourceTombstones,
  prepareExternalTombstoneReopen,
  rebaselineExternalProviderWithRecovery,
  recordExternalTombstoneReopenTerminalExclusion,
  retryExternalSourceQuarantineWithAudit,
  skipExternalSourceQuarantineWithAudit,
} from './external-source-recovery';
import {
  BoundedSourceEvidence,
  EvidenceBundle,
  SkillEvolutionResult,
  SkillEvolutionQueueReviewResult,
  ReferencedSkillSnapshot,
  RelatedCurrentSkill,
  SkillEvidenceRef,
} from './skill-evolution';
import {
  migratePersistedEvidenceBundleAuthority,
} from './evidence-bundle-authority';
import {
  EvidenceCapsuleStore,
  buildEvidenceCapsule,
  redactExternalEvidenceContent,
  sanitizeExternalDistillationUnit,
} from './evidence-capsule';
import {
  ExternalSessionLogBackfillRequest,
  ExternalSessionLogBackfillIngestContext,
  ExternalSessionLogBackfillMetrics,
  ExternalSessionLogBackfillRunResult,
  ExternalSessionLogBackfillService,
  ExternalSessionLogBackfillSource,
  ExternalSessionLogBackfillState,
  ExternalHistoryProgressUpdate,
  loadExternalSessionLogBackfillState,
} from './session-log-backfill';
import {
  buildEpisodeEvidenceBundle,
  buildEpisodeSettlementEvidence,
  MissingLearningEpisodeSourceEvidenceError,
} from './episode-evidence-bundle';
import {
  ExternalEpisodeProvenanceStore,
  type ExternalEpisodeProvenanceState,
} from './external-episode-provenance-store';

// Re-export types used by callers (preserved public API from the former tail imports)
export type {
  EvidenceBundle,
  SkillEvolutionResult,
  SkillEvolutionQueueReviewResult,
  BoundedSourceEvidence,
  ReferencedSkillSnapshot,
  RelatedCurrentSkill,
  SkillEvidenceRef,
};
// Re-export provenance state type (preserved public API from former inline definition)
export type { ExternalEpisodeProvenanceState };

// ---------------------------------------------------------------------------
// Public API: wake context / reports (shared with the heartbeat scheduler)
// ---------------------------------------------------------------------------

export type RuntimeLearningReason =
  | 'startup'
  | 'scheduled'
  | 'session-log-append'
  | 'settlement-deadline'
  | 'operational-retry'
  | 'curator'
  | 'semantic-reassessment'
  | 'manual'
  /**
   * Coalesced follow-up when external discovery stopped only because a bounded
   * wake slice reached quota / page boundary while durable continuation remains.
   */
  | 'external-continuation';

export type RuntimeLearningStageStatus = 'succeeded' | 'failed' | 'skipped';

export type RuntimeLearningHeartbeatRunStatus =
  | 'succeeded'
  | 'failed'
  | 'quiet'
  | 'coalesced'
  | 'timed_out'
  | 'queued_operational_retry'
  | 'drained';

export interface RuntimeLearningHeartbeatOwner {
  pid: number;
  generation: string;
  startedAt: string;
  lastHeartbeatAt?: string;
}

export interface RuntimeLearningBacklogSnapshot {
  eligibleEpisodes: number;
  reviewContinuationEpisodes: number;
  operationalReviews: number;
  lagMs: number;
}

export interface RuntimeLearningDiscoveryReport {
  scanned: boolean;
  filesScanned: number;
  unitsProcessed: number;
  advancedFiles: number;
  /** Per-source reports for observable source progress and status (issue #75). */
  sources: readonly SessionLogSourceReport[];
}

export interface RuntimeLearningIngestionReport {
  admittedEpisodes: number;
  contradictionSignals: number;
}

export interface RuntimeLearningMaturationReport {
  status: RuntimeLearningStageStatus;
  errorMessage?: string;
  maturedEpisodes: number;
  becameEligible: number;
  becameContradicted: number;
}

export interface RuntimeLearningReviewReport {
  status: RuntimeLearningStageStatus;
  errorMessage?: string;
  reviewedEpisodes: number;
  reviewedQueueEntries: number;
  deferredQueueReviews: number;
  operationalQueueReviews: number;
  deferredRetries: number;
  operationalRetries: number;
  reviewTimeoutCount: number;
  reviewFailureCount: number;
  transitionsByKind: Partial<Record<CapabilityTransitionKind, number>>;
}

export interface RuntimeLearningCurationReport {
  status: RuntimeLearningStageStatus;
  errorMessage?: string;
  ran: boolean;
  expedited: boolean;
  transitionsByKind: Partial<Record<CapabilityTransitionKind, number>>;
}

export interface RuntimeLearningReassessmentReport {
  status: RuntimeLearningStageStatus;
  errorMessage?: string;
  discovered: number;
  completed: number;
  deferred: number;
  failed: number;
  transitionsByKind: Partial<Record<CapabilityTransitionKind, number>>;
}

export interface RuntimeLearningWakeReport {
  maturation: RuntimeLearningMaturationReport;
  review: RuntimeLearningReviewReport;
  curation: RuntimeLearningCurationReport;
}

export interface RuntimeLearningHeartbeatResult {
  /** Number of Distillation Units produced this cycle. */
  unitsProcessed: number;
  /** Number of session log files whose cursor advanced this cycle. */
  advancedFiles: number;
  /** Whether this cycle actually executed (vs. being skipped/guarded). */
  ran: boolean;
  /** Discovery-stage outcome for this wake. */
  discovery: RuntimeLearningDiscoveryReport;
  /** Durable admission-stage outcome for this wake. */
  ingestion: RuntimeLearningIngestionReport;
  /** Settlement/maturation outcome for this wake. */
  maturation: RuntimeLearningMaturationReport;
  /** Capability-learning review outcome for this wake. */
  review: RuntimeLearningReviewReport;
  /** Current-skill curation outcome for this wake. */
  curation: RuntimeLearningCurationReport;
  reassessment: RuntimeLearningReassessmentReport;
}

export interface RuntimeLearningHeartbeatRecord {
  schemaVersion: 1;
  /** ISO timestamp of the last heartbeat run. */
  lastRunAt: string;
  /** Monotonic count of heartbeat runs since record creation. */
  runCount: number;
  /** Last heartbeat status from the most recent wake cycle. */
  lastRunStatus: RuntimeLearningHeartbeatRunStatus;
  /** Last wake duration in milliseconds. */
  lastRunDurationMs: number;
  /** Reason of the last run. */
  lastReason: string;
  /** Distillation Units produced by the last run. */
  lastUnitsProcessed: number;
  /** Files whose cursor advanced on the last run. */
  lastAdvancedFiles: number;
  /** Reasons merged into the latest wake request. */
  lastPendingWakeReasons: RuntimeLearningReason[];
  /** Reasons durably queued by the scheduler but not yet consumed by a wake. */
  pendingWakeReasons: RuntimeLearningReason[];
  /** Review timeout count from the latest review phase. */
  lastReviewTimeoutCount: number;
  /** Review failure count from the latest review phase. */
  lastReviewFailureCount: number;
  cumulativeReviewTimeoutCount: number;
  cumulativeReviewFailureCount: number;
  inProgress?: {
    startedAt: string;
    reasons: RuntimeLearningReason[];
  };
  owner?: RuntimeLearningHeartbeatOwner;
  nextWakeAt?: string;
  nextWakeReason?: string;
  backlog: RuntimeLearningBacklogSnapshot;
  lastSourceReports: readonly SessionLogSourceReport[];
  externalSourceDiagnostics: ExternalSourceDiagnosticSnapshot;
}

export interface RuntimeLearningBackfillOperationPaths {
  stateFilePath: string;
  auditFilePath: string;
}

export interface RuntimeLearningBackfillResult {
  paths: RuntimeLearningBackfillOperationPaths;
  backfill: ExternalSessionLogBackfillRunResult;
  ingestion: RuntimeLearningIngestionReport;
  maturation: RuntimeLearningMaturationReport;
  review: RuntimeLearningReviewReport;
  /** True when shutdown requested a resumable stop between bounded slices. */
  drained: boolean;
}

// ---------------------------------------------------------------------------
// Construction options
// ---------------------------------------------------------------------------

/**
 * Wake-level discovery quotas. Bounds one discovery wake so it cannot
 * monopolize the heartbeat and starve overdue settlement/review. Defaults
 * are production-safe; tests inject smaller values.
 */
export interface DiscoveryWakeQuotas {
  /** Max resources (e.g. log files) examined across all sources in one wake. */
  maxResourcesPerWake: number;
  /** Max admitted Learning Episode candidates across all sources in one wake. */
  maxAdmittedEpisodesPerWake: number;
  /** Max wall-clock milliseconds spent in discovery in one wake. */
  maxDiscoveryMs: number;
}

/** Production defaults for wake-level discovery quotas. */
export const DEFAULT_DISCOVERY_WAKE_QUOTAS: DiscoveryWakeQuotas = {
  maxResourcesPerWake: 1000,
  maxAdmittedEpisodesPerWake: 200,
  maxDiscoveryMs: 60_000, // 60 s
};

interface ExternalSourceLaneIdentity {
  provider: string;
  sourceId: string;
}

interface ExternalResourceLaneIdentity extends ExternalSourceLaneIdentity {
  resourceRef: string;
}

function externalSourceLaneKey(identity: ExternalSourceLaneIdentity): string {
  return JSON.stringify([identity.provider, identity.sourceId]);
}

function externalAdmissionConfigurationsMatch(
  left: ExternalSourceAdmissionConfiguration,
  right: ExternalSourceAdmissionConfiguration,
): boolean {
  return left.historyMode === right.historyMode
    && left.scope === right.scope
    && left.scopePath === right.scopePath;
}

function parseExternalSourceLaneKey(key: string): ExternalSourceLaneIdentity | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (
      Array.isArray(parsed)
      && parsed.length === 2
      && typeof parsed[0] === 'string'
      && typeof parsed[1] === 'string'
    ) {
      return { provider: parsed[0], sourceId: parsed[1] };
    }
  } catch {
    // Legacy sourceId-only key.
  }
  return null;
}

function externalResourceLaneKey(identity: ExternalResourceLaneIdentity): string {
  return JSON.stringify([identity.provider, identity.sourceId, identity.resourceRef]);
}

function parseExternalResourceLaneKey(key: string): ExternalResourceLaneIdentity | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (
      Array.isArray(parsed)
      && parsed.length === 3
      && typeof parsed[0] === 'string'
      && typeof parsed[1] === 'string'
      && typeof parsed[2] === 'string'
    ) {
      return { provider: parsed[0], sourceId: parsed[1], resourceRef: parsed[2] };
    }
  } catch {
    // Invalid resource-lane key.
  }
  return null;
}

function isResourceLocalExternalFailure(state: SourceFailureState): boolean {
  return state.failureClass === 'transient'
    || state.failureClass === 'pending'
    || state.failureClass === 'quarantine';
}

function isProviderBlockingExternalFailure(
  failureClass: ExternalSourceFailureClass | undefined,
): boolean {
  return failureClass === 'protocol' || failureClass === 'integrity_conflict';
}

class DiscoveryAdmissionQuotaReachedError extends Error {
  constructor() {
    super('wake episode admission quota reached before source acknowledgement');
    this.name = 'DiscoveryAdmissionQuotaReachedError';
  }
}

function normalizeDiscoveryQuota(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

const EXTERNAL_BACKFILL_SLICE_RESOURCES = 10;
const EXTERNAL_BACKFILL_SLICE_BYTES = 2 * 1024 * 1024;
// A single xurl discovery/read pair is an external process boundary. Keep the
// cooperative slice bounded, but leave enough room for normal child-process
// startup and one bounded page under concurrent Runtime test/load conditions.
const EXTERNAL_BACKFILL_SLICE_MS = 5_000;
const REVIEW_CONTINUATION_SCHEMA_VERSION = 2;

type ReviewWorkClass = 'retry' | 'live' | 'historical';

const REVIEW_WORK_CLASS_ORDER: readonly ReviewWorkClass[] = [
  'retry',
  'live',
  'historical',
];

interface ReviewFairnessContinuation {
  nextClass: ReviewWorkClass;
  classCursors: Partial<Record<ReviewWorkClass, string>>;
}

interface ReviewContinuationState {
  schemaVersion: typeof REVIEW_CONTINUATION_SCHEMA_VERSION;
  episodeIds: string[];
  reviewJobIds: string[];
  nextAttemptAt: string;
  updatedAt: string;
  nextClass: ReviewWorkClass;
  classCursors: Partial<Record<ReviewWorkClass, string>>;
}

export interface RuntimeLearningOptions {
  /** Working directory for config resolution. */
  workingDirectory: string;
  /** Evidence Ingestor (derives and persists Learning Episodes from source). */
  evidenceIngestor: EvidenceIngestor;
  /** Durable Learning Episode store. */
  learningEpisodeStore: LearningEpisodeStore;
  /** V3 Branch Promotion Reviewer / transition writer. */
  skillEvolution: SkillEvolutionRuntime;
  /** V3 generated-skill curator (optional — null when not configured). */
  curator: SkillUsageCurator | null;
  /** Due Work Planner (deadline-aware scheduling). */
  planner: DueWorkPlanner;
  /**
   * Session Log Source adapters for source-neutral discovery. When omitted,
   * the RuntimeLearning module constructs a single Internal Session Log Source
   * adapter (the default production path). Tests may inject a fixture adapter
   * to feed canonical source events through the public wake() path.
   *
   * External sources are disabled by default (see config
   * `externalSessionLogSourcesEnabled`); an adapter that reports
   * `isEnabled() === false` is skipped during discovery.
   */
  sessionLogSources?: readonly SessionLogSourceAdapter[];
  /**
   * Production-safe wake-level caps for discovery (issue #51). Bounds the
   * number of resources examined, candidates (episodes) admitted, and wall-clock
   * time spent in one discovery wake so a large multi-source scan cannot starve
   * the subsequent overdue settlement/review stages. Remaining resources are
   * deferred to the next wake without falsely acknowledging their cursors.
   */
  discoveryQuotas?: Partial<DiscoveryWakeQuotas>;
  /**
   * Per-source work budget for external source lanes (issue #77). When set,
   * this budget is applied to every external source adapter. Each external
   * source enforces configurable resource, byte, and elapsed-time quotas per
   * wake so a single chatty or failing external source cannot starve internal
   * discovery or due settlement/review/retry work.
   *
   * Defaults to {@link DEFAULT_EXTERNAL_SOURCE_BUDGET} when omitted.
   */
  externalSourceBudget?: SourceWorkBudget;
  /** Per-source budget for the internal JSONL lane. */
  internalSourceBudget?: SourceWorkBudget;
  /**
   * Maximum concurrent external provider reads (issue #92). Defaults to
   * the config value (3, range 1–8). When set, overrides the config value.
   */
  externalSourceMaxConcurrency?: number;
  /** Injectable clock for tests. */
  clock?: () => Date;
}

// ---------------------------------------------------------------------------
// Empty / skipped report factories
// ---------------------------------------------------------------------------

function skippedMaturationReport(): RuntimeLearningMaturationReport {
  return {
    status: 'skipped',
    maturedEpisodes: 0,
    becameEligible: 0,
    becameContradicted: 0,
  };
}

function skippedReviewReport(): RuntimeLearningReviewReport {
  return {
    status: 'skipped',
    reviewedEpisodes: 0,
    reviewedQueueEntries: 0,
    deferredQueueReviews: 0,
    operationalQueueReviews: 0,
    deferredRetries: 0,
    operationalRetries: 0,
    reviewTimeoutCount: 0,
    reviewFailureCount: 0,
    transitionsByKind: {},
  };
}

function skippedCurationReport(): RuntimeLearningCurationReport {
  return {
    status: 'skipped',
    ran: false,
    expedited: false,
    transitionsByKind: {},
  };
}

function skippedReassessmentReport(): RuntimeLearningReassessmentReport {
  return { status: 'skipped', discovered: 0, completed: 0, deferred: 0, failed: 0, transitionsByKind: {} };
}

function mergeMaturationReports(
  first: RuntimeLearningMaturationReport,
  second: RuntimeLearningMaturationReport,
): RuntimeLearningMaturationReport {
  return {
    status: first.status === 'failed' || second.status === 'failed'
      ? 'failed'
      : (first.status === 'succeeded' || second.status === 'succeeded' ? 'succeeded' : 'skipped'),
    ...(first.errorMessage || second.errorMessage
      ? { errorMessage: [first.errorMessage, second.errorMessage].filter(Boolean).join('; ') }
      : {}),
    maturedEpisodes: first.maturedEpisodes + second.maturedEpisodes,
    becameEligible: first.becameEligible + second.becameEligible,
    becameContradicted: first.becameContradicted + second.becameContradicted,
  };
}

function mergeReviewReports(
  first: RuntimeLearningReviewReport,
  second: RuntimeLearningReviewReport,
): RuntimeLearningReviewReport {
  const transitionsByKind: Partial<Record<CapabilityTransitionKind, number>> = { ...first.transitionsByKind };
  for (const [kind, count] of Object.entries(second.transitionsByKind) as [CapabilityTransitionKind, number][]) {
    transitionsByKind[kind] = (transitionsByKind[kind] ?? 0) + count;
  }
  return {
    status: first.status === 'failed' || second.status === 'failed'
      ? 'failed'
      : (first.status === 'succeeded' || second.status === 'succeeded' ? 'succeeded' : 'skipped'),
    ...(first.errorMessage || second.errorMessage
      ? { errorMessage: [first.errorMessage, second.errorMessage].filter(Boolean).join('; ') }
      : {}),
    reviewedEpisodes: first.reviewedEpisodes + second.reviewedEpisodes,
    reviewedQueueEntries: first.reviewedQueueEntries + second.reviewedQueueEntries,
    deferredQueueReviews: first.deferredQueueReviews + second.deferredQueueReviews,
    operationalQueueReviews: first.operationalQueueReviews + second.operationalQueueReviews,
    deferredRetries: first.deferredRetries + second.deferredRetries,
    operationalRetries: first.operationalRetries + second.operationalRetries,
    reviewTimeoutCount: first.reviewTimeoutCount + second.reviewTimeoutCount,
    reviewFailureCount: first.reviewFailureCount + second.reviewFailureCount,
    transitionsByKind,
  };
}

function mergeSessionLogSourceReports(
  first: SessionLogSourceReport,
  second: SessionLogSourceReport,
): SessionLogSourceReport {
  const statusPriority: Record<NonNullable<SessionLogSourceReport['status']>, number> = {
    active: 0,
    drained: 1,
    quota_reached: 2,
    locked: 3,
    backoff: 4,
    failed: 5,
  };
  const firstStatus = first.status ?? 'active';
  const secondStatus = second.status ?? 'active';
  const status = statusPriority[firstStatus] >= statusPriority[secondStatus]
    ? firstStatus
    : secondStatus;
  return {
    ...first,
    ...second,
    enabled: first.enabled || second.enabled,
    resourcesDiscovered: first.resourcesDiscovered + second.resourcesDiscovered,
    unitsProcessed: first.unitsProcessed + second.unitsProcessed,
    advancedResources: first.advancedResources + second.advancedResources,
    status,
    accounting: {
      events: (first.accounting?.events ?? 0) + (second.accounting?.events ?? 0),
      bytes: (first.accounting?.bytes ?? 0) + (second.accounting?.bytes ?? 0),
      elapsedMs: (first.accounting?.elapsedMs ?? 0) + (second.accounting?.elapsedMs ?? 0),
    },
  };
}

function emptyHeartbeatResult(ran: boolean): RuntimeLearningHeartbeatResult {
  return {
    unitsProcessed: 0,
    advancedFiles: 0,
    ran,
    discovery: { scanned: false, filesScanned: 0, unitsProcessed: 0, advancedFiles: 0, sources: [] },
    ingestion: { admittedEpisodes: 0, contradictionSignals: 0 },
    maturation: skippedMaturationReport(),
    review: skippedReviewReport(),
    curation: skippedCurationReport(),
    reassessment: skippedReassessmentReport(),
  };
}

function emptyHeartbeatRecord(): RuntimeLearningHeartbeatRecord {
  return {
    schemaVersion: 1,
    lastRunAt: '',
    runCount: 0,
    lastRunStatus: 'quiet',
    lastRunDurationMs: 0,
    lastReason: 'manual',
    lastUnitsProcessed: 0,
    lastAdvancedFiles: 0,
    lastPendingWakeReasons: [],
    pendingWakeReasons: [],
    lastReviewTimeoutCount: 0,
    lastReviewFailureCount: 0,
    cumulativeReviewTimeoutCount: 0,
    cumulativeReviewFailureCount: 0,
    backlog: {
      eligibleEpisodes: 0,
      reviewContinuationEpisodes: 0,
      operationalReviews: 0,
      lagMs: 0,
    },
    lastSourceReports: [],
    externalSourceDiagnostics: {
      schemaVersion: 1,
      generatedAt: '',
      overallStatus: 'healthy',
      overallReadiness: 'ready',
      providers: [],
      activeCount: 0,
      activatingCount: 0,
      pausedCount: 0,
      activationBlockedCount: 0,
      failureCount: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// RuntimeLearning
// ---------------------------------------------------------------------------

/**
 * The single production background-learning entry point.
 *
 * Encoding: one deep module that owns ingestion, maturation, review, curation,
 * and wake coordination. The Distillation Heartbeat Scheduler is only a thin
 * wake-loop adapter; this class holds all the intelligence.
 */
export class RuntimeLearning {
  private readonly workingDirectory: string;
  private readonly evidenceIngestor: EvidenceIngestor;
  private readonly episodeStore: LearningEpisodeStore;
  private readonly skillEvolution: SkillEvolutionRuntime;
  private readonly curator: SkillUsageCurator | null;
  private readonly planner: DueWorkPlanner;
  private readonly clock: () => Date;
  private config: DistillationHeartbeatConfig;
  /**
   * Session log source adapters. The internal adapter is always first.
   * External adapters are built from the effective enabled provider set
   * (issue #91), resolved from environment defaults + durable overrides.
   */
  private sessionLogSources: readonly SessionLogSourceAdapter[];
  /** True only when RuntimeLearning owns adapters derived from production config. */
  private readonly managesConfiguredSessionLogSources: boolean;
  /** Runtime-local source pauses that must survive production lane refreshes. */
  private readonly disabledExternalSourceLanes = new Set<string>();
  /**
   * Durable per-provider override store (issue #91). Owns the online
   * enable/disable/reset/rebaseline operator surface.
   */
  private readonly providerOverrideStore: ExternalProviderOverrideStore;
  private readonly discoveryQuotas: DiscoveryWakeQuotas;
  /** Per-source work budgets; internal logs are never exempt from quotas. */
  private readonly externalSourceBudget: SourceWorkBudget;
  private readonly internalSourceBudget: SourceWorkBudget;
  /**
   * Per-lane failure tracking keyed by the opaque (provider, sourceId) tuple.
   * State is persisted to disk after each wake so restart recovery restores
   * lane due time, cursor, quota continuation, and backoff state.
   */
  private readonly externalSourceFailureState = new Map<string, SourceFailureState>();
  /** Independent transient/pending/quarantine gates for resources in one source. */
  private readonly externalResourceFailureState = new Map<string, SourceFailureState>();
  /** Prevent read-only/follower snapshots from rewriting another writer's state. */
  private externalSourceSchedulingStateDirty = false;
  /**
   * Path to the durable external source scheduling state file. Used for
   * restart recovery of per-source backoff/suspension state.
   */
  private readonly schedulingStatePath: string;
  /** Durable Evidence Capsule store for external evidence (issue #78). */
  private readonly evidenceCapsuleStore: EvidenceCapsuleStore;
  /**
   * The single External Admission Coordinator (issue #93) that serializes
   * durable admission of ready pages produced by external source work lanes.
   * Provider reads may overlap, but Episode, Capsule, provenance, and cursor
   * acknowledgement settle through this coordinator in fair, page-sized turns.
   */
  private readonly externalAdmissionCoordinator: ExternalAdmissionCoordinator;
  /** Durable provenance index tying external events to episode ids (issue #78). */
  private readonly externalEpisodeProvenanceStore: ExternalEpisodeProvenanceStore;

  private readonly activeWakeAbortControllers = new Set<AbortController>();
  /** Public wake results tracked separately so shutdown drain can await durable settlement. */
  private readonly activeWakeResults = new Set<Promise<RuntimeLearningHeartbeatResult>>();
  private readonly reviewContinuationPath: string;
  private stateWriterOwner: symbol | null = null;
  private stateWriterDepth = 0;
  private readonly stateWriterWaiters: Array<() => void> = [];
  /** Cooperative explicit-backfill operation tracked for scheduler drain. */
  private activeBackfill: Promise<RuntimeLearningBackfillResult> | null = null;
  private backfillDrainRequested = false;
  /** Shutdown drain stops new review admission without aborting already active review work. */
  private shutdownDrainRequested = false;
  /** Operator pause for external reads only; internal discovery/review remains live. */
  private externalSourceDrainRequested = false;
  /** Maximum concurrent external provider reads (issue #92). */
  private readonly externalSourceMaxConcurrency: number;
  /** Shared abort signal for the current external read phase. */
  private externalReadAbortController: AbortController | null = null;
  /** Provider-scoped child signals let disable cancel only the affected lane. */
  private readonly activeExternalReadAbortControllers = new Map<string, AbortController>();

  constructor(options: RuntimeLearningOptions) {
    this.workingDirectory = options.workingDirectory;
    this.evidenceIngestor = options.evidenceIngestor;
    this.episodeStore = options.learningEpisodeStore;
    this.skillEvolution = options.skillEvolution;
    this.curator = options.curator;
    this.planner = options.planner;
    this.clock = options.clock ?? (() => new Date());
    this.config = getDistillationHeartbeatConfig(this.workingDirectory);
    this.providerOverrideStore = new ExternalProviderOverrideStore({
      stateFilePath: resolveExternalProviderOverridePath(this.config),
      now: this.clock,
    });
    this.managesConfiguredSessionLogSources = options.sessionLogSources === undefined;
    this.sessionLogSources = options.sessionLogSources ?? [
      new InternalSessionLogSourceAdapter(this.config),
      ...this.buildConfiguredExternalSources(),
    ];
    this.discoveryQuotas = {
      maxResourcesPerWake: normalizeDiscoveryQuota(
        options.discoveryQuotas?.maxResourcesPerWake,
        DEFAULT_DISCOVERY_WAKE_QUOTAS.maxResourcesPerWake,
      ),
      maxAdmittedEpisodesPerWake: normalizeDiscoveryQuota(
        options.discoveryQuotas?.maxAdmittedEpisodesPerWake,
        DEFAULT_DISCOVERY_WAKE_QUOTAS.maxAdmittedEpisodesPerWake,
      ),
      maxDiscoveryMs: normalizeDiscoveryQuota(
        options.discoveryQuotas?.maxDiscoveryMs,
        DEFAULT_DISCOVERY_WAKE_QUOTAS.maxDiscoveryMs,
      ),
    };
    this.externalSourceBudget = options.externalSourceBudget ?? DEFAULT_EXTERNAL_SOURCE_BUDGET;
    this.internalSourceBudget = options.internalSourceBudget ?? DEFAULT_INTERNAL_SOURCE_BUDGET;
    this.externalSourceMaxConcurrency = clampConcurrency(
      options.externalSourceMaxConcurrency ?? this.config.externalSessionLogMaxConcurrency,
    );
    this.reviewContinuationPath = reviewContinuationPathForEpisodeStore(
      this.config.learningEpisodeStorePath,
    );
    this.schedulingStatePath = path.join(
      path.dirname(this.config.learningEpisodeStorePath),
      'external-source-scheduling-state.json',
    );
    const externalEpisodeProvenancePath = path.join(
      path.dirname(this.config.learningEpisodeStorePath),
      'external-source-provenance.json',
    );
    this.loadExternalSourceSchedulingState();
    for (const adapter of this.sessionLogSources) {
      if (adapter.identity.category !== 'external' || !adapter.getCursorStorePath?.()) continue;
      this.reconcileExternalSourceRecovery(adapter.identity.provider, adapter.identity.sourceId);
    }
    this.evidenceCapsuleStore = new EvidenceCapsuleStore(this.config.evidenceCapsulePath);
    this.externalEpisodeProvenanceStore = new ExternalEpisodeProvenanceStore({
      stateFilePath: externalEpisodeProvenancePath,
      corruptMarkerPath: `${externalEpisodeProvenancePath}.state-corrupt`,
      clock: this.clock,
    });
    this.externalAdmissionCoordinator = new ExternalAdmissionCoordinator({
      stateFilePath: path.join(
        path.dirname(this.config.learningEpisodeStorePath),
        'external-admission-coordinator-state.json',
      ),
      commitFn: (page) => this.commitExternalEvidencePage(page),
    });
  }

  /** Access the SkillEvolutionRuntime for registry/audit inspection. */
  getSkillEvolution(): SkillEvolutionRuntime {
    return this.skillEvolution;
  }

  /** The DueWorkPlanner for scheduling computations. */
  getPlanner(): DueWorkPlanner {
    return this.planner;
  }

  /** Heartbeat config used by the thin scheduler for timer computation. */
  getConfig(): DistillationHeartbeatConfig {
    return this.config;
  }

  /** Learning Episode store for inspection/testing. */
  getEpisodeStore(): LearningEpisodeStore {
    return this.episodeStore;
  }

  /** Skill Usage Curator for inspection/testing. */
  getCurator(): SkillUsageCurator | null {
    return this.curator;
  }

  /** Session Log Source adapters for source-neutral discovery (issue #75). */
  getSessionLogSources(): readonly SessionLogSourceAdapter[] {
    return this.sessionLogSources;
  }

  /**
   * Apply external-source settings written by a connected control surface
   * without rebuilding the writable Runtime owner. Only external settings are
   * refreshed; paths and the rest of the heartbeat generation stay immutable.
   */
  reloadExternalHistoryConfiguration(expectedWorkingDirectory = this.workingDirectory): boolean {
    if (
      !this.managesConfiguredSessionLogSources
      || path.resolve(expectedWorkingDirectory) !== path.resolve(this.workingDirectory)
    ) return false;

    const latest = getDistillationHeartbeatConfig(this.workingDirectory);
    this.config = {
      ...this.config,
      externalSessionLogSourcesEnabled: latest.externalSessionLogSourcesEnabled,
      externalSessionLogEnabledProviders: latest.externalSessionLogEnabledProviders,
      externalSessionLogSelectedProvider: latest.externalSessionLogSelectedProvider,
      externalSessionLogSelectedSourceId: latest.externalSessionLogSelectedSourceId,
      externalSessionLogXurlCommand: latest.externalSessionLogXurlCommand,
      externalSessionLogHistoryMode: latest.externalSessionLogHistoryMode,
      externalSessionLogHistoryModeDiagnostic: latest.externalSessionLogHistoryModeDiagnostic,
    };

    const enabledProviders = new Set(
      this.providerOverrideStore.resolveEnabledProviders(this.config),
    );
    for (const [key, controller] of this.activeExternalReadAbortControllers) {
      const identity = parseExternalSourceLaneKey(key);
      if (identity && !enabledProviders.has(identity.provider)) controller.abort();
    }
    this.reconcileProviderLanes();
    return true;
  }

  /**
   * External source failure state (issue #77). Returns a snapshot of the
   * current per-source failure tracking for inspection/testing.
   */
  getExternalSourceFailureState(): ReadonlyMap<string, SourceFailureState> {
    const entries = [...this.externalSourceFailureState.entries()]
      .map(([key, state]) => ({ key, state, identity: parseExternalSourceLaneKey(key) }))
      .filter((entry): entry is { key: string; state: SourceFailureState; identity: ExternalSourceLaneIdentity } => (
        entry.identity !== null
      ));
    const sourceIdCounts = new Map<string, number>();
    for (const entry of entries) {
      sourceIdCounts.set(
        entry.identity.sourceId,
        (sourceIdCounts.get(entry.identity.sourceId) ?? 0) + 1,
      );
    }
    const snapshot = new Map<string, SourceFailureState>();
    for (const entry of entries) {
      const key = sourceIdCounts.get(entry.identity.sourceId) === 1
        ? entry.identity.sourceId
        : entry.key;
      snapshot.set(key, entry.state);
    }
    return snapshot;
  }

  getExternalSourceFailure(
    provider: string,
    sourceId: string,
  ): SourceFailureState | undefined {
    return this.externalSourceFailureState.get(externalSourceLaneKey({ provider, sourceId }));
  }

  /** Durable resource-local gates for operator diagnostics and deterministic tests. */
  getExternalResourceFailureState(
    provider: string,
    sourceId: string,
  ): ReadonlyMap<string, SourceFailureState> {
    const snapshot = new Map<string, SourceFailureState>();
    for (const [key, state] of this.externalResourceFailureState) {
      const identity = parseExternalResourceLaneKey(key);
      if (identity?.provider === provider && identity.sourceId === sourceId) {
        snapshot.set(identity.resourceRef, state);
      }
    }
    return snapshot;
  }

  /** External source work budget (issue #77). */
  getExternalSourceBudget(): SourceWorkBudget {
    return { ...this.externalSourceBudget };
  }

  /** Evidence Capsule store for external evidence inspection/testing (issue #78). */
  getEvidenceCapsuleStore(): EvidenceCapsuleStore {
    return this.evidenceCapsuleStore;
  }

  /**
   * The single External Admission Coordinator (issue #93). All external
   * Episode, Capsule, provenance, and cursor mutations pass through this
   * coordinator. Tests can inspect it to verify single-writer behavior,
   * fair round-robin order, backfill arbitration, and deadline drain.
   */
  getExternalAdmissionCoordinator(): ExternalAdmissionCoordinator {
    return this.externalAdmissionCoordinator;
  }

  listExternalSourceQuarantines(provider: string, sourceId: string): readonly ExternalSourceQuarantineEntry[] {
    return listExternalSourceQuarantines(this.externalCursorStorePath(provider, sourceId));
  }

  listExternalSourceTombstones(provider: string, sourceId: string): readonly ExternalSourceTombstoneEntry[] {
    return listExternalSourceTombstones(this.externalCursorStorePath(provider, sourceId));
  }

  listExternalSourceRecoveryAudit(provider: string, sourceId: string): readonly ExternalSourceRecoveryAuditEntry[] {
    return listExternalSourceRecoveryAudit(this.externalCursorStorePath(provider, sourceId));
  }

  retryExternalSourceQuarantine(provider: string, sourceId: string, quarantineId: string): boolean {
    const mutation = this.runExternalSourceMutation(provider, sourceId, 'quarantine-retry', () => {
      const changed = retryExternalSourceQuarantineWithAudit(
        this.externalCursorStorePath(provider, sourceId),
        provider,
        sourceId,
        quarantineId,
        this.clock(),
      );
      if (changed) this.reconcileExternalSourceRecovery(provider, sourceId);
      return changed;
    });
    return mutation.acquired ? mutation.value : false;
  }

  /** Retry all durable safety gates for one provider without skipping evidence. */
  retryExternalProviderRecovery(provider: string): {
    quarantinesRetried: number;
    sourceFailuresRetried: number;
  } {
    const normalizedProvider = provider.trim().toLowerCase();
    const sourceIds = new Set(
      this.sessionLogSources
        .filter(source => (
          source.identity.category === 'external'
          && source.identity.provider === normalizedProvider
        ))
        .map(source => source.identity.sourceId),
    );
    for (const key of this.externalSourceFailureState.keys()) {
      const identity = parseExternalSourceLaneKey(key);
      if (identity?.provider === normalizedProvider) sourceIds.add(identity.sourceId);
    }
    if (sourceIds.size === 0) sourceIds.add(`external-${normalizedProvider}`);

    let quarantinesRetried = 0;
    let sourceFailuresRetried = 0;
    for (const sourceId of sourceIds) {
      const quarantines = this.listExternalSourceQuarantines(normalizedProvider, sourceId);
      for (const quarantine of quarantines) {
        if (this.retryExternalSourceQuarantine(
          normalizedProvider,
          sourceId,
          quarantine.quarantineId,
        )) quarantinesRetried++;
      }
      if (this.retryExternalSourceFailure(normalizedProvider, sourceId)) {
        sourceFailuresRetried++;
      }
    }
    return { quarantinesRetried, sourceFailuresRetried };
  }

  skipExternalSourceQuarantine(
    provider: string,
    sourceId: string,
    quarantineId: string,
    reason = 'operator skip',
  ): boolean {
    const mutation = this.runExternalSourceMutation(provider, sourceId, 'quarantine-skip', () => {
      const changed = skipExternalSourceQuarantineWithAudit(
        this.externalCursorStorePath(provider, sourceId),
        provider,
        sourceId,
        quarantineId,
        reason,
        this.clock(),
      );
      if (changed) this.reconcileExternalSourceRecovery(provider, sourceId);
      return changed;
    });
    return mutation.acquired ? mutation.value : false;
  }

  /** Retry a source-level protocol/integrity failure after operator repair. */
  retryExternalSourceFailure(provider: string, sourceId: string): boolean {
    const mutation = this.runExternalSourceMutation(provider, sourceId, 'source-failure-retry', () => {
      const current = this.getExternalSourceFailure(provider, sourceId);
      if (!current?.requiresOperatorAction) return false;
      if (this.listExternalSourceQuarantines(provider, sourceId).length > 0) return false;
      this.clearExternalResourceFailures(provider, sourceId);
      this.clearExternalSourceFailureGate(provider, sourceId);
      this.saveExternalSourceSchedulingState();
      return true;
    });
    return mutation.acquired ? mutation.value : false;
  }

  /**
   * Close an external resource locally after the operator confirms the
   * upstream resource has been deleted. Preserves the cursor, Capsules,
   * Episodes, Capabilities, and Transition Audits for the closed resource
   * (issue #87).
   */
  deleteExternalSourceResource(provider: string, sourceId: string, resourceRef: string): boolean {
    return this.closeExternalSourceResource(provider, sourceId, resourceRef, 'deleted');
  }

  /**
   * Close an external resource locally after the operator confirms the
   * upstream resource has been archived. Preserves the cursor and all local
   * evidence (issue #87).
   */
  archiveExternalSourceResource(provider: string, sourceId: string, resourceRef: string): boolean {
    return this.closeExternalSourceResource(provider, sourceId, resourceRef, 'archived');
  }

  private closeExternalSourceResource(
    provider: string,
    sourceId: string,
    resourceRef: string,
    reason: 'deleted' | 'archived',
  ): boolean {
    const mutation = this.runExternalSourceMutation(provider, sourceId, `resource-${reason}`, () => (
      closeExternalSourceResourceWithAudit(
        this.externalCursorStorePath(provider, sourceId),
        provider,
        sourceId,
        resourceRef,
        reason,
        this.clock(),
      )
    ));
    if (!mutation.acquired || !mutation.value.changed) return false;
    for (const targetId of mutation.value.historicalTargetIds) {
      this.episodeStore.abandonHistoricalTarget(targetId);
    }
    return true;
  }

  /**
   * Advance external discovery observations without inferring deletion from
   * absence. Explicit delete/archive commands own the `closed` transition.
   */
  finalizeExternalDiscoveryCycle(provider: string, sourceId: string, cycle: number): ExternalCursorState {
    const mutation = this.runExternalSourceMutation(provider, sourceId, 'resource-finalize', () => (
      finalizeExternalDiscoveryCycleForStore(this.externalCursorStorePath(provider, sourceId), cycle)
    ));
    if (!mutation.acquired) throw new Error(`external source provider lock is busy for ${provider}`);
    return mutation.value;
  }

  /**
   * Request a graceful drain of external source reads (issue #87). Stops new
   * external reads on the next wake but leaves unacknowledged work resumable —
   * cursors are not advanced for resources that were examined but not
   * acknowledged. Internal heartbeat work continues independently.
   */
  requestExternalSourceDrain(): void {
    this.externalSourceDrainRequested = true;
    // Abort any in-flight external reads so they stop promptly (issue #92).
    if (this.externalReadAbortController) {
      this.externalReadAbortController.abort();
    }
  }

  /**
   * Resume external source reads after a drain or clear a drain request before
   * it takes effect (issue #87).
   */
  resumeExternalSourceReads(): void {
    this.externalSourceDrainRequested = false;
  }

  /**
   * Reversibly disable external ingestion without deleting source state or
   * local evidence (issue #87). The adapter is disabled at the session-log-source
   * layer so discovery skips it, but all durable cursor/quarantine/tombstone/
   * capsule state is preserved for re-enablement.
   */
  disableExternalSource(provider: string, sourceId: string): boolean {
    const adapter = this.findExternalSourceAdapter(provider, sourceId);
    if (!adapter?.setEnabled) return false;
    adapter.setEnabled(false);
    this.activeExternalReadAbortControllers
      .get(externalSourceLaneKey({ provider, sourceId }))
      ?.abort();
    this.disabledExternalSourceLanes.add(externalSourceLaneKey({ provider, sourceId }));
    return true;
  }

  /**
   * Re-enable a previously disabled external source (issue #87). Restores the
   * adapter's enabled flag; durable state was preserved during disablement.
   */
  enableExternalSource(provider: string, sourceId: string): boolean {
    const adapter = this.findExternalSourceAdapter(provider, sourceId);
    if (!adapter?.setEnabled) return false;
    adapter.setEnabled(true);
    this.disabledExternalSourceLanes.delete(externalSourceLaneKey({ provider, sourceId }));
    return true;
  }

  // -----------------------------------------------------------------------
  // Multi-provider operator surface (issue #91)
  // -----------------------------------------------------------------------

  /**
   * Get the durable provider override store for testing/CLI access.
   */
  getProviderOverrideStore(): ExternalProviderOverrideStore {
    return this.providerOverrideStore;
  }

  /**
   * Enable a provider through the durable override store and lazily create
   * its source lane if it was previously unseen. Creates a durable override
   * that takes precedence over the environment default and survives restart.
   */
  enableExternalProvider(
    provider: string,
    scope?: { scope: 'global' | 'path'; scopePath?: string },
    historyMode?: ExternalHistoryMode,
  ): void {
    this.providerOverrideStore.enableProvider(provider, scope, historyMode);
    this.reconcileProviderLanes();
  }

  /** Switch an enabled provider's durable history policy at a wake boundary. */
  setExternalProviderHistoryMode(provider: string, historyMode: ExternalHistoryMode): void {
    if (!this.providerOverrideStore.isProviderEnabled(provider, this.config)) {
      throw new Error(`external provider is not enabled: ${provider}`);
    }
    this.providerOverrideStore.setProviderHistoryMode(provider, historyMode);
    this.reconcileProviderLanes();
  }

  /**
   * Disable a provider through the durable override store. Pauses new
   * admission without deleting cursor, evidence, quarantine, or audit state.
   */
  disableExternalProvider(provider: string): void {
    for (const [key, controller] of this.activeExternalReadAbortControllers) {
      if (parseExternalSourceLaneKey(key)?.provider === provider) controller.abort();
    }
    this.providerOverrideStore.disableProvider(provider);
    this.reconcileProviderLanes();
  }

  /**
   * Reset a provider: remove the durable override and return to the
   * environment startup default.
   */
  resetExternalProvider(provider: string): void {
    this.providerOverrideStore.resetProvider(provider);
    this.reconcileProviderLanes();
  }

  /**
   * Explicit rebaseline: record an operator audit entry and mark the
   * rebaseline request. The actual watermark advance happens at the next
   * Runtime scheduling boundary.
   */
  rebaselineExternalProvider(provider: string, skipToNow: boolean): void {
    const normalizedProvider = provider.trim().toLowerCase();
    const providerAdapters = this.sessionLogSources.filter(adapter => (
      adapter.identity.category === 'external'
      && adapter.identity.provider === normalizedProvider
    ));
    const historyMode = this.providerOverrideStore
      .getProviderHistoryMode(normalizedProvider, this.config)
      .mode;
    rebaselineExternalProviderWithRecovery({
      provider: normalizedProvider,
      skipToNow,
      historyMode,
      sources: providerAdapters,
      lockRoot: this.externalSourceLockRoot(),
      episodeStore: this.episodeStore,
      recordProviderAudit: () => {
        this.providerOverrideStore.rebaselineProvider(normalizedProvider, skipToNow);
      },
      now: this.clock,
    });
  }

  /**
   * Get observable provider statuses for all known providers (environment
   * defaults plus durable overrides). Used by CLI and Dashboard.
   */
  getExternalProviderStatuses(): readonly ProviderStatus[] {
    return this.providerOverrideStore.getAllProviderStatuses(this.config);
  }

  /**
   * Rebuild the session log source list from the effective enabled provider
   * set. This handles lazy lane creation when a previously unseen provider
   * is enabled online, and removal of disabled providers from the active set.
   */
  private reconcileProviderLanes(): void {
    if (!this.managesConfiguredSessionLogSources) return;
    const internal = this.sessionLogSources.filter(
      adapter => adapter.identity.category === 'internal',
    );
    const external = this.buildConfiguredExternalSources();
    for (const adapter of external) {
      if (this.disabledExternalSourceLanes.has(externalSourceLaneKey(adapter.identity))) {
        adapter.setEnabled?.(false);
      }
    }
    this.sessionLogSources = [...internal, ...external];
  }

  private findExternalSourceAdapter(
    provider: string,
    sourceId: string,
  ): SessionLogSourceAdapter | undefined {
    return this.sessionLogSources.find(
      adapter => adapter.identity.category === 'external'
        && adapter.identity.provider === provider
        && adapter.identity.sourceId === sourceId,
    );
  }

  private isExternalReadConfigurationCurrent(adapter: SessionLogSourceAdapter): boolean {
    if (!adapter.isEnabled()) return false;
    if (!this.managesConfiguredSessionLogSources) return true;
    const expected = adapter.getExternalAdmissionConfiguration?.();
    if (!expected) return false;
    const provider = adapter.identity.provider;
    if (!this.providerOverrideStore.isProviderEnabled(provider, this.config)) return false;
    const currentScope = this.providerOverrideStore.getProviderScope(provider);
    const currentHistoryMode = this.providerOverrideStore.getProviderHistoryMode(provider, this.config).mode;
    return externalAdmissionConfigurationsMatch(expected, {
      historyMode: currentHistoryMode,
      scope: currentScope.scope,
      ...(currentScope.scopePath ? { scopePath: currentScope.scopePath } : {}),
    });
  }

  private shouldDiscardExternalReadyWork(
    adapter: SessionLogSourceAdapter,
    signal?: AbortSignal,
  ): boolean {
    return signal?.aborted === true
      || this.shutdownDrainRequested
      || this.externalSourceDrainRequested
      || !this.isExternalReadConfigurationCurrent(adapter);
  }

  private externalCursorStorePath(provider: string, sourceId: string): string {
    return this.findExternalSourceAdapter(provider, sourceId)?.getCursorStorePath?.()
      ?? resolveExternalCursorStorePath({ provider, sourceId });
  }

  private runExternalSourceMutation<T>(
    provider: string,
    sourceId: string,
    operation: string,
    work: () => T,
  ): { acquired: true; value: T } | { acquired: false } {
    const providerLock = this.acquireExternalProviderLock(provider, operation, sourceId);
    if (!providerLock.acquired) return { acquired: false };
    try {
      return { acquired: true, value: work() };
    } finally {
      providerLock.release();
    }
  }

  private reconcileExternalSourceRecovery(provider: string, sourceId: string): void {
    const remaining = this.listExternalSourceQuarantines(provider, sourceId);
    const remainingResourceRefs = new Set(remaining.map(entry => entry.resourceRef));
    this.clearExternalResourceFailures(
      provider,
      sourceId,
      (state, resourceRef) => (
        state.failureClass === 'quarantine'
        && !remainingResourceRefs.has(resourceRef)
      ),
    );
    if (remaining.length > 0) {
      const current = this.getExternalSourceFailure(provider, sourceId);
      const first = remaining[0]!;
      const state: SourceFailureState = {
        consecutiveFailures: current?.consecutiveFailures ?? 1,
        lastFailedAt: current?.lastFailedAt ?? first.detectedAt,
        lastError: first.message,
        suspendedUntil: null,
        failureClass: first.failureClass,
        nextRetryAt: null,
        requiresOperatorAction: true,
        resourceRef: first.resourceRef,
        eventId: first.identity.eventId,
        lastAttemptedAt: current?.lastAttemptedAt ?? first.detectedAt,
        lastSuccessfulReadAt: current?.lastSuccessfulReadAt ?? null,
      };
      if (first.failureClass === 'quarantine') {
        this.setExternalResourceFailure(provider, sourceId, first.resourceRef, state);
      }
      this.setExternalSourceFailure(provider, sourceId, state);
    } else {
      const remainingFailures = [...this.listExternalResourceFailures(provider, sourceId)]
        .sort((left, right) => (left.lastFailedAt ?? '').localeCompare(right.lastFailedAt ?? ''));
      const representative = remainingFailures[remainingFailures.length - 1];
      if (representative) {
        this.setExternalSourceFailure(provider, sourceId, representative);
      } else {
        const current = this.getExternalSourceFailure(provider, sourceId);
        const cursorBackedRecoveryGate = current?.resourceRef
          && current.eventId
          && (
            current.failureClass === 'quarantine'
            || current.failureClass === 'integrity_conflict'
          );
        if (!cursorBackedRecoveryGate) return;
        this.clearExternalSourceFailureGate(provider, sourceId);
      }
    }
    this.saveExternalSourceSchedulingState();
  }

  private setExternalSourceFailure(
    provider: string,
    sourceId: string,
    state: SourceFailureState,
  ): void {
    this.externalSourceSchedulingStateDirty = true;
    this.externalSourceFailureState.set(externalSourceLaneKey({ provider, sourceId }), state);
  }

  private getExternalResourceFailure(
    provider: string,
    sourceId: string,
    resourceRef: string,
  ): SourceFailureState | undefined {
    return this.externalResourceFailureState.get(externalResourceLaneKey({
      provider,
      sourceId,
      resourceRef,
    }));
  }

  private setExternalResourceFailure(
    provider: string,
    sourceId: string,
    resourceRef: string,
    state: SourceFailureState,
  ): void {
    this.externalSourceSchedulingStateDirty = true;
    this.externalResourceFailureState.set(externalResourceLaneKey({
      provider,
      sourceId,
      resourceRef,
    }), state);
  }

  private listExternalResourceFailures(
    provider: string,
    sourceId: string,
  ): readonly SourceFailureState[] {
    return [...this.getExternalResourceFailureState(provider, sourceId).values()];
  }

  private clearExternalResourceFailures(
    provider: string,
    sourceId: string,
    predicate: (state: SourceFailureState, resourceRef: string) => boolean = () => true,
  ): void {
    for (const key of this.externalResourceFailureState.keys()) {
      const identity = parseExternalResourceLaneKey(key);
      if (identity?.provider !== provider || identity.sourceId !== sourceId) continue;
      const state = this.externalResourceFailureState.get(key);
      if (!state || !predicate(state, identity.resourceRef)) continue;
      this.externalResourceFailureState.delete(key);
      this.externalSourceSchedulingStateDirty = true;
    }
  }

  private clearExternalSourceFailureGate(provider: string, sourceId: string): void {
    const current = this.getExternalSourceFailure(provider, sourceId);
    if (!current) return;
    this.setExternalSourceFailure(provider, sourceId, {
      consecutiveFailures: 0,
      lastFailedAt: null,
      lastError: null,
      suspendedUntil: null,
      failureClass: undefined,
      nextRetryAt: null,
      requiresOperatorAction: false,
      resourceRef: undefined,
      eventId: undefined,
      lastAttemptedAt: current.lastAttemptedAt ?? null,
      lastSuccessfulReadAt: current.lastSuccessfulReadAt ?? null,
    });
  }

  /**
   * Build external source adapters from the effective enabled provider set
   * (issue #91). Uses the durable override store to resolve which providers
   * are enabled, then creates one adapter per provider.
   *
   * Until bounded concurrent scheduling is delivered (#92), this slice may
   * process providers serially; the adapters are still constructed independently.
   */
  private buildConfiguredExternalSources(): readonly SessionLogSourceAdapter[] {
    if (!this.config.externalSessionLogSourcesEnabled) return [];
    const enabledProviders = this.providerOverrideStore.resolveEnabledProviders(this.config);
    if (enabledProviders.length === 0) return [];
    const adapters: ExternalSessionLogSourceAdapter[] = [];
    const legacySelectedProvider = this.config.externalSessionLogSelectedProvider?.trim().toLowerCase();
    const legacySelectedSourceId = this.config.externalSessionLogSelectedSourceId?.trim();
    for (const provider of enabledProviders) {
      const sourceId = enabledProviders.length === 1
        && legacySelectedProvider
        && legacySelectedProvider === provider
        && legacySelectedSourceId
        ? legacySelectedSourceId
        : `external-${provider}`;
      const scope = this.providerOverrideStore.getProviderScope(provider);
      const history = this.providerOverrideStore.getProviderHistoryMode(provider, this.config);
      const reader = this.config.externalSessionLogXurlCommand
        ? new XurlExternalSourceReader({
          command: this.config.externalSessionLogXurlCommand,
          provider,
          sourceId,
          scope: scope.scope,
          scopePath: scope.scopePath,
          // Least-privilege env: xurl subprocesses receive only OS essentials,
          // never unrelated model/CatsCo secrets or parent-only XiaoBa config.
          env: buildXurlSubprocessEnv(),
        })
        : undefined;
      adapters.push(new ExternalSessionLogSourceAdapter({
        sourceId,
        label: `${provider} Session Logs`,
        provider,
        reader,
        enabled: true,
        scope,
        historyMode: history.mode,
        now: this.clock,
      }));
    }
    return adapters;
  }

  private externalSourceLockRoot(): string {
    return path.dirname(this.config.learningEpisodeStorePath);
  }

  private acquireExternalProviderLock(provider: string, operation: string, sourceId?: string) {
    return acquireExternalSourceProviderLock({
      runtimeRoot: this.externalSourceLockRoot(),
      provider,
      operation,
      sourceId,
      now: this.clock,
    });
  }

  /**
   * Explicitly restore a quarantined provenance index from a verified backup.
   * Recovery is never implicit because an empty replacement could misclassify
   * already-admitted external episodes as internal evidence.
   */
  recoverExternalEpisodeProvenanceState(state: ExternalEpisodeProvenanceState): void {
    this.externalEpisodeProvenanceStore.recover(state);
  }

  private async withStateWriter<T>(owner: symbol, work: () => Promise<T>): Promise<T> {
    await this.acquireStateWriter(owner);
    try {
      return await work();
    } finally {
      this.releaseStateWriter(owner);
    }
  }

  private async acquireStateWriter(owner: symbol): Promise<void> {
    if (this.stateWriterOwner === owner) {
      this.stateWriterDepth += 1;
      return;
    }
    if (!this.stateWriterOwner) {
      this.stateWriterOwner = owner;
      this.stateWriterDepth = 1;
      return;
    }
    await new Promise<void>(resolve => {
      this.stateWriterWaiters.push(() => {
        this.stateWriterOwner = owner;
        this.stateWriterDepth = 1;
        resolve();
      });
    });
  }

  private releaseStateWriter(owner: symbol): void {
    if (this.stateWriterOwner !== owner) {
      throw new Error('runtime learning state writer released by a non-owner');
    }
    this.stateWriterDepth -= 1;
    if (this.stateWriterDepth > 0) return;
    const next = this.stateWriterWaiters.shift();
    if (next) {
      next();
      return;
    }
    this.stateWriterOwner = null;
  }

  /** Deterministic state/audit paths for one explicit external backfill operation. */
  getExternalBackfillOperationPaths(
    request: Pick<ExternalSessionLogBackfillRequest, 'provider' | 'sourceId' | 'operationId'>,
  ): RuntimeLearningBackfillOperationPaths {
    const backfillRoot = path.join(
      path.dirname(this.config.learningEpisodeStorePath),
      'external-session-log-backfills',
      toStablePathComponent(request.provider),
      toStablePathComponent(request.sourceId),
    );
    const operationStem = toStablePathComponent(request.operationId);
    return {
      stateFilePath: path.join(backfillRoot, `${operationStem}.state.json`),
      auditFilePath: path.join(backfillRoot, `${operationStem}.audit.jsonl`),
    };
  }

  /**
   * Explicit operator-triggered backfill for a bounded external source range.
   * This is intentionally separate from normal wake/provider enablement.
   */
  async runExternalBackfill(
    request: ExternalSessionLogBackfillRequest,
    source: ExternalSessionLogBackfillSource,
    options: { onProgress?: (progress: ExternalHistoryProgressUpdate) => void } = {},
  ): Promise<RuntimeLearningBackfillResult> {
    if (this.activeBackfill) {
      throw new Error('another external backfill operation is already active');
    }
    const writerOwner = Symbol('runtime-learning-external-backfill');
    const operation = Promise.resolve().then(
      () => this.withStateWriter(writerOwner, () => this.executeExternalBackfill(request, source, writerOwner, options)),
    );
    this.activeBackfill = operation;
    try {
      return await operation;
    } finally {
      if (this.activeBackfill === operation) this.activeBackfill = null;
      this.backfillDrainRequested = false;
      if (this.activeWakeAbortControllers.size === 0) {
        this.shutdownDrainRequested = false;
      }
    }
  }

  /**
   * Ask an active backfill to stop after its current bounded slice. The
   * persisted operation remains resumable on the next explicit invocation.
   */
  async drain(timeoutMs = this.config.skillEvolutionReviewAttemptDeadlineMinutes * 60_000): Promise<void> {
    this.shutdownDrainRequested = true;
    this.backfillDrainRequested = true;
    this.externalReadAbortController?.abort();
    for (const source of this.sessionLogSources) source.close?.();
    const active = this.activeBackfill;
    const activeWakes = [...this.activeWakeResults];
    if (!active && activeWakes.length === 0) {
      this.backfillDrainRequested = false;
      if (this.activeWakeAbortControllers.size === 0) {
        this.shutdownDrainRequested = false;
      }
      return;
    }
    let timer: NodeJS.Timeout | null = null;
    const settling = Promise.allSettled([
      ...(active ? [active] : []),
      ...activeWakes,
    ]).then(() => undefined);
    await Promise.race([
      settling.finally(() => {
        if (timer) clearTimeout(timer);
        timer = null;
      }),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, Math.max(1, timeoutMs));
      }),
    ]);
    if (!this.activeBackfill && this.activeWakeAbortControllers.size === 0) {
      this.shutdownDrainRequested = false;
    }
  }

  private async executeExternalBackfill(
    request: ExternalSessionLogBackfillRequest,
    source: ExternalSessionLogBackfillSource,
    writerOwner: symbol,
    options: { onProgress?: (progress: ExternalHistoryProgressUpdate) => void } = {},
  ): Promise<RuntimeLearningBackfillResult> {
    if (this.getProviderBlockingExternalFailure(source.identity.provider)) {
      throw new Error(
        `external provider ${source.identity.provider} is paused pending explicit protocol or integrity repair`,
      );
    }
    const paths = this.getExternalBackfillOperationPaths(request);
    const service = new ExternalSessionLogBackfillService({
      stateFilePath: paths.stateFilePath,
      auditFilePath: paths.auditFilePath,
      now: this.clock,
    });

    const initialProviderLock = this.acquireExternalProviderLock(
      source.identity.provider,
      'explicit-backfill',
      source.identity.sourceId,
    );
    if (!initialProviderLock.acquired) {
      throw new Error(`external source provider lock is busy for ${source.identity.provider}`);
    }
    let providerLock: ExternalSourceProviderLock = initialProviderLock;

    try {
      const yieldBackfillPageTurn = async (): Promise<void> => {
        providerLock.release();
        this.releaseStateWriter(writerOwner);
        try {
          await new Promise<void>(resolve => setImmediate(resolve));
        } finally {
          await this.acquireStateWriter(writerOwner);
          const reacquiredProviderLock = this.acquireExternalProviderLock(
            source.identity.provider,
            'explicit-backfill',
            source.identity.sourceId,
          );
          if (!reacquiredProviderLock.acquired) {
            throw new Error(`external source provider lock is busy for ${source.identity.provider}`);
          }
          providerLock = reacquiredProviderLock;
        }
      };
      const recoveryStorePath = this.externalCursorStorePath(
        source.identity.provider,
        source.identity.sourceId,
      );
      const reopenedRange = request.reopenTombstoneId
        ? prepareExternalTombstoneReopen(
          recoveryStorePath,
          request,
          request.reopenTombstoneId,
          this.clock(),
        )
        : undefined;
      if (reopenedRange?.originalTargetId) {
        this.episodeStore.reopenHistoricalTarget(reopenedRange.originalTargetId, {
          targetId: reopenedRange.targetId,
          provider: reopenedRange.provider,
          sourceId: reopenedRange.sourceId,
          resourceRef: reopenedRange.resourceRef,
          position: reopenedRange.range.endPosition,
          prefixDigest: reopenedRange.prefixDigest,
        });
      }
      let admittedEpisodes = 0;
      let contradictionSignals = 0;
      let reopenedTerminalTombstoneId = reopenedRange?.terminalTombstoneId;

      const ingest = (unit: DistillationUnit, context: ExternalSessionLogBackfillIngestContext) => {
        const recoveryState = loadExternalCursorState(recoveryStorePath);
        const blockingTombstone = findBlockingExternalSourceTombstone(
          recoveryState,
          source.identity,
          context.resource.resourceRef,
          context.eventIdentity,
          request.reopenTombstoneId,
        );
        if (blockingTombstone) {
          if (reopenedRange) {
            const persistedReopen = recordExternalTombstoneReopenTerminalExclusion(
              recoveryStorePath,
              request.operationId,
              blockingTombstone.tombstoneId,
              this.clock(),
            );
            reopenedTerminalTombstoneId = persistedReopen.terminalTombstoneId;
          }
          return {
            admittedEpisodeIds: [],
            tombstoneId: blockingTombstone.tombstoneId,
          };
        }
        // Minimal #93 seam: explicit backfill evidence admission also flows
        // through the single External Admission Coordinator, but the backfill
        // service still owns its separate operation cursor/audit state. When the
        // future bounded async reader pool (#92) lands, same-provider continuous
        // and backfill pages can be interleaved at page boundaries by selecting
        // lanes before calling admitPage().
        this.externalAdmissionCoordinator.markBackfillPending(source.identity.provider);
        const page: ExternalEvidencePage = {
          providerId: source.identity.provider,
          sourceId: source.identity.sourceId,
          identity: source.identity,
          resource: context.resource,
          distillationUnits: [unit],
          eventIdentities: [context.eventIdentity],
          readResult: {
            distillationUnit: unit,
            distillationUnits: [unit],
            advanced: true,
            status: 'advanced',
            newCursor: {
              resourceRef: context.resource.resourceRef,
              position: context.eventIdentity.position,
              processedCount: 1,
            },
            eventIdentities: [context.eventIdentity],
            accounting: { events: 1, bytes: 0, elapsedMs: 0 },
          },
          lane: 'backfill',
          ...(reopenedRange
            ? {
              historicalTarget: {
                targetId: reopenedRange.targetId,
                provider: reopenedRange.provider,
                sourceId: reopenedRange.sourceId,
                resourceRef: reopenedRange.resourceRef,
                position: reopenedRange.range.endPosition,
                prefixDigest: reopenedRange.prefixDigest,
              },
            }
            : {}),
        };
        const commit = this.externalAdmissionCoordinator.admitPages(
          [page],
          [source.identity.provider],
        )[0];
        if (!commit) {
          throw new Error('external backfill admission coordinator did not select a ready page');
        }
        if (!commit.acknowledged) {
          throw commit.error ?? new Error('external backfill admission coordinator commit failed');
        }
        admittedEpisodes += commit.admittedEpisodes;
        contradictionSignals += commit.contradictionSignals;
        return { admittedEpisodeIds: commit.admittedEpisodeIds ?? [] };
      };

      let backfill: ExternalSessionLogBackfillRunResult | null = null;
      let drained = false;
      let priorityMaturation = skippedMaturationReport();
      let priorityReview = skippedReviewReport();
      const invocationStartedAtMs = this.clock().getTime();
      const invocationStartState = loadExternalSessionLogBackfillState(paths.stateFilePath);
      const invocationStartMetrics = invocationStartState?.metrics;
      const invocationStartResources = invocationStartMetrics?.resourcesProcessed ?? 0;
      const invocationStartBytes = invocationStartMetrics?.bytesProcessed ?? 0;
      const invocationStartEvents = countBackfillProcessedEvents(invocationStartMetrics);
      do {
        // Deadline/retry work has priority between every bounded backfill slice.
        const due = this.planner.plan(this.clock()).due;
        const priorityReasons: RuntimeLearningReason[] = [];
        if (due.operationalRetryDue) priorityReasons.push('operational-retry');
        if (due.settlementDue) priorityReasons.push('settlement-deadline');
        if (priorityReasons.length > 0) {
          const priorityWake = await this.wakeWithStateWriter(priorityReasons, {}, writerOwner);
          priorityMaturation = mergeMaturationReports(priorityMaturation, priorityWake.maturation);
          priorityReview = mergeReviewReports(priorityReview, priorityWake.review);
        }

        const beforeSliceState = backfill?.state ?? invocationStartState;
        const beforeSliceMetrics = beforeSliceState?.metrics;
        const consumedResources = (beforeSliceMetrics?.resourcesProcessed ?? 0) - invocationStartResources;
        const consumedBytes = (beforeSliceMetrics?.bytesProcessed ?? 0) - invocationStartBytes;
        const consumedEvents = countBackfillProcessedEvents(beforeSliceMetrics) - invocationStartEvents;
        const elapsedMs = Math.max(0, this.clock().getTime() - invocationStartedAtMs);
        const remainingResources = request.limits.maxResources - consumedResources;
        const remainingBytes = request.limits.maxBytes - consumedBytes;
        const remainingElapsedMs = request.limits.maxElapsedMs - elapsedMs;
        const remainingEvents = request.limits.maxEvents === undefined
          ? Number.POSITIVE_INFINITY
          : request.limits.maxEvents - consumedEvents;
        if (
          backfill
          && (
            remainingResources <= 0
            || remainingBytes <= 0
            || remainingElapsedMs <= 0
            || remainingEvents <= 0
          )
        ) break;

        backfill = service.run({
          ...request,
          limits: {
            maxResources: Math.max(1, Math.min(remainingResources, EXTERNAL_BACKFILL_SLICE_RESOURCES)),
            maxBytes: Math.max(1, Math.min(remainingBytes, EXTERNAL_BACKFILL_SLICE_BYTES)),
            maxElapsedMs: Math.max(1, Math.min(remainingElapsedMs, EXTERNAL_BACKFILL_SLICE_MS)),
            maxEvents: Math.max(1, Math.min(remainingEvents, 1)),
          },
        }, source, ingest, { filterOutOfRangeEvents: true, onProgress: options.onProgress });

        if (backfill.status !== 'quota_reached') break;
        if (this.backfillDrainRequested) {
          drained = true;
          break;
        }
        // A single event larger than the cooperative byte slice must remain
        // resumable, but retrying the same zero-progress slice would spin.
        // Leave it quota-limited for the next explicit invocation.
        if (!backfillSliceMadeProgress(beforeSliceState, backfill.state)) {
          break;
        }
        await yieldBackfillPageTurn();
        if (this.backfillDrainRequested) {
          drained = true;
          break;
        }
      } while (backfill.status === 'quota_reached');

      if (!backfill) {
        throw new Error('external backfill did not produce a result');
      }

      if (reopenedRange && backfill.status === 'completed') {
        completeExternalTombstoneReopen(
          recoveryStorePath,
          request.operationId,
          this.clock(),
          reopenedTerminalTombstoneId,
        );
        this.episodeStore.reconcileHistoricalTarget(reopenedRange.targetId);
        // Refresh durable external capsules for the reopened range's episodes so
        // a pinned admission capsule reflects the authoritative matured status
        // before review enqueues.
        this.refreshExternalCapsuleSettlementEvidence(
          Object.values(this.episodeStore.load().episodes).filter(
            episode => episode.historicalTarget?.targetId === reopenedRange.targetId,
          ),
        );
      }

      // Backfill owns a separate cursor/audit, but source health is shared with
      // continuous ingestion. Persist the same durable failure class without
      // routing source failures into Operational Review Retry accounting.
      if (backfill.status === 'source_failed') {
        const latestFailure = backfill.state.failures[backfill.state.failures.length - 1];
        const message = latestFailure?.message ?? 'external backfill source failed';
        this.recordExternalSourceFailure(source.identity, new Error(message), {
          failureClass: this.classifyExternalSourceFailure(message),
          resourceRef: latestFailure?.resourceRef,
          eventId: latestFailure?.eventId,
        });
        this.saveExternalSourceSchedulingState();
      } else if (backfill.status === 'pending') {
        this.recordExternalSourceFailure(source.identity, new Error('pending external backfill range'), {
          failureClass: 'pending',
        });
        this.saveExternalSourceSchedulingState();
      } else if (backfill.status === 'blocked_zero_progress') {
        // Operator-actionable and resumable: record so diagnostics surface it,
        // then allow a later explicit retry after bounds/policy correction.
        const latestFailure = backfill.state.failures[backfill.state.failures.length - 1];
        const message = latestFailure?.message
          ?? 'external backfill blocked with zero progress; inspect failures or raise bounds, then retry';
        this.recordExternalSourceFailure(source.identity, new Error(message), {
          failureClass: this.classifyExternalSourceFailure(message),
          resourceRef: latestFailure?.resourceRef,
          eventId: latestFailure?.eventId,
        });
        this.saveExternalSourceSchedulingState();
      } else if (backfill.status === 'completed') {
        this.resetExternalSourceFailure(source.identity);
        this.saveExternalSourceSchedulingState();
      }

      this.externalEpisodeProvenanceStore.flush();

      const maturationDueWork: DueWork = {
        settlementDue: true,
        operationalRetryDue: false,
        routineCuratorDue: false,
        expeditedCuratorDue: false,
        semanticReassessmentDue: false,
      };
      const reviewDueWork: DueWork = {
        settlementDue: true,
        operationalRetryDue: true,
        routineCuratorDue: false,
        expeditedCuratorDue: false,
        semanticReassessmentDue: false,
      };

      const maturation = drained
        ? priorityMaturation
        : mergeMaturationReports(priorityMaturation, await this.runMaturation(maturationDueWork, false));
      if (!drained) await this.flushCuratorObservations();
      const review = drained
        ? priorityReview
        : mergeReviewReports(priorityReview, await this.runReview(reviewDueWork));

      const metrics = backfill.state.metrics;
      const aggregateBackfill: ExternalSessionLogBackfillRunResult = {
        ...backfill,
        processedResources: metrics.resourcesProcessed,
        pendingResources: metrics.pendingResources,
        failedResources: metrics.failedResources,
        ingestedEvents: metrics.ingestedEvents,
        duplicateEventsSkipped: metrics.duplicateEventsSkipped,
        tombstonedEventsSkipped: metrics.tombstonedEventsSkipped,
        admittedEpisodes: metrics.admittedEpisodes,
        bytesProcessed: metrics.bytesProcessed,
      };

      return {
        paths,
        backfill: aggregateBackfill,
        ingestion: {
          admittedEpisodes,
          contradictionSignals,
        },
        maturation,
        review,
        drained,
      };
    } finally {
      if (providerLock.acquired) providerLock.release();
    }
  }

  // -----------------------------------------------------------------------
  // Single wake entry point
  // -----------------------------------------------------------------------

  /**
   * Run one wake cycle of the Runtime Learning module.
   *
   * For discovery reasons (startup, scheduled, session-log-append, manual): scan session logs,
   * ingest evidence, then run settlement/review/curation based on what's due.
   *
   * For targeted reasons (settlement-deadline, operational-retry, curator):
   * skip session-log scanning and run only the due stages. This is the
   * production path for deadline-driven wakes.
   */
  async wake(
    reason: RuntimeLearningReason | readonly RuntimeLearningReason[],
    wakeOptions: { coalesced?: boolean } = {},
  ): Promise<RuntimeLearningHeartbeatResult> {
    const operation = this.wakeWithStateWriter(reason, wakeOptions);
    this.activeWakeResults.add(operation);
    try {
      return await operation;
    } finally {
      this.activeWakeResults.delete(operation);
    }
  }

  private async wakeWithStateWriter(
    reason: RuntimeLearningReason | readonly RuntimeLearningReason[],
    wakeOptions: { coalesced?: boolean } = {},
    owner: symbol = Symbol('runtime-learning-wake'),
  ): Promise<RuntimeLearningHeartbeatResult> {
    return this.withStateWriter(owner, () => this.executeWake(reason, wakeOptions));
  }

  private async executeWake(
    reason: RuntimeLearningReason | readonly RuntimeLearningReason[],
    wakeOptions: { coalesced?: boolean } = {},
  ): Promise<RuntimeLearningHeartbeatResult> {
    const wake = emptyHeartbeatResult(true);
    const now = this.clock();
    const reasons = this.normalizeReasons(reason);
    const orderedReasons = [...reasons].sort();
    const wakeStartMs = this.clock().getTime();
    const isDiscoveryWake = this.isDiscoveryWake(reasons);
    const wakeAbortController = new AbortController();
    this.activeWakeAbortControllers.add(wakeAbortController);

    try {
      // Durable provider controls can be changed by a separate CLI process.
      // Refresh Runtime-owned lanes at the wake boundary; injected fixtures
      // remain owned by their caller and are never replaced here.
      this.reconcileProviderLanes();

      // ---- 1. Discovery + Ingestion (source-neutral) ----
      const shouldScan = isDiscoveryWake;

      if (shouldScan) {
        const allowNewCatchUpGeneration = reasons.has('startup')
          || reasons.has('scheduled')
          || reasons.has('manual');
        const discoveryResult = await this.runDiscovery({
          processCatchUp: allowNewCatchUpGeneration || reasons.has('external-continuation'),
          allowNewCatchUpGeneration,
        });
        wake.discovery.scanned = discoveryResult.sourceReports.some(r => r.enabled);
        wake.discovery.filesScanned = discoveryResult.sourceReports.reduce((sum, r) => sum + r.resourcesDiscovered, 0);
        wake.discovery.unitsProcessed = discoveryResult.sourceReports.reduce((sum, r) => sum + r.unitsProcessed, 0);
        wake.discovery.advancedFiles = discoveryResult.sourceReports.reduce((sum, r) => sum + r.advancedResources, 0);
        wake.discovery.sources = discoveryResult.sourceReports;
        wake.ingestion.admittedEpisodes += discoveryResult.admittedEpisodes;
        wake.ingestion.contradictionSignals += discoveryResult.contradictionSignals;
      }

      wake.unitsProcessed = wake.discovery.unitsProcessed;
      wake.advancedFiles = wake.discovery.advancedFiles;

      if (wake.unitsProcessed > 0) {
        Logger.info(
          `[RuntimeLearning] ingested ${wake.unitsProcessed} distillation unit(s) across ${wake.advancedFiles} file(s) (${this.formatReasons(reasons)})`,
        );
      } else if (wake.discovery.scanned) {
        Logger.info(`[RuntimeLearning] no new session log appends (${this.formatReasons(reasons)})`);
      } else {
        Logger.info(`[RuntimeLearning] skipped session log scan (${this.formatReasons(reasons)})`);
      }

      // ---- 2. Due work planning ----
      const plan = this.planner.plan(now);
      // Discovery wakes always run the discovery scan plus due-like review work,
      // so they are not blocked by planner due status.
      // Targeted wakes use the planner due union from the requested reason set.
      const dueWork = this.resolveWakeDueWork(reasons, plan.due);

      // ---- 3. Settlement (maturation) ----
      const maturation = await this.runMaturation(dueWork, reasons.has('settlement-deadline'));
      wake.maturation = maturation;

      // ---- 4. Curator observation (after settlement so episode status is final) ----
      await this.flushCuratorObservations();

      // ---- 5. Review ----
      const review = await this.runReview(dueWork, wakeAbortController.signal);
      wake.review = review;

      // ---- 6. Curation ----
      const curation = await this.runCuration(dueWork);
      wake.curation = curation;

      if (this.shouldRunReassessment(reasons, dueWork)) {
        wake.reassessment = await this.runSemanticReassessment();
      }

      // ---- 7. Retain only audit-linked active-capability transcripts ----
      this.cleanupBranchTranscripts();

      // ---- 8. Record heartbeat ----
      const runDurationMs = Math.max(0, this.clock().getTime() - wakeStartMs);
      const hadDurableWork = this.hasDurableWakeWork(wake);
      const nextPlan = this.planner.plan(this.clock());
      this.recordHeartbeat(
        this.formatReasons(reasons),
        wake.unitsProcessed,
        wake.advancedFiles,
        this.deriveHeartbeatRunStatus(
          wake.review,
          orderedReasons,
          wakeOptions.coalesced,
          hadDurableWork,
        ),
        orderedReasons,
        runDurationMs,
        wake.review.reviewTimeoutCount,
        wake.review.reviewFailureCount,
        true,
        {
          sources: wake.discovery.sources,
          nextWakeTime: nextPlan.nextWakeTime,
          nextWakeReason: nextPlan.nextWakeReason,
        },
      );

      // Bounded external discovery may leave a durable incomplete page cycle
      // (discovery.nextPageToken). Request a coalesced discovery follow-up so
      // large catalogs do not appear stuck until the next scheduled interval.
      this.requestExternalContinuationWakeIfNeeded(wake.discovery.sources);

      return wake;
    } catch (error: any) {
      Logger.warning(`[RuntimeLearning] wake cycle failed (${this.formatReasons(this.normalizeReasons(reason))}): ${error.message}`);
      const wakeDurationMs = Math.max(0, this.clock().getTime() - wakeStartMs);
      this.recordHeartbeat(
        this.formatReasons(reasons),
        wake.unitsProcessed,
        wake.advancedFiles,
        'failed',
        orderedReasons,
        wakeDurationMs,
        0,
        1,
        true,
        {
          sources: wake.discovery.sources,
          nextWakeTime: null,
          nextWakeReason: 'failed',
        },
      );
      // Fail-closed: still re-enter only when durable continuation remains and
      // the source is not in backoff/blocked failure (checked inside helper).
      this.requestExternalContinuationWakeIfNeeded(wake.discovery.sources);
      return wake;
    } finally {
      this.activeWakeAbortControllers.delete(wakeAbortController);
      if (this.activeWakeAbortControllers.size === 0 && !this.activeBackfill) {
        this.shutdownDrainRequested = false;
      }
    }
  }

  public markHeartbeatStatus(
    status: RuntimeLearningHeartbeatRunStatus,
    options: {
      reason?: RuntimeLearningReason | string;
      pendingWakeReasons?: readonly RuntimeLearningReason[];
      durationMs?: number;
      reviewTimeoutCount?: number;
      reviewFailureCount?: number;
      unitsProcessed?: number;
      advancedFiles?: number;
    } = {},
  ): void {
    this.recordHeartbeat(
      options.reason ?? 'manual',
      options.unitsProcessed ?? 0,
      options.advancedFiles ?? 0,
      status,
      options.pendingWakeReasons ?? [],
      options.durationMs ?? 0,
      options.reviewTimeoutCount ?? 0,
      options.reviewFailureCount ?? 0,
      false,
    );
  }

  /** Persist scheduler demand before the active wake can consume it. */
  public markHeartbeatPending(reasons: readonly RuntimeLearningReason[]): void {
    const record = this.loadHeartbeatRecord();
    record.pendingWakeReasons = Array.from(new Set(reasons)).sort();
    this.writeHeartbeatRecord(record);
  }

  /** Restart-safe scheduler input; reading it never starts or mutates a wake. */
  public getPendingHeartbeatReasons(): RuntimeLearningReason[] {
    return [...this.loadHeartbeatRecord().pendingWakeReasons];
  }

  public markHeartbeatInProgress(
    reasons: readonly RuntimeLearningReason[],
    owner?: RuntimeLearningHeartbeatOwner,
  ): void {
    const record = this.loadHeartbeatRecord();
    record.inProgress = {
      startedAt: this.clock().toISOString(),
      reasons: Array.from(new Set(reasons)).sort(),
    };
    if (owner) record.owner = owner;
    this.writeHeartbeatRecord(record);
  }

  public markHeartbeatScheduled(
    nextWakeAt: Date,
    reason: RuntimeLearningReason | string,
    owner?: RuntimeLearningHeartbeatOwner,
  ): void {
    const record = this.loadHeartbeatRecord();
    record.nextWakeAt = nextWakeAt.toISOString();
    record.nextWakeReason = reason;
    if (owner) record.owner = owner;
    this.writeHeartbeatRecord(record);
  }

  private deriveHeartbeatRunStatus(
    reviewReport: RuntimeLearningReviewReport,
    reasons: readonly RuntimeLearningReason[],
    wasCoalesced: boolean | undefined,
    hadDurableWork: boolean,
  ): RuntimeLearningHeartbeatRunStatus {
    if (reviewReport.status === 'failed') return 'failed';
    if (reviewReport.reviewTimeoutCount > 0) return 'timed_out';
    if (wasCoalesced) return 'coalesced';
    if (
      reviewReport.reviewFailureCount > 0
      || reviewReport.operationalRetries > 0
      || reviewReport.deferredRetries > 0
      || reviewReport.deferredQueueReviews > 0
      || reviewReport.operationalQueueReviews > 0
      && reasons.includes('operational-retry')
    ) return 'queued_operational_retry';
    if (!hadDurableWork) return 'quiet';
    return 'succeeded';
  }

  private hasDurableWakeWork(wake: RuntimeLearningHeartbeatResult): boolean {
    return (
      wake.unitsProcessed > 0
      || wake.advancedFiles > 0
      || wake.maturation.maturedEpisodes > 0
      || wake.review.reviewedEpisodes > 0
      || wake.review.reviewedQueueEntries > 0
      || wake.review.operationalRetries > 0
      || wake.review.deferredRetries > 0
      || wake.curation.ran
      || wake.curation.expedited
      || wake.reassessment.completed > 0
      || wake.reassessment.deferred > 0
      || wake.reassessment.failed > 0
      || wake.reassessment.discovered > 0
    );
  }

  private normalizeReasons(
    reason: RuntimeLearningReason | readonly RuntimeLearningReason[],
  ): Set<RuntimeLearningReason> {
    if (typeof reason === 'string') return new Set([reason]);
    return new Set(reason);
  }

  private isDiscoveryWake(reasons: Set<RuntimeLearningReason>): boolean {
    return (
      reasons.has('startup')
      || reasons.has('scheduled')
      || reasons.has('session-log-append')
      || reasons.has('manual')
      || reasons.has('external-continuation')
    );
  }

  /**
   * When a bounded external discovery slice stops with a durable incomplete
   * catalog page cycle (`discovery.nextPageToken != null`), merge an
   * `external-continuation` discovery reason into the durable pending-wake set
   * so the existing coalesced scheduler loop can drain the rest without a
   * second scheduler or manual re-wake. Covers both unfinished future-only
   * baseline and post-baseline continuous discovery. Never starts a new
   * catalog cycle from the continuation reason alone, and never hot-loops
   * failure/backoff/blocked/drained/locked lanes.
   */
  private requestExternalContinuationWakeIfNeeded(
    sourceReports: readonly SessionLogSourceReport[],
  ): void {
    if (!this.hasRemainingExternalDiscoveryWork(sourceReports)) return;
    const existing = this.getPendingHeartbeatReasons();
    if (existing.includes('external-continuation')) return;
    this.markHeartbeatPending([...existing, 'external-continuation']);
  }

  private hasRemainingExternalDiscoveryWork(
    sourceReports: readonly SessionLogSourceReport[],
  ): boolean {
    // Fail-closed for suspended / non-runnable lanes. A per-resource read
    // failure (`status: failed`) must NOT block durable incomplete page-cycle
    // continuation — catalog paging still has to finish. Backoff/drained/
    // locked/activation-blocked do not self-spin.
    const reportBySourceId = new Map(
      sourceReports
        .filter(report => report.category === 'external' && report.enabled)
        .map(report => [report.sourceId, report] as const),
    );

    for (const adapter of this.sessionLogSources) {
      if (adapter.identity.category !== 'external' || !adapter.isEnabled()) continue;

      const report = reportBySourceId.get(adapter.identity.sourceId);
      if (
        report?.status === 'backoff'
        || report?.status === 'drained'
        || report?.status === 'locked'
      ) {
        continue;
      }

      const failureState = this.getProviderBlockingExternalFailure(adapter.identity.provider)
        ?? this.getExternalSourceFailure(adapter.identity.provider, adapter.identity.sourceId);
      if (this.shouldSkipExternalSourceForFailure(failureState)) continue;

      const storePath = adapter.getCursorStorePath?.();
      if (!storePath) continue;
      let state: ExternalCursorState;
      try {
        state = loadExternalCursorState(storePath);
      } catch {
        continue;
      }
      // Activation blocked is operator-gated; do not hot-loop.
      if (state.activation?.activationBlocked === true) continue;

      // Catch-up uses an expanding catalog plus stability/page quanta rather
      // than discovery.nextPageToken. Continue only the active generation;
      // the default allowNewGeneration=false prevents a completed catch-up
      // from starting a fresh historical scan on its own.
      if (adapter.getNextCatchUpAction?.() !== undefined) {
        return true;
      }

      // Future-only discovery uses a finite incomplete page cycle. When
      // nextPageToken is null that catalog cycle is finished. Do not auto-start
      // a fresh cycle from the continuation reason alone — that waits for
      // ordinary scheduled / session-log cadence.
      if (state.discovery?.nextPageToken != null) {
        return true;
      }
    }
    return false;
  }

  private resolveWakeDueWork(
    reasons: Set<RuntimeLearningReason>,
    planDue: DueWork,
  ): DueWork {
    if (this.isDiscoveryWake(reasons)) {
      return {
        settlementDue: true,
        operationalRetryDue: true,
        routineCuratorDue: true,
        expeditedCuratorDue: true,
        semanticReassessmentDue: Boolean(planDue.semanticReassessmentDue),
      };
    }

    const hasAnyTargetedWakeReason = reasons.size > 0;
    if (!hasAnyTargetedWakeReason) {
      return {
        settlementDue: false,
        operationalRetryDue: false,
        routineCuratorDue: false,
        expeditedCuratorDue: false,
        semanticReassessmentDue: false,
      };
    }

    return {
      settlementDue: planDue.settlementDue,
      operationalRetryDue: planDue.operationalRetryDue,
      routineCuratorDue: planDue.routineCuratorDue,
      expeditedCuratorDue: planDue.expeditedCuratorDue,
      semanticReassessmentDue: Boolean(planDue.semanticReassessmentDue),
    };
  }

  private formatReasons(reasons: Set<RuntimeLearningReason>): string {
    return [...reasons].sort().join('+');
  }

  private cleanupBranchTranscripts(): void {
    try {
      const registry = this.skillEvolution.getRegistry();
      cleanupBranchTranscripts({
        branchLogRoot: this.config.branchLogRoot,
        // Independent reader lanes live under data/reader-transcripts and are
        // retained when linked from Transition Audit for active capabilities.
        additionalTranscriptRoots: [
          path.join(this.workingDirectory, 'data', 'reader-transcripts'),
        ],
        auditEntries: this.skillEvolution.getAudit(),
        activeCapabilityHandles: new Set(Object.keys(registry.capabilities)),
        now: this.clock(),
        retentionDays: this.config.branchTranscriptRetentionDays,
      });
    } catch (error) {
      Logger.warning(`[RuntimeLearning] branch transcript cleanup skipped: ${toErrorMessage(error)}`);
    }
  }

  private shouldRunReassessment(
    reasons: Set<RuntimeLearningReason>,
    dueWork: DueWork,
  ): boolean {
    return (
      reasons.has('startup')
      || reasons.has('manual')
      || reasons.has('scheduled')
      || Boolean(dueWork.semanticReassessmentDue)
    );
  }
  private async runSemanticReassessment(): Promise<RuntimeLearningReassessmentReport> {
    try {
      const results = await bootstrapSemanticReassessmentOnce({
        skillEvolution: this.skillEvolution,
        manifestPath: this.config.skillEvolutionReassessmentManifestPath,
        learningEpisodeStore: this.episodeStore,
      });
      const transitionsByKind: Partial<Record<CapabilityTransitionKind, number>> = {};
      let completed = 0;
      let deferred = 0;
      let failed = 0;
      for (const result of results) {
        if (result.status === 'succeeded') completed++;
        if (result.status === 'deferred') deferred++;
        if (result.status === 'failed') failed++;
        if (result.transition) incrementTransition(transitionsByKind, result.transition);
      }
      return {
        status: failed > 0 ? 'failed' : 'succeeded',
        discovered: results.length,
        completed,
        deferred,
        failed,
        transitionsByKind,
      };
    } catch (error) {
      return {
        status: 'failed',
        errorMessage: toErrorMessage(error),
        discovered: 0,
        completed: 0,
        deferred: 0,
        failed: 1,
        transitionsByKind: {},
      } as RuntimeLearningReassessmentReport & { errorMessage: string };
    }
  }

  // -----------------------------------------------------------------------
  // Curator observation (runs independent of settlement)
  // -----------------------------------------------------------------------

  /**
   * Flush any pending curator observations from newly ingested episodes.
   * This runs unconditionally after ingestion, regardless of whether
   * settlement is due — contradicted episodes also need observation for
   * expedited curator wake triggering.
   */
  private async flushCuratorObservations(): Promise<void> {
    if (!this.curator) return;

    const state = this.episodeStore.load();
    for (const episode of Object.values(state.episodes)) {
      if (!episode.agentTurnEpisodeId || episode.contradictionSignals.length === 0) continue;
      try {
        this.curator.observeEpisode(episode);
      } catch {
        // Observation failure should not block the wake. The episode
        // remains durable for a later retry.
      }
    }

    // The ledger append and expedited-wake state update are separate writes.
    // Rebuild the latter even when there were no newly admitted episode ids.
    this.curator.recoverExpeditedWakes();
  }

  // -----------------------------------------------------------------------
  // Stage: maturation (settle Learning Episodes)
  // -----------------------------------------------------------------------

  private async runMaturation(
    dueWork: DueWork,
    isDedicatedSettlementWake: boolean,
  ): Promise<RuntimeLearningMaturationReport> {
    const maturationAttempted = dueWork.settlementDue || isDedicatedSettlementWake;
    if (!maturationAttempted) return skippedMaturationReport();

    try {
      const preSettleEpisodes = Object.values(this.episodeStore.load().episodes);
      const preSettleStatuses = new Map(
        preSettleEpisodes.map(e => [e.episodeId, e.status]),
      );

      const settledState = this.episodeStore.settle({ now: this.clock() });
      const episodes = Object.values(settledState.episodes);

      const maturedEpisodes = episodes.filter(
        e => preSettleStatuses.get(e.episodeId) === 'settling' && e.status !== 'settling',
      );
      const maturedEpisodeIds = maturedEpisodes.map(e => e.episodeId);

      // Refresh durable external capsules for matured episodes so a pinned
      // admission capsule (recorded while the episode was still settling) is
      // updated to the authoritative matured status before review enqueues.
      this.refreshExternalCapsuleSettlementEvidence(maturedEpisodes);

      const becameEligible = maturedEpisodes.filter(e => e.status === 'eligible').length;
      const becameContradicted = maturedEpisodes.filter(e => e.status === 'contradicted').length;

      return {
        status: 'succeeded',
        maturedEpisodes: maturedEpisodeIds.length,
        becameEligible,
        becameContradicted,
      };
    } catch (error) {
      return {
        status: 'failed',
        errorMessage: toErrorMessage(error),
        maturedEpisodes: 0,
        becameEligible: 0,
        becameContradicted: 0,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Stage: review (eligible episodes + queue entries)
  // -----------------------------------------------------------------------

  private async runReview(
    dueWork: DueWork,
    wakeSignal?: AbortSignal,
  ): Promise<RuntimeLearningReviewReport> {
    const reviewAttempted = dueWork.settlementDue || dueWork.operationalRetryDue;
    if (!reviewAttempted) return skippedReviewReport();

    const transitionsByKind: Partial<Record<CapabilityTransitionKind, number>> = {};

    // Restart-safe settlement reconciliation: a capsule persisted before the
    // settlement-consistency fix may carry contradictory settlement evidence
    // while its LearningEpisode is durably matured. Reconcile capsules from the
    // authoritative status and supersede any active job whose frozen basis still
    // carries the old contradiction — before fair advance so only clean
    // successors can advance.
    try {
      this.reconcileSettlementConsistency();
    } catch (error) {
      Logger.warning(
        `[RuntimeLearning] settlement reconciliation skipped: ${toErrorMessage(error)}`,
      );
    }

    // Rebuild current bundles for dormant defers before scheduling. This is the
    // production evidence-change trigger; reviewer/policy/Registry triggers are
    // checked in the same single-owner reactivation pass.
    const deferredBundleIds = new Set(this.skillEvolution.getDeferredReviewBundleIds());
    const liveDeferredBundles: EvidenceBundle[] = [];
    for (const episode of Object.values(this.episodeStore.load().episodes)) {
      if (!deferredBundleIds.has(`v3:learning-episode:${episode.episodeId}`)) continue;
      try {
        liveDeferredBundles.push(buildEpisodeEvidenceBundle(
          episode,
          buildLearningEpisodeCandidate(episode),
          this.skillEvolution,
          this.evidenceCapsuleStore,
          this.isEpisodeFromExternalSource.bind(this),
          this.listSkillLoadFactsForEpisode(episode),
        ));
      } catch (error) {
        Logger.warning(`[RuntimeLearning] deferred bundle refresh skipped for ${episode.episodeId}: ${toErrorMessage(error)}`);
      }
    }
    this.skillEvolution.reactivateDeferredReviews(liveDeferredBundles);

    const reviewBudget = createReviewBudget({
      maxCandidates: this.config.skillEvolutionReviewMaxCandidates,
      deadlineMs: this.config.skillEvolutionReviewAttemptDeadlineMinutes * 60_000,
      now: () => this.clock().getTime(),
    });

    // Fence before scheduling so the Runtime-level ring sees only runnable,
    // current Jobs. Durable retry/defer execution remains exclusively one fair
    // graph Quantum claim; there is no synchronous queue drain.
    let fairJobIds: string[] = [];
    let hasRunnableReviewJob = false;
    try {
      if (!this.shutdownDrainRequested) {
        this.skillEvolution.fenceStaleActiveJobsBeforeFairAdvance(this.clock());
        hasRunnableReviewJob = this.listRunnableReviewJobIds().length > 0;
      }
    } catch {
      // Job store optional during early construction / V3-disabled paths.
    }

    const pendingEpisodeIds = new Set<string>();
    const fairness = this.loadReviewFairnessContinuation();
    const classCursors = { ...fairness.classCursors };
    let nextClass = fairness.nextClass;

    type EpisodeReviewTask = {
      kind: 'episode';
      workClass: 'live' | 'historical';
      episode: LearningEpisode;
    };
    type RetryReviewTask = {
      kind: 'retry';
      workClass: 'retry';
      taskId: 'fair-review-quantum';
    };
    type ReviewTask = EpisodeReviewTask | RetryReviewTask;

    const reviewedOrQueuedBundleIds = this.skillEvolution.getReviewedOrQueuedBundleIds();
    const episodeState = this.episodeStore.load();
    const eligibleEpisodes = Object.values(episodeState.episodes)
      .filter(episode => (
        episode.status === 'eligible'
        && !this.hasReviewedEpisode(episode, reviewedOrQueuedBundleIds)
      ));
    for (const episode of eligibleEpisodes) pendingEpisodeIds.add(episode.episodeId);

    const remainingByClass: Record<ReviewWorkClass, ReviewTask[]> = {
      // A single fair Quantum is one task in the same persistent ring as new
      // live/historical admission. With maxCandidates=1 no class can monopolize
      // every wake merely because it already has durable work.
      retry: hasRunnableReviewJob
        ? [{ kind: 'retry', workClass: 'retry', taskId: 'fair-review-quantum' }]
        : [],
      live: eligibleEpisodes
        .filter(episode => episode.historicalTarget === undefined)
        .map(episode => ({ kind: 'episode' as const, workClass: 'live' as const, episode })),
      historical: eligibleEpisodes
        .filter(episode => episode.historicalTarget !== undefined)
        .map(episode => ({ kind: 'episode' as const, workClass: 'historical' as const, episode })),
    };

    const taskId = (task: ReviewTask): string => task.kind === 'retry'
      ? task.taskId
      : task.episode.episodeId;
    for (const workClass of REVIEW_WORK_CLASS_ORDER) {
      remainingByClass[workClass].sort((left, right) => (
        taskId(left).localeCompare(taskId(right), 'en')
      ));
    }

    const selectionClassCursors = { ...classCursors };
    let selectionNextClass = nextClass;
    const maxCandidates = Math.max(0, Math.floor(this.config.skillEvolutionReviewMaxCandidates));
    const admittedEpisodeTasks: Array<{
      episode: LearningEpisode;
      bundle: ReturnType<typeof buildEpisodeEvidenceBundle>;
    }> = [];
    let settlementError: unknown;
    while (reviewBudget.candidates < maxCandidates) {
      const availableClasses = new Set(
        REVIEW_WORK_CLASS_ORDER.filter(workClass => remainingByClass[workClass].length > 0),
      );
      if (availableClasses.size === 0) break;
      const startIndex = REVIEW_WORK_CLASS_ORDER.indexOf(selectionNextClass);
      let selectedClass: ReviewWorkClass | undefined;
      for (let offset = 0; offset < REVIEW_WORK_CLASS_ORDER.length; offset++) {
        const candidateClass = REVIEW_WORK_CLASS_ORDER[
          (startIndex + offset) % REVIEW_WORK_CLASS_ORDER.length
        ]!;
        if (availableClasses.has(candidateClass)) {
          selectedClass = candidateClass;
          break;
        }
      }
      if (!selectedClass) break;

      const tasks = remainingByClass[selectedClass];
      const cursor = selectionClassCursors[selectedClass];
      const selectedIndex = cursor
        ? tasks.findIndex(task => taskId(task).localeCompare(cursor, 'en') > 0)
        : 0;
      const [selected] = tasks.splice(selectedIndex < 0 ? 0 : selectedIndex, 1);
      if (!selected) break;
      selectionClassCursors[selectedClass] = taskId(selected);
      selectionNextClass = REVIEW_WORK_CLASS_ORDER[
        (REVIEW_WORK_CLASS_ORDER.indexOf(selectedClass) + 1) % REVIEW_WORK_CLASS_ORDER.length
      ]!;
      if (wakeSignal?.aborted || this.shutdownDrainRequested) break;
      if (selected.kind === 'retry') {
        if (!this.canAdmitReviewWork(reviewBudget)) continue;
        classCursors.retry = taskId(selected);
        nextClass = 'live';
        try {
          const fair = await advanceJobsFairly(
            this.skillEvolution.getEvidenceReviewEngine(),
            `wake-fair:${this.clock().getTime()}`,
            {
              // One provider-backed Quantum is deliberate backpressure. The
              // next durable wake continues it after live/historical get turns.
              maxClaims: 1,
              maxClaimsPerJob: 1,
              signal: wakeSignal,
              now: this.clock(),
              shouldStopClaiming: () => this.shutdownDrainRequested,
            },
          );
          fairJobIds = fair.jobIds;
        } catch {
          // Graph execution persists its own operational outcome. Keep the
          // Runtime stage behavior identical to the former fair-advance seam.
        }
        continue;
      }
      try {
        const bundle = buildEpisodeEvidenceBundle(
          selected.episode,
          buildLearningEpisodeCandidate(selected.episode),
          this.skillEvolution,
          this.evidenceCapsuleStore,
          this.isEpisodeFromExternalSource.bind(this),
          this.listSkillLoadFactsForEpisode(selected.episode),
        );
        if (!this.canAdmitReviewWork(reviewBudget)) continue;
        classCursors[selected.workClass] = taskId(selected);
        nextClass = REVIEW_WORK_CLASS_ORDER[
          (REVIEW_WORK_CLASS_ORDER.indexOf(selected.workClass) + 1) % REVIEW_WORK_CLASS_ORDER.length
        ]!;
        admittedEpisodeTasks.push({ episode: selected.episode, bundle });
      } catch (error) {
        // Pre-snapshot local Episodes cannot be safely reconstructed. Do not
        // turn that immutable-data gap into a forever retry continuation;
        // leave the Episode untouched for explicit migration/inspection.
        if (error instanceof MissingLearningEpisodeSourceEvidenceError) {
          pendingEpisodeIds.delete(selected.episode.episodeId);
          Logger.warning(`[RuntimeLearning] review skipped for legacy Episode ${selected.episode.episodeId}: ${error.message}`);
          continue;
        }
        settlementError = settlementError ?? error;
      }
    }

    let reviewedEpisodes = 0;
    let episodeReviewFailures = 0;
    let episodeReviewTimeouts = 0;
    let episodeOperationalFailures = 0;

    const externalEpisodeTasks = admittedEpisodeTasks.filter(({ episode }) =>
      this.isEpisodeFromExternalSource(episode.episodeId));
    const localEpisodeTasks = admittedEpisodeTasks.filter(({ episode }) =>
      !this.isEpisodeFromExternalSource(episode.episodeId));

    // External/Pi learning is maintenance work with an unreliable provider in
    // its path. Admit it durably and let fair background wakes advance it;
    // never hold external ingestion open while waiting for model review.
    for (const { episode, bundle } of externalEpisodeTasks) {
      try {
        this.skillEvolution.enqueueReview(bundle);
        // Admission is complete. The durable job, not this heartbeat, now owns
        // the episode until a fair background wake reaches a disposition.
        pendingEpisodeIds.delete(episode.episodeId);
      } catch (error) {
        episodeReviewFailures++;
        settlementError = settlementError ?? error;
        Logger.warning(`[RuntimeLearning] review admission failed for ${episode.episodeId}: ${toErrorMessage(error)}`);
      }
    }

    // Preserve the established one-wake behavior for local delivery episodes,
    // whose callers and tests rely on an immediate transition result.
    try {
      await mapWithConcurrency(
        localEpisodeTasks,
        Math.max(1, Math.floor(this.config.skillEvolutionReviewerConcurrency)),
        async ({ episode, bundle }) => {
          try {
            const result = await this.skillEvolution.reviewAndApply(bundle, wakeSignal);
            if (result.queued === 'operational') {
              const queued = this.skillEvolution.getQueuedReviewState(bundle.bundleId);
              if (queued?.failureKind === 'branch_timeout') episodeReviewTimeouts++;
              else episodeOperationalFailures++;
            }
            this.linkEvidenceCapsuleToAudit(bundle.bundleId, result.audit?.transitionId ?? result.transitionId);
            incrementTransition(transitionsByKind, result.transition);
            reviewedEpisodes++;
            pendingEpisodeIds.delete(episode.episodeId);
          } catch (error: any) {
            episodeReviewFailures++;
            Logger.warning(`[RuntimeLearning] review failed for ${episode.episodeId}: ${error.message}`);
          }
        },
      );
    } catch (error) {
      settlementError = settlementError ?? error;
    }

    type QueueResult = {
      reviewed: number; deferredReviewed: number; operationalReviewed: number;
      operationalRetried: number; deferredRetried: number;
      transitionsByKind: Partial<Record<string, number>>;
      queueOutcomes?: Record<string, {
        status: 'succeeded' | 'deferred' | 'operational';
        nextRetryAt?: string;
        reason?: string;
        failureKind?: string;
      }>;
    };
    let queueResult: QueueResult = {
      reviewed: 0, deferredReviewed: 0, operationalReviewed: 0,
      operationalRetried: 0, deferredRetried: 0, transitionsByKind: {},
      queueOutcomes: {},
    };
    let reviewTimeoutCount = episodeReviewTimeouts;
    let reviewFailureCount = episodeOperationalFailures;
    if (!this.shutdownDrainRequested && !wakeSignal?.aborted) {
      queueResult = this.skillEvolution.collectFairReviewOutcomes(fairJobIds);
      this.reconcileReassessmentQueueOutcomes(queueResult.queueOutcomes);
    }

    for (const [transition, count] of Object.entries(queueResult.transitionsByKind)) {
      if (!count) continue;
      const key = transition as CapabilityTransitionKind;
      transitionsByKind[key] = (transitionsByKind[key] ?? 0) + count;
    }

    // Completed counts and transitions are preserved; operational retry and
    // cursor semantics are derived from the fair graph outcome.
    const hasEpisodeFailure = episodeReviewFailures > 0;
    if (hasEpisodeFailure) reviewFailureCount += episodeReviewFailures;

    if (queueResult.queueOutcomes) {
      for (const outcome of Object.values(queueResult.queueOutcomes)) {
        if (outcome.status !== 'operational' || !outcome.failureKind) continue;
        if (outcome.failureKind === 'branch_timeout') {
          reviewTimeoutCount += 1;
        } else {
          reviewFailureCount += 1;
        }
      }
    }

    const status: RuntimeLearningStageStatus = (hasEpisodeFailure || !!settlementError)
      ? 'failed'
      : 'succeeded';

    const errorParts: string[] = [];
    if (hasEpisodeFailure) errorParts.push(`${episodeReviewFailures} episode review(s) failed`);
    if (settlementError) errorParts.push(`settlement error: ${toErrorMessage(settlementError)}`);

    this.persistReviewContinuation(
      pendingEpisodeIds,
      { nextClass, classCursors },
      new Set(this.listRunnableReviewJobIds()),
    );

    return {
      status,
      ...(errorParts.length > 0 ? { errorMessage: errorParts.join('; ') } : {}),
      reviewedEpisodes,
      reviewedQueueEntries: queueResult.reviewed,
      deferredQueueReviews: queueResult.deferredReviewed,
      operationalQueueReviews: queueResult.operationalReviewed,
      deferredRetries: queueResult.deferredRetried,
      operationalRetries: queueResult.operationalRetried,
      reviewTimeoutCount,
      reviewFailureCount,
      transitionsByKind,
    };
  }

  private canAdmitReviewWork(reviewBudget: ReviewBudget): boolean {
    if (this.shutdownDrainRequested) return false;
    return reviewBudget.admit();
  }

  /**
   * Reconcile reassessment task state after the shared review queue has
   * recovered a due entry. The queue is the single retry authority; this
   * manifest mirror is updated from the queue outcome, including the actual
   * backoff deadline, so restart planning cannot strand a failed task.
   */
  private reconcileReassessmentQueueOutcomes(
    outcomes: Record<string, { status: 'succeeded' | 'deferred' | 'operational'; nextRetryAt?: string; reason?: string }> | undefined,
  ): void {
    if (!outcomes || Object.keys(outcomes).length === 0) return;
    const manifestPath = this.config.skillEvolutionReassessmentManifestPath;
    if (!manifestPath) return;
    const manifest = new SemanticReassessmentManifestStore(manifestPath);
    const state = manifest.load();
    let changed = false;
    const now = this.clock().toISOString();
    for (const [taskId, outcome] of Object.entries(outcomes)) {
      const entry = state.entries[taskId];
      if (!entry) continue;
      const status = outcome.status === 'operational' ? 'failed' : outcome.status;
      if (entry.status !== status
        || entry.nextRetryAt !== outcome.nextRetryAt
        || entry.lastError !== outcome.reason) changed = true;
      entry.status = status;
      entry.lastError = outcome.reason;
      if (status === 'failed' && outcome.nextRetryAt) entry.nextRetryAt = outcome.nextRetryAt;
      else delete entry.nextRetryAt;
      entry.updatedAt = now;
    }
    if (changed) manifest.save(state);
  }

  // -----------------------------------------------------------------------
  // Stage: curation
  // -----------------------------------------------------------------------

  private async runCuration(dueWork: DueWork): Promise<RuntimeLearningCurationReport> {
    if (!this.curator) return skippedCurationReport();

    // Check expedited wakes directly from the curator state file.
    // The planner may have been computed before observations, so the
    // pre-computed dueWork might miss freshly triggered expedited wakes.
    const hasExpedited = this.readExpeditedCuratorCount() > 0;

    if (!dueWork.routineCuratorDue && !dueWork.expeditedCuratorDue && !hasExpedited) {
      return skippedCurationReport();
    }

    try {
      const result = await this.curator.runDue();
      const transitionsByKind: Partial<Record<CapabilityTransitionKind, number>> = {};
      for (const transition of result.transitions) {
        incrementTransition(transitionsByKind, transition.transition);
      }
      return {
        status: result.ran ? 'succeeded' : 'skipped',
        ran: result.ran,
        expedited: result.expedited,
        transitionsByKind,
      };
    } catch (error) {
      return {
        status: 'failed',
        errorMessage: toErrorMessage(error),
        ran: false,
        expedited: false,
        transitionsByKind: {},
      };
    }
  }

  // -----------------------------------------------------------------------
  // Source-neutral discovery + ingestion (issue #75)
  // -----------------------------------------------------------------------

  /**
   * Run source-neutral discovery across all configured Session Log Source
   * adapters (issue #75, #77).
   *
   * === Ordering ===
   * Internal sources are always processed BEFORE external sources so due
   * settlement/review/retry work and internal discovery are protected from
   * optional external scanning (AC2).
   *
   * === Per-source budgets (external only) ===
   * Each external source enforces configurable resource, byte, and elapsed-time
   * quotas per wake (AC1). When a quota is reached the source's remaining
   * resources are deferred to the next wake and the cursor is left resumable
   * (resources examined but not acknowledged are NOT advanced).
   *
   * === Failure isolation ===
   * Provider failures (missing reader, malformed data, transient unavailability)
   * record source-specific status, error context, and retry/backoff state WITHOUT
   * blocking internal or other enabled external source lanes (AC3). Failures are
   * also isolated from candidate review failure accounting — they never increment
   * the Operational Retry counter (AC4).
   *
   * === Backoff ===
   * A source that experiences consecutive failures enters backoff:
   *   1 failure  → 30s suspension
   *   2 failures → 5m suspension
   *   3+ failures → 30m suspension
   * On success the consecutive count resets to zero. Suspended sources are
   * skipped on subsequent wakes until the suspension deadline passes (AC3).
   */
  private async runDiscovery(catchUpPolicy: {
    processCatchUp: boolean;
    allowNewCatchUpGeneration: boolean;
  }): Promise<{
    sourceReports: readonly SessionLogSourceReport[];
    admittedEpisodes: number;
    contradictionSignals: number;
  }> {
    const sourceReports: SessionLogSourceReport[] = [];
    let totalAdmittedEpisodes = 0;
    let totalContradictionSignals = 0;

    // Wake-level caps: bound resources examined, candidates admitted, and
    // wall-clock time so discovery cannot starve the overdue settlement/review
    // stages that run after it. Remaining resources are deferred to the next
    // wake; their cursors are NOT advanced here (only successfully processed
    // resources are acknowledged below), so no cursor is falsely acknowledged.
    const shared = {
      discoveryStartMs: this.clock().getTime(),
      wakeResourcesExamined: 0,
      wakeAdmittedEpisodes: 0,
      discoveryCapped: false,
    };

    // ---- AC2: Internal-first ordering ----
    const orderedSources = this.orderSourcesForDiscovery();
    const internalSources = orderedSources.filter(adapter => adapter.identity.category !== 'external');
    const externalSources = orderedSources.filter(adapter => adapter.identity.category === 'external');

    for (const adapter of internalSources) {
      if (shared.discoveryCapped) break;
      const result = await this.processDiscoverySource(adapter, shared);
      sourceReports.push(result.report);
      totalAdmittedEpisodes += result.admittedEpisodes;
      totalContradictionSignals += result.contradictionSignals;
    }

    if (!shared.discoveryCapped && externalSources.length > 0) {
      const { controller, cancelTimer } = this.createExternalDiscoveryAbortController(shared.discoveryStartMs);
      this.externalReadAbortController = controller;
      let continuousController: AbortController | null = null;
      let continuousCancelTimer: NodeJS.Timeout | null = null;
      let detachContinuousAbort: (() => void) | null = null;
      try {
        const externalReports = new Array<SessionLogSourceReport>(externalSources.length);
        let externalAdmittedEpisodes = 0;
        let externalContradictionSignals = 0;
        const mergeExternalResult = (
          adapter: SessionLogSourceAdapter,
          result: Awaited<ReturnType<RuntimeLearning['processDiscoverySource']>>,
        ) => {
          const index = externalSources.indexOf(adapter);
          externalReports[index] = externalReports[index]
            ? mergeSessionLogSourceReports(externalReports[index]!, result.report)
            : result.report;
          externalAdmittedEpisodes += result.admittedEpisodes;
          externalContradictionSignals += result.contradictionSignals;
        };

        const catchUpSources = catchUpPolicy.processCatchUp ? externalSources
          .filter(adapter => (
            adapter.isEnabled()
            && adapter.getExternalAdmissionConfiguration?.().historyMode === 'catch-up'
            && !this.shouldSkipExternalSourceForFailure(
              this.getExternalSourceFailure(adapter.identity.provider, adapter.identity.sourceId),
            )
          )) : [];
        const dueCatchUpSources = catchUpSources.flatMap(adapter => {
          const action = adapter.getNextCatchUpAction?.();
          return action ? [{ adapter, action }] : [];
        });
        const providersWithDueCatchUp = new Set(
          dueCatchUpSources.map(({ adapter }) => adapter.identity.provider),
        );
        if (catchUpPolicy.allowNewCatchUpGeneration) {
          dueCatchUpSources.push(...catchUpSources
            .filter(adapter => !providersWithDueCatchUp.has(adapter.identity.provider))
            .flatMap(adapter => {
              const action = adapter.getNextCatchUpAction?.({ allowNewGeneration: true });
              return action ? [{ adapter, action }] : [];
            }));
        }

        // Preserve the catch-up continuation observed at the start of the
        // external phase. The initial continuous pass may complete a full
        // provider round and move the shared marker before this quantum runs;
        // it must not erase the historical provider that was next at wake
        // start. No separate scheduler state is introduced.
        const catchUpProviders = [...new Set(
          dueCatchUpSources.map(({ adapter }) => adapter.identity.provider),
        )].sort();
        const firstCatchUpProvider = this.externalAdmissionCoordinator
          .selectNextProvider(catchUpProviders, 'catch-up');
        const firstCatchUpProviderIndex = firstCatchUpProvider
          ? catchUpProviders.indexOf(firstCatchUpProvider)
          : 0;
        const catchUpProviderOrder = firstCatchUpProviderIndex > 0
          ? [
              ...catchUpProviders.slice(firstCatchUpProviderIndex),
              ...catchUpProviders.slice(0, firstCatchUpProviderIndex),
            ]
          : catchUpProviders;
        const orderedCatchUpSources = catchUpProviderOrder.flatMap(provider => {
          const sources = dueCatchUpSources
            .filter(({ adapter }) => adapter.identity.provider === provider)
            .sort((left, right) => left.adapter.identity.sourceId.localeCompare(
              right.adapter.identity.sourceId,
              'en',
            ));
          const firstSource = this.externalAdmissionCoordinator.selectNextSource(
            provider,
            sources.map(({ adapter }) => adapter.identity.sourceId),
            'catch-up',
          );
          const firstSourceIndex = firstSource
            ? sources.findIndex(({ adapter }) => adapter.identity.sourceId === firstSource)
            : 0;
          return firstSourceIndex > 0
            ? [...sources.slice(firstSourceIndex), ...sources.slice(0, firstSourceIndex)]
            : sources;
        });

        const sortedProviders = [...new Set(
          externalSources.map(adapter => adapter.identity.provider),
        )].sort();
        const firstProvider = this.externalAdmissionCoordinator.selectNextProvider(
          sortedProviders,
          'continuous',
        );
        const firstProviderIndex = firstProvider ? sortedProviders.indexOf(firstProvider) : 0;
        const providerOrder = firstProviderIndex > 0
          ? [
              ...sortedProviders.slice(firstProviderIndex),
              ...sortedProviders.slice(0, firstProviderIndex),
            ]
          : sortedProviders;
        const orderedContinuousSources = providerOrder.flatMap(provider => {
          const providerSources = externalSources
            .filter(adapter => adapter.identity.provider === provider)
            .sort((left, right) => left.identity.sourceId.localeCompare(right.identity.sourceId, 'en'));
          const firstSource = this.externalAdmissionCoordinator.selectNextSource(
            provider,
            providerSources.map(adapter => adapter.identity.sourceId),
            'continuous',
          );
          const firstSourceIndex = firstSource
            ? providerSources.findIndex(adapter => adapter.identity.sourceId === firstSource)
            : 0;
          return firstSourceIndex > 0
            ? [...providerSources.slice(firstSourceIndex), ...providerSources.slice(0, firstSourceIndex)]
            : providerSources;
        });
        const runContinuousPass = async (
          signal: AbortSignal,
          wakeResourceLimit: number,
          wakeAdmissionLimit: number,
        ) => {
          await mapWithConcurrency(
            orderedContinuousSources.map(adapter => ({ adapter })),
            this.externalSourceMaxConcurrency,
            async ({ adapter }) => {
              if (shared.discoveryCapped) return;
              const result = await this.processDiscoverySource(adapter, shared, {
                signal,
                workLane: 'continuous',
                wakeResourceLimit,
                wakeAdmissionLimit,
              });
              mergeExternalResult(adapter, result);
            },
          );
        };

        // Give timely continuous work a bounded opportunity while reserving
        // one resource/admission slot and part of the deadline for the global
        // catch-up quantum. Empty or unused reserved capacity is donated below.
        const catchUpQuantumDue = dueCatchUpSources.length > 0;
        const initialContinuousResourceLimit = catchUpQuantumDue
          ? Math.max(0, this.discoveryQuotas.maxResourcesPerWake - 1)
          : this.discoveryQuotas.maxResourcesPerWake;
        const initialContinuousAdmissionLimit = catchUpQuantumDue
          ? Math.max(0, this.discoveryQuotas.maxAdmittedEpisodesPerWake - 1)
          : this.discoveryQuotas.maxAdmittedEpisodesPerWake;
        let initialContinuousSignal = controller.signal;
        if (catchUpQuantumDue) {
          continuousController = new AbortController();
          const abortContinuous = () => continuousController?.abort();
          if (controller.signal.aborted) abortContinuous();
          else {
            controller.signal.addEventListener('abort', abortContinuous, { once: true });
            detachContinuousAbort = () => controller.signal.removeEventListener('abort', abortContinuous);
          }
          const remainingExternalMs = Math.max(
            0,
            this.discoveryQuotas.maxDiscoveryMs - (this.clock().getTime() - shared.discoveryStartMs),
          );
          const catchUpElapsedReserve = Math.min(
            Math.max(1, this.externalSourceBudget.maxElapsedMsPerWake),
            Math.max(1, Math.floor(remainingExternalMs / 2)),
          );
          const continuousElapsedMs = Math.max(0, remainingExternalMs - catchUpElapsedReserve);
          if (continuousElapsedMs === 0) abortContinuous();
          else {
            continuousCancelTimer = setTimeout(abortContinuous, continuousElapsedMs);
            continuousCancelTimer.unref?.();
          }
          initialContinuousSignal = continuousController.signal;
        }
        await runContinuousPass(
          initialContinuousSignal,
          initialContinuousResourceLimit,
          initialContinuousAdmissionLimit,
        );
        if (continuousCancelTimer) {
          clearTimeout(continuousCancelTimer);
          continuousCancelTimer = null;
        }
        detachContinuousAbort?.();
        detachContinuousAbort = null;

        // Internal work is complete. Consume at most one source-derived global
        // catch-up quantum, skipping providers that cannot currently claim it.
        const knownCatchUpProviders = [...new Set(
          dueCatchUpSources.map(({ adapter }) => adapter.identity.provider),
        )];
        let catchUpConsumedResource = false;
        for (const { adapter, action } of orderedCatchUpSources) {
          if (shared.discoveryCapped || controller.signal.aborted) break;
          const result = await this.processDiscoverySource(adapter!, shared, {
            signal: controller.signal,
            workLane: 'catch-up',
            catchUpAction: action,
          });
          mergeExternalResult(adapter!, result);
          const actionCompleted = action === 'page'
            ? result.report.advancedResources > 0
            : result.report.status === 'active';
          if (!actionCompleted) continue;
          catchUpConsumedResource = result.report.advancedResources > 0;
          this.externalAdmissionCoordinator.completeCatchUpQuantum(
            knownCatchUpProviders,
            adapter!.identity.provider,
            adapter!.identity.sourceId,
          );
          break;
        }

        // Any capacity left after the one catch-up quantum is donated to
        // continuous work. There is no second historical pass in this wake.
        if (
          catchUpQuantumDue
          && !catchUpConsumedResource
          && !shared.discoveryCapped
          && !controller.signal.aborted
          && shared.wakeResourcesExamined < this.discoveryQuotas.maxResourcesPerWake
          && shared.wakeAdmittedEpisodes < this.discoveryQuotas.maxAdmittedEpisodesPerWake
        ) {
          await runContinuousPass(
            controller.signal,
            this.discoveryQuotas.maxResourcesPerWake,
            this.discoveryQuotas.maxAdmittedEpisodesPerWake,
          );
        }
        if (controller.signal.aborted) {
          for (const adapter of externalSources) {
            const index = externalSources.indexOf(adapter);
            if (externalReports[index]) continue;
            const result = await this.processDiscoverySource(adapter, shared, {
              signal: controller.signal,
              workLane: 'continuous',
            });
            mergeExternalResult(adapter, result);
          }
        }
        sourceReports.push(...externalReports.filter((report): report is SessionLogSourceReport => Boolean(report)));
        totalAdmittedEpisodes += externalAdmittedEpisodes;
        totalContradictionSignals += externalContradictionSignals;
      } finally {
        detachContinuousAbort?.();
        if (continuousCancelTimer) clearTimeout(continuousCancelTimer);
        this.externalReadAbortController = null;
        if (cancelTimer) clearTimeout(cancelTimer);
      }
    }

    // Persist external source scheduling state (backoff deadlines) for restart
    // recovery (AC6).
    this.saveExternalSourceSchedulingState();
    this.externalEpisodeProvenanceStore.flush();
    this.reconcileCompletedHistoricalTargets();

    return {
      sourceReports,
      admittedEpisodes: totalAdmittedEpisodes,
      contradictionSignals: totalContradictionSignals,
    };
  }

  private createExternalDiscoveryAbortController(
    discoveryStartMs: number,
  ): { controller: AbortController; cancelTimer: NodeJS.Timeout | null } {
    const controller = new AbortController();
    if (this.shutdownDrainRequested || this.externalSourceDrainRequested) {
      controller.abort();
      return { controller, cancelTimer: null };
    }
    const remainingMs = Math.max(
      0,
      this.discoveryQuotas.maxDiscoveryMs - (this.clock().getTime() - discoveryStartMs),
    );
    if (remainingMs === 0) {
      controller.abort();
      return { controller, cancelTimer: null };
    }
    const cancelTimer = setTimeout(() => controller.abort(), remainingMs);
    cancelTimer.unref?.();
    return { controller, cancelTimer };
  }

  private reconcileCompletedHistoricalTargets(): void {
    const completedTargetIds = new Set<string>();
    const abandonedTargetIds = new Set<string>();
    for (const adapter of this.sessionLogSources) {
      if (adapter.identity.category !== 'external') continue;
      const storePath = adapter.getCursorStorePath?.();
      if (!storePath) continue;
      const state = loadExternalCursorState(storePath);
      for (const [resourceRef, progress] of Object.entries(state.catchUpResources)) {
        const target = state.catchUpTargets[resourceRef];
        if (!target || target.empty) continue;
        if (progress.status === 'complete') completedTargetIds.add(target.targetId);
        if (progress.status === 'abandoned' || progress.status === 'closed') {
          abandonedTargetIds.add(target.targetId);
        }
      }
      for (const reopened of Object.values(state.reopenedRanges)) {
        if (reopened.originalTargetId) {
          this.episodeStore.reopenHistoricalTarget(reopened.originalTargetId, {
            targetId: reopened.targetId,
            provider: reopened.provider,
            sourceId: reopened.sourceId,
            resourceRef: reopened.resourceRef,
            position: reopened.range.endPosition,
            prefixDigest: reopened.prefixDigest,
          });
        }
        if (reopened.status === 'complete' || reopened.status === 'terminal-excluded') {
          completedTargetIds.add(reopened.targetId);
        }
      }
    }
    for (const targetId of abandonedTargetIds) {
      this.episodeStore.abandonHistoricalTarget(targetId);
    }
    for (const targetId of completedTargetIds) {
      this.episodeStore.reconcileHistoricalTarget(targetId);
    }

    // Refresh durable external capsules for historical episodes whose fixed
    // immutable target just completed or was abandoned, so their pinned
    // admission capsule (recorded while the episode was still
    // historical-pending) reflects the authoritative matured status before
    // review enqueues.
    const maturedHistoricalEpisodes = Object.values(this.episodeStore.load().episodes).filter(
      episode => episode.historicalTarget !== undefined
        && (completedTargetIds.has(episode.historicalTarget.targetId)
          || abandonedTargetIds.has(episode.historicalTarget.targetId)),
    );
    this.refreshExternalCapsuleSettlementEvidence(maturedHistoricalEpisodes);
  }

  private async processDiscoverySource(
    adapter: SessionLogSourceAdapter,
    shared: {
      discoveryStartMs: number;
      wakeResourcesExamined: number;
      wakeAdmittedEpisodes: number;
      discoveryCapped: boolean;
    },
    options: {
      signal?: AbortSignal;
      workLane?: ExternalSourceWorkLane;
      catchUpAction?: ExternalCatchUpAction;
      wakeResourceLimit?: number;
      wakeAdmissionLimit?: number;
    } = {},
  ): Promise<{
    report: SessionLogSourceReport;
    admittedEpisodes: number;
    contradictionSignals: number;
  }> {
    const identity = adapter.identity;
    const isExternal = identity.category === 'external';
    const enabled = adapter.isEnabled();
    const budget = isExternal ? this.externalSourceBudget : this.internalSourceBudget;
    const wakeResourceLimit = options.wakeResourceLimit ?? this.discoveryQuotas.maxResourcesPerWake;
    const wakeAdmissionLimit = options.wakeAdmissionLimit ?? this.discoveryQuotas.maxAdmittedEpisodesPerWake;

    if (!enabled) {
      return {
        report: {
          sourceId: identity.sourceId,
          category: identity.category,
          enabled: false,
          resourcesDiscovered: 0,
          unitsProcessed: 0,
          advancedResources: 0,
          status: 'active',
          ...(isExternal
            ? this.buildExternalSourceReportDiagnostics(
              identity,
              this.getExternalSourceFailure(identity.provider, identity.sourceId),
            )
            : {}),
        },
        admittedEpisodes: 0,
        contradictionSignals: 0,
              };
    }

    if (isExternal && (this.shutdownDrainRequested || this.externalSourceDrainRequested || options.signal?.aborted)) {
      const failureState = this.getExternalSourceFailure(identity.provider, identity.sourceId);
      return {
        report: {
          sourceId: identity.sourceId,
          category: identity.category,
          enabled: true,
          resourcesDiscovered: 0,
          unitsProcessed: 0,
          advancedResources: 0,
          status: 'drained',
          failureState,
          ...this.buildExternalSourceReportDiagnostics(identity, failureState),
        },
        admittedEpisodes: 0,
        contradictionSignals: 0,
              };
    }

    if (isExternal) {
      const failureState = this.getProviderBlockingExternalFailure(identity.provider)
        ?? this.getExternalSourceFailure(identity.provider, identity.sourceId);
      if (this.shouldSkipExternalSourceForFailure(failureState)) {
        return {
          report: {
            sourceId: identity.sourceId,
            category: identity.category,
            enabled: true,
            resourcesDiscovered: 0,
            unitsProcessed: 0,
            advancedResources: 0,
            status: 'backoff',
            failureState,
            ...this.buildExternalSourceReportDiagnostics(identity, failureState),
          },
          admittedEpisodes: 0,
          contradictionSignals: 0,
                  };
      }
    }

    const providerLock = isExternal
      ? this.acquireExternalProviderLock(identity.provider, 'continuous-discovery', identity.sourceId)
      : null;
    if (providerLock && !providerLock.acquired) {
      const failureState = this.getExternalSourceFailure(identity.provider, identity.sourceId);
      return {
        report: {
          sourceId: identity.sourceId,
          category: identity.category,
          enabled: true,
          resourcesDiscovered: 0,
          unitsProcessed: 0,
          advancedResources: 0,
          status: 'locked',
          failureState,
          budget,
          ...this.buildExternalSourceReportDiagnostics(identity, failureState),
          ...(adapter.getSupportStatus ? { supportStatus: adapter.getSupportStatus() } : {}),
          ...(adapter.getUnsupportedReason?.() ? { unsupportedReason: adapter.getUnsupportedReason() } : {}),
        },
        admittedEpisodes: 0,
        contradictionSignals: 0,
              };
    }

    const activeReadKey = isExternal ? externalSourceLaneKey(identity) : null;
    const activeReadController = isExternal ? new AbortController() : null;
    let detachParentAbort: (() => void) | null = null;
    if (activeReadKey && activeReadController) {
      const abortActiveRead = () => activeReadController.abort();
      if (options.signal?.aborted) abortActiveRead();
      else if (options.signal) {
        options.signal.addEventListener('abort', abortActiveRead, { once: true });
        detachParentAbort = () => options.signal?.removeEventListener('abort', abortActiveRead);
      }
      this.activeExternalReadAbortControllers.set(activeReadKey, activeReadController);
      options = { ...options, signal: activeReadController.signal };
    }

    let sourceResourcesExamined = 0;
    let sourceResourcesBackedOff = 0;
    let sourceBytesRead = 0;
    let sourceEventsRead = 0;
    let sourceReaderElapsedMs = 0;
    let sourceHadFailure = false;
    let sourceBudgetHit = false;
    let sourceDrained = false;
    let unitsProcessed = 0;
    let advancedResources = 0;
    let totalAdmittedEpisodes = 0;
    let totalContradictionSignals = 0;
    const sourceStartMs = this.clock().getTime();

    try {
      let resources: readonly SessionLogSourceResource[];
      try {
        resources = adapter.discoverResources({
          maxResources: Math.min(
            budget.maxResourcesPerWake,
            Math.max(1, wakeResourceLimit - shared.wakeResourcesExamined),
          ),
          maxElapsedMs: Math.min(
            budget.maxElapsedMsPerWake,
            Math.max(1, this.discoveryQuotas.maxDiscoveryMs - (this.clock().getTime() - shared.discoveryStartMs)),
          ),
          workLane: options.workLane,
          catchUpAction: options.catchUpAction,
        });
      } catch (error) {
        sourceHadFailure = true;
        if (isExternal) this.recordExternalSourceFailure(identity, error);
        const failureState = isExternal
          ? this.getExternalSourceFailure(identity.provider, identity.sourceId)
          : undefined;
        return {
          report: {
            sourceId: identity.sourceId,
            category: identity.category,
            enabled: true,
            resourcesDiscovered: 0,
            unitsProcessed: 0,
            advancedResources: 0,
            status: 'failed',
            failureState,
            budget,
            ...(isExternal ? this.buildExternalSourceReportDiagnostics(identity, failureState) : {}),
          },
          admittedEpisodes: 0,
          contradictionSignals: 0,
                  };
      }

      const readContextBase: SessionLogSourceReadContext = { orderedResources: resources };

      for (const resource of resources) {
        if (shared.discoveryCapped) break;
        if (isExternal && options.signal?.aborted) {
          sourceDrained = true;
          break;
        }
        if (
          isExternal
          && this.shouldSkipExternalResourceForFailure(
            this.getExternalResourceFailure(
              identity.provider,
              identity.sourceId,
              resource.resourceRef,
            ),
            resource.resourceRef,
          )
        ) {
          sourceResourcesBackedOff += 1;
          continue;
        }

        if (sourceResourcesExamined >= budget.maxResourcesPerWake) {
          sourceBudgetHit = true;
          break;
        }
        if (budget.maxBytesPerWake > 0 && sourceBytesRead >= budget.maxBytesPerWake) {
          sourceBudgetHit = true;
          break;
        }
        const sourceElapsedMs = this.clock().getTime() - sourceStartMs;
        if (sourceResourcesExamined > 0 && sourceElapsedMs >= budget.maxElapsedMsPerWake) {
          sourceBudgetHit = true;
          break;
        }
        sourceResourcesExamined++;

        if (shared.wakeResourcesExamined >= wakeResourceLimit) {
          sourceBudgetHit = true;
          if (wakeResourceLimit >= this.discoveryQuotas.maxResourcesPerWake) {
            shared.discoveryCapped = true;
          }
          break;
        }
        if (shared.wakeAdmittedEpisodes >= wakeAdmissionLimit) {
          sourceBudgetHit = true;
          if (wakeAdmissionLimit >= this.discoveryQuotas.maxAdmittedEpisodesPerWake) {
            shared.discoveryCapped = true;
          }
          break;
        }
        if (
          shared.wakeResourcesExamined > 0
          && this.clock().getTime() - shared.discoveryStartMs > this.discoveryQuotas.maxDiscoveryMs
        ) {
          shared.discoveryCapped = true;
          break;
        }
        shared.wakeResourcesExamined++;

        let readResult: SessionLogSourceReadResult;
        try {
          const elapsedMs = Math.max(0, this.clock().getTime() - sourceStartMs);
          const readContext: SessionLogSourceReadContext = {
            ...readContextBase,
            workLane: options.workLane,
            remainingAdmissionEvents: Math.max(
              0,
              wakeAdmissionLimit - shared.wakeAdmittedEpisodes,
            ),
            remainingBudget: {
              maxResourcesPerWake: Math.max(0, budget.maxResourcesPerWake - sourceResourcesExamined + 1),
              maxBytesPerWake: Math.max(0, budget.maxBytesPerWake - sourceBytesRead),
              maxElapsedMsPerWake: Math.max(0, budget.maxElapsedMsPerWake - elapsedMs),
            },
          };
          if (isExternal && adapter.readAsync) {
            readResult = await adapter.readAsync(resource, readContext, options.signal ?? new AbortController().signal);
          } else if (isExternal) {
            readResult = await Promise.resolve().then(() => adapter.read(resource, readContext));
          } else {
            readResult = adapter.read(resource, readContext);
          }
        } catch (error) {
          if (isExternal && options.signal?.aborted) {
            sourceDrained = true;
            break;
          }
          adapter.markFailed(resource, error);
          sourceHadFailure = true;
          if (isExternal) {
            const failureClass = this.classifyExternalSourceFailure(
              this.redactExternalSourceError(error),
            );
            this.recordExternalSourceFailure(identity, error, {
              failureClass,
              resourceRef: resource.resourceRef,
            });
            if (isProviderBlockingExternalFailure(failureClass)) break;
          }
          continue;
        }

        if (isExternal && options.signal?.aborted) {
          sourceDrained = true;
          break;
        }
        if (isExternal && !this.isExternalReadConfigurationCurrent(adapter)) {
          // Mode/scope/provider changes invalidate work that is still Reading
          // or Ready. No acknowledgement has started, so replay under the new
          // configuration remains lossless. Once admitPage starts below, the
          // coordinator owns an atomic Committing page and may finish it.
          continue;
        }

        if (readResult.status === 'failed') {
          const failure = readResult.failure;
          adapter.markFailed(resource, new Error(failure?.message ?? 'source read reported failed status'));
          sourceHadFailure = true;
          if (isExternal) {
            const failedEvent = failure?.eventIdentities?.[0]
              ?? readResult.eventIdentities?.[0];
            if (failure?.failureClass === 'quarantine' || failure?.failureClass === 'integrity_conflict') {
              if (failedEvent) {
                this.recordExternalSourceQuarantine(
                  identity,
                  resource.resourceRef,
                  failedEvent,
                  failure.failureClass,
                  failure.message,
                  readResult.newCursor.position,
                );
              }
            }
            this.recordExternalSourceFailure(identity, new Error(failure?.message ?? 'source read reported failed status'), {
              failureClass: failure?.failureClass,
              resourceRef: failure?.resourceRef ?? resource.resourceRef,
              eventId: failedEvent?.eventId,
            });
            if (isProviderBlockingExternalFailure(failure?.failureClass)) break;
          }
          continue;
        }

        const distillationUnits = readResult.distillationUnits
          ?? (readResult.distillationUnit ? [readResult.distillationUnit] : []);
        const unitBytes = distillationUnits.reduce(
          (total, unit) => total + Math.max(0, unit.byteRange.end - unit.byteRange.start),
          0,
        );
        sourceBytesRead += readResult.accounting?.bytes ?? unitBytes;
        sourceEventsRead += readResult.accounting?.events ?? distillationUnits.length;
        sourceReaderElapsedMs += readResult.accounting?.elapsedMs ?? 0;

        if (distillationUnits.length === 0) {
          if (readResult.advanced || readResult.releaseResource) {
            try {
              if (isExternal) {
                const knownExternalProviders = this.orderSourcesForDiscovery()
                  .filter(candidate => candidate.identity.category === 'external' && candidate.isEnabled())
                  .map(candidate => candidate.identity.provider);
                if (this.shouldDiscardExternalReadyWork(adapter, options.signal)) {
                  sourceDrained = true;
                  continue;
                }
                const commitResult = this.externalAdmissionCoordinator.admitPages([{
                  providerId: identity.provider,
                  sourceId: identity.sourceId,
                  identity,
                  resource,
                  distillationUnits: [],
                  eventIdentities: [],
                  readResult,
                  lane: readResult.admissionLane
                    ?? options.workLane
                    ?? adapter.getAdmissionLane?.(resource)
                    ?? 'continuous',
                }], knownExternalProviders)[0];
                if (!commitResult) {
                  throw new Error('external admission coordinator did not select a ready page');
                }
                if (!commitResult.acknowledged) {
                  throw commitResult.error ?? new Error('external admission coordinator commit failed');
                }
              } else {
                adapter.acknowledge(resource, readResult);
              }
              if (readResult.advanced) advancedResources++;
              if (isExternal) {
                this.resetExternalSourceFailure(identity, resource.resourceRef);
              }
            } catch (error) {
              adapter.markFailed(resource, error);
              sourceHadFailure = true;
              if (isExternal) {
                this.recordExternalSourceFailure(identity, error, { resourceRef: resource.resourceRef });
              }
            }
          } else if (
            isExternal
            && !options.signal?.aborted
            && readResult.status === 'idle'
          ) {
            this.recordExternalSourceFailure(identity, new Error('pending external range remains unacknowledged'), {
              failureClass: 'pending',
              resourceRef: resource.resourceRef,
            });
          }
          continue;
        }

        let batchEventInProgress: SourceEventIdentity | undefined;
        try {
          const eventIdentities = readResult.eventIdentities ?? [];
          if (isExternal && eventIdentities.length > 0 && eventIdentities.length !== distillationUnits.length) {
            throw new Error('stable external batch is missing one or more event identities');
          }

          // Wake-level quota check before commit.
          if (
            shared.wakeAdmittedEpisodes + distillationUnits.length
            > wakeAdmissionLimit
          ) {
            if (wakeAdmissionLimit >= this.discoveryQuotas.maxAdmittedEpisodesPerWake) {
              shared.discoveryCapped = true;
            }
            throw new DiscoveryAdmissionQuotaReachedError();
          }

          let batchAdmittedEpisodes = 0;
          let batchContradictionSignals = 0;

          if (isExternal) {
            // Route external commits through the External Admission Coordinator
            // (issue #93). The coordinator is the single-writer boundary:
            // all external Episode, Capsule, provenance, and cursor mutations
            // pass through it serially. The commit function preserves the
            // Episode → Capsule → provenance → cursor acknowledgement order.
            const knownExternalProviders = this.orderSourcesForDiscovery()
              .filter((a): a is SessionLogSourceAdapter => a.identity.category === 'external' && a.isEnabled())
              .map(a => a.identity.provider);
            const page: ExternalEvidencePage = {
              providerId: identity.provider,
              sourceId: identity.sourceId,
              identity,
              resource,
              distillationUnits,
              eventIdentities,
              readResult,
              lane: readResult.admissionLane
                ?? options.workLane
                ?? adapter.getAdmissionLane?.(resource)
                ?? 'continuous',
            };
            if (this.shouldDiscardExternalReadyWork(adapter, options.signal)) {
              sourceDrained = true;
              continue;
            }
            const commitResult = this.externalAdmissionCoordinator.admitPages(
              [page],
              knownExternalProviders,
            )[0];
            if (!commitResult) {
              throw new Error('external admission coordinator did not select a ready page');
            }
            if (!commitResult.acknowledged) {
              throw commitResult.error ?? new Error('external admission coordinator commit failed');
            }
            batchAdmittedEpisodes = commitResult.admittedEpisodes;
            batchContradictionSignals = commitResult.contradictionSignals;
          } else {
            // Internal sources: existing inline commit logic (unchanged).
            for (let index = 0; index < distillationUnits.length; index++) {
              if (
                shared.wakeAdmittedEpisodes + batchAdmittedEpisodes
                >= wakeAdmissionLimit
              ) {
                if (wakeAdmissionLimit >= this.discoveryQuotas.maxAdmittedEpisodesPerWake) {
                  shared.discoveryCapped = true;
                }
                throw new DiscoveryAdmissionQuotaReachedError();
              }
              const eventIdentity = eventIdentities[index]
                ?? (distillationUnits.length === 1
                  ? (resource.firstEventIdentity ?? { eventId: resource.resourceRef, position: 0 })
                  : undefined);
              const resolvedEventIdentity = eventIdentity ?? {
                eventId: resource.resourceRef,
                position: index,
              };
              batchEventInProgress = resolvedEventIdentity;

              const ingestUnit = distillationUnits[index]!;
              const ingestionResult = this.evidenceIngestor.ingest(ingestUnit);

              batchAdmittedEpisodes += ingestionResult.admittedEpisodeIds.length;
              batchContradictionSignals += ingestionResult.contradictionSignalIds.length;
            }

            adapter.acknowledge(resource, readResult);
          }
          unitsProcessed += distillationUnits.length;
          advancedResources++;
          totalAdmittedEpisodes += batchAdmittedEpisodes;
          shared.wakeAdmittedEpisodes += batchAdmittedEpisodes;
          totalContradictionSignals += batchContradictionSignals;
          if (isExternal) {
            this.resetExternalSourceFailure(identity, resource.resourceRef);
          }
        } catch (error) {
          if (error instanceof DiscoveryAdmissionQuotaReachedError) {
            sourceBudgetHit = true;
            break;
          }
          adapter.markFailed(resource, error);
          sourceHadFailure = true;
          if (isExternal) {
            const message = this.redactExternalSourceError(error);
            const failureClass = this.classifyExternalSourceFailure(message);
            const eventIdentity = batchEventInProgress
              ?? readResult.eventIdentities?.[0];
            if (
              (failureClass === 'quarantine' || failureClass === 'integrity_conflict')
              && eventIdentity
              && !(error && typeof error === 'object' && (error as Record<string, unknown>).externalAdmissionFailureRecorded === true)
            ) {
              this.recordExternalSourceQuarantine(
                identity,
                resource.resourceRef,
                eventIdentity,
                failureClass,
                message,
                readResult.newCursor.position,
              );
            }
            this.recordExternalSourceFailure(identity, error, {
              failureClass,
              resourceRef: resource.resourceRef,
              eventId: eventIdentity?.eventId,
            });
            if (isProviderBlockingExternalFailure(failureClass)) break;
          }
        }
      }

      let status: SessionLogSourceStatus = 'active';
      if (sourceDrained) status = 'drained';
      else if (sourceHadFailure) status = 'failed';
      else if (resources.length > 0 && sourceResourcesBackedOff === resources.length) status = 'backoff';
      if (sourceBudgetHit && !sourceDrained) status = 'quota_reached';

      const failureState = isExternal
        ? this.getExternalSourceFailure(identity.provider, identity.sourceId)
        : undefined;

      return {
        report: {
          sourceId: identity.sourceId,
          category: identity.category,
          enabled: true,
          resourcesDiscovered: resources.length,
          unitsProcessed,
          advancedResources,
          status,
          failureState,
          budget,
          accounting: {
            events: sourceEventsRead,
            bytes: sourceBytesRead,
            elapsedMs: Math.max(sourceReaderElapsedMs, this.clock().getTime() - sourceStartMs),
          },
          ...(adapter.getSupportStatus ? { supportStatus: adapter.getSupportStatus() } : {}),
          ...(adapter.getUnsupportedReason?.() ? { unsupportedReason: adapter.getUnsupportedReason() } : {}),
          ...(isExternal ? this.buildExternalSourceReportDiagnostics(identity, failureState) : {}),
        },
        admittedEpisodes: totalAdmittedEpisodes,
        contradictionSignals: totalContradictionSignals,
      };
    } finally {
      detachParentAbort?.();
      if (activeReadKey
        && this.activeExternalReadAbortControllers.get(activeReadKey) === activeReadController) {
        this.activeExternalReadAbortControllers.delete(activeReadKey);
      }
      if (providerLock?.acquired) providerLock.release();
    }
  }

  // -----------------------------------------------------------------------
  // Source ordering and external failure management (issue #77)
  // -----------------------------------------------------------------------

   /**
   * Order session log sources for discovery: internal sources are processed
   * BEFORE external sources. This protects due settlement/review/retry work
   * and internal discovery from optional external scanning (AC2).
   *
   * External sources are ordered by the External Admission Coordinator's
   * round-robin selection (issue #93), so a stable provider ordering cannot
   * starve later providers across wakes or restarts.
   */
  private orderSourcesForDiscovery(): readonly SessionLogSourceAdapter[] {
    const internal: SessionLogSourceAdapter[] = [];
    const external: SessionLogSourceAdapter[] = [];
    for (const adapter of this.sessionLogSources) {
      if (adapter.identity.category === 'external') {
        external.push(adapter);
      } else {
        internal.push(adapter);
      }
    }

    // Use the coordinator's round-robin selection for external source ordering.
    const ordered: SessionLogSourceAdapter[] = [];
    const remaining = new Set(external);

    // Serve external sources in coordinator-determined round-robin order.
    while (remaining.size > 0) {
      const nextProvider = this.externalAdmissionCoordinator.selectNextProvider(
        [...remaining].filter(a => a.isEnabled()).map(a => a.identity.provider),
        'continuous',
      );
      if (!nextProvider) break;
      const nextAdapter = [...remaining].find(
        a => a.identity.provider === nextProvider,
      );
      if (!nextAdapter) break;
      ordered.push(nextAdapter);
      remaining.delete(nextAdapter);
    }
    // Append any remaining external sources (e.g., disabled ones).
    for (const adapter of remaining) {
      ordered.push(adapter);
    }

    return [...internal, ...ordered];
  }

  private recordExternalSourceFailure(
    identity: ExternalSourceLaneIdentity,
    error: unknown,
    context: {
      failureClass?: ExternalSourceFailureClass;
      resourceRef?: string;
      eventId?: string;
    } = {},
  ): void {
    const message = this.redactExternalSourceError(error);
    const failureClass = context.failureClass ?? this.classifyExternalSourceFailure(message);
    const resourceLocal = context.resourceRef !== undefined
      && (
        failureClass === 'transient'
        || failureClass === 'pending'
        || failureClass === 'quarantine'
      );
    const current = resourceLocal
      ? this.getExternalResourceFailure(
        identity.provider,
        identity.sourceId,
        context.resourceRef!,
      )
      : this.getExternalSourceFailure(identity.provider, identity.sourceId);
    const now = this.clock();
    const nowIso = now.toISOString();

    let consecutiveFailures = current?.consecutiveFailures ?? 0;
    let nextRetryAt: string | null = current?.nextRetryAt ?? null;
    let suspendedUntil: string | null = current?.suspendedUntil ?? null;
    let requiresOperatorAction = false;

    switch (failureClass) {
      case 'transient': {
        consecutiveFailures += 1;
        const suspensionMs = consecutiveFailures >= 3
          ? 30 * 60 * 1000
          : consecutiveFailures >= 2
            ? 5 * 60 * 1000
            : 30_000;
        nextRetryAt = new Date(now.getTime() + suspensionMs).toISOString();
        suspendedUntil = nextRetryAt;
        break;
      }
      case 'permission': {
        consecutiveFailures += 1;
        nextRetryAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
        suspendedUntil = nextRetryAt;
        break;
      }
      case 'pending': {
        nextRetryAt = nowIso;
        suspendedUntil = null;
        break;
      }
      case 'protocol':
      case 'integrity_conflict':
      case 'quarantine': {
        consecutiveFailures += 1;
        nextRetryAt = null;
        suspendedUntil = null;
        requiresOperatorAction = true;
        break;
      }
      default:
        break;
    }

    const state: SourceFailureState = {
      consecutiveFailures,
      lastFailedAt: nowIso,
      lastError: message,
      suspendedUntil,
      failureClass,
      nextRetryAt,
      requiresOperatorAction,
      resourceRef: context.resourceRef,
      eventId: context.eventId,
      lastAttemptedAt: nowIso,
      lastSuccessfulReadAt: current?.lastSuccessfulReadAt ?? null,
    };
    if (resourceLocal) {
      this.setExternalResourceFailure(
        identity.provider,
        identity.sourceId,
        context.resourceRef!,
        state,
      );
    }
    this.setExternalSourceFailure(identity.provider, identity.sourceId, state);
  }

  private resetExternalSourceFailure(
    identity: ExternalSourceLaneIdentity,
    resourceRef?: string,
  ): void {
    let current = this.getExternalSourceFailure(identity.provider, identity.sourceId);
    // Only update if the source had prior state — a healthy source that never
    // failed should not accumulate a scheduling-state entry just from a
    // successful read. When prior state exists, clear the failure counters and
    // record the successful read timestamp for diagnostics.
    if (resourceRef) {
      const resourceKey = externalResourceLaneKey({ ...identity, resourceRef });
      const resourceFailure = this.externalResourceFailureState.get(resourceKey);
      if (resourceFailure) {
        this.externalResourceFailureState.delete(resourceKey);
        this.externalSourceSchedulingStateDirty = true;
        const remaining = [...this.listExternalResourceFailures(identity.provider, identity.sourceId)]
          .sort((left, right) => (left.lastFailedAt ?? '').localeCompare(right.lastFailedAt ?? ''));
        const representative = remaining[remaining.length - 1];
        if (representative) {
          this.setExternalSourceFailure(identity.provider, identity.sourceId, {
            ...representative,
            lastSuccessfulReadAt: this.clock().toISOString(),
          });
          return;
        }
        current = resourceFailure;
      } else if (
        current?.resourceRef
        && current.resourceRef !== resourceRef
        && isResourceLocalExternalFailure(current)
      ) {
        return;
      }
    }
    if (!current) return;
    const nowIso = this.clock().toISOString();
    this.setExternalSourceFailure(identity.provider, identity.sourceId, {
      consecutiveFailures: 0,
      lastFailedAt: null,
      lastError: null,
      suspendedUntil: null,
      failureClass: undefined,
      nextRetryAt: null,
      requiresOperatorAction: false,
      resourceRef: undefined,
      eventId: undefined,
      lastAttemptedAt: current.lastAttemptedAt ?? null,
      lastSuccessfulReadAt: nowIso,
    });
  }

  private classifyExternalSourceFailure(message: string): ExternalSourceFailureClass {
    return classifyExternalSourceFailureMessage(message);
  }

  private redactExternalSourceError(error: unknown): string {
    return redactExternalSourceDiagnostic(error);
  }

  private shouldSkipExternalSourceForFailure(state: SourceFailureState | undefined): boolean {
    if (!state) return false;
    // Event quarantine is resource-local: selection filters only that resource.
    // Transient/pending reads with a resource identity use the same local
    // scheduling rule. Protocol/integrity failures still pause the provider
    // because normalized source identity is no longer trustworthy.
    if (state.resourceRef && isResourceLocalExternalFailure(state)) return false;
    if (state.requiresOperatorAction) return true;
    if (!state.suspendedUntil) return false;
    const suspendedUntilMs = Date.parse(state.suspendedUntil);
    return Number.isFinite(suspendedUntilMs) && suspendedUntilMs > this.clock().getTime();
  }

  private getProviderBlockingExternalFailure(provider: string): SourceFailureState | undefined {
    const normalizedProvider = provider.trim().toLowerCase();
    for (const [key, state] of this.externalSourceFailureState) {
      const identity = parseExternalSourceLaneKey(key);
      if (
        identity?.provider === normalizedProvider
        && isProviderBlockingExternalFailure(state.failureClass)
        && state.requiresOperatorAction
      ) {
        return state;
      }
    }
    return undefined;
  }

  private shouldSkipExternalResourceForFailure(
    state: SourceFailureState | undefined,
    resourceRef: string,
  ): boolean {
    if (!state?.resourceRef || state.resourceRef !== resourceRef) return false;
    if (!isResourceLocalExternalFailure(state)) return false;
    if (state.requiresOperatorAction) return true;
    if (!state.suspendedUntil) return false;
    const suspendedUntilMs = Date.parse(state.suspendedUntil);
    return Number.isFinite(suspendedUntilMs) && suspendedUntilMs > this.clock().getTime();
  }

  private loadExternalSourceSchedulingState(): void {
    try {
      if (!fs.existsSync(this.schedulingStatePath)) return;
      const raw = fs.readFileSync(this.schedulingStatePath, 'utf-8');
      const parsed = JSON.parse(raw) as {
        schemaVersion?: number;
        lanes?: Array<{
          provider?: string;
          sourceId?: string;
          state?: SourceFailureState;
        }>;
        resourceLanes?: Array<{
          provider?: string;
          sourceId?: string;
          resourceRef?: string;
          state?: SourceFailureState;
        }>;
        sources?: Record<string, SourceFailureState>;
      };
      const normalize = (state: SourceFailureState): SourceFailureState | undefined => {
        if (typeof state.consecutiveFailures !== 'number') return undefined;
        return {
          consecutiveFailures: state.consecutiveFailures,
          lastFailedAt: state.lastFailedAt ?? null,
          lastError: state.lastError ?? null,
          suspendedUntil: state.suspendedUntil ?? null,
          ...(state.failureClass ? { failureClass: state.failureClass } : {}),
          nextRetryAt: state.nextRetryAt ?? state.suspendedUntil ?? null,
          requiresOperatorAction: state.requiresOperatorAction === true,
          ...(state.resourceRef ? { resourceRef: state.resourceRef } : {}),
          ...(state.eventId ? { eventId: state.eventId } : {}),
          lastAttemptedAt: state.lastAttemptedAt ?? null,
          lastSuccessfulReadAt: state.lastSuccessfulReadAt ?? null,
        };
      };
      const restore = (identity: ExternalSourceLaneIdentity, state: SourceFailureState): void => {
        const normalized = normalize(state);
        if (normalized) {
          this.externalSourceFailureState.set(externalSourceLaneKey(identity), normalized);
        }
      };
      if (parsed.schemaVersion === 3 && Array.isArray(parsed.lanes)) {
        for (const lane of parsed.lanes) {
          if (
            typeof lane.provider !== 'string'
            || typeof lane.sourceId !== 'string'
            || !lane.state
          ) continue;
          restore({ provider: lane.provider, sourceId: lane.sourceId }, lane.state);
        }
        for (const lane of parsed.resourceLanes ?? []) {
          if (
            typeof lane.provider !== 'string'
            || typeof lane.sourceId !== 'string'
            || typeof lane.resourceRef !== 'string'
            || !lane.state
          ) continue;
          const state = normalize(lane.state);
          if (!state) continue;
          this.externalResourceFailureState.set(externalResourceLaneKey({
            provider: lane.provider,
            sourceId: lane.sourceId,
            resourceRef: lane.resourceRef,
          }), state);
        }
        return;
      }
      if (!parsed.sources || typeof parsed.sources !== 'object') return;
      for (const [sourceId, state] of Object.entries(parsed.sources)) {
        for (const adapter of this.sessionLogSources) {
          if (adapter.identity.category !== 'external' || adapter.identity.sourceId !== sourceId) continue;
          restore(adapter.identity, state);
        }
      }
    } catch {
      // Corrupt state file — start fresh; the source will be retried.
    }
  }

  private saveExternalSourceSchedulingState(): void {
    if (!this.externalSourceSchedulingStateDirty) return;
    try {
      const lanes: Array<ExternalSourceLaneIdentity & { state: SourceFailureState }> = [];
      for (const [key, state] of this.externalSourceFailureState) {
        const identity = parseExternalSourceLaneKey(key);
        if (!identity) continue;
        const hasSignal = state.consecutiveFailures > 0
          || Boolean(state.suspendedUntil)
          || Boolean(state.failureClass)
          || Boolean(state.lastError)
          || Boolean(state.lastSuccessfulReadAt);
        if (hasSignal) {
          lanes.push({ ...identity, state });
        }
      }
      const resourceLanes: Array<ExternalResourceLaneIdentity & { state: SourceFailureState }> = [];
      for (const [key, state] of this.externalResourceFailureState) {
        const identity = parseExternalResourceLaneKey(key);
        if (identity) resourceLanes.push({ ...identity, state });
      }
      if (lanes.length === 0 && resourceLanes.length === 0) {
        if (fs.existsSync(this.schedulingStatePath)) {
          fs.unlinkSync(this.schedulingStatePath);
        }
        this.externalSourceSchedulingStateDirty = false;
        return;
      }
      lanes.sort((left, right) => (
        (left.provider < right.provider ? -1 : (left.provider > right.provider ? 1 : 0))
        || (left.sourceId < right.sourceId ? -1 : (left.sourceId > right.sourceId ? 1 : 0))
      ));
      resourceLanes.sort((left, right) => (
        (left.provider < right.provider ? -1 : (left.provider > right.provider ? 1 : 0))
        || (left.sourceId < right.sourceId ? -1 : (left.sourceId > right.sourceId ? 1 : 0))
        || (left.resourceRef < right.resourceRef ? -1 : (left.resourceRef > right.resourceRef ? 1 : 0))
      ));
      const payload = { schemaVersion: 3, lanes, resourceLanes };
      fs.mkdirSync(path.dirname(this.schedulingStatePath), { recursive: true });
      const tmpPath = `${this.schedulingStatePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.renameSync(tmpPath, this.schedulingStatePath);
      this.externalSourceSchedulingStateDirty = false;
    } catch (error) {
      Logger.warning(
        `[RuntimeLearning] failed to persist external source scheduling state: ${(error as Error).message}`,
      );
    }
  }

  private loadExternalCursorStateFor(identity: SessionLogSourceIdentity): ExternalCursorState {
    return loadExternalCursorState(this.externalCursorStorePath(identity.provider, identity.sourceId));
  }

  private recordExternalSourceQuarantine(
    identity: SessionLogSourceIdentity,
    resourceRef: string,
    eventIdentity: SourceEventIdentity,
    failureClass: Extract<ExternalSourceFailureClass, 'quarantine' | 'integrity_conflict'>,
    message: string,
    cursorPosition: number,
  ): void {
    const storePath = this.externalCursorStorePath(identity.provider, identity.sourceId);
    const state = loadExternalCursorState(storePath);
    const quarantineId = buildExternalEventDedupKey(identity, eventIdentity);
    saveExternalCursorState(storePath, {
      ...state,
      quarantinedEvents: {
        ...state.quarantinedEvents,
        [quarantineId]: {
          quarantineId,
          resourceRef,
          sourceIdentity: identity,
          identity: eventIdentity,
          failureClass,
          message: this.redactExternalSourceError(message),
          detectedAt: this.clock().toISOString(),
          cursorPosition,
        },
      },
      updatedAt: this.clock().toISOString(),
    });
  }

  private buildExternalSourceReportDiagnostics(
    identity: SessionLogSourceIdentity,
    failureState: SourceFailureState | undefined,
  ): Pick<SessionLogSourceReport, 'provider' | 'reader' | 'readerVersion' | 'selectedProvider' | 'cursorProgress' | 'lastSuccessfulReadAt' | 'nextRetryAt' | 'lastError' | 'failureClass' | 'requiresOperatorAction' | 'nextAction' | 'workState' | 'drainState'> {
    let cursorProgress = {
      maxPosition: -1,
      activeResources: 0,
      closedResources: 0,
      quarantinedEvents: 0,
      tombstones: 0,
    };
    let resourceLastSuccessfulReadAt: string | undefined;
    try {
      const state = this.loadExternalCursorStateFor(identity);
      const resources = Object.values(state.resources);
      cursorProgress = {
        maxPosition: Object.values(state.cursors)
          .filter(entry => entry.sourceIdentity?.sourceId === identity.sourceId)
          .reduce((max, entry) => Math.max(max, entry.cursor.position), -1),
        activeResources: resources.filter(resource => resource.lifecycleStatus !== 'closed').length,
        closedResources: resources.filter(resource => resource.lifecycleStatus === 'closed').length,
        quarantinedEvents: Object.values(state.quarantinedEvents)
          .filter(entry => entry.resourceRef in state.resources)
          .length,
        tombstones: Object.keys(state.tombstones).length,
      };
      const resourceReadTimes = resources
        .map(resource => resource.lastSuccessfulReadAt)
        .filter((ts): ts is string => typeof ts === 'string')
        .sort()
        .reverse();
      resourceLastSuccessfulReadAt = resourceReadTimes[0];
    } catch {
      // Fail closed; heartbeat status still surfaces the lane-level error state.
    }
    const readerVersion = this.findExternalSourceAdapter(identity.provider, identity.sourceId)?.getReaderVersion?.();
    const nextAction = failureState?.requiresOperatorAction
      ? (failureState.failureClass === 'quarantine' || failureState.failureClass === 'integrity_conflict'
        ? 'retry_or_skip_quarantine' as const
        : 'repair_source_then_retry' as const)
      : failureState?.nextRetryAt
        ? 'wait_for_retry' as const
        : failureState?.failureClass === 'pending'
          ? 'retry_next_wake' as const
          : undefined;
    return {
      provider: identity.provider,
      reader: identity.reader,
      ...(readerVersion ? { readerVersion } : {}),
      selectedProvider: identity.provider,
      cursorProgress,
      lastSuccessfulReadAt: failureState?.lastSuccessfulReadAt ?? resourceLastSuccessfulReadAt,
      nextRetryAt: failureState?.nextRetryAt ?? undefined,
      lastError: failureState?.lastError ?? undefined,
      failureClass: failureState?.failureClass,
      requiresOperatorAction: failureState?.requiresOperatorAction,
      nextAction,
      workState: {
        read: 'idle',
        readyPages: 0,
        committing: false,
      },
      drainState: (this.shutdownDrainRequested || this.externalSourceDrainRequested) ? 'draining' : 'idle',
    };
  }


  /**
   * Track that a specific external event maps to the listed episode ids.
   */
  private recordExternalEpisodeProvenance(
    identity: SessionLogSourceIdentity,
    eventIdentity: SourceEventIdentity,
    episodeIds: readonly string[],
  ): void {
    this.externalEpisodeProvenanceStore.record(identity, eventIdentity, episodeIds);
  }

  /**
   * Resolve a replayed event even when the process previously stopped after
   * episode persistence but before provenance/cursor persistence. External
   * sanitization makes sourceFilePath deterministic for the fixed event range.
   */
  private resolveExternalEpisodeIds(
    identity: SessionLogSourceIdentity,
    eventIdentity: SourceEventIdentity,
    sanitizedUnit: DistillationUnit,
    ingestion: EvidenceIngestionResult,
  ): string[] {
    this.externalEpisodeProvenanceStore.assertHealthy();
    if (ingestion.admittedEpisodeIds.length > 0) {
      return [...ingestion.admittedEpisodeIds];
    }
    const indexed = this.externalEpisodeProvenanceStore.getEpisodeIdsForEvent(identity, eventIdentity);
    if (indexed.length > 0) return indexed;
    return Object.values(ingestion.state.episodes)
      .filter(episode => episode.sourceFilePath === sanitizedUnit.filePath)
      .map(episode => episode.episodeId)
      .sort();
  }

  private isEpisodeFromExternalSource(episodeId: string): boolean {
    if (this.externalEpisodeProvenanceStore.hasEpisode(episodeId)) return true;
    // A crash can persist the Episode before its Capsule/provenance writes.
    // Sanitized external admission always uses this opaque URI namespace, so
    // review must still fail closed until replay completes those later writes.
    return this.episodeStore.load().episodes[episodeId]?.sourceFilePath
      .startsWith('external://event/') === true;
  }

  /**
   * Return runtime-owned GeneratedSkillLoadFact entries tied to the episode's
   * canonical AgentTurn and runtime-session identity. Never join by timestamp
   * or session proximity.
   */
  private listSkillLoadFactsForEpisode(episode: LearningEpisode): readonly GeneratedSkillLoadFact[] {
    return this.curator?.listLoadFactsForEpisode(episode) ?? [];
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Create Evidence Capsules for each admitted episode from an external source.
   *
   * The capsule preserves redacted evidence content and provenance so that
   * mutating, deleting, or disabling the upstream source does not affect
   * bounded review retry (issue #78).
   */
  /**
   * Single-writer commit for one external evidence page (issue #93).
   *
   * This method is called exclusively through the External Admission
   * Coordinator’s injected commit function, ensuring that all external
   * Episode, Capsule, provenance, and cursor mutations pass through one
   * observable single-writer boundary. The commit preserves the established
   * durable order:
   *
   *   normalize stable event
   *   → ingest Learning Episode
   *   → persist redacted Evidence Capsule
   *   → persist external provenance
   *   → acknowledge provider cursor last
   *
   * A crash or failure before cursor acknowledgement leaves the page
   * replayable and idempotent — the Evidence Ingestor deduplicates by
   * source identity and event position.
   *
   * Binding to the future bounded async reader pool (#92):
   * When #92 lands, the async reader pool will produce ExternalEvidencePage
   * objects as xURL processes complete and call
   * `coordinator.admitPage(page)` for each ready page. This method remains
   * the commit boundary; no changes to it are required.
   */
  private commitExternalEvidencePage(page: ExternalEvidencePage): ExternalAdmissionCommitResult {
    const adapter = this.findExternalSourceAdapter(page.identity.provider, page.sourceId);
    if (page.lane !== 'backfill' && !adapter) {
      return {
        admittedEpisodes: 0,
        contradictionSignals: 0,
        acknowledged: false,
        error: new Error(`external admission coordinator: adapter not found for ${page.identity.provider}/${page.sourceId}`),
      };
    }

    const { identity, resource, distillationUnits, eventIdentities, readResult } = page;
    let admittedEpisodes = 0;
    let contradictionSignals = 0;
    const admittedEpisodeIds: string[] = [];
    let eventInProgress: SourceEventIdentity | undefined;

    try {
      // Validate event identity count matches distillation unit count
      if (eventIdentities.length > 0 && eventIdentities.length !== distillationUnits.length) {
        throw new Error('stable external batch is missing one or more event identities');
      }

      for (let index = 0; index < distillationUnits.length; index++) {
        const eventIdentity = eventIdentities[index]
          ?? (distillationUnits.length === 1
            ? (resource.firstEventIdentity ?? { eventId: resource.resourceRef, position: 0 })
            : undefined);
        if (!eventIdentity) {
          throw new Error('stable external batch event has no canonical identity');
        }
        eventInProgress = eventIdentity;

        // External evidence crosses the privacy boundary before it reaches
        // EvidenceIngestor. Sanitize the distillation unit.
        const ingestUnit = sanitizeExternalDistillationUnit(distillationUnits[index]!, {
          sourceId: identity.sourceId,
          eventIdentity,
        });
        const catchUpTarget = page.lane === 'catch-up'
          ? adapter?.getCatchUpTarget?.(resource)
          : undefined;
        if (page.lane === 'catch-up' && (!catchUpTarget || catchUpTarget.position === null)) {
          throw new Error(`external catch-up target is missing for ${resource.resourceRef}`);
        }
        const ingestionResult = this.evidenceIngestor.ingest(
          ingestUnit,
          page.historicalTarget
            ? { historicalTarget: page.historicalTarget }
            : catchUpTarget && catchUpTarget.position !== null
            ? {
              historicalTarget: {
                targetId: catchUpTarget.targetId,
                provider: catchUpTarget.provider,
                sourceId: catchUpTarget.sourceId,
                resourceRef: catchUpTarget.resourceRef,
                position: catchUpTarget.position,
                prefixDigest: catchUpTarget.prefixDigest,
              },
            }
            : {},
        );
        const admissionEpisodeIds = this.resolveExternalEpisodeIds(
          identity,
          eventIdentity,
          ingestUnit,
          ingestionResult,
        );

        // Capsule persistence is the first external-evidence boundary after
        // Episode ingestion. Provenance must not become durable without the
        // redacted evidence it points at; replay repairs both before cursor
        // acknowledgement.
        this.createCapsulesForExternalSource(
          identity,
          eventIdentity,
          ingestionResult,
          admissionEpisodeIds,
        );

        if (admissionEpisodeIds.length > 0) {
          this.recordExternalEpisodeProvenance(
            identity,
            eventIdentity,
            admissionEpisodeIds,
          );
        }

        admittedEpisodes += ingestionResult.admittedEpisodeIds.length;
        contradictionSignals += ingestionResult.contradictionSignalIds.length;
        admittedEpisodeIds.push(...admissionEpisodeIds);
      }

      // Provenance is part of the crash-safe external commit boundary.
      // Persist it after episodes/capsules but before cursor acknowledgement;
      // replay is idempotent if the process stops anywhere before this point.
      this.externalEpisodeProvenanceStore.flush();

      // Cursor acknowledgement is lane-specific and remains the final durable
      // step owned by that lane.
      if (page.lane !== 'backfill') {
        adapter!.acknowledge(resource, readResult);
        // Success resets failure count for continuous and catch-up pages.
        this.resetExternalSourceFailure(identity, resource.resourceRef);
      }

      return {
        admittedEpisodes,
        contradictionSignals,
        admittedEpisodeIds,
        acknowledged: true,
      };
    } catch (error) {
      // A failure before cursor acknowledgement leaves the page replayable.
      // Record the failure for source health tracking.
      const message = this.redactExternalSourceError(error);
      const failureClass = this.classifyExternalSourceFailure(message);
      const eventIdentity = eventInProgress ?? eventIdentities?.[0];
      if (error && typeof error === 'object') {
        (error as Record<string, unknown>).externalAdmissionFailureRecorded = true;
      }
      if ((failureClass === 'quarantine' || failureClass === 'integrity_conflict') && eventIdentity) {
        this.recordExternalSourceQuarantine(
          identity,
          resource.resourceRef,
          eventIdentity,
          failureClass,
          message,
          readResult.newCursor.position,
        );
      }
      if (adapter) {
        adapter.markFailed(resource, error);
      }
      this.recordExternalSourceFailure(identity, error, {
        failureClass,
        resourceRef: resource.resourceRef,
        eventId: eventIdentity?.eventId,
      });
      return {
        admittedEpisodes,
        contradictionSignals,
        acknowledged: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  private createCapsulesForExternalSource(
    identity: SessionLogSourceIdentity,
    eventIdentity: SourceEventIdentity,
    ingestionResult: EvidenceIngestionResult,
    admissionEpisodeIds: readonly string[] = ingestionResult.admittedEpisodeIds,
  ): void {
    const uniqueEpisodeIds = Array.from(new Set(admissionEpisodeIds));
    if (uniqueEpisodeIds.length === 0) return;

    const episodeStates = ingestionResult.state.episodes;
    for (const episodeId of uniqueEpisodeIds) {
      const episode = episodeStates[episodeId] ?? this.episodeStore.load().episodes[episodeId];
      if (!episode) continue;

      const bundleId = `v3:learning-episode:${episodeId}`;

      // Prefer the immutable source snapshot captured at Episode admission.
      // `detail` remains a legacy fallback only; it is a control-plane summary,
      // not the user/assistant transcript Author and Verifier should learn from.
      const frozenSourceByRef = new Map(
        (episode.sourceEvidence ?? []).map(source => [source.ref, source]),
      );
      const completionEvidence: {
        ref: string;
        content: string;
        role: 'problem-action' | 'verification';
        sourceFilePath?: string;
        turn?: number;
        byteRange?: { start: number; end: number };
      }[] = episode.completionEvidence
        .filter(e => e.kind !== 'contradiction')
        .map(e => {
          const frozen = frozenSourceByRef.get(e.ref);
          return {
            ref: e.ref,
            content: frozen?.content ?? e.detail ?? `${e.kind} at turn ${e.turn}`,
            role: e.kind === 'artifact-validation' || e.kind === 'user-acceptance'
              ? 'verification' as const
              : 'problem-action' as const,
            sourceFilePath: frozen?.sourceFilePath ?? e.sourceFilePath,
            turn: frozen?.turn ?? e.turn,
            ...(frozen?.byteRange ? { byteRange: frozen.byteRange } : {}),
          };
        });

      // Generate settlement evidence content from episode metadata. The
      // episode is still settling (or historical-pending) at this admission
      // boundary, so the evidence must honestly record the non-settled state.
      // Maturation refreshes this entry to the authoritative matured status.
      const settlementEntry = buildEpisodeSettlementEvidence(episode);
      const settlementEvidence: {
        ref: string;
        content: string;
        role: 'problem-action' | 'verification';
        sourceFilePath?: string;
        turn?: number;
        byteRange?: { start: number; end: number };
      }[] = [{
        ref: settlementEntry.ref,
        content: settlementEntry.content,
        role: 'verification' as const,
        sourceFilePath: settlementEntry.sourceFilePath,
        turn: settlementEntry.turn,
        ...(settlementEntry.byteRange ? { byteRange: settlementEntry.byteRange } : {}),
      }];

      const capsule = buildEvidenceCapsule({
        sourceIdentity: identity,
        eventIdentity,
        episodeId,
        bundleId,
        completionEvidence,
        settlementEvidence,
        semanticObservations: episode.semanticObservations,
        now: this.clock(),
      });
      this.evidenceCapsuleStore.upsert(capsule);
      // Settlement is mutable lifecycle metadata, so synchronize it only
      // after the immutable upsert succeeds. A completion/semantic conflict
      // throws above and keeps the external page unacknowledged.
      this.evidenceCapsuleStore.refreshSettlementEvidence(bundleId, settlementEvidence);
    }
  }

  /**
   * Re-derive the durable settlement evidence for external-origin episodes
   * after a maturation transition, so a pinned admission capsule (recorded
   * while the episode was still settling) is updated to the authoritative
   * matured status before review enqueues from it.
   *
   * Only external episodes with a persisted capsule are touched; the
   * lifecycle-neutral settlement ref is stable across the update, so only the
   * honest status-derived content (and the recomputed fingerprint) changes.
   * Best-effort: a refresh failure is logged and never blocks maturation or
   * review, because review itself still fail-closes when a capsule is missing
   * or internally inconsistent.
   */
  private refreshExternalCapsuleSettlementEvidence(
    episodes: readonly LearningEpisode[],
  ): void {
    for (const episode of episodes) {
      if (!this.isEpisodeFromExternalSource(episode.episodeId)) continue;
      const bundleId = `v3:learning-episode:${episode.episodeId}`;
      if (!this.evidenceCapsuleStore.findByBundleId(bundleId)) continue;
      try {
        const settlement = buildEpisodeSettlementEvidence(episode);
        this.evidenceCapsuleStore.refreshSettlementEvidence(bundleId, [settlement]);
      } catch (error) {
        Logger.warning(
          `[RuntimeLearning] capsule settlement refresh failed for ${episode.episodeId}: ${toErrorMessage(error)}`,
        );
      }
    }
  }

  /**
   * Restart-safe reconciliation of durable settlement evidence for external
   * Learning Episodes, plus supersession of any active Evidence Review Job
   * whose frozen Review Basis still carries the pre-fix contradictory
   * settlement evidence.
   *
   * A capsule persisted before the settlement-consistency fix may carry
   * `settled ... (status: settling)` content (and a `:settled-` ref) while its
   * LearningEpisode is durably `eligible`. On restart, runMaturation sees the
   * pre-status as already matured, so the transition-based refresh above never
   * fires for that capsule. Worse, an already-created active Evidence Review Job
   * owns a frozen bundle copied from that old capsule; refreshing only the
   * capsule cannot silently mutate the immutable Review Basis.
   *
   * This reconciliation runs before review enqueue/fair advancement and:
   *   1. Re-derives each external capsule's settlement evidence from the
   *      authoritative LearningEpisode status (idempotent; no-op when already
   *      consistent). Settlement evidence is runtime-owned maturation metadata,
   *      not external content, so this never weakens the Verifier or fabricates
   *      settlement — it reconciles the capsule to what the authoritative
   *      status already says.
   *   2. For active Evidence Review Jobs whose frozen bundle still carries the
   *      old settlement evidence, supersedes the job with a clean successor
   *      built from the current authoritative/reconstructed capsule — the
   *      immutable frozen basis is never mutated in place; the existing audited
   *      successor mechanism is reused so only the successor can advance.
   *
   * Restart-safety across the refresh/supersede boundary: step 2 is NOT gated
   * on step 1 having mutated a capsule in THIS wake. A prior wake may have
   * refreshed the capsule and then crashed before superseding the stale active
   * job; on restart the capsule already matches the authoritative status, so
   * step 1 is an idempotent no-op, yet the active job's frozen basis still
   * carries the pre-fix contradictory settlement evidence. Step 2 therefore
   * compares every active external learning-episode job against the current
   * authoritative reconstruction regardless of whether step 1 modified a
   * capsule this wake, so the crash-window stale job is still superseded.
   *
   * This is a narrow structural-corruption detector, not a policy/version
   * marker bump: only actually-corrupted legacy state is superseded, so
   * healthy in-flight reviews are not disturbed (minimal blast radius). It is
   * bounded to active jobs for external learning-episode bundles and performs
   * no model calls — only pure bundle reconstruction and structural
   * comparison.
   *
   * Fail-closed: a reconciliation/refresh/supersession failure is logged and
   * never blocks review, because review itself still fail-closes when a
   * capsule is missing or internally inconsistent.
   */
  private reconcileSettlementConsistency(): void {
    const episodes = Object.values(this.episodeStore.load().episodes);
    const episodeById = new Map(episodes.map(e => [e.episodeId, e] as const));

    // 1. Reconcile capsules from the authoritative episode status. This step is
    //    intentionally independent of step 2: a capsule refreshed here OR in a
    //    prior (possibly crashed) wake must both lead to stale-job supersession.
    for (const episode of episodes) {
      if (!this.isEpisodeFromExternalSource(episode.episodeId)) continue;
      const bundleId = `v3:learning-episode:${episode.episodeId}`;
      const capsule = this.evidenceCapsuleStore.findByBundleId(bundleId);
      if (!capsule) continue;
      try {
        const expected = buildEpisodeSettlementEvidence(episode);
        const current = capsule.settlementEvidence[0];
        // Idempotent: skip when the redacted authoritative content already
        // matches the durable capsule content and the ref is already
        // lifecycle-neutral.
        const expectedContent = redactExternalEvidenceContent(expected.content);
        if (
          current
          && current.ref === expected.ref
          && current.content === expectedContent
        ) {
          continue;
        }
        this.evidenceCapsuleStore.refreshSettlementEvidence(bundleId, [expected]);
      } catch (error) {
        Logger.warning(
          `[RuntimeLearning] settlement reconciliation failed for ${episode.episodeId}: ${toErrorMessage(error)}`,
        );
      }
    }

    // 2. Supersede active OR durably-deferred jobs whose frozen bundle still
    //    carries stale settlement evidence. This step is NOT gated on step 1
    //    having mutated a capsule in this wake: a prior wake may have refreshed
    //    the capsule and crashed before superseding the stale job, leaving the
    //    capsule already consistent with the authoritative status while the
    //    job's frozen basis still carries the old contradictory evidence. Every
    //    active external learning-episode job is therefore compared against the
    //    current authoritative reconstruction regardless of capsule mutation
    //    this wake.
    //
    //    The scan also covers the specific stale `deferred` terminal state: a
    //    job that reached durable `disposition: deferred` because the Verifier
    //    semantically deferred on the fabricated `settled ... (status:
    //    settling)` contradiction can remain permanently stuck even after the
    //    capsule is repaired — `getReviewedOrQueuedBundleIds()` treats deferred
    //    jobs as bundle owners (so the episode is never re-admitted for review)
    //    and fair scheduling only executes active jobs. The same structural
    //    comparison decides staleness, and the same audited supersede/successor
    //    path recovers the job; the immutable frozen basis is never mutated in
    //    place. A legitimate deferral whose frozen settlement evidence already
    //    equals the authoritative capsule is skipped by the structural-equality
    //    check below and is never reopened.
    const engine = this.skillEvolution.getEvidenceReviewEngine();
    let recoverableJobs: import('./evidence-review-types').EvidenceReviewJob[];
    try {
      recoverableJobs = Object.values(engine.loadStore().jobs).filter(job => {
        if (job.disposition !== 'active' && job.disposition !== 'deferred') return false;
        return migratePersistedEvidenceBundleAuthority(job.bundle)?.authority.kind
          === 'learning-episode';
      });
    } catch {
      // Job store optional during early construction / V3-disabled paths.
      return;
    }
    for (const job of recoverableJobs) {
      const normalized = migratePersistedEvidenceBundleAuthority(job.bundle);
      if (!normalized || normalized.authority.kind !== 'learning-episode') continue;
      const episode = episodeById.get(normalized.authority.episodeId);
      if (!episode || !this.isEpisodeFromExternalSource(episode.episodeId)) continue;
      const freshBundle = buildEpisodeEvidenceBundle(
        episode,
        buildLearningEpisodeCandidate(episode),
        this.skillEvolution,
        this.evidenceCapsuleStore,
        this.isEpisodeFromExternalSource.bind(this),
        this.listSkillLoadFactsForEpisode(episode),
      );
      // Detect whether the frozen bundle's settlement evidence is stale
      // relative to the current authoritative/reconstructed capsule. The
      // fresh bundle is reconstructed from the capsule (reconciled either in
      // this wake or a prior one), so structural inequality of the settlement
      // evidence means the job is carrying the old contradictory basis.
      //
      // Structural equality is over BOTH the settlement ref AND the settlement
      // source content. The ref is the lifecycle-neutral, stable settlement
      // identifier (`...:settlement-<deadline>`); the pre-fix corruption used a
      // `...:settled-<deadline>` ref, so a ref mismatch alone is a reliable
      // corruption signal. The content carries the status-derived assertion;
      // a status mismatch (e.g. `status: settling` vs `status: eligible`) is
      // the material settlement contradiction the Verifier defers on. Either
      // divergence makes the frozen basis stale, so the job is skipped only
      // when BOTH the ref and the content match the authoritative
      // reconstruction. Comparing content alone would miss a stale ref that
      // happened to share content; comparing ref alone would miss a
      // legitimately-refrozen status change under the stable ref. Together
      // they are the minimal structural equality that covers the pre-fix
      // `:settled-` ref corruption AND the post-fix legitimate maturation
      // refresh under the stable `:settlement-` ref, without weakening the
      // Verifier or bumping any global policy.
      const frozenRef = job.bundle.settlementEvidence[0]?.ref;
      const freshRef = freshBundle.settlementEvidence[0]?.ref;
      const frozenSettlement = job.bundle.sourceEvidence?.find(
        s => s.ref === frozenRef,
      );
      const freshSettlement = freshBundle.sourceEvidence?.find(
        s => s.ref === freshRef,
      );
      if (!frozenSettlement || !freshSettlement) continue;
      if (frozenRef === freshRef && frozenSettlement.content === freshSettlement.content) {
        continue;
      }
      try {
        if (job.disposition === 'deferred') {
          this.skillEvolution.supersedeStaleDeferredJobWithFreshBundle(
            job.bundle.bundleId,
            freshBundle,
            'settlement evidence reconciled from authoritative episode status (restart-safe)',
          );
        } else {
          this.skillEvolution.supersedeActiveJobWithFreshBundle(
            job.bundle.bundleId,
            freshBundle,
            'settlement evidence reconciled from authoritative episode status (restart-safe)',
          );
        }
      } catch (error) {
        Logger.warning(
          `[RuntimeLearning] stale job supersession failed for ${job.bundle.bundleId}: ${toErrorMessage(error)}`,
        );
      }
    }
  }

  private linkEvidenceCapsuleToAudit(bundleId: string, auditTransitionId: string | undefined): void {
    if (!auditTransitionId) return;
    const capsule = this.evidenceCapsuleStore.findByBundleId(bundleId);
    if (!capsule) return;
    this.evidenceCapsuleStore.addPromotionAuditRef(capsule.capsuleId, auditTransitionId);
  }

  private hasReviewedEpisode(
    episode: LearningEpisode,
    reviewedOrQueuedBundleIds?: ReadonlySet<string>,
  ): boolean {
    const bundleId = `v3:learning-episode:${episode.episodeId}`;
    if (reviewedOrQueuedBundleIds) return reviewedOrQueuedBundleIds.has(bundleId);
    return (
      this.skillEvolution.getAudit().some(entry => entry.bundleId === bundleId)
      || this.skillEvolution.getQueuedReviewKind(bundleId) !== undefined
    );
  }

  private loadReviewFairnessContinuation(): ReviewFairnessContinuation {
    const fallback: ReviewFairnessContinuation = {
      nextClass: 'retry',
      classCursors: {},
    };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.reviewContinuationPath, 'utf8')) as {
        schemaVersion?: number;
        nextClass?: unknown;
        classCursors?: unknown;
      };
      if (parsed.schemaVersion !== REVIEW_CONTINUATION_SCHEMA_VERSION) return fallback;
      if (!REVIEW_WORK_CLASS_ORDER.includes(parsed.nextClass as ReviewWorkClass)) return fallback;
      const rawCursors = parsed.classCursors;
      if (!rawCursors || typeof rawCursors !== 'object' || Array.isArray(rawCursors)) return fallback;
      const classCursors: Partial<Record<ReviewWorkClass, string>> = {};
      for (const workClass of REVIEW_WORK_CLASS_ORDER) {
        const cursor = (rawCursors as Partial<Record<ReviewWorkClass, unknown>>)[workClass];
        if (typeof cursor === 'string' && cursor) classCursors[workClass] = cursor;
      }
      // Pre-consolidation continuation files may carry `deferredEpisodeIds`.
      // Ignore that legacy duplicate owner at this explicit read boundary;
      // retry/defer disposition belongs only to the Evidence Review Job store.
      return { nextClass: parsed.nextClass as ReviewWorkClass, classCursors };
    } catch {
      return fallback;
    }
  }

  /** Persist derivable backlog plus durable class and within-class continuations. */
  private persistReviewContinuation(
    episodeIds: ReadonlySet<string>,
    fairness: ReviewFairnessContinuation,
    reviewJobIds: ReadonlySet<string> = new Set(),
  ): void {

    const now = this.clock();
    const state: ReviewContinuationState = {
      schemaVersion: REVIEW_CONTINUATION_SCHEMA_VERSION,
      episodeIds: [...episodeIds].sort(),
      reviewJobIds: [...reviewJobIds].sort(),
      nextAttemptAt: new Date(now.getTime() + REVIEW_CONTINUATION_DELAY_MS).toISOString(),
      updatedAt: now.toISOString(),
      nextClass: fairness.nextClass,
      classCursors: fairness.classCursors,
    };
    const tmp = `${this.reviewContinuationPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.reviewContinuationPath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.reviewContinuationPath);
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      Logger.warning(`[RuntimeLearning] failed to persist review continuation: ${toErrorMessage(error)}`);
    }
  }

  /** Keep the heartbeat live while admitted review jobs have runnable quanta. */
  private listRunnableReviewJobIds(): string[] {
    try {
      const now = this.clock();
      const jobs = this.skillEvolution.getEvidenceReviewEngine().loadStore().jobs;
      return Object.values(jobs)
        .filter(job => job.disposition === 'active' && listRunnableQuanta(job, now).length > 0)
        .map(job => job.jobId)
        .sort((left, right) => left.localeCompare(right, 'en'));
    } catch {
      // The job store is optional during early construction / V3-disabled paths.
      return [];
    }
  }

  /** Read the number of pending expedited curator wakes directly from state. */
  private readExpeditedCuratorCount(): number {
    try {
      const curatorStatePath = this.config.skillEvolutionCuratorStatePath;
      if (!curatorStatePath || !fs.existsSync(curatorStatePath)) return 0;
      const raw = fs.readFileSync(curatorStatePath, 'utf8');
      const parsed = JSON.parse(raw) as { expedited?: Record<string, unknown> };
      if (!parsed.expedited || typeof parsed.expedited !== 'object') return 0;
      return Object.keys(parsed.expedited).length;
    } catch {
      return 0;
    }
  }

  private recordHeartbeat(
    reason: string,
    unitsProcessed: number,
    advancedFiles: number,
    runStatus: RuntimeLearningHeartbeatRunStatus,
    pendingWakeReasons: readonly RuntimeLearningReason[] = [],
    runDurationMs = 0,
    reviewTimeoutCount = 0,
    reviewFailureCount = 0,
    incrementRunCount = true,
    diagnostics?: {
      sources: readonly SessionLogSourceReport[];
      nextWakeTime: number | null;
      nextWakeReason: string;
    },
  ): void {
    const recordPath = this.config.heartbeatRecordPath;
    let record: RuntimeLearningHeartbeatRecord;
    try {
      if (fs.existsSync(recordPath)) {
        record = JSON.parse(fs.readFileSync(recordPath, 'utf-8')) as RuntimeLearningHeartbeatRecord;
      } else {
        record = emptyHeartbeatRecord();
      }
    } catch {
      record = emptyHeartbeatRecord();
    }

    record.lastRunAt = this.clock().toISOString();
    if (incrementRunCount) {
      record.runCount += 1;
    }
    record.lastRunStatus = runStatus;
    record.lastRunDurationMs = runDurationMs;
    record.lastPendingWakeReasons = Array.from(new Set(pendingWakeReasons)).sort();
    record.lastReason = reason;
    record.lastUnitsProcessed = unitsProcessed;
    record.lastAdvancedFiles = advancedFiles;
    record.lastReviewTimeoutCount = reviewTimeoutCount;
    record.lastReviewFailureCount = reviewFailureCount;
    record.cumulativeReviewTimeoutCount += reviewTimeoutCount;
    record.cumulativeReviewFailureCount += reviewFailureCount;
    delete record.inProgress;
    if (diagnostics) {
      record.lastSourceReports = diagnostics.sources;
      if (diagnostics.nextWakeTime !== null) {
        record.nextWakeAt = new Date(diagnostics.nextWakeTime).toISOString();
        record.nextWakeReason = diagnostics.nextWakeReason;
      } else {
        delete record.nextWakeAt;
        delete record.nextWakeReason;
      }
    }
    record.externalSourceDiagnostics = buildExternalSourceDiagnosticSnapshot({
      config: this.config,
      providerStatuses: this.getExternalProviderStatuses(),
      sourceReports: diagnostics?.sources ?? record.lastSourceReports,
      generatedAt: record.lastRunAt,
      internalReady: runStatus !== 'failed',
    });
    record.backlog = this.snapshotBacklog(record.nextWakeAt);

    this.writeHeartbeatRecord(record);
  }

  private writeHeartbeatRecord(record: RuntimeLearningHeartbeatRecord): void {
    const recordPath = this.config.heartbeatRecordPath;
    const tmpPath = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(recordPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.renameSync(tmpPath, recordPath);
      fs.chmodSync(recordPath, 0o600);
    } catch (error: any) {
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
      Logger.warning(`[RuntimeLearning] failed to record heartbeat: ${error.message}`);
    }
  }

  private snapshotBacklog(nextWakeAt?: string): RuntimeLearningBacklogSnapshot {
    let eligibleEpisodes = 0;
    let reviewContinuationEpisodes = 0;
    let operationalReviews = 0;
    try {
      const reviewedOrQueuedBundleIds = this.skillEvolution.getReviewedOrQueuedBundleIds();
      eligibleEpisodes = Object.values(this.episodeStore.load().episodes)
        .filter(episode => (
          episode.status === 'eligible'
          && !this.hasReviewedEpisode(episode, reviewedOrQueuedBundleIds)
        ))
        .length;
    } catch { /* fail-closed store status is reported by the wake */ }
    try {
      const continuation = JSON.parse(fs.readFileSync(this.reviewContinuationPath, 'utf8')) as {
        episodeIds?: unknown;
        reviewJobIds?: unknown;
      };
      const episodeCount = Array.isArray(continuation.episodeIds)
        ? continuation.episodeIds.length
        : 0;
      const reviewJobCount = Array.isArray(continuation.reviewJobIds)
        ? continuation.reviewJobIds.length
        : 0;
      reviewContinuationEpisodes = episodeCount + reviewJobCount;
    } catch { /* missing continuation means zero */ }
    try {
      const jobs = this.skillEvolution.getEvidenceReviewEngine().loadStore().jobs;
      operationalReviews = Object.values(jobs)
        .filter(job => job.disposition === 'active' && job.workClass === 'operational_recovery')
        .length;
    } catch { /* missing job store means zero */ }
    const nextWakeMs = nextWakeAt ? Date.parse(nextWakeAt) : Number.NaN;
    return {
      eligibleEpisodes,
      reviewContinuationEpisodes,
      operationalReviews,
      lagMs: Number.isFinite(nextWakeMs) ? Math.max(0, this.clock().getTime() - nextWakeMs) : 0,
    };
  }

  /** Load the heartbeat record for inspection. */
  loadHeartbeatRecord(): RuntimeLearningHeartbeatRecord {
    const recordPath = this.config.heartbeatRecordPath;
    try {
      if (!fs.existsSync(recordPath)) return emptyHeartbeatRecord();
      return normalizeHeartbeatRecord(
        JSON.parse(fs.readFileSync(recordPath, 'utf-8')) as Record<string, unknown>,
      );
    } catch {
      return emptyHeartbeatRecord();
    }
  }
}

function normalizeHeartbeatRecord(
  record: Record<string, unknown>,
): RuntimeLearningHeartbeatRecord {
  const defaults = emptyHeartbeatRecord();
  const status = normalizeHeartbeatRunStatus(record.lastRunStatus);
  return {
    ...defaults,
    schemaVersion: (record.schemaVersion === 1 ? 1 : defaults.schemaVersion),
    lastRunAt: typeof record.lastRunAt === 'string' ? record.lastRunAt : defaults.lastRunAt,
    runCount: Number.isInteger(record.runCount) && typeof record.runCount === 'number' ? record.runCount : defaults.runCount,
    lastRunStatus: status,
    lastRunDurationMs: typeof record.lastRunDurationMs === 'number' && Number.isFinite(record.lastRunDurationMs)
      ? Math.max(0, Math.floor(record.lastRunDurationMs))
      : defaults.lastRunDurationMs,
    lastReason: typeof record.lastReason === 'string' ? record.lastReason : defaults.lastReason,
    lastUnitsProcessed: typeof record.lastUnitsProcessed === 'number' && Number.isFinite(record.lastUnitsProcessed)
      ? Math.max(0, Math.floor(record.lastUnitsProcessed))
      : defaults.lastUnitsProcessed,
    lastAdvancedFiles: typeof record.lastAdvancedFiles === 'number' && Number.isFinite(record.lastAdvancedFiles)
      ? Math.max(0, Math.floor(record.lastAdvancedFiles))
      : defaults.lastAdvancedFiles,
    lastPendingWakeReasons: Array.isArray(record.lastPendingWakeReasons)
      ? Array.from(new Set(record.lastPendingWakeReasons.filter(value => typeof value === 'string'))) as RuntimeLearningReason[]
      : defaults.lastPendingWakeReasons,
    pendingWakeReasons: Array.isArray(record.pendingWakeReasons)
      ? Array.from(new Set(record.pendingWakeReasons.filter(value => typeof value === 'string'))) as RuntimeLearningReason[]
      : defaults.pendingWakeReasons,
    lastReviewTimeoutCount: typeof record.lastReviewTimeoutCount === 'number' && Number.isFinite(record.lastReviewTimeoutCount)
      ? Math.max(0, Math.floor(record.lastReviewTimeoutCount))
      : defaults.lastReviewTimeoutCount,
    lastReviewFailureCount: typeof record.lastReviewFailureCount === 'number' && Number.isFinite(record.lastReviewFailureCount)
      ? Math.max(0, Math.floor(record.lastReviewFailureCount))
      : defaults.lastReviewFailureCount,
    cumulativeReviewTimeoutCount: typeof record.cumulativeReviewTimeoutCount === 'number'
      && Number.isFinite(record.cumulativeReviewTimeoutCount)
      ? Math.max(0, Math.floor(record.cumulativeReviewTimeoutCount))
      : defaults.cumulativeReviewTimeoutCount,
    cumulativeReviewFailureCount: typeof record.cumulativeReviewFailureCount === 'number'
      && Number.isFinite(record.cumulativeReviewFailureCount)
      ? Math.max(0, Math.floor(record.cumulativeReviewFailureCount))
      : defaults.cumulativeReviewFailureCount,
    ...(isHeartbeatInProgress(record.inProgress)
      ? { inProgress: record.inProgress }
      : {}),
    ...(isHeartbeatOwner(record.owner) ? { owner: record.owner } : {}),
    ...(typeof record.nextWakeAt === 'string' ? { nextWakeAt: record.nextWakeAt } : {}),
    ...(typeof record.nextWakeReason === 'string' ? { nextWakeReason: record.nextWakeReason } : {}),
    backlog: isBacklogSnapshot(record.backlog) ? record.backlog : defaults.backlog,
    lastSourceReports: Array.isArray(record.lastSourceReports)
      ? record.lastSourceReports as SessionLogSourceReport[]
      : defaults.lastSourceReports,
    externalSourceDiagnostics: isExternalSourceDiagnosticSnapshot(record.externalSourceDiagnostics)
      ? record.externalSourceDiagnostics
      : defaults.externalSourceDiagnostics,
  };
}

function isHeartbeatInProgress(value: unknown): value is NonNullable<RuntimeLearningHeartbeatRecord['inProgress']> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { startedAt?: unknown; reasons?: unknown };
  return typeof candidate.startedAt === 'string' && Array.isArray(candidate.reasons);
}

function isHeartbeatOwner(value: unknown): value is RuntimeLearningHeartbeatOwner {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RuntimeLearningHeartbeatOwner>;
  return Number.isInteger(candidate.pid)
    && typeof candidate.generation === 'string'
    && typeof candidate.startedAt === 'string';
}

function isBacklogSnapshot(value: unknown): value is RuntimeLearningBacklogSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RuntimeLearningBacklogSnapshot>;
  return [
    candidate.eligibleEpisodes,
    candidate.reviewContinuationEpisodes,
    candidate.operationalReviews,
    candidate.lagMs,
  ].every(item => typeof item === 'number' && Number.isFinite(item) && item >= 0);
}

function normalizeHeartbeatRunStatus(value: unknown): RuntimeLearningHeartbeatRunStatus {
  const valid: RuntimeLearningHeartbeatRunStatus[] = ['succeeded', 'failed', 'quiet', 'coalesced', 'timed_out', 'queued_operational_retry', 'drained'];
  return valid.includes(value as RuntimeLearningHeartbeatRunStatus) ? value as RuntimeLearningHeartbeatRunStatus : 'quiet';
}

// ---------------------------------------------------------------------------
// Episode evidence bundle builder
// ---------------------------------------------------------------------------
// buildEpisodeEvidenceBundle now lives in ./episode-evidence-bundle. The
// RuntimeLearning class calls the extracted function directly; the imports
// and type re-exports it depended on were hoisted to the top-level import
// section above to eliminate the former mid-file late imports.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function incrementTransition(
  counts: Partial<Record<CapabilityTransitionKind, number>>,
  transition: CapabilityTransitionKind,
): void {
  counts[transition] = (counts[transition] ?? 0) + 1;
}

function countBackfillProcessedEvents(metrics: ExternalSessionLogBackfillMetrics | undefined): number {
  if (!metrics) return 0;
  return metrics.ingestedEvents + metrics.duplicateEventsSkipped + metrics.tombstonedEventsSkipped;
}

function backfillSliceMadeProgress(
  before: ExternalSessionLogBackfillState | null,
  after: ExternalSessionLogBackfillState,
): boolean {
  if (
    countBackfillProcessedEvents(after.metrics) > countBackfillProcessedEvents(before?.metrics)
    || after.metrics.resourcesProcessed > (before?.metrics.resourcesProcessed ?? 0)
    || after.metrics.bytesProcessed > (before?.metrics.bytesProcessed ?? 0)
  ) return true;

  return Object.entries(after.resourceCursors).some(([resourceRef, cursor]) => {
    const previous = before?.resourceCursors[resourceRef];
    return !previous
      || cursor.position > previous.position
      || cursor.processedCount > previous.processedCount;
  });
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await worker(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, run));
}

/** Clamp external provider read concurrency to the supported 1–8 range. */
function clampConcurrency(value: number): number {
  const n = Math.floor(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 8) return 8;
  return n;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function toStablePathComponent(value: string): string {
  const normalized = value.trim();
  if (!normalized) return 'backfill';
  return encodeURIComponent(normalized).replace(/%/g, '_');
}
