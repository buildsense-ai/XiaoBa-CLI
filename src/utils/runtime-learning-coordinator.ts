/**
 * LEGACY COMPATIBILITY ADAPTER — issue #53 supersedes this module.
 *
 * Production background learning now uses `RuntimeLearning`
 * (./runtime-learning.ts) as the single entry point. This legacy coordinator
 * is retained only for test adapters and explicit compatibility configuration;
 * no new RuntimeLearning behavior depends on it.
 *
 * See `RuntimeLearning` for the production entry point.
 */

import { DistillationPipeline, QueueReviewResultV3, V3PipelineUnitResult } from './distillation-pipeline';
import { CapabilityTransitionKind } from './skill-evolution';
import { CuratorRunResult, SkillUsageCurator } from './skill-usage-curator';
import type { DueWork } from './due-work-planner';

export type RuntimeLearningStageStatus = 'succeeded' | 'failed' | 'skipped';

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
  transitionsByKind: Partial<Record<CapabilityTransitionKind, number>>;
}

export interface RuntimeLearningCurationReport {
  status: RuntimeLearningStageStatus;
  errorMessage?: string;
  ran: boolean;
  expedited: boolean;
  transitionsByKind: Partial<Record<CapabilityTransitionKind, number>>;
}

export interface RuntimeLearningWakeReport {
  maturation: RuntimeLearningMaturationReport;
  review: RuntimeLearningReviewReport;
  curation: RuntimeLearningCurationReport;
}

export interface RuntimeLearningWakeContext {
  reason: 'startup' | 'scheduled' | 'settlement-deadline' | 'operational-retry' | 'curator' | 'manual';
  discovery: RuntimeLearningDiscoveryReport;
  ingestion: RuntimeLearningIngestionReport;
  /** Optional filter: when provided, only the due stages execute. */
  dueWork?: DueWork;
}

const EMPTY_SETTLEMENT_RESULT: V3PipelineUnitResult = { candidates: [], evolutions: [] };
const EMPTY_QUEUE_REVIEW_RESULT: QueueReviewResultV3 = {
  reviewed: 0,
  deferredReviewed: 0,
  operationalReviewed: 0,
  operationalRetried: 0,
  deferredRetried: 0,
  transitionsByKind: {},
};
export class RuntimeLearningCoordinator {
  constructor(
    private readonly pipeline: DistillationPipeline,
    private readonly curator?: SkillUsageCurator | null,
  ) {}

  async runWake(context: RuntimeLearningWakeContext): Promise<RuntimeLearningWakeReport> {
    const dueWork = context.dueWork;

    // Track whether each stage was actually attempted so the report can
    // distinguish 'skipped' (not attempted) from 'succeeded' (ran, zero work).
    const maturationAttempted = !dueWork || dueWork.settlementDue;
    let settlement = EMPTY_SETTLEMENT_RESULT;
    let settlementError: unknown;

    if (maturationAttempted) {
      try {
        settlement = await this.pipeline.processSettledLearningEpisodes();
      } catch (error) {
        settlementError = error;
      }
    }

    const maturation = !maturationAttempted
      ? skippedMaturationReport()
      : settlementError
        ? failedMaturationReport(settlementError)
        : summarizeMaturation(settlement);

    const reviewAttempted = !dueWork || dueWork.settlementDue || dueWork.operationalRetryDue;
    let queue = EMPTY_QUEUE_REVIEW_RESULT;
    let queueError: unknown;
    if (reviewAttempted) {
      try {
        queue = await this.pipeline.reviewSkillEvolutionQueueEntries();
      } catch (error) {
        queueError = error;
      }
    }

    const reviewReportStatus = !reviewAttempted
      ? 'skipped'
      : settlementError || queueError
        ? 'failed'
        : 'succeeded';

    const review = summarizeReview(
      settlement,
      queue,
      reviewReportStatus,
      reviewReportStatus !== 'failed'
        ? undefined
        : [settlementError, queueError].filter(Boolean).map(toErrorMessage).join('; '),
    );

    const curationAttempted = !!(this.curator && (!dueWork || dueWork.routineCuratorDue || dueWork.expeditedCuratorDue));

    if (!curationAttempted) {
      return {
        maturation,
        review,
        curation: skippedCurationReport(),
      };
    }

    try {
      const curation = await this.curator.runDue();
      return {
        maturation,
        review,
        curation: summarizeCuration(curation),
      };
    } catch (error) {
      return {
        maturation,
        review,
        curation: failedCurationReport(error),
      };
    }
  }
}

function skippedMaturationReport(): RuntimeLearningMaturationReport {
  return {
    status: 'skipped',
    maturedEpisodes: 0,
    becameEligible: 0,
    becameContradicted: 0,
  };
}

function summarizeMaturation(result: V3PipelineUnitResult): RuntimeLearningMaturationReport {
  return {
    status: 'succeeded',
    maturedEpisodes: result.maturation?.maturedEpisodeIds.length ?? 0,
    becameEligible: result.maturation?.becameEligible ?? 0,
    becameContradicted: result.maturation?.becameContradicted ?? 0,
  };
}

function failedMaturationReport(error: unknown): RuntimeLearningMaturationReport {
  return {
    status: 'failed',
    errorMessage: toErrorMessage(error),
    maturedEpisodes: 0,
    becameEligible: 0,
    becameContradicted: 0,
  };
}

function summarizeReview(
  settlement: V3PipelineUnitResult,
  queue: QueueReviewResultV3,
  status: RuntimeLearningStageStatus,
  errorMessage?: string,
): RuntimeLearningReviewReport {
  const transitionsByKind: Partial<Record<CapabilityTransitionKind, number>> = {};
  for (const evolution of settlement.evolutions) {
    incrementTransitionCount(transitionsByKind, evolution.transition);
  }
  for (const [transition, count] of Object.entries(queue.transitionsByKind)) {
    if (!count) continue;
    const key = transition as CapabilityTransitionKind;
    transitionsByKind[key] = (transitionsByKind[key] ?? 0) + count;
  }

  return {
    status,
    ...(errorMessage ? { errorMessage } : {}),
    reviewedEpisodes: settlement.candidates.length,
    reviewedQueueEntries: queue.reviewed,
    deferredQueueReviews: queue.deferredReviewed,
    operationalQueueReviews: queue.operationalReviewed,
    deferredRetries: queue.deferredRetried,
    operationalRetries: queue.operationalRetried,
    transitionsByKind,
  };
}

function summarizeCuration(result: CuratorRunResult): RuntimeLearningCurationReport {
  const transitionsByKind: Partial<Record<CapabilityTransitionKind, number>> = {};
  for (const transition of result.transitions) {
    incrementTransitionCount(transitionsByKind, transition.transition);
  }
  return {
    status: result.ran ? 'succeeded' : 'skipped',
    ran: result.ran,
    expedited: result.expedited,
    transitionsByKind,
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

function failedCurationReport(error: unknown): RuntimeLearningCurationReport {
  return {
    status: 'failed',
    errorMessage: toErrorMessage(error),
    ran: false,
    expedited: false,
    transitionsByKind: {},
  };
}

function incrementTransitionCount(
  counts: Partial<Record<CapabilityTransitionKind, number>>,
  transition: CapabilityTransitionKind,
): void {
  counts[transition] = (counts[transition] ?? 0) + 1;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
