/**
 * Runtime command support — startup wiring (issue #53).
 *
 * Simplified to construct one RuntimeLearning module instead of manually
 * coordinating evidence extraction, episode state, review queue, and curator
 * hooks. The Distillation Heartbeat Scheduler is a thin wake-loop adapter
 * that delegates to RuntimeLearning.wake().
 */

import { CatscoLogUploadScheduler } from './catsco-log-upload-scheduler';
import {
  acquireHeartbeatSchedulerOwnerLock,
  HeartbeatSchedulerOwnerLock,
} from './heartbeat-scheduler-owner-lock';
import { DistillationHeartbeatScheduler } from './distillation-heartbeat-scheduler';
import { defaultDistilledOutputDir } from './path-resolver';
import { bootstrapSemanticReassessmentOnce } from './distilled-skill-bootstrap';
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
  stop(): Promise<void>;
}

export function getActiveRuntimeLearning(): RuntimeLearning | null {
  return activeSupport?.runtimeLearning ?? null;
}

export interface ExternalHistoryRuntimeActivation {
  appliedImmediately: boolean;
  wakeScheduled: boolean;
}

/** Hot-apply persisted external-source settings on the current Runtime owner. */
export function activateExternalHistoryRuntimeConfiguration(
  workingDirectory: string = process.cwd(),
): ExternalHistoryRuntimeActivation {
  const runtimeLearning = activeSupport?.runtimeLearning;
  const scheduler = activeSupport?.distillationHeartbeatScheduler;
  if (
    !runtimeLearning
    || !scheduler
    || !runtimeLearning.reloadExternalHistoryConfiguration(workingDirectory)
  ) {
    return { appliedImmediately: false, wakeScheduled: false };
  }

  void scheduler.runHeartbeat('manual').catch(error => {
    Logger.warning(
      `[RuntimeCommandSupport] external history activation wake failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return { appliedImmediately: true, wakeScheduled: true };
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
      let heartbeatOwnerLock: HeartbeatSchedulerOwnerLock | null = null;
      let heartbeatOwnerElectionTimer: NodeJS.Timeout | null = null;
      let heartbeatOwnerElectionInFlight: Promise<boolean> | null = null;
      let stopping = false;
      let attemptHeartbeatOwnership: ((startImmediately: boolean) => Promise<boolean>) | null = null;
      const currentHeartbeatOwnerLock = (): HeartbeatSchedulerOwnerLock | null => heartbeatOwnerLock;
      const currentHeartbeatScheduler = (): DistillationHeartbeatScheduler | null => distillationHeartbeatScheduler;

      const config = getDistillationHeartbeatConfig(workingDirectory);
      const skillsRoot = PathResolver.getSkillsPath();
      const outputDir = defaultDistilledOutputDir(skillsRoot);

      // Only build V3 runtime components (RuntimeLearning + scheduler) when
      // the heartbeat master switch is on AND skill evolution is enabled.
      // When V3 is disabled, background learning is fully suppressed — no
      // RuntimeLearning or heartbeat scheduler is constructed.
      const v3Enabled = DistillationHeartbeatScheduler.shouldStartForCurrentRuntime(workingDirectory)
        && config.skillEvolutionEnabled;

      if (v3Enabled) {
        const buildWritableRuntime = async (
          ownerLock: HeartbeatSchedulerOwnerLock,
          startImmediately: boolean,
        ): Promise<boolean> => {
          let builtScheduler: DistillationHeartbeatScheduler | null = null;
          try {
            // The owner lease fences Journal recovery performed by this
            // constructor and every durable module built below it.
            const skillEvolution = new SkillEvolutionRuntime({
              workingDirectory,
              branchLogRoot: config.branchLogRoot,
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
              reviewAttemptDeadlineMs: config.skillEvolutionReviewAttemptDeadlineMinutes * 60 * 1000,
              authorModel: config.skillEvolutionAuthorModel,
              verifierModel: config.skillEvolutionVerifierModel,
              ...options.skillEvolutionOptions,
            });

            const learningEpisodeStore = new LearningEpisodeStore(config.learningEpisodeStorePath);

            try {
              await bootstrapSemanticReassessmentOnce({
                skillEvolution,
                manifestPath: config.skillEvolutionReassessmentManifestPath,
                learningEpisodeStore,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              Logger.warning(`Semantic skill reassessment bootstrap failed: ${message}`);
            }

            const evidenceIngestor = new EvidenceIngestor({
              episodeStore: learningEpisodeStore,
              settlementWindowMs: config.skillEvolutionSettlementWindowHours * 60 * 60 * 1000,
            });
            const curator = new SkillUsageCurator({
              ledger: new SkillUsageLedger(config.skillUsageLedgerPath),
              statePath: config.skillEvolutionCuratorStatePath,
              intervalMs: config.skillEvolutionCuratorIntervalHours * 60 * 60 * 1000,
              runtime: skillEvolution,
              now: options.clock,
            });
            const planner = new DueWorkPlanner({
              learningEpisodeStorePath: config.learningEpisodeStorePath,
              reviewQueuePath: config.skillEvolutionReviewQueuePath,
              curatorStatePath: config.skillEvolutionCuratorStatePath,
              curatorIntervalMs: config.skillEvolutionCuratorIntervalHours * 60 * 60 * 1000,
              semanticReassessmentManifestPath: config.skillEvolutionReassessmentManifestPath,
            });
            const builtRuntimeLearning = new RuntimeLearning({
              workingDirectory,
              evidenceIngestor,
              learningEpisodeStore,
              skillEvolution,
              curator,
              planner,
              clock: options.clock,
            });
            builtScheduler = new DistillationHeartbeatScheduler(
              workingDirectory,
              builtRuntimeLearning,
              ownerLock,
            );
            if (startImmediately) await builtScheduler.start();

            if (stopping) {
              const drained = !startImmediately || await builtScheduler.stop();
              if (drained) ownerLock.release();
              return false;
            }

            // Publish one complete owner generation. A follower never sees or
            // retains a partially constructed writable stack.
            heartbeatOwnerLock = ownerLock;
            runtimeLearning = builtRuntimeLearning;
            distillationHeartbeatScheduler = builtScheduler;
            return true;
          } catch (error) {
            const drained = builtScheduler ? await builtScheduler.stop() : true;
            if (drained) ownerLock.release();
            throw error;
          }
        };

        attemptHeartbeatOwnership = async (startImmediately: boolean): Promise<boolean> => {
          if (stopping || distillationHeartbeatScheduler || runtimeLearning) return false;
          const ownerLock = acquireHeartbeatSchedulerOwnerLock({
            runtimeRoot: workingDirectory,
            command: process.argv.join(' '),
            env: process.env,
          });
          if (ownerLock.acquired) {
            if (stopping) {
              ownerLock.release();
              return false;
            }
            return buildWritableRuntime(ownerLock, startImmediately);
          } else {
            Logger.info(
              `[RuntimeCommandSupport] writable Runtime already owned by pid=${ownerLock.existing.pid}; waiting for safe owner failover`,
            );
            return false;
          }
        };

        // Ownership precedes construction, recovery, and bootstrap. A
        // follower retains only this election function and constructs a fresh
        // stack from disk after a later takeover.
        await attemptHeartbeatOwnership(false);
      }

      try {
        if (catscoLogUploadScheduler) {
          await catscoLogUploadScheduler.start();
        }

        const initialHeartbeatScheduler = currentHeartbeatScheduler();
        if (initialHeartbeatScheduler) {
          await initialHeartbeatScheduler.start();
        }
      } catch (error) {
        // Startup failed after acquiring ownership — release the lock so a
        // retry or another connector can acquire it. The scheduler, if
        // partially started, is best-effort stopped before releasing.
        const partiallyStartedScheduler = currentHeartbeatScheduler();
        if (partiallyStartedScheduler) {
          try {
            const drained = await partiallyStartedScheduler.stop();
            if (!drained) heartbeatOwnerLock = null;
          } catch {
            // Best-effort; the startup error is the primary concern.
          }
        }
        const publishedOwnerLock = currentHeartbeatOwnerLock();
        if (publishedOwnerLock) {
          publishedOwnerLock.release();
          heartbeatOwnerLock = null;
        }
        distillationHeartbeatScheduler = null;
        runtimeLearning = null;
        throw error;
      }

      if (!distillationHeartbeatScheduler && attemptHeartbeatOwnership) {
        heartbeatOwnerElectionTimer = setInterval(() => {
          if (stopping || heartbeatOwnerElectionInFlight || !attemptHeartbeatOwnership) return;
          heartbeatOwnerElectionInFlight = attemptHeartbeatOwnership(true)
            .then(acquired => {
              if (acquired && heartbeatOwnerElectionTimer) {
                clearInterval(heartbeatOwnerElectionTimer);
                heartbeatOwnerElectionTimer = null;
              }
              return acquired;
            })
            .catch(error => {
              Logger.warning(`[RuntimeCommandSupport] owner election retry failed: ${error instanceof Error ? error.message : String(error)}`);
              return false;
            })
            .finally(() => {
              heartbeatOwnerElectionInFlight = null;
            });
        }, 5_000);
        heartbeatOwnerElectionTimer.unref?.();
      }

      const support: ActiveRuntimeSupport = {
        catscoLogUploadScheduler,
        get distillationHeartbeatScheduler() { return distillationHeartbeatScheduler; },
        get runtimeLearning() { return runtimeLearning; },
        async stop() {
          stopping = true;
          if (heartbeatOwnerElectionTimer) {
            clearInterval(heartbeatOwnerElectionTimer);
            heartbeatOwnerElectionTimer = null;
          }
          await heartbeatOwnerElectionInFlight;
          if (catscoLogUploadScheduler) {
            await catscoLogUploadScheduler.stop();
          }
          const heartbeatDrained = distillationHeartbeatScheduler
            ? await distillationHeartbeatScheduler.stop()
            : true;
          // Release runtime-wide scheduler ownership only after the
          // scheduler has drained, so stop cannot race with in-flight writes.
          if (heartbeatOwnerLock && heartbeatDrained) {
            heartbeatOwnerLock.release();
            heartbeatOwnerLock = null;
          }
          distillationHeartbeatScheduler = null;
          runtimeLearning = null;
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
