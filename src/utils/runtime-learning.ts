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
 *
 * Legacy DistillationPipeline behavior is reachable only through the explicit
 * `legacyPipeline` constructor option. No RuntimeLearning wake depends on it.
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
import { DistillationPipeline } from './distillation-pipeline';
import {
  CrossFileContinuityOptions,
  DistillationUnit,
  extractDistillationUnit,
} from './distillation-unit';
import {
  advanceCursor,
  getCursor,
  loadLogCursorState,
  markCursorFailed,
  saveLogCursorState,
} from './log-cursor-state';
import { getDistillationHeartbeatConfig, DistillationHeartbeatConfig } from './distillation-heartbeat-config';
import { LearningEpisodeStore, LearningEpisode, buildLearningEpisodeCandidate } from './learning-episode';
import { SkillEvolutionRuntime, CapabilityTransitionKind } from './skill-evolution';
import { SkillUsageCurator, CuratorRunResult } from './skill-usage-curator';
import { Logger } from './logger';
import { bootstrapSemanticReassessmentOnce } from './distilled-skill-bootstrap';
import { SemanticReassessmentManifestStore } from './semantic-reassessment';
import { cleanupBranchTranscripts } from './branch-transcript-retention';
import { createReviewBudget, type ReviewBudget } from './review-budget';
import { XurlExternalSourceReader } from './xurl-session-log-source';
import { acquireExternalSourceProviderLock } from './external-source-provider-lock';
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
  ExternalSourceQuarantineEntry,
  ExternalCursorState,
  buildExternalEventDedupKey,
  listExternalSourceQuarantines,
  loadExternalCursorState,
  resolveExternalCursorStorePath,
  retryExternalSourceQuarantine,
  skipExternalSourceQuarantine,
  closeExternalResource,
  finalizeExternalDiscoveryCycleForStore,
  saveExternalCursorState,
  classifyExternalSourceFailureMessage,
  redactExternalSourceDiagnostic,
  DEFAULT_EXTERNAL_SOURCE_BUDGET,
  DEFAULT_INTERNAL_SOURCE_BUDGET,
} from './session-log-source';

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
  | 'manual';

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

const EXTERNAL_EPISODE_PROVENANCE_SCHEMA_VERSION = 1;
const EXTERNAL_BACKFILL_SLICE_RESOURCES = 10;
const EXTERNAL_BACKFILL_SLICE_BYTES = 2 * 1024 * 1024;
// A single xurl discovery/read pair is an external process boundary. Keep the
// cooperative slice bounded, but leave enough room for normal child-process
// startup and one bounded page under concurrent Runtime test/load conditions.
const EXTERNAL_BACKFILL_SLICE_MS = 5_000;
const REVIEW_CONTINUATION_SCHEMA_VERSION = 1;

interface ReviewContinuationState {
  schemaVersion: typeof REVIEW_CONTINUATION_SCHEMA_VERSION;
  episodeIds: string[];
  nextAttemptAt: string;
  updatedAt: string;
}

export interface ExternalEpisodeProvenanceState {
  schemaVersion: typeof EXTERNAL_EPISODE_PROVENANCE_SCHEMA_VERSION;
  episodeToEvent: Record<string, string>;
  eventToEpisodes: Record<string, string[]>;
}

