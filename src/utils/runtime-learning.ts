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
import { DueWorkPlanner, DueWork } from './due-work-planner';
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

// ---------------------------------------------------------------------------
// Public API: wake context / reports (shared with the heartbeat scheduler)
// ---------------------------------------------------------------------------

export type RuntimeLearningReason =
  | 'startup'
  | 'scheduled'
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

export interface RuntimeLearningDiscoveryReport {
  scanned: boolean;
  filesScanned: number;
  unitsProcessed: number;
  advancedFiles: number;
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
  /** Review timeout count from the latest review phase. */
  lastReviewTimeoutCount: number;
  /** Review failure count from the latest review phase. */
  lastReviewFailureCount: number;
}

// ---------------------------------------------------------------------------
// Construction options
// ---------------------------------------------------------------------------

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

function emptyHeartbeatResult(ran: boolean): RuntimeLearningHeartbeatResult {
  return {
    unitsProcessed: 0,
    advancedFiles: 0,
    ran,
    discovery: { scanned: false, filesScanned: 0, unitsProcessed: 0, advancedFiles: 0 },
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
    lastReviewTimeoutCount: 0,
    lastReviewFailureCount: 0,
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

  private readonly pendingCuratorObservationEpisodeIds = new Set<string>();

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

  // -----------------------------------------------------------------------
  // Single wake entry point
  // -----------------------------------------------------------------------

  /**
   * Run one wake cycle of the Runtime Learning module.
   *
   * For discovery reasons (startup, scheduled, manual): scan session logs,
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
    const wake = emptyHeartbeatResult(true);
    const now = this.clock();
    const reasons = this.normalizeReasons(reason);
    const orderedReasons = [...reasons].sort();
    const wakeStartMs = this.clock().getTime();
    const isDiscoveryWake = this.isDiscoveryWake(reasons);

    try {
      // ---- 1. Discovery + Ingestion ----
      const shouldScan = isDiscoveryWake;

      if (shouldScan) {
        const sessionLogsRoot = resolveSessionLogsRoot(this.config.logsRoot);
        if (fs.existsSync(sessionLogsRoot) && fs.statSync(sessionLogsRoot).isDirectory()) {
          const files = collectJsonlFiles(sessionLogsRoot);
          wake.discovery.scanned = true;
          wake.discovery.filesScanned = files.length;

          for (const filePath of files) {
            const result = await this.processSessionLogFile(filePath, files);
            if (result.processed && result.distillationUnit) wake.discovery.unitsProcessed++;
            if (result.advanced) wake.discovery.advancedFiles++;
            wake.ingestion.admittedEpisodes += result.admittedEpisodes;
            wake.ingestion.contradictionSignals += result.contradictionSignals;
          }
        }
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
      const review = await this.runReview(dueWork);
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
    return reasons.has('startup') || reasons.has('scheduled') || reasons.has('manual');
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

  private async runReview(dueWork: DueWork): Promise<RuntimeLearningReviewReport> {
    const reviewAttempted = dueWork.settlementDue || dueWork.operationalRetryDue;
    if (!reviewAttempted) return skippedReviewReport();

    const transitionsByKind: Partial<Record<CapabilityTransitionKind, number>> = {};

    // Review eligible learning episodes
    let reviewedEpisodes = 0;
    let episodeReviewFailures = 0;
    let settlementError: unknown;

    try {
      const episodes = Object.values(this.episodeStore.load().episodes);
      for (const episode of episodes) {
        if (episode.status !== 'eligible') continue;
        if (this.hasReviewedEpisode(episode)) continue;

        const candidate = buildLearningEpisodeCandidate(episode);
        const bundle = buildEpisodeEvidenceBundle(episode, candidate, this.skillEvolution);

        try {
          const result = await this.skillEvolution.reviewAndApply(bundle);
          incrementTransition(transitionsByKind, result.transition);
          reviewedEpisodes++;
        } catch (error: any) {
          // reviewAndApply already retried internally (max optimistic retries
          // then operational enqueue). If it still throws, the episode will be
          // re-examined on a future wake — safe because the cursor was already
          // advanced and the episode remains durable.
          episodeReviewFailures++;
          Logger.warning(
            `[RuntimeLearning] review failed for ${episode.episodeId}: ${error.message}`,
          );
        }
      }
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
    let reviewTimeoutCount = 0;
    let reviewFailureCount = 0;
    try {
      queueResult = await this.skillEvolution.reviewDueQueueEntries();
      this.reconcileReassessmentQueueOutcomes(queueResult.queueOutcomes);
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
  // Session log processing (moved from DistillationHeartbeatScheduler)
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

  private queueCuratorObservation(episodeIds: readonly string[]): void {
    for (const id of episodeIds) this.pendingCuratorObservationEpisodeIds.add(id);
  }

  private hasReviewedEpisode(episode: LearningEpisode): boolean {
    const bundleId = `v3:learning-episode:${episode.episodeId}`;
    return (
      this.skillEvolution.getAudit().some(entry => entry.bundleId === bundleId)
      || this.skillEvolution.getQueuedReviewKind(bundleId) !== undefined
    );
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

    try {
      fs.mkdirSync(path.dirname(recordPath), { recursive: true });
      const tmpPath = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.renameSync(tmpPath, recordPath);
    } catch (error: any) {
      Logger.warning(`[RuntimeLearning] failed to record heartbeat: ${error.message}`);
    }
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
    lastReviewTimeoutCount: typeof record.lastReviewTimeoutCount === 'number' && Number.isFinite(record.lastReviewTimeoutCount)
      ? Math.max(0, Math.floor(record.lastReviewTimeoutCount))
      : defaults.lastReviewTimeoutCount,
    lastReviewFailureCount: typeof record.lastReviewFailureCount === 'number' && Number.isFinite(record.lastReviewFailureCount)
      ? Math.max(0, Math.floor(record.lastReviewFailureCount))
      : defaults.lastReviewFailureCount,
  };
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

  return {
    bundleId: `v3:learning-episode:${episode.episodeId}`,
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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
