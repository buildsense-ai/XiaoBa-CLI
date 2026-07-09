import { CatscoLogUploadScheduler } from './catsco-log-upload-scheduler';
import { DistillationHeartbeatScheduler } from './distillation-heartbeat-scheduler';

interface ActiveRuntimeSupport {
  catscoLogUploadScheduler: CatscoLogUploadScheduler | null;
  distillationHeartbeatScheduler: DistillationHeartbeatScheduler | null;
  stop(): Promise<void>;
}

let activeSupport: ActiveRuntimeSupport | null = null;
let startPromise: Promise<ActiveRuntimeSupport> | null = null;

export async function startRuntimeCommandSupport(): Promise<ActiveRuntimeSupport> {
  if (activeSupport) {
    return activeSupport;
  }

  if (!startPromise) {
    startPromise = (async () => {
      const catscoLogUploadScheduler = CatscoLogUploadScheduler.shouldStartForCurrentRuntime()
        ? new CatscoLogUploadScheduler(process.cwd())
        : null;

      const distillationHeartbeatScheduler = DistillationHeartbeatScheduler.shouldStartForCurrentRuntime()
        ? new DistillationHeartbeatScheduler(process.cwd())
        : null;

      if (catscoLogUploadScheduler) {
        await catscoLogUploadScheduler.start();
      }

      if (distillationHeartbeatScheduler) {
        await distillationHeartbeatScheduler.start();
      }

      const support: ActiveRuntimeSupport = {
        catscoLogUploadScheduler,
        distillationHeartbeatScheduler,
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
