import express from 'express';
import * as path from 'path';
import type { Server } from 'http';
import { Logger } from '../utils/logger';
import { createApiRouter } from './routes/api';
import { ServiceManager } from './service-manager';
import { bootstrapDefaultSkillHubSkillsOnce } from '../skillhub/default-skill-bootstrap';
import { createDashboardAuth } from './auth';

const DEFAULT_PORT = 3800;
const activeServers: Server[] = [];
export interface UpdateController {
  getStatus: () => any;
  checkForUpdates: (manual?: boolean) => Promise<any>;
  downloadUpdate: () => Promise<any>;
  installUpdate: () => void;
}

export interface DashboardControllers {
  updateController?: UpdateController;
  projectRoot?: string;
}

export interface DashboardServerHandle {
  stop: () => Promise<void>;
}

export async function startDashboard(
  port: number = DEFAULT_PORT,
  controllers: DashboardControllers = {}
): Promise<DashboardServerHandle> {
  const app = express();
  const envPackaged = /^(1|true|yes)$/i.test(process.env.XIAOBA_IS_PACKAGED || '');
  const projectRoot = controllers.projectRoot || (envPackaged ? process.env.XIAOBA_APP_ROOT : undefined) || process.cwd();
  const serviceManager = new ServiceManager(projectRoot);

  app.use(express.json({ limit: '25mb' }));

  bootstrapDefaultSkillHubSkillsOnce().catch(error => {
    Logger.warning(`Default SkillHub bootstrap failed: ${error?.message || String(error)}`);
  });

  // Configure and apply dashboard authentication.
  // Trim the env var so whitespace-only values are treated as "not set"
  // (the middleware also trims, but we check the trimmed value for logging).
  const dashboardApiKey = (process.env.DASHBOARD_API_KEY || '').trim();
  const dashboardAuth = createDashboardAuth({
    apiKey: dashboardApiKey || undefined,
  });

  // API routes (with auth protection)
  app.use('/api', dashboardAuth.middleware, createApiRouter(serviceManager, controllers.updateController, {
    getAuthStatus: dashboardAuth.getStatus,
  }));

  // Serve frontend
  const frontendPath = path.join(__dirname, '../../dashboard');
  app.use(express.static(frontendPath));

  // SPA fallback
  app.use((_req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });

  // 优雅退出 — await service drain before process exit so an active
  // heartbeat wake can finish within the configured Review Deadline.
  let shuttingDown = false;
  const gracefulShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await serviceManager.drainAll();
    } catch (error) {
      Logger.warning(`Service drain failed during shutdown: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  const server = app.listen(port, '127.0.0.1', () => {
    Logger.success(`\nCatsCo Dashboard started`);
    if (dashboardApiKey) {
      Logger.info(`API authentication enabled — provide DASHBOARD_API_KEY as Bearer token or X-API-Key header`);
    }
    Logger.info(`Open browser: http://127.0.0.1:${port} or http://localhost:${port}\n`);
  });
  activeServers.push(server);

  const localhostIpv6Server = app.listen(port, '::1');
  localhostIpv6Server.on('error', () => {
    // Some environments do not expose IPv6 loopback. The IPv4 listener above is enough.
  });
  activeServers.push(localhostIpv6Server);

  return {
    async stop(): Promise<void> {
      // Await service drain before closing HTTP servers so an active
      // heartbeat wake can finish within the configured Review Deadline.
      await serviceManager.drainAll();
      await Promise.all(activeServers.splice(0).map(closeServer));
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
  });
}
