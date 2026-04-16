import { InspectorUploadScheduler } from './inspector-upload-scheduler';

interface ActiveRuntimeSupport {
  uploadScheduler: InspectorUploadScheduler | null;
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
      const uploadScheduler = InspectorUploadScheduler.shouldStartForCurrentRuntime()
        ? new InspectorUploadScheduler(process.cwd())
        : null;

      if (uploadScheduler) {
        await uploadScheduler.start();
      }

      const support: ActiveRuntimeSupport = {
        uploadScheduler,
        async stop() {
          if (uploadScheduler) {
            await uploadScheduler.stop();
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
