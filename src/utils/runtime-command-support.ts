/**
 * Runtime command support — startup wiring (issue #53).
 *
 * Simplified to construct one RuntimeLearning module instead of manually
 * coordinating evidence extraction, episode state, review queue, and curator
 * hooks. The Distillation Heartbeat Scheduler is a thin wake-loop adapter
 * that delegates to RuntimeLearning.wake().
 */

import { CatscoLogUploadScheduler } from './catsco-log-upload-scheduler';
import { DistillationHeartbeatScheduler } from './distillation-heartbeat-scheduler';
import { DistillationPipeline, defaultDistilledOutputDir } from './distillation-pipeline';
import { bootstrapLegacyDistilledSkillsOnce } from './distilled-skill-bootstrap';
import { getDistillationHeartbeatConfig } from './distillation-heartbeat-config';
import { LearningEpisodeStore } from './learning-episode';
import { EvidenceIngestor } from './evidence-ingestor';
import { PathResolver } from './path-resolver';
import { AIService } from './ai-service';
import { Logger } from './logger';
import { SkillEvolutionOptions, SkillEvolutionRuntime } from './skill-evolution';
import { SkillUsageCurator } from './skill-usage-curator';
import { SkillUsageLedger } from './skill-usage-ledger';
import { DueWorkPlanner } from './due-work-planner';
import { RuntimeLearning } from './runtime-learning';

export interface RuntimeCommandSupportOptions {
  /**
   * Deterministic Author/Verifier seams for runtime wiring tests. Production
   * startup leaves these unset and uses the real constrained branches.
   */
  skillEvolutionOptions?: Pick<SkillEvolutionOptions, 'authorFixture' | 'verifierFixture'>;
  /** Injectable runtime clock for curator cadence tests. */
  clock?: () => Date;
}

interface ActiveRuntimeSupport {
  catscoLogUploadScheduler: CatscoLogUploadScheduler | null;
  distillationHeartbeatScheduler: DistillationHeartbeatScheduler | null;
  /**
   * The RuntimeLearning production module — the single background-learning
   * entry point. Exposed so startup-level regression tests can prove the
   * runtime uses RuntimeLearning rather than legacy wiring.
   */
  runtimeLearning: RuntimeLearning | null;
  /** Legacy DistillationPipeline accessor (compatibility). */
  distillationPipeline: DistillationPipeline | null;
  stop(): Promise<void>;
}

let activeSupport: ActiveRuntimeSupport | null = null;
let startPromise: Promise<ActiveRuntimeSupport> | null = null;

