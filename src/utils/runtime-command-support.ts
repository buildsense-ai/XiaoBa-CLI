import { InspectorUploadScheduler } from './inspector-upload-scheduler';
import { LogIngestScheduler } from './log-ingest-scheduler';

interface ActiveRuntimeSupport {
  autoDevLogIngestScheduler: LogIngestScheduler | null;
  inspectorUploadScheduler: InspectorUploadScheduler | null;
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
      const autoDevLogIngestScheduler = LogIngestScheduler.shouldStartForCurrentRuntime()
        ? new LogIngestScheduler(process.cwd())
        : null;
      const inspectorUploadScheduler = !autoDevLogIngestScheduler && InspectorUploadScheduler.shouldStartForCurrentRuntime()
        ? new InspectorUploadScheduler(process.cwd())
        : null;

      if (autoDevLogIngestScheduler) {
        await autoDevLogIngestScheduler.start();
      }
      if (inspectorUploadScheduler) {
        await inspectorUploadScheduler.start();
      }

      const support: ActiveRuntimeSupport = {
        autoDevLogIngestScheduler,
        inspectorUploadScheduler,
        async stop() {
          if (autoDevLogIngestScheduler) {
            await autoDevLogIngestScheduler.stop();
          }
          if (inspectorUploadScheduler) {
            await inspectorUploadScheduler.stop();
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
