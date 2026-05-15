import { LogIngestScheduler } from './log-ingest-scheduler';

interface ActiveRuntimeSupport {
  logIngestScheduler: LogIngestScheduler | null;
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
      const logIngestScheduler = LogIngestScheduler.shouldStartForCurrentRuntime()
        ? new LogIngestScheduler(process.cwd())
        : null;

      if (logIngestScheduler) {
        await logIngestScheduler.start();
      }

      const support: ActiveRuntimeSupport = {
        logIngestScheduler,
        async stop() {
          if (logIngestScheduler) {
            await logIngestScheduler.stop();
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