function validateExternalEpisodeProvenanceState(value: unknown): ExternalEpisodeProvenanceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('external provenance state must be an object');
  }
  const candidate = value as Partial<ExternalEpisodeProvenanceState>;
  if (candidate.schemaVersion !== EXTERNAL_EPISODE_PROVENANCE_SCHEMA_VERSION) {
    throw new Error(`unsupported external provenance schema: ${String(candidate.schemaVersion)}`);
  }
  if (!candidate.episodeToEvent || typeof candidate.episodeToEvent !== 'object'
    || Array.isArray(candidate.episodeToEvent)) {
    throw new Error('external provenance episodeToEvent must be an object');
  }
  if (!candidate.eventToEpisodes || typeof candidate.eventToEpisodes !== 'object'
    || Array.isArray(candidate.eventToEpisodes)) {
    throw new Error('external provenance eventToEpisodes must be an object');
  }

  const episodeToEvent: Record<string, string> = {};
  const expectedByEvent = new Map<string, string[]>();
  for (const [episodeId, eventKey] of Object.entries(candidate.episodeToEvent)) {
    if (!episodeId || typeof eventKey !== 'string' || !eventKey) {
      throw new Error('external provenance contains an invalid episode/event mapping');
    }
    episodeToEvent[episodeId] = eventKey;
    expectedByEvent.set(eventKey, [...(expectedByEvent.get(eventKey) ?? []), episodeId]);
  }

  const eventToEpisodes: Record<string, string[]> = {};
  for (const [eventKey, episodeIds] of Object.entries(candidate.eventToEpisodes)) {
    if (!eventKey || !Array.isArray(episodeIds)
      || episodeIds.some(episodeId => typeof episodeId !== 'string' || !episodeId)) {
      throw new Error('external provenance contains an invalid event/episodes mapping');
    }
    const normalized = [...new Set(episodeIds)].sort();
    if (normalized.length !== episodeIds.length) {
      throw new Error(`external provenance contains duplicate episode ids for event: ${eventKey}`);
    }
    eventToEpisodes[eventKey] = normalized;
  }

  const expectedKeys = [...expectedByEvent.keys()].sort();
  const actualKeys = Object.keys(eventToEpisodes).sort();
  if (expectedKeys.join('\n') !== actualKeys.join('\n')) {
    throw new Error('external provenance indexes disagree on event keys');
  }
  for (const eventKey of expectedKeys) {
    const expected = [...(expectedByEvent.get(eventKey) ?? [])].sort();
    if (expected.join('\n') !== eventToEpisodes[eventKey].join('\n')) {
      throw new Error(`external provenance indexes disagree for event: ${eventKey}`);
    }
  }

  return {
    schemaVersion: EXTERNAL_EPISODE_PROVENANCE_SCHEMA_VERSION,
    episodeToEvent,
    eventToEpisodes,
  };
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
   * Legacy DistillationPipeline for compatibility. When set, the pipeline's
   * processUnit and admitEvidence methods remain callable through a
   * RuntimeLearning accessor. No RuntimeLearning wake depends on it.
   */
  legacyPipeline?: DistillationPipeline;
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
  private readonly legacyPipeline: DistillationPipeline | undefined;
  private readonly clock: () => Date;
  private readonly config: DistillationHeartbeatConfig;
  private readonly sessionLogSources: readonly SessionLogSourceAdapter[];
  private readonly discoveryQuotas: DiscoveryWakeQuotas;
  /** Per-source work budgets; internal logs are never exempt from quotas. */
  private readonly externalSourceBudget: SourceWorkBudget;
  private readonly internalSourceBudget: SourceWorkBudget;
  /**
   * Per-source failure tracking for external source lanes. Keyed by sourceId.
   * State is persisted to disk after each wake so restart recovery restores
   * lane due time, cursor, quota continuation, and backoff state.
   */
  private readonly externalSourceFailureState = new Map<string, SourceFailureState>();
  /**
   * Path to the durable external source scheduling state file. Used for
   * restart recovery of per-source backoff/suspension state.
   */
  private readonly schedulingStatePath: string;
  /** Durable Evidence Capsule store for external evidence (issue #78). */
  private readonly evidenceCapsuleStore: EvidenceCapsuleStore;
  /** Durable provenance index tying external events to episode ids (issue #78). */
  private readonly externalEpisodeProvenancePath: string;
  /** Fail-closed marker written before a corrupt provenance file is quarantined. */
  private readonly externalEpisodeProvenanceCorruptMarkerPath: string;
  private externalEpisodeProvenanceStateCorrupt = false;
  /** Episode id -> event key for external provenance lookup. */
  private readonly externalEpisodeProvenance = new Map<string, string>();
  /** Event key -> external episode ids. */
  private readonly externalEpisodeProvenanceByEvent = new Map<string, string[]>();
  /** Remains true until the latest in-memory provenance mutation is durable. */
  private externalEpisodeProvenanceDirty = false;

  private readonly pendingCuratorObservationEpisodeIds = new Set<string>();
  private readonly activeWakeAbortControllers = new Set<AbortController>();
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

  constructor(options: RuntimeLearningOptions) {
    this.workingDirectory = options.workingDirectory;
    this.evidenceIngestor = options.evidenceIngestor;
    this.episodeStore = options.learningEpisodeStore;
    this.skillEvolution = options.skillEvolution;
    this.curator = options.curator;
    this.planner = options.planner;
    this.legacyPipeline = options.legacyPipeline;
    this.clock = options.clock ?? (() => new Date());
    this.config = getDistillationHeartbeatConfig(this.workingDirectory);
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
    this.reviewContinuationPath = reviewContinuationPathForEpisodeStore(
      this.config.learningEpisodeStorePath,
    );
    this.schedulingStatePath = path.join(
      path.dirname(this.config.learningEpisodeStorePath),
      'external-source-scheduling-state.json',
    );
    this.externalEpisodeProvenancePath = path.join(
      path.dirname(this.config.learningEpisodeStorePath),
      'external-source-provenance.json',
    );
    this.externalEpisodeProvenanceCorruptMarkerPath = `${this.externalEpisodeProvenancePath}.state-corrupt`;
    this.loadExternalSourceSchedulingState();
    this.evidenceCapsuleStore = new EvidenceCapsuleStore(this.config.evidenceCapsulePath);
    this.loadExternalEpisodeProvenanceState();
  }

  // -----------------------------------------------------------------------
  // Public accessors for legacy compatibility
  // -----------------------------------------------------------------------

  /** Access the legacy pipeline for compatibility tests only. */
  getLegacyPipeline(): DistillationPipeline | undefined {
    return this.legacyPipeline;
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
   * External source failure state (issue #77). Returns a snapshot of the
   * current per-source failure tracking for inspection/testing.
   */
  getExternalSourceFailureState(): ReadonlyMap<string, SourceFailureState> {
    return new Map(this.externalSourceFailureState);
  }

  /** External source work budget (issue #77). */
  getExternalSourceBudget(): SourceWorkBudget {
    return { ...this.externalSourceBudget };
  }

  /** Evidence Capsule store for external evidence inspection/testing (issue #78). */
  getEvidenceCapsuleStore(): EvidenceCapsuleStore {
    return this.evidenceCapsuleStore;
  }

  listExternalSourceQuarantines(provider: string, sourceId: string): readonly ExternalSourceQuarantineEntry[] {
    return listExternalSourceQuarantines(this.externalCursorStorePath(provider, sourceId));
  }

  retryExternalSourceQuarantine(provider: string, sourceId: string, quarantineId: string): boolean {
    const mutation = this.runExternalSourceMutation(provider, sourceId, 'quarantine-retry', () => {
      const changed = retryExternalSourceQuarantine(this.externalCursorStorePath(provider, sourceId), quarantineId);
      if (changed) this.reconcileExternalSourceRecovery(provider, sourceId);
      return changed;
    });
    return mutation.acquired ? mutation.value : false;
  }

  skipExternalSourceQuarantine(
    provider: string,
    sourceId: string,
    quarantineId: string,
    reason = 'operator skip',
  ): boolean {
    const mutation = this.runExternalSourceMutation(provider, sourceId, 'quarantine-skip', () => {
      const changed = skipExternalSourceQuarantine(
        this.externalCursorStorePath(provider, sourceId),
        quarantineId,
        reason,
      );
      if (changed) this.reconcileExternalSourceRecovery(provider, sourceId);
      return changed;
    });
    return mutation.acquired ? mutation.value : false;
  }

  /** Retry a source-level protocol/integrity failure after operator repair. */
  retryExternalSourceFailure(provider: string, sourceId: string): boolean {
    const mutation = this.runExternalSourceMutation(provider, sourceId, 'source-failure-retry', () => {
      const current = this.externalSourceFailureState.get(sourceId);
      if (!current?.requiresOperatorAction) return false;
      if (this.listExternalSourceQuarantines(provider, sourceId).length > 0) return false;
      this.clearExternalSourceFailureGate(sourceId);
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
    const mutation = this.runExternalSourceMutation(provider, sourceId, 'resource-delete', () => (
      closeExternalResource(this.externalCursorStorePath(provider, sourceId), resourceRef, 'deleted')
    ));
    return mutation.acquired ? mutation.value : false;
  }

  /**
   * Close an external resource locally after the operator confirms the
   * upstream resource has been archived. Preserves the cursor and all local
   * evidence (issue #87).
   */
  archiveExternalSourceResource(provider: string, sourceId: string, resourceRef: string): boolean {
    const mutation = this.runExternalSourceMutation(provider, sourceId, 'resource-archive', () => (
      closeExternalResource(this.externalCursorStorePath(provider, sourceId), resourceRef, 'archived')
    ));
    return mutation.acquired ? mutation.value : false;
  }

  /**
   * Advance the external discovery lifecycle: closes any resource missing for
   * at least two cycles without waiting for the next wake (issue #87).
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
    return true;
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
    if (remaining.length > 0) {
      const current = this.externalSourceFailureState.get(sourceId);
      const first = remaining[0]!;
      this.externalSourceFailureState.set(sourceId, {
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
      });
    } else {
      this.clearExternalSourceFailureGate(sourceId);
    }
    this.saveExternalSourceSchedulingState();
  }

  private clearExternalSourceFailureGate(sourceId: string): void {
    const current = this.externalSourceFailureState.get(sourceId);
    if (!current) return;
    this.externalSourceFailureState.set(sourceId, {
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

  private buildConfiguredExternalSources(): readonly SessionLogSourceAdapter[] {
    if (!this.config.externalSessionLogSourcesEnabled) return [];
    const provider = this.config.externalSessionLogSelectedProvider?.trim();
    if (!provider) return [];
    const sourceId = this.config.externalSessionLogSelectedSourceId?.trim() || `external-${provider}`;
    const reader = this.config.externalSessionLogXurlCommand
      ? new XurlExternalSourceReader({
        command: this.config.externalSessionLogXurlCommand,
        provider,
        sourceId,
      })
      : undefined;
    return [new ExternalSessionLogSourceAdapter({
      sourceId,
      label: `${provider} Session Logs`,
      provider,
      reader,
      enabled: true,
    })];
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
    const validated = validateExternalEpisodeProvenanceState(state);
    this.externalEpisodeProvenance.clear();
    this.externalEpisodeProvenanceByEvent.clear();
    for (const [episodeId, eventKey] of Object.entries(validated.episodeToEvent)) {
      this.externalEpisodeProvenance.set(episodeId, eventKey);
    }
    for (const [eventKey, episodeIds] of Object.entries(validated.eventToEpisodes)) {
      this.externalEpisodeProvenanceByEvent.set(eventKey, [...episodeIds]);
    }

    const marker = fs.existsSync(this.externalEpisodeProvenanceCorruptMarkerPath)
      ? fs.readFileSync(this.externalEpisodeProvenanceCorruptMarkerPath)
      : undefined;
    try {
      if (marker) fs.unlinkSync(this.externalEpisodeProvenanceCorruptMarkerPath);
      this.externalEpisodeProvenanceStateCorrupt = false;
      this.externalEpisodeProvenanceDirty = true;
      this.saveExternalEpisodeProvenanceState();
    } catch (error) {
      this.externalEpisodeProvenanceStateCorrupt = true;
      if (marker && !fs.existsSync(this.externalEpisodeProvenanceCorruptMarkerPath)) {
        fs.writeFileSync(this.externalEpisodeProvenanceCorruptMarkerPath, marker, { mode: 0o600 });
      }
      throw error;
    }
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
  ): Promise<RuntimeLearningBackfillResult> {
    if (this.activeBackfill) {
      throw new Error('another external backfill operation is already active');
    }
    const writerOwner = Symbol('runtime-learning-external-backfill');
    const operation = Promise.resolve().then(
      () => this.withStateWriter(writerOwner, () => this.executeExternalBackfill(request, source, writerOwner)),
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
    for (const source of this.sessionLogSources) source.close?.();
    const active = this.activeBackfill;
    if (!active) {
      this.backfillDrainRequested = false;
      if (this.activeWakeAbortControllers.size === 0) {
        this.shutdownDrainRequested = false;
      }
      return;
    }
    let timer: NodeJS.Timeout | null = null;
    await Promise.race([
      active.then(() => undefined, () => undefined).finally(() => {
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
  ): Promise<RuntimeLearningBackfillResult> {
    const paths = this.getExternalBackfillOperationPaths(request);
    const service = new ExternalSessionLogBackfillService({
      stateFilePath: paths.stateFilePath,
      auditFilePath: paths.auditFilePath,
      now: this.clock,
    });

    const providerLock = this.acquireExternalProviderLock(
      source.identity.provider,
      'explicit-backfill',
      source.identity.sourceId,
    );
    if (!providerLock.acquired) {
      this.recordExternalSourceLockContention(source.identity.sourceId, source.identity.provider);
      throw new Error(`external source provider lock is busy for ${source.identity.provider}`);
    }

    try {
      let admittedEpisodes = 0;
      let contradictionSignals = 0;
      let externalProvenanceUpdated = false;

    const ingest = (unit: DistillationUnit, context: ExternalSessionLogBackfillIngestContext) => {
      const sanitizedUnit = sanitizeExternalDistillationUnit(unit, {
        sourceId: source.identity.sourceId,
        eventIdentity: context.eventIdentity,
      });
      const ingestion = this.evidenceIngestor.ingest(sanitizedUnit);
      const admissionEpisodeIds = this.resolveExternalEpisodeIds(
        source.identity,
        context.eventIdentity,
        sanitizedUnit,
        ingestion,
      );

      if (admissionEpisodeIds.length > 0) {
        externalProvenanceUpdated ||= this.recordExternalEpisodeProvenance(
          source.identity,
          context.eventIdentity,
          admissionEpisodeIds,
        );
      }

      this.queueCuratorObservation(ingestion.admittedEpisodeIds);
      this.createCapsulesForExternalSource(
        source.identity,
        context.eventIdentity,
        ingestion,
        admissionEpisodeIds,
      );
      if (externalProvenanceUpdated || this.externalEpisodeProvenanceDirty) {
        // The backfill service persists its resource cursor after this ingest
        // callback returns, so provenance must cross the durable boundary now.
        this.saveExternalEpisodeProvenanceState();
        externalProvenanceUpdated = false;
      }
      admittedEpisodes += ingestion.admittedEpisodeIds.length;
      contradictionSignals += ingestion.contradictionSignalIds.length;
      return { admittedEpisodeIds: ingestion.admittedEpisodeIds };
    };

    let backfill: ExternalSessionLogBackfillRunResult | null = null;
    let drained = false;
    let priorityMaturation = skippedMaturationReport();
    let priorityReview = skippedReviewReport();
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

      backfill = service.run({
        ...request,
        limits: {
          maxResources: Math.min(request.limits.maxResources, EXTERNAL_BACKFILL_SLICE_RESOURCES),
          maxBytes: Math.min(request.limits.maxBytes, EXTERNAL_BACKFILL_SLICE_BYTES),
          maxElapsedMs: Math.min(request.limits.maxElapsedMs, EXTERNAL_BACKFILL_SLICE_MS),
        },
      }, source, ingest);

      if (backfill.status !== 'quota_reached') break;
      const priorMetrics = backfill.state.metrics;
      if (this.backfillDrainRequested) {
        drained = true;
        break;
      }
      // A single event larger than the cooperative byte slice must remain
      // resumable, but retrying the same zero-progress slice would spin.
      // Leave it quota-limited for the next explicit invocation.
      if (
        backfill.ingestedEvents === 0
        && backfill.duplicateEventsSkipped === 0
        && backfill.processedResources === 0
        && priorMetrics.resourcesProcessed === 0
      ) {
        break;
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    } while (backfill.status === 'quota_reached');

    if (!backfill) {
      throw new Error('external backfill did not produce a result');
    }

    // Backfill owns a separate cursor/audit, but source health is shared with
    // continuous ingestion. Persist the same durable failure class without
    // routing source failures into Operational Review Retry accounting.
    if (backfill.status === 'source_failed') {
      const latestFailure = backfill.state.failures[backfill.state.failures.length - 1];
      const message = latestFailure?.message ?? 'external backfill source failed';
      this.recordExternalSourceFailure(source.identity.sourceId, new Error(message), {
        failureClass: this.classifyExternalSourceFailure(message),
        resourceRef: latestFailure?.resourceRef,
        eventId: latestFailure?.eventId,
      });
      this.saveExternalSourceSchedulingState();
    } else if (backfill.status === 'pending') {
      this.recordExternalSourceFailure(source.identity.sourceId, new Error('pending external backfill range'), {
        failureClass: 'pending',
      });
      this.saveExternalSourceSchedulingState();
    } else if (backfill.status === 'completed') {
      this.resetExternalSourceFailure(source.identity.sourceId);
      this.saveExternalSourceSchedulingState();
    }

    if (externalProvenanceUpdated || this.externalEpisodeProvenanceDirty) {
      this.saveExternalEpisodeProvenanceState();
    }

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
    return this.wakeWithStateWriter(reason, wakeOptions);
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
      // ---- 1. Discovery + Ingestion (source-neutral) ----
      const shouldScan = isDiscoveryWake;

      if (shouldScan) {
        const discoveryResult = this.runDiscovery();
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
      );
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
    );
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
    if (!this.curator || this.pendingCuratorObservationEpisodeIds.size === 0) return;

    const state = this.episodeStore.load();
    const pending = new Set(this.pendingCuratorObservationEpisodeIds);

    for (const episode of Object.values(state.episodes)) {
      if (!pending.has(episode.episodeId)) continue;
      try {
        this.curator.observeEpisode(episode);
        this.pendingCuratorObservationEpisodeIds.delete(episode.episodeId);
      } catch {
        // Observation failure should not block the wake. The episode
        // remains queued for a later retry.
      }
    }
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

      const maturedEpisodeIds = episodes
        .filter(e => preSettleStatuses.get(e.episodeId) === 'settling' && e.status !== 'settling')
        .map(e => e.episodeId);

      const becameEligible = episodes.filter(
        e => preSettleStatuses.get(e.episodeId) === 'settling' && e.status === 'eligible',
      ).length;

      const becameContradicted = episodes.filter(
        e => preSettleStatuses.get(e.episodeId) === 'settling' && e.status === 'contradicted',
      ).length;

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
    // One wake owns one shared wall-clock and conservative input budget. Any
    // unadmitted eligible episode remains durable and is resumed next wake.
    const reviewBudget = createReviewBudget({
      maxCandidates: this.config.skillEvolutionReviewMaxCandidates,
      maxPromptTokens: this.config.skillEvolutionReviewMaxPromptTokens,
      deadlineMs: this.config.skillEvolutionReviewAttemptDeadlineMinutes * 60_000,
      now: () => this.clock().getTime(),
    });
    const pendingEpisodeIds = new Set<string>();

    // Review eligible learning episodes
    let reviewedEpisodes = 0;
    let episodeReviewFailures = 0;
    let episodeReviewTimeouts = 0;
    let episodeOperationalFailures = 0;
    let settlementError: unknown;

    try {
      const episodes = Object.values(this.episodeStore.load().episodes);
      const reviewedOrQueuedBundleIds = this.skillEvolution.getReviewedOrQueuedBundleIds();
      const reviewTasks: Array<{ episode: LearningEpisode; bundle: ReturnType<typeof buildEpisodeEvidenceBundle> }> = [];
      for (const episode of episodes) {
        if (episode.status !== 'eligible' || this.hasReviewedEpisode(episode, reviewedOrQueuedBundleIds)) continue;
        pendingEpisodeIds.add(episode.episodeId);
        if (reviewTasks.length >= this.config.skillEvolutionReviewMaxCandidates) continue;
        const candidate = buildLearningEpisodeCandidate(episode);
        const bundle = buildEpisodeEvidenceBundle(
          episode,
          candidate,
          this.skillEvolution,
          this.evidenceCapsuleStore,
          this.isEpisodeFromExternalSource.bind(this),
        );
        reviewTasks.push({ episode, bundle });
      }
      await mapWithConcurrency(
        reviewTasks,
        Math.max(1, Math.floor(this.config.skillEvolutionReviewerConcurrency)),
        async ({ episode, bundle }) => {
          // Charge at dispatch time, not collection time. This prevents queued
          // concurrency work from starting after the shared wall-clock limit.
          if (!this.canAdmitReviewWork(reviewBudget, bundle)) {
            Logger.info(`[RuntimeLearning] review budget exhausted or shutdown drain requested; episode ${episode.episodeId} remains resumable`);
            return;
          }
          try {
            const result = await this.skillEvolution.reviewAndApply(
              bundle,
              wakeSignal,
            );
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
            // The candidate remains durable and is retried independently.
            episodeReviewFailures++;
            Logger.warning(`[RuntimeLearning] review failed for ${episode.episodeId}: ${error.message}`);
          }
        },
      );
    } catch (error) {
      settlementError = error;
    }

    // Review due queue entries (semantic defers + operational retries)
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
    let queueError: unknown;
    let reviewTimeoutCount = episodeReviewTimeouts;
    let reviewFailureCount = episodeOperationalFailures;
    try {
      // Queue entries share the exact same candidate/token/time budget as
      // eligible episodes. Admission is charged on each frozen queue bundle.
      if (!this.shutdownDrainRequested && !wakeSignal?.aborted) {
        queueResult = await this.skillEvolution.reviewDueQueueEntries({
          signal: wakeSignal,
          admit: bundle => this.canAdmitReviewWork(reviewBudget, bundle),
        });
        this.reconcileReassessmentQueueOutcomes(queueResult.queueOutcomes);
      }
    } catch (error) {
      queueError = error;
      Logger.warning(`[RuntimeLearning] queue review failed: ${toErrorMessage(error)}`);
    }

    for (const [transition, count] of Object.entries(queueResult.transitionsByKind)) {
      if (!count) continue;
      const key = transition as CapabilityTransitionKind;
      transitionsByKind[key] = (transitionsByKind[key] ?? 0) + count;
    }

    // Report failure when any per-episode review or queue review failed.
    // Completed counts and transitions are preserved; operational retry and
    // cursor semantics are unaffected.
    const hasEpisodeFailure = episodeReviewFailures > 0;
    const hasQueueFailure = !!queueError;
    if (hasEpisodeFailure) reviewFailureCount += episodeReviewFailures;
    if (hasQueueFailure) reviewFailureCount += 1;

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

    const status: RuntimeLearningStageStatus = (hasEpisodeFailure || hasQueueFailure || !!settlementError)
      ? 'failed'
      : 'succeeded';

    const errorParts: string[] = [];
    if (hasEpisodeFailure) errorParts.push(`${episodeReviewFailures} episode review(s) failed`);
    if (hasQueueFailure) errorParts.push(`queue review failed: ${toErrorMessage(queueError)}`);
    if (settlementError) errorParts.push(`settlement error: ${toErrorMessage(settlementError)}`);

    this.persistReviewContinuation(pendingEpisodeIds);

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

  private canAdmitReviewWork(reviewBudget: ReviewBudget, bundle: EvidenceBundle): boolean {
    if (this.shutdownDrainRequested) return false;
    return reviewBudget.admit(bundle);
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

    // Override the dueWork flags if observations since planning triggered
    // a new expedited wake.
    const effectiveExpeditedDue = dueWork.expeditedCuratorDue || hasExpedited;

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
  private runDiscovery(): {
    sourceReports: readonly SessionLogSourceReport[];
    admittedEpisodes: number;
    contradictionSignals: number;
  } {
    const sourceReports: SessionLogSourceReport[] = [];
    let totalAdmittedEpisodes = 0;
    let totalContradictionSignals = 0;

    // Wake-level caps: bound resources examined, candidates admitted, and
    // wall-clock time so discovery cannot starve the overdue settlement/review
    // stages that run after it. Remaining resources are deferred to the next
    // wake; their cursors are NOT advanced here (only successfully processed
    // resources are acknowledged below), so no cursor is falsely acknowledged.
    const discoveryStartMs = this.clock().getTime();
    let wakeResourcesExamined = 0;
    let wakeAdmittedEpisodes = 0;
    let discoveryCapped = false;

    // ---- AC2: Internal-first ordering ----
    const orderedSources = this.orderSourcesForDiscovery();
    let externalProvenanceUpdated = false;

    for (const adapter of orderedSources) {
      if (discoveryCapped) break;
      const enabled = adapter.isEnabled();
      const identity = adapter.identity;
      const isExternal = identity.category === 'external';

      if (!enabled) {
        sourceReports.push({
          sourceId: identity.sourceId,
          category: identity.category,
          enabled: false,
          resourcesDiscovered: 0,
          unitsProcessed: 0,
          advancedResources: 0,
          status: 'active',
          ...(isExternal ? this.buildExternalSourceReportDiagnostics(identity, this.externalSourceFailureState.get(identity.sourceId)) : {}),
        });
        continue;
      }

      if (isExternal && (this.shutdownDrainRequested || this.externalSourceDrainRequested)) {
        const failureState = this.externalSourceFailureState.get(identity.sourceId);
        sourceReports.push({
          sourceId: identity.sourceId,
          category: identity.category,
          enabled: true,
          resourcesDiscovered: 0,
          unitsProcessed: 0,
          advancedResources: 0,
          status: 'drained',
          failureState,
          ...(this.buildExternalSourceReportDiagnostics(identity, failureState)),
        });
        continue;
      }

      // ---- AC3: Skip suspended/manual-action external sources ----
      if (isExternal) {
        const failureState = this.externalSourceFailureState.get(identity.sourceId);
        if (this.shouldSkipExternalSourceForFailure(failureState)) {
          sourceReports.push({
            sourceId: identity.sourceId,
            category: identity.category,
            enabled: true,
            resourcesDiscovered: 0,
            unitsProcessed: 0,
            advancedResources: 0,
            status: 'backoff',
            failureState,
            ...(this.buildExternalSourceReportDiagnostics(identity, failureState)),
          });
          continue;
        }
      }

      // Every lane, including the internal JSONL lane, has resource/byte/time
      // limits. Optional external sources use a separately configurable cap.
      const budget = isExternal ? this.externalSourceBudget : this.internalSourceBudget;
      const sourceStartMs = this.clock().getTime();
      let sourceResourcesExamined = 0;
      let sourceBytesRead = 0;
      let sourceEventsRead = 0;
      let sourceReaderElapsedMs = 0;
      let sourceHadFailure = false;
      let sourceBudgetHit = false;
      const providerLock = isExternal
        ? this.acquireExternalProviderLock(identity.provider, 'continuous-discovery', identity.sourceId)
        : null;
      if (providerLock && !providerLock.acquired) {
        this.recordExternalSourceLockContention(identity.sourceId, identity.provider);
        const failureState = this.externalSourceFailureState.get(identity.sourceId) ?? undefined;
        sourceReports.push({
          sourceId: identity.sourceId,
          category: identity.category,
          enabled: true,
          resourcesDiscovered: 0,
          unitsProcessed: 0,
          advancedResources: 0,
          status: 'locked',
          failureState,
          budget,
          ...(this.buildExternalSourceReportDiagnostics(identity, failureState)),
          ...(adapter.getSupportStatus ? { supportStatus: adapter.getSupportStatus() } : {}),
          ...(adapter.getUnsupportedReason?.() ? { unsupportedReason: adapter.getUnsupportedReason() } : {}),
        });
        continue;
      }

      try {
      let resources: readonly SessionLogSourceResource[];
      try {
        resources = adapter.discoverResources({
          maxResources: Math.min(
            budget.maxResourcesPerWake,
            Math.max(1, this.discoveryQuotas.maxResourcesPerWake - wakeResourcesExamined),
          ),
          maxElapsedMs: Math.min(
            budget.maxElapsedMsPerWake,
            Math.max(1, this.discoveryQuotas.maxDiscoveryMs - (this.clock().getTime() - discoveryStartMs)),
          ),
        });
      } catch (error) {
        // AC3: Discovering resources is source-local failure; keep discovery
        // for other sources and keep OPR independent of this failure.
        sourceHadFailure = true;
        if (isExternal) this.recordExternalSourceFailure(identity.sourceId, error);
        const failureState = isExternal ? (this.externalSourceFailureState.get(identity.sourceId) ?? undefined) : undefined;
        sourceReports.push({
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
        });
        continue;
      }

      let unitsProcessed = 0;
      let advancedResources = 0;

      const readContextBase: SessionLogSourceReadContext = { orderedResources: resources };

      for (const resource of resources) {
        if (discoveryCapped) break;

        // ---- AC1: Per-source quota checks ----
        {
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
        }
        sourceResourcesExamined++;

        // ---- Wake-level cap checks ----
        if (wakeResourcesExamined >= this.discoveryQuotas.maxResourcesPerWake) {
          discoveryCapped = true;
          break;
        }
        if (wakeAdmittedEpisodes >= this.discoveryQuotas.maxAdmittedEpisodesPerWake) {
          discoveryCapped = true;
          break;
        }
        if (wakeResourcesExamined > 0
          && this.clock().getTime() - discoveryStartMs > this.discoveryQuotas.maxDiscoveryMs) {
          discoveryCapped = true;
          break;
        }
        wakeResourcesExamined++;

        // ---- Read resource ----
        let readResult: SessionLogSourceReadResult;
        try {
          const elapsedMs = Math.max(0, this.clock().getTime() - sourceStartMs);
          readResult = adapter.read(resource, {
            ...readContextBase,
            remainingBudget: {
              maxResourcesPerWake: Math.max(0, budget.maxResourcesPerWake - sourceResourcesExamined + 1),
              maxBytesPerWake: Math.max(0, budget.maxBytesPerWake - sourceBytesRead),
              maxElapsedMsPerWake: Math.max(0, budget.maxElapsedMsPerWake - elapsedMs),
            },
          });
        } catch (error) {
          // AC3: Per-source failure recording, NOT OPR
          adapter.markFailed(resource, error);
          sourceHadFailure = true;
          if (isExternal) {
            this.recordExternalSourceFailure(identity.sourceId, error, { resourceRef: resource.resourceRef });
          }
          continue;
        }

        if (readResult.status === 'failed') {
          const failure = readResult.failure;
          adapter.markFailed(resource, new Error(failure?.message ?? 'source read reported failed status'));
          sourceHadFailure = true;
          if (isExternal) {
            const failedEvent = failure?.eventIdentities?.[0]
              ?? readResult.eventIdentities?.[0]
              ?? resource.firstEventIdentity;
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
            this.recordExternalSourceFailure(identity.sourceId, new Error(failure?.message ?? 'source read reported failed status'), {
              failureClass: failure?.failureClass,
              resourceRef: failure?.resourceRef ?? resource.resourceRef,
              eventId: failedEvent?.eventId,
            });
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
          // No distillation unit — advance cursor if the adapter reports progress
          if (readResult.advanced || readResult.releaseResource) {
            try {
              adapter.acknowledge(resource, readResult);
              if (readResult.advanced) advancedResources++;
              // Success resets failure count for external sources
              if (isExternal) {
                this.resetExternalSourceFailure(identity.sourceId);
              }
            } catch (error) {
              adapter.markFailed(resource, error);
              sourceHadFailure = true;
              if (isExternal) {
                this.recordExternalSourceFailure(identity.sourceId, error, { resourceRef: resource.resourceRef });
              }
            }
          } else if (isExternal) {
            this.recordExternalSourceFailure(identity.sourceId, new Error('pending external range remains unacknowledged'), {
              failureClass: 'pending',
              resourceRef: resource.resourceRef,
            });
          }
          continue;
        }

        // A multi-event external read is one acknowledgement unit: every
        // stable event must be admitted before the cursor can advance. A
        // missing identity would make provenance/capsule ownership ambiguous,
        // so fail closed and leave the whole batch resumable.
        let batchEventInProgress: SourceEventIdentity | undefined;
        try {
          const eventIdentities = readResult.eventIdentities ?? [];
          if (isExternal && eventIdentities.length > 0 && eventIdentities.length !== distillationUnits.length) {
            throw new Error('stable external batch is missing one or more event identities');
          }

          let batchAdmittedEpisodes = 0;
          let batchContradictionSignals = 0;
          for (let index = 0; index < distillationUnits.length; index++) {
            if (
              wakeAdmittedEpisodes + batchAdmittedEpisodes
              >= this.discoveryQuotas.maxAdmittedEpisodesPerWake
            ) {
              discoveryCapped = true;
              throw new DiscoveryAdmissionQuotaReachedError();
            }
            const eventIdentity = eventIdentities[index]
              ?? (distillationUnits.length === 1
                ? (resource.firstEventIdentity ?? { eventId: resource.resourceRef, position: 0 })
                : undefined);
            if (isExternal && !eventIdentity) {
              throw new Error('stable external batch event has no canonical identity');
            }
            const resolvedEventIdentity = eventIdentity ?? {
              eventId: resource.resourceRef,
              position: index,
            };
            batchEventInProgress = resolvedEventIdentity;

            // External evidence crosses the privacy boundary before it reaches
            // EvidenceIngestor. Internal source behavior remains unchanged.
            const ingestUnit = isExternal
              ? sanitizeExternalDistillationUnit(distillationUnits[index]!, {
                sourceId: identity.sourceId,
                eventIdentity,
              })
              : distillationUnits[index]!;
            const ingestionResult = this.evidenceIngestor.ingest(ingestUnit);
            const admissionEpisodeIds = isExternal
              ? this.resolveExternalEpisodeIds(
                identity,
                resolvedEventIdentity,
                ingestUnit,
                ingestionResult,
              )
              : ingestionResult.admittedEpisodeIds;

            if (isExternal && admissionEpisodeIds.length > 0) {
              externalProvenanceUpdated ||= this.recordExternalEpisodeProvenance(
                identity,
                resolvedEventIdentity,
                admissionEpisodeIds,
              );
            }

            this.queueCuratorObservation(ingestionResult.admittedEpisodeIds);
            if (isExternal) {
              // Persist the redacted Evidence Capsule BEFORE acknowledging the
              // external cursor. If any event fails, the fixed batch remains
              // unacknowledged and can be replayed idempotently.
              this.createCapsulesForExternalSource(
                identity,
                resolvedEventIdentity,
                ingestionResult,
                admissionEpisodeIds,
              );
            }
            batchAdmittedEpisodes += ingestionResult.admittedEpisodeIds.length;
            batchContradictionSignals += ingestionResult.contradictionSignalIds.length;
          }

          // Provenance is part of the crash-safe external commit boundary.
          // Persist it after episodes/capsules but before cursor acknowledgement;
          // replay is idempotent if the process stops anywhere before this point.
          if (isExternal && (externalProvenanceUpdated || this.externalEpisodeProvenanceDirty)) {
            this.saveExternalEpisodeProvenanceState();
            externalProvenanceUpdated = false;
          }

          adapter.acknowledge(resource, readResult);
          unitsProcessed += distillationUnits.length;
          advancedResources++;
          totalAdmittedEpisodes += batchAdmittedEpisodes;
          wakeAdmittedEpisodes += batchAdmittedEpisodes;
          totalContradictionSignals += batchContradictionSignals;
          // Success resets failure count for external sources
          if (isExternal) {
            this.resetExternalSourceFailure(identity.sourceId);
          }
        } catch (error) {
          if (error instanceof DiscoveryAdmissionQuotaReachedError) {
            sourceBudgetHit = true;
            break;
          }
          // AC3: Per-source failure on ingestion, NOT OPR
          adapter.markFailed(resource, error);
          sourceHadFailure = true;
          if (isExternal) {
            const message = this.redactExternalSourceError(error);
            const failureClass = this.classifyExternalSourceFailure(message);
            const eventIdentity = batchEventInProgress
              ?? readResult.eventIdentities?.[0]
              ?? resource.firstEventIdentity;
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
            this.recordExternalSourceFailure(identity.sourceId, error, {
              failureClass,
              resourceRef: resource.resourceRef,
              eventId: eventIdentity?.eventId,
            });
          }
        }
      }

      // ---- Determine status ----
      let status: SessionLogSourceStatus = 'active';
      if (sourceHadFailure) status = 'failed';
      if (sourceBudgetHit) status = 'quota_reached';

      const failureState = isExternal
        ? this.externalSourceFailureState.get(identity.sourceId) ?? undefined
        : undefined;

      sourceReports.push({
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
        ...(adapter.getUnsupportedReason?.()
          ? { unsupportedReason: adapter.getUnsupportedReason() }
          : {}),
        ...(isExternal ? this.buildExternalSourceReportDiagnostics(identity, failureState) : {}),
      });
      } finally {
        if (providerLock?.acquired) providerLock.release();
      }
    }

    // Persist external source scheduling state (backoff deadlines) for restart
    // recovery (AC6).
    this.saveExternalSourceSchedulingState();
    if (externalProvenanceUpdated || this.externalEpisodeProvenanceDirty) {
      this.saveExternalEpisodeProvenanceState();
    }

    return {
      sourceReports,
      admittedEpisodes: totalAdmittedEpisodes,
      contradictionSignals: totalContradictionSignals,
    };
  }

  // -----------------------------------------------------------------------
  // Source ordering and external failure management (issue #77)
  // -----------------------------------------------------------------------

  /**
   * Order session log sources for discovery: internal sources are processed
   * BEFORE external sources. This protects due settlement/review/retry work
   * and internal discovery from optional external scanning (AC2).
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
    return [...internal, ...external];
  }

  private recordExternalSourceFailure(
    sourceId: string,
    error: unknown,
    context: {
      failureClass?: ExternalSourceFailureClass;
      resourceRef?: string;
      eventId?: string;
    } = {},
  ): void {
    const current = this.externalSourceFailureState.get(sourceId);
    const message = this.redactExternalSourceError(error);
    const failureClass = context.failureClass ?? this.classifyExternalSourceFailure(message);
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

    this.externalSourceFailureState.set(sourceId, {
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
    });
  }

  private recordExternalSourceLockContention(sourceId: string, provider: string): void {
    const current = this.externalSourceFailureState.get(sourceId);
    const nowIso = this.clock().toISOString();
    this.externalSourceFailureState.set(sourceId, {
      consecutiveFailures: current?.consecutiveFailures ?? 0,
      lastFailedAt: current?.lastFailedAt ?? null,
      lastError: `provider lock busy for ${provider}`,
      suspendedUntil: null,
      failureClass: 'pending',
      nextRetryAt: nowIso,
      requiresOperatorAction: false,
      lastAttemptedAt: nowIso,
      lastSuccessfulReadAt: current?.lastSuccessfulReadAt ?? null,
    });
  }

  private resetExternalSourceFailure(sourceId: string): void {
    const current = this.externalSourceFailureState.get(sourceId);
    // Only update if the source had prior state — a healthy source that never
    // failed should not accumulate a scheduling-state entry just from a
    // successful read. When prior state exists, clear the failure counters and
    // record the successful read timestamp for diagnostics.
    if (!current) return;
    const nowIso = this.clock().toISOString();
    this.externalSourceFailureState.set(sourceId, {
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
        sources?: Record<string, SourceFailureState>;
      };
      if (!parsed.sources || typeof parsed.sources !== 'object') return;
      for (const [sourceId, state] of Object.entries(parsed.sources)) {
        if (typeof state.consecutiveFailures !== 'number') continue;
        this.externalSourceFailureState.set(sourceId, {
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
        });
      }
    } catch {
      // Corrupt state file — start fresh; the source will be retried.
    }
  }

  private saveExternalSourceSchedulingState(): void {
    try {
      const sources: Record<string, SourceFailureState> = {};
      for (const [sourceId, state] of this.externalSourceFailureState) {
        const hasSignal = state.consecutiveFailures > 0
          || Boolean(state.suspendedUntil)
          || Boolean(state.failureClass)
          || Boolean(state.lastError)
          || Boolean(state.lastSuccessfulReadAt);
        if (hasSignal) {
          sources[sourceId] = state;
        }
      }
      if (Object.keys(sources).length === 0) {
        if (fs.existsSync(this.schedulingStatePath)) {
          fs.unlinkSync(this.schedulingStatePath);
        }
        return;
      }
      const payload = { schemaVersion: 2, sources };
      fs.mkdirSync(path.dirname(this.schedulingStatePath), { recursive: true });
      const tmpPath = `${this.schedulingStatePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.renameSync(tmpPath, this.schedulingStatePath);
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
  ): Pick<SessionLogSourceReport, 'provider' | 'reader' | 'selectedProvider' | 'cursorProgress' | 'lastSuccessfulReadAt' | 'nextRetryAt' | 'lastError' | 'failureClass' | 'requiresOperatorAction' | 'nextAction' | 'drainState'> {
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
      selectedProvider: this.config.externalSessionLogSelectedProvider?.trim() || undefined,
      cursorProgress,
      lastSuccessfulReadAt: failureState?.lastSuccessfulReadAt ?? resourceLastSuccessfulReadAt,
      nextRetryAt: failureState?.nextRetryAt ?? undefined,
      lastError: failureState?.lastError ?? undefined,
      failureClass: failureState?.failureClass,
      requiresOperatorAction: failureState?.requiresOperatorAction,
      nextAction,
      drainState: (this.shutdownDrainRequested || this.externalSourceDrainRequested) ? 'draining' : 'idle',
    };
  }


  /**
   * Track that a specific external event maps to the listed episode ids.
   * Returns true if this run changed durable provenance state.
   */
  private recordExternalEpisodeProvenance(
    identity: SessionLogSourceIdentity,
    eventIdentity: SourceEventIdentity,
    episodeIds: readonly string[],
  ): boolean {
    this.assertExternalEpisodeProvenanceHealthy();
    if (episodeIds.length === 0) return false;

    const eventKey = this.getExternalEpisodeProvenanceEventKey(identity, eventIdentity);
    const existingEventEpisodeIds = new Set(this.externalEpisodeProvenanceByEvent.get(eventKey) ?? []);
    const nextEventEpisodeIds = new Set(existingEventEpisodeIds);

    let changed = false;
    for (const episodeId of episodeIds) {
      nextEventEpisodeIds.add(episodeId);

      const previousEventKey = this.externalEpisodeProvenance.get(episodeId);
      if (previousEventKey === eventKey) {
        continue;
      }
      if (previousEventKey !== undefined) {
        const removedFromPrevious = this.externalEpisodeProvenanceByEvent.get(previousEventKey);
        if (removedFromPrevious) {
          const nextRemovedSet = new Set(removedFromPrevious);
          nextRemovedSet.delete(episodeId);
          const nextRemoved = [...nextRemovedSet];
          if (nextRemoved.length === 0) {
            this.externalEpisodeProvenanceByEvent.delete(previousEventKey);
          } else {
            this.externalEpisodeProvenanceByEvent.set(previousEventKey, nextRemoved);
          }
        }
      }
      this.externalEpisodeProvenance.set(episodeId, eventKey);
      changed = true;
    }

    const nextEventEpisodeIdsList = [...nextEventEpisodeIds].sort();
    const currentEventEpisodeIds = this.externalEpisodeProvenanceByEvent.get(eventKey);
    if (!currentEventEpisodeIds || currentEventEpisodeIds.join('|') !== nextEventEpisodeIdsList.join('|')) {
      this.externalEpisodeProvenanceByEvent.set(eventKey, nextEventEpisodeIdsList);
      changed = true;
    }
    if (changed) this.externalEpisodeProvenanceDirty = true;
    return changed;
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
    this.assertExternalEpisodeProvenanceHealthy();
    if (ingestion.admittedEpisodeIds.length > 0) {
      return [...ingestion.admittedEpisodeIds];
    }
    const indexed = this.getExternalEpisodeIdsForEvent(identity, eventIdentity);
    if (indexed.length > 0) return indexed;
    return Object.values(ingestion.state.episodes)
      .filter(episode => episode.sourceFilePath === sanitizedUnit.filePath)
      .map(episode => episode.episodeId)
      .sort();
  }

  private getExternalEpisodeIdsForEvent(
    identity: SessionLogSourceIdentity,
    eventIdentity: SourceEventIdentity,
  ): string[] {
    this.assertExternalEpisodeProvenanceHealthy();
    const eventKey = this.getExternalEpisodeProvenanceEventKey(identity, eventIdentity);
    return [...(this.externalEpisodeProvenanceByEvent.get(eventKey) ?? [])];
  }

  private isEpisodeFromExternalSource(episodeId: string): boolean {
    this.assertExternalEpisodeProvenanceHealthy();
    return this.externalEpisodeProvenance.has(episodeId);
  }

  private getExternalEpisodeProvenanceEventKey(
    identity: SessionLogSourceIdentity,
    eventIdentity: SourceEventIdentity,
  ): string {
    const sourceHash = normalizeSourceHash(identity);
    const contentHash = normalizeSourceEventHash(eventIdentity.contentHash);
    const conversationPart = eventIdentity.conversationId ? `::conversation=${eventIdentity.conversationId}` : '';
    const branchPart = eventIdentity.branchId ? `::branch=${eventIdentity.branchId}` : '';
    const revisionPart = eventIdentity.revision ? `::revision=${eventIdentity.revision}` : '';
    return `${identity.sourceId}::${identity.provider}::${identity.reader}::${sourceHash}::${eventIdentity.eventId}#${eventIdentity.position}`
      + conversationPart
      + branchPart
      + revisionPart
      + (contentHash ? `::${contentHash}` : '');
  }

  private loadExternalEpisodeProvenanceState(): void {
    if (fs.existsSync(this.externalEpisodeProvenanceCorruptMarkerPath)) {
      this.externalEpisodeProvenanceStateCorrupt = true;
      Logger.warning(
        `[RuntimeLearning] external episode provenance is quarantined: ${this.externalEpisodeProvenanceCorruptMarkerPath}`,
      );
      return;
    }

    try {
      if (!fs.existsSync(this.externalEpisodeProvenancePath)) return;
      const raw = fs.readFileSync(this.externalEpisodeProvenancePath, 'utf-8');
      const parsed = validateExternalEpisodeProvenanceState(JSON.parse(raw));
      for (const [episodeId, eventKey] of Object.entries(parsed.episodeToEvent)) {
        this.externalEpisodeProvenance.set(episodeId, eventKey);
      }
      for (const [eventKey, episodeIds] of Object.entries(parsed.eventToEpisodes)) {
        this.externalEpisodeProvenanceByEvent.set(eventKey, [...episodeIds]);
      }
    } catch (error) {
      this.externalEpisodeProvenanceStateCorrupt = true;
      fs.mkdirSync(path.dirname(this.externalEpisodeProvenancePath), { recursive: true });
      fs.writeFileSync(
        this.externalEpisodeProvenanceCorruptMarkerPath,
        JSON.stringify({
          detectedAt: this.clock().toISOString(),
          sourcePath: this.externalEpisodeProvenancePath,
          reason: error instanceof Error ? error.message : String(error),
        }, null, 2),
        { encoding: 'utf-8', mode: 0o600 },
      );
      const quarantinePath = `${this.externalEpisodeProvenancePath}.corrupt-${Date.now()}`;
      try {
        if (fs.existsSync(this.externalEpisodeProvenancePath)) {
          fs.renameSync(this.externalEpisodeProvenancePath, quarantinePath);
        }
      } catch (quarantineError) {
        Logger.warning(
          `[RuntimeLearning] failed to quarantine corrupt external provenance: ${(quarantineError as Error).message}`,
        );
      }
      Logger.warning(
        `[RuntimeLearning] external episode provenance failed closed: ${(error as Error).message}`,
      );
    }
  }

  private saveExternalEpisodeProvenanceState(): void {
    this.assertExternalEpisodeProvenanceHealthy();
    const episodeToEvent: Record<string, string> = {};
    for (const [episodeId, eventKey] of this.externalEpisodeProvenance) {
      episodeToEvent[episodeId] = eventKey;
    }

    if (Object.keys(episodeToEvent).length === 0) {
      if (fs.existsSync(this.externalEpisodeProvenancePath)) {
        fs.unlinkSync(this.externalEpisodeProvenancePath);
      }
      this.externalEpisodeProvenanceDirty = false;
      return;
    }

    const eventToEpisodes: Record<string, string[]> = {};
    for (const [eventKey, episodeIds] of this.externalEpisodeProvenanceByEvent) {
      if (episodeIds.length > 0) {
        eventToEpisodes[eventKey] = [...episodeIds].sort();
      }
    }

    const payload: ExternalEpisodeProvenanceState = {
      schemaVersion: EXTERNAL_EPISODE_PROVENANCE_SCHEMA_VERSION,
      episodeToEvent,
      eventToEpisodes,
    };
    fs.mkdirSync(path.dirname(this.externalEpisodeProvenancePath), { recursive: true });
    const tmpPath = `${this.externalEpisodeProvenancePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.renameSync(tmpPath, this.externalEpisodeProvenancePath);
      this.externalEpisodeProvenanceDirty = false;
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // Preserve the original persistence failure; stale temp files are safe.
      }
    }
  }

  private assertExternalEpisodeProvenanceHealthy(): void {
    if (this.externalEpisodeProvenanceStateCorrupt
      || fs.existsSync(this.externalEpisodeProvenanceCorruptMarkerPath)) {
      this.externalEpisodeProvenanceStateCorrupt = true;
      throw new Error(
        `external episode provenance is corrupt; restore a verified state and call recoverExternalEpisodeProvenanceState(): ${this.externalEpisodeProvenanceCorruptMarkerPath}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Session log processing (legacy — preserved for compatibility)
  // -----------------------------------------------------------------------

  private async processSessionLogFile(
    filePath: string,
    orderedFilePaths: readonly string[],
  ): Promise<{
    distillationUnit: DistillationUnit | null;
    advanced: boolean;
    processed: boolean;
    admittedEpisodes: number;
    contradictionSignals: number;
  }> {
    const state = loadLogCursorState(this.config.stateFilePath);
    const cursor = getCursor(state, filePath);
    let extracted;

    try {
      const crossFileContinuity: CrossFileContinuityOptions = { orderedFilePaths };
      extracted = extractDistillationUnit(filePath, cursor, { crossFileContinuity });
    } catch (error) {
      markCursorFailed(state, filePath, cursor.byteOffset, error);
      saveLogCursorState(this.config.stateFilePath, state);
      return {
        distillationUnit: null,
        advanced: false,
        processed: false,
        admittedEpisodes: 0,
        contradictionSignals: 0,
      };
    }

    if (!extracted.distillationUnit) {
      if (extracted.advanced) {
        advanceCursor(state, extracted.newCursor);
        saveLogCursorState(this.config.stateFilePath, state);
      }
      return {
        distillationUnit: null,
        advanced: extracted.advanced,
        processed: false,
        admittedEpisodes: 0,
        contradictionSignals: 0,
      };
    }

    // Admit evidence via EvidenceIngestor (evidence ingestion only — no review)
    try {
      const ingestionResult = this.evidenceIngestor.ingest(extracted.distillationUnit);
      this.queueCuratorObservation(ingestionResult.admittedEpisodeIds);
      advanceCursor(state, extracted.newCursor);
      saveLogCursorState(this.config.stateFilePath, state);
      return {
        distillationUnit: extracted.distillationUnit,
        advanced: true,
        processed: true,
        admittedEpisodes: ingestionResult.admittedEpisodeIds.length,
        contradictionSignals: ingestionResult.contradictionSignalIds.length,
      };
    } catch (error) {
      markCursorFailed(state, filePath, cursor.byteOffset, error);
      saveLogCursorState(this.config.stateFilePath, state);
      return {
        distillationUnit: extracted.distillationUnit,
        advanced: false,
        processed: false,
        admittedEpisodes: 0,
        contradictionSignals: 0,
      };
    }
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

      // Extract evidence content from the episode's completion evidence detail.
      const completionEvidence: {
        ref: string;
        content: string;
        role: 'problem-action' | 'verification';
        sourceFilePath?: string;
        turn?: number;
      }[] = episode.completionEvidence
        .filter(e => e.kind !== 'contradiction')
        .map(e => ({
          ref: e.ref,
          content: e.detail ?? `${e.kind} at turn ${e.turn}`,
          role: 'problem-action' as const,
          sourceFilePath: e.sourceFilePath,
          turn: e.turn,
        }));

      // Generate settlement evidence content from episode metadata.
      const settlementEvidence: {
        ref: string;
        content: string;
        role: 'problem-action' | 'verification';
        sourceFilePath?: string;
        turn?: number;
      }[] = [{
        ref: `${episode.sourceFilePath}#episode-${episodeId}:settled-${episode.settlementDeadline}`,
        content: `Episode ${episodeId} settled at ${episode.settlementDeadline} (status: ${episode.status})`,
        role: 'verification' as const,
        sourceFilePath: episode.sourceFilePath,
        turn: episode.deliveryTurn,
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
    }
  }

  private linkEvidenceCapsuleToAudit(bundleId: string, auditTransitionId: string | undefined): void {
    if (!auditTransitionId) return;
    const capsule = this.evidenceCapsuleStore.findByBundleId(bundleId);
    if (!capsule) return;
    this.evidenceCapsuleStore.addPromotionAuditRef(capsule.capsuleId, auditTransitionId);
  }

  private queueCuratorObservation(episodeIds: readonly string[]): void {
    for (const id of episodeIds) this.pendingCuratorObservationEpisodeIds.add(id);
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

  /** Persist only derivable continuation metadata; source episodes stay authoritative. */
  private persistReviewContinuation(episodeIds: ReadonlySet<string>): void {
    if (episodeIds.size === 0) {
      try {
        fs.rmSync(this.reviewContinuationPath, { force: true });
      } catch (error) {
        Logger.warning(`[RuntimeLearning] failed to clear review continuation: ${toErrorMessage(error)}`);
      }
      return;
    }

    const now = this.clock();
    const state: ReviewContinuationState = {
      schemaVersion: REVIEW_CONTINUATION_SCHEMA_VERSION,
      episodeIds: [...episodeIds].sort(),
      nextAttemptAt: new Date(now.getTime() + REVIEW_CONTINUATION_DELAY_MS).toISOString(),
      updatedAt: now.toISOString(),
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
        .filter(episode => episode.status === 'eligible' && !this.hasReviewedEpisode(episode, reviewedOrQueuedBundleIds))
        .length;
    } catch { /* fail-closed store status is reported by the wake */ }
    try {
      const continuation = JSON.parse(fs.readFileSync(this.reviewContinuationPath, 'utf8')) as {
        episodeIds?: unknown;
      };
      reviewContinuationEpisodes = Array.isArray(continuation.episodeIds)
        ? continuation.episodeIds.length
        : 0;
    } catch { /* missing continuation means zero */ }
    try {
      const queue = JSON.parse(fs.readFileSync(this.config.skillEvolutionReviewQueuePath, 'utf8')) as {
        operational?: unknown;
      };
      operationalReviews = Array.isArray(queue.operational) ? queue.operational.length : 0;
    } catch { /* missing queue means zero */ }
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
  EvidenceCapsuleStore,
  buildEvidenceCapsule,
  sanitizeExternalDistillationUnit,
  reconstructBundleFromCapsule,
} from './evidence-capsule';
import {
  ExternalSessionLogBackfillRequest,
  ExternalSessionLogBackfillIngestContext,
  ExternalSessionLogBackfillRunResult,
  ExternalSessionLogBackfillService,
  ExternalSessionLogBackfillSource,
} from './session-log-backfill';
import { DistilledKnowledgeCandidate } from './capability-distiller';

// Re-export types used by callers
export type {
  EvidenceBundle,
  SkillEvolutionResult,
  SkillEvolutionQueueReviewResult,
  BoundedSourceEvidence,
  ReferencedSkillSnapshot,
  RelatedCurrentSkill,
  SkillEvidenceRef,
};

function buildEpisodeEvidenceBundle(
  episode: LearningEpisode,
  candidate: DistilledKnowledgeCandidate,
  skillEvolution: SkillEvolutionRuntime,
  capsuleStore?: EvidenceCapsuleStore,
  isExternalEpisode?: (episodeId: string) => boolean,
): EvidenceBundle {
  const completionEvidence: readonly SkillEvidenceRef[] = episode.completionEvidence
    .filter(evidence => evidence.kind !== 'contradiction')
    .map(evidence => ({
      ref: evidence.ref,
      sourceFilePath: evidence.sourceFilePath,
      turn: evidence.turn,
    }));
  const settlementEvidence: readonly SkillEvidenceRef[] = [{
    ref: `${episode.sourceFilePath}#episode-${episode.episodeId}:settled-${episode.settlementDeadline}`,
    sourceFilePath: episode.sourceFilePath,
    turn: episode.deliveryTurn,
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

  if (capsuleStore) {
    const capsule = capsuleStore.findByBundleId(bundleId);
    if (capsule) {
      // For external-origin evidence, reconstruct the entire bundle from the
      // pinned capsule so Author/Verifier never see raw external detail leaked
      // through the fallback candidate's actionPattern or solvedLoop fields.
      return reconstructBundleFromCapsule(
        capsule,
        skillEvolution.getReferencedSkillSnapshots(),
        registry,
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
    referencedSkills: skillEvolution.getReferencedSkillSnapshots(),
    relatedCurrentSkills,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function incrementTransition(
  counts: Partial<Record<CapabilityTransitionKind, number>>,
  transition: CapabilityTransitionKind,
): void {
  counts[transition] = (counts[transition] ?? 0) + 1;
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeSourceHash(identity: SessionLogSourceIdentity): string {
  return `${identity.sourceId}::${identity.provider}::${identity.reader}`;
}

function normalizeSourceEventHash(contentHash: string | undefined): string {
  return (contentHash ?? '').trim();
}

function toStablePathComponent(value: string): string {
  const normalized = value.trim();
  if (!normalized) return 'backfill';
  return encodeURIComponent(normalized).replace(/%/g, '_');
}

function resolveSessionLogsRoot(logsRoot: string): string {
  const normalizedRoot = path.resolve(logsRoot);
  return path.basename(normalizedRoot) === 'sessions'
    ? normalizedRoot
    : path.join(normalizedRoot, 'sessions');
}

function collectJsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectJsonlFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
  }
  return files.sort();
}
