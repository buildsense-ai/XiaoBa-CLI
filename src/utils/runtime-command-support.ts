import { CatscoLogUploadScheduler } from './catsco-log-upload-scheduler';
import { DistillationHeartbeatScheduler } from './distillation-heartbeat-scheduler';
import { DistillationPipeline, defaultDistilledOutputDir } from './distillation-pipeline';
import { getDistillationHeartbeatConfig } from './distillation-heartbeat-config';
import { PathResolver } from './path-resolver';

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

      // Wire the full first-version DistillationPipeline (distill -> review ->
      // install) into the runtime heartbeat. The scheduler is constructed with
      // `pipeline.processUnit` as its processor instead of the default no-op,
      // so runtime startup drives the real durable state transitions: review
      // outcomes are appended to the runtime data state file and promoted
      // candidates are installed under the current runtime skills root in
      // `generated-distilled/`. Existing runtime guards (enable/disable config,
      // inspector-cat guard, six-hour default cadence) remain intact because
      // the scheduler still owns them.
      if (DistillationHeartbeatScheduler.shouldStartForCurrentRuntime(workingDirectory)) {
        const config = getDistillationHeartbeatConfig(workingDirectory);
        const pipeline = new DistillationPipeline({
          outputDir: defaultDistilledOutputDir(PathResolver.getSkillsPath()),
          reviewOutcomesPath: config.reviewOutcomesPath,
          needsReviewQueuePath: config.needsReviewQueuePath,
          capabilityRegistryPath: config.capabilityRegistryPath,
          workLogRoot: config.workLogRoot,
        });
        distillationPipeline = pipeline;
        distillationHeartbeatScheduler = new DistillationHeartbeatScheduler(
          workingDirectory,
          unit => pipeline.processUnit(unit),
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
