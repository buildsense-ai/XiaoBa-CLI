import { startDashboard, type DashboardServerHandle } from '../dashboard/server';

export async function dashboardCommand(options: { port?: string }): Promise<void> {
  const port = options.port ? parseInt(options.port, 10) : 3800;
  const handle = await startDashboard(port);
  await waitForShutdown(handle);
}

function waitForShutdown(handle: DashboardServerHandle): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      try {
        await handle.stop();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    const onSignal = () => { void stop(); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}
