import { CatscoLogUploadScheduler } from './catsco-log-upload-scheduler';
import { DistillationHeartbeatScheduler } from './distillation-heartbeat-scheduler';
import { DistillationPipeline, defaultDistilledOutputDir } from './distillation-pipeline';
import { bootstrapLegacyDistilledSkillsOnce } from './distilled-skill-bootstrap';
import { getDistillationHeartbeatConfig } from './distillation-heartbeat-config';
import { PathResolver } from './path-resolver';
import { AIService } from './ai-service';
import { Logger } from './logger';
import { SkillEvolutionOptions, SkillEvolutionRuntime } from './skill-evolution';
import {
  buildSkillUsageEvidenceBundle,
  SkillUsageCurator,
} from './skill-usage-curator';
import { SkillUsageLedger } from './skill-usage-ledger';

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
   * The DistillationPipeline wired as the heartbeat scheduler processor, or
   * `null` when the heartbeat did not start for the current runtime. Exposed so
   * startup-level regression tests can prove the runtime uses the full pipeline
   * path rather than the scheduler's default no-op processor.
   */
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
      let distillationPipeline: DistillationPipeline | null = null;

      // Wire the V3 DistillationPipeline (episode admission -> Author/Verifier
      // review -> Capability Transition) into the runtime heartbeat. Production
      // startup uses the real constrained branches; tests may inject only the
      // branch completion fixtures through the narrow options seam above.
      if (DistillationHeartbeatScheduler.shouldStartForCurrentRuntime(workingDirectory)) {
        const config = getDistillationHeartbeatConfig(workingDirectory);
        const skillEvolution = config.skillEvolutionEnabled
          ? new SkillEvolutionRuntime({
            workingDirectory,
            outputDir: defaultDistilledOutputDir(PathResolver.getSkillsPath()),
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
          : undefined;
        if (skillEvolution) {
          try {
            await bootstrapLegacyDistilledSkillsOnce({
              skillEvolution,
              generatedDistilledRoot: defaultDistilledOutputDir(PathResolver.getSkillsPath()),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            Logger.warning(`Legacy distilled skill bootstrap failed: ${message}`);
          }
        }
        const curator = skillEvolution
          ? new SkillUsageCurator({
            ledger: new SkillUsageLedger(config.skillUsageLedgerPath, defaultDistilledOutputDir(PathResolver.getSkillsPath())),
            statePath: config.skillUsageCuratorStatePath,
            generatedSkillsRoot: defaultDistilledOutputDir(PathResolver.getSkillsPath()),
            now: options.clock,
            evidenceBundleBuilder: (summary, ledger) => buildSkillUsageEvidenceBundle(summary, ledger, skillEvolution),
            review: request => skillEvolution.reviewAndApply(request.evidenceBundle),
          })
          : null;
        const clock = options.clock ?? (() => new Date());
        let nextCuratorReviewAt = 0;
        const runCuratorReview = async () => {
          if (!curator) return;
          const now = clock();
          // A contradiction wake bypasses the low-frequency batch interval.
          const expedited = curator.getPendingExpeditedWakes().length > 0;
          if (!expedited && now.getTime() < nextCuratorReviewAt) return;
          await curator.reviewDue();
          nextCuratorReviewAt = now.getTime()
            + config.skillEvolutionCuratorIntervalHours * 60 * 60 * 1000;
        };
        const pipeline = new DistillationPipeline({
          outputDir: defaultDistilledOutputDir(PathResolver.getSkillsPath()),
          reviewOutcomesPath: config.reviewOutcomesPath,
          needsReviewQueuePath: config.needsReviewQueuePath,
          capabilityRegistryPath: config.capabilityRegistryPath,
          workLogRoot: config.workLogRoot,
          skillEvolution,
          learningEpisodeStorePath: config.learningEpisodeStorePath,
          learningEpisodeSettlementWindowMs: config.skillEvolutionSettlementWindowHours * 60 * 60 * 1000,
          skillUsageLedgerPath: config.skillUsageLedgerPath,
        });
        distillationPipeline = pipeline;
        distillationHeartbeatScheduler = new DistillationHeartbeatScheduler(
          workingDirectory,
          unit => skillEvolution ? pipeline.processUnitAsync(unit) : pipeline.processUnit(unit),
          async () => {
            await pipeline.reviewSkillEvolutionQueueEntries();
          },
          skillEvolution
            ? async () => {
              await pipeline.processSettledLearningEpisodes();
            }
            : null,
          runCuratorReview,
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
      })
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
