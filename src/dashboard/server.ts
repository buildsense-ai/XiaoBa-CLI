import express from 'express';
import * as path from 'path';
import type { Server } from 'http';
import { Logger } from '../utils/logger';
import { PathResolver } from '../utils/path-resolver';
import { isBotSkillRuntimeEnabled } from '../bot-skills/runtime';
import { BotSkillWorkspaceService } from '../bot-skills/workspace';
import { FileBotSkillSwitchJournalStore } from '../bot-skills/switch-journal';
import { BotSkillWorkspaceSwitchService } from '../bot-skills/switch-service';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { createApiRouter } from './routes/api';
import { ServiceManager } from './service-manager';
import { createDashboardAuth } from './auth';
import { bootstrapDefaultSkillHubSkillsOnce } from '../skillhub/default-skill-bootstrap';

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
  if (!isBotSkillRuntimeEnabled()) {
    void bootstrapDefaultSkillHubSkillsOnce().catch(error => {
      Logger.warning(`Default Skill bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  } else {
    const runtimeRoot = PathResolver.getRuntimeDataRoot();
    const auth = createCatsCoLocalConfigService({ runtimeRoot }).getAuthState();
    const recovery = await new BotSkillWorkspaceSwitchService({
      workspace: new BotSkillWorkspaceService({ runtimeRoot }),
      journalStore: new FileBotSkillSwitchJournalStore({ runtimeRoot }),
    }).recover({
      currentBotId: auth.botUid,
      restartConnector: async result => {
        try {
          await serviceManager.startAndWait('catscompany');
        } catch (error) {
          Logger.warning(
            `Recovered Bot Skill switch (${result}), but the CatsCo connector could not restart: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      },
    });
    if (recovery !== 'none') Logger.info(`Recovered Bot Skill workspace switch: ${recovery}`);
  }

  app.use(express.json({ limit: '25mb' }));

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

  // 优雅退出
  process.on('SIGINT', () => {
    serviceManager.stopAll();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    serviceManager.stopAll();
    process.exit(0);
  });

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
      serviceManager.stopAll();
      await Promise.all(activeServers.splice(0).map(closeServer));
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
  });
}
