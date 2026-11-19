import { CatscoLogUploadScheduler } from './catsco-log-upload-scheduler';
import { PathResolver } from './path-resolver';
import { MondayMemoryUploader, mondayMemoryConfig } from './monday-memory-uploader';
import { Logger } from './logger';

interface ActiveRuntimeSupport {
  catscoLogUploadScheduler: CatscoLogUploadScheduler | null;
  mondayMemoryUploader: MondayMemoryUploader | null;
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
      const runtimeDataRoot = PathResolver.getRuntimeDataRoot();
      let mondayMemoryUploader: MondayMemoryUploader | null = null;
      try {
        const memoryConfig = mondayMemoryConfig(runtimeDataRoot);
        mondayMemoryUploader = memoryConfig ? new MondayMemoryUploader(memoryConfig) : null;
        if (mondayMemoryUploader) await mondayMemoryUploader.start();
      } catch (error) {
        if (mondayMemoryUploader) await mondayMemoryUploader.stop();
        mondayMemoryUploader = null;
        Logger.warning('[MondayMemory] uploader paused: ' + (error instanceof Error ? error.message : 'initialization failed'));
      }
      const catscoLogUploadScheduler = CatscoLogUploadScheduler.shouldStartForCurrentRuntime(runtimeDataRoot)
        ? new CatscoLogUploadScheduler(runtimeDataRoot)
        : null;

      if (catscoLogUploadScheduler) {
        await catscoLogUploadScheduler.start();
      }

      const support: ActiveRuntimeSupport = {
        catscoLogUploadScheduler,
        mondayMemoryUploader,
        async stop() {
          if (mondayMemoryUploader) await mondayMemoryUploader.stop();
          if (catscoLogUploadScheduler) {
            await catscoLogUploadScheduler.stop();
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
