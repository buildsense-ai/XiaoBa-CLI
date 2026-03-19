import { startDashboard } from '../dashboard/server';

export async function dashboardCommand(options: { port?: string }): Promise<void> {
  const port = options.port ? parseInt(options.port, 10) : 3800;
  await startDashboard(port);
}
