import { DistillationPipeline, QueueReviewResultV3, V3PipelineUnitResult } from './distillation-pipeline';
import { CapabilityTransitionKind } from './skill-evolution';
import { CuratorRunResult, SkillUsageCurator } from './skill-usage-curator';

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
  maturedEpisodes: number;
  becameEligible: number;
  becameContradicted: number;
}

export interface RuntimeLearningReviewReport {
  reviewedEpisodes: number;
  reviewedQueueEntries: number;
  deferredQueueReviews: number;
  operationalQueueReviews: number;
  deferredRetries: number;
  operationalRetries: number;
  transitionsByKind: Partial<Record<CapabilityTransitionKind, number>>;
}

export interface RuntimeLearningCurationReport {
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
  reason: 'startup' | 'scheduled' | 'settlement-deadline' | 'manual';
  discovery: RuntimeLearningDiscoveryReport;
  ingestion: RuntimeLearningIngestionReport;
}

export class RuntimeLearningCoordinator {
  constructor(
    private readonly pipeline: DistillationPipeline,
    private readonly curator?: SkillUsageCurator | null,
  ) {}

  async runWake(_context: RuntimeLearningWakeContext): Promise<RuntimeLearningWakeReport> {
    const settlement = await this.pipeline.processSettledLearningEpisodes();
    const queue = await this.pipeline.reviewSkillEvolutionQueueEntries();
    const curation = this.curator
      ? await this.curator.runDue()
      : { ran: false, expedited: false, transitions: [] } as CuratorRunResult;

    return {
      maturation: summarizeMaturation(settlement),
      review: summarizeReview(settlement, queue),
      curation: summarizeCuration(curation),
    };
  }
}

function summarizeMaturation(result: V3PipelineUnitResult): RuntimeLearningMaturationReport {
  return {
    maturedEpisodes: result.maturation?.maturedEpisodeIds.length ?? 0,
    becameEligible: result.maturation?.becameEligible ?? 0,
    becameContradicted: result.maturation?.becameContradicted ?? 0,
  };
}

function summarizeReview(
  settlement: V3PipelineUnitResult,
  queue: QueueReviewResultV3,
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
    ran: result.ran,
    expedited: result.expedited,
    transitionsByKind,
  };
}

function incrementTransitionCount(
  counts: Partial<Record<CapabilityTransitionKind, number>>,
  transition: CapabilityTransitionKind,
): void {
  counts[transition] = (counts[transition] ?? 0) + 1;
}