export async function startRuntimeCommandSupport(
  workingDirectory: string = process.cwd(),
  options: RuntimeCommandSupportOptions = {},
): Promise<ActiveRuntimeSupport> {
  if (activeSupport) {
    return activeSupport;
  }

  if (!startPromise) {
    startPromise = (async () => {
      const catscoLogUploadScheduler = CatscoLogUploadScheduler.shouldStartForCurrentRuntime(workingDirectory)
        ? new CatscoLogUploadScheduler(workingDirectory)
        : null;

      let distillationHeartbeatScheduler: DistillationHeartbeatScheduler | null = null;
      let runtimeLearning: RuntimeLearning | null = null;
      let distillationPipeline: DistillationPipeline | null = null;

      // Construct the single RuntimeLearning production module.
      if (DistillationHeartbeatScheduler.shouldStartForCurrentRuntime(workingDirectory)) {
        const config = getDistillationHeartbeatConfig(workingDirectory);
        const skillsRoot = PathResolver.getSkillsPath();
        const outputDir = defaultDistilledOutputDir(skillsRoot);

        // V3 Skill Evolution Runtime
        const skillEvolution = config.skillEvolutionEnabled
          ? new SkillEvolutionRuntime({
            workingDirectory,
            outputDir,
            registryPath: config.skillEvolutionRegistryPath,
            auditPath: config.skillEvolutionAuditPath,
            journalPath: config.skillEvolutionJournalPath,
            reviewQueuePath: config.skillEvolutionReviewQueuePath,
            aiService: new AIService(),
            settlementWindowMs: config.skillEvolutionSettlementWindowHours * 60 * 60 * 1000,
            reviewerConcurrency: config.skillEvolutionReviewerConcurrency,
            operationalRetryMs: config.skillEvolutionOperationalRetryMinutes * 60 * 1000,
            operationalRetryMaxMs: config.skillEvolutionOperationalRetryMaxHours * 60 * 60 * 1000,
            authorModel: config.skillEvolutionAuthorModel,
            verifierModel: config.skillEvolutionVerifierModel,
            ...options.skillEvolutionOptions,
          })
          : null;

        // Legacy distilled skill bootstrap (V3 bootstrap reassessment)
        if (skillEvolution) {
          try {
            await bootstrapLegacyDistilledSkillsOnce({
              skillEvolution,
              generatedDistilledRoot: outputDir,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            Logger.warning(`Legacy distilled skill bootstrap failed: ${message}`);
          }
        }

        // Durable Learning Episode store
        const learningEpisodeStore = skillEvolution
          ? new LearningEpisodeStore(config.learningEpisodeStorePath)
          : null;

        // Evidence Ingestor (source admission only, no review)
        const evidenceIngestor = learningEpisodeStore
          ? new EvidenceIngestor({
            episodeStore: learningEpisodeStore,
            settlementWindowMs: config.skillEvolutionSettlementWindowHours * 60 * 60 * 1000,
          })
          : null;

        // Skill Usage Curator
        const curator = skillEvolution
          ? new SkillUsageCurator({
            ledger: new SkillUsageLedger(config.skillUsageLedgerPath),
            statePath: config.skillEvolutionCuratorStatePath,
            intervalMs: config.skillEvolutionCuratorIntervalHours * 60 * 60 * 1000,
            runtime: skillEvolution,
            now: options.clock,
          })
          : null;

        // Legacy DistillationPipeline (compatibility only)
        distillationPipeline = new DistillationPipeline({
          outputDir,
          reviewOutcomesPath: config.reviewOutcomesPath,
          needsReviewQueuePath: config.needsReviewQueuePath,
          capabilityRegistryPath: config.capabilityRegistryPath,
          workLogRoot: config.workLogRoot,
          skillEvolution: skillEvolution ?? undefined,
          learningEpisodeStorePath: config.learningEpisodeStorePath,
          learningEpisodeSettlementWindowMs: config.skillEvolutionSettlementWindowHours * 60 * 60 * 1000,
          skillUsageCurator: curator ?? undefined,
        });

        // Due Work Planner
        const planner = new DueWorkPlanner({
          learningEpisodeStorePath: config.learningEpisodeStorePath,
          reviewQueuePath: config.skillEvolutionReviewQueuePath,
          curatorStatePath: config.skillEvolutionCuratorStatePath,
          curatorIntervalMs: config.skillEvolutionCuratorIntervalHours * 60 * 60 * 1000,
        });

        // Construct the single RuntimeLearning module.
        // evidenceIngestor may be null when V3 is disabled — in that case
        // fall back to the legacy pipeline's admitEvidence for compatibility.
        runtimeLearning = new RuntimeLearning({
          workingDirectory,
          evidenceIngestor: evidenceIngestor ?? {
            ingest(unit: any) {
              return distillationPipeline!.admitEvidence(unit);
            },
          } as any,
          learningEpisodeStore: learningEpisodeStore ?? new LearningEpisodeStore(
            config.learningEpisodeStorePath,
          ),
          skillEvolution: skillEvolution!,
          curator,
          planner,
          legacyPipeline: distillationPipeline,
          clock: options.clock,
        });

        // Thin heartbeat scheduler that delegates to RuntimeLearning
        distillationHeartbeatScheduler = new DistillationHeartbeatScheduler(
          workingDirectory,
          runtimeLearning,
        );
      }

      if (catscoLogUploadScheduler) {
        await catscoLogUploadScheduler.start();
      }

      if (distillationHeartbeatScheduler) {
        await distillationHeartbeatScheduler.start();
      }

      const support: ActiveRuntimeSupport = {
        catscoLogUploadScheduler,
        distillationHeartbeatScheduler,
        runtimeLearning,
        distillationPipeline,
        async stop() {
          if (catscoLogUploadScheduler) {
            await catscoLogUploadScheduler.stop();
          }
          if (distillationHeartbeatScheduler) {
            await distillationHeartbeatScheduler.stop();
          }
        },
      };

      activeSupport = support;
      return support;
    })()
      .finally(() => {
        startPromise = null;
      });
  }

  return startPromise;
}

export async function stopRuntimeCommandSupport(): Promise<void> {
  const support = activeSupport;
  activeSupport = null;
  if (support) {
    await support.stop();
  }
}
