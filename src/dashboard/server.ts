import express from 'express';
import * as path from 'path';
import type { Server } from 'http';
import { Logger } from '../utils/logger';
import { createApiRouter } from './routes/api';
import { ServiceManager } from './service-manager';
import { bootstrapDefaultSkillHubSkillsOnce } from '../skillhub/default-skill-bootstrap';
import { createDashboardAuth } from './auth';
import { PathResolver } from '../utils/path-resolver';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { createBotSkillWorkspaceService } from '../bot-skills/workspace-service';
import { recoverBotSkillActivation } from '../bot-skills/activation-recovery';
import * as fs from 'node:fs';
import { FileBotDefinitionRepository } from '../bot-definition/repository';
import { createBotSkillService } from '../bot-skills/service';

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

  const runtimeRoot = PathResolver.getRuntimeDataRoot();
  const initialBotId = String(
    createCatsCoLocalConfigService({ runtimeRoot }).load().currentBot?.uid || '',
  ).trim();
  const workspaceMetadataExists = fs.existsSync(
    path.join(runtimeRoot, 'data', 'bot-skills', 'workspace-state.json'),
  ) || fs.existsSync(
    path.join(runtimeRoot, 'data', 'bot-skills', 'binding-rollback.json'),
  );
  let activeBotWorkspaceReady = false;
  if (initialBotId || workspaceMetadataExists) {
    const workspaceService = createBotSkillWorkspaceService({ runtimeRoot });
    recoverBotSkillActivation(runtimeRoot, workspaceService);
    const recoveredBotId = String(
      createCatsCoLocalConfigService({ runtimeRoot }).load().currentBot?.uid || '',
    ).trim();
    if (!recoveredBotId) {
      throw new Error('Bot binding disappeared during Skill workspace recovery.');
    }
    const hasLocalWorkspace = Boolean(
      workspaceService.readState() || fs.existsSync(workspaceService.activePath),
    );
    if (hasLocalWorkspace) {
      workspaceService.ensureActive(recoveredBotId);
    } else {
      const definitions = new FileBotDefinitionRepository({ runtimeRoot });
      const definition = definitions.readCache(recoveredBotId) ??
        definitions.readCanonical(recoveredBotId);
      workspaceService.ensureActive(recoveredBotId, {
        allowCreate: Array.isArray(definition?.skills) && definition.skills.length === 0,
      });
    }
    const manifest = await createBotSkillService({ runtimeRoot }).scanManifest();
    if (manifest.status === 'partial') {
      Logger.warning(
        `Active Bot Skill manifest is partial; Dashboard will start in degraded mode. ${formatManifestIssues(manifest.issues)}`,
      );
    } else if (manifest.status !== 'complete') {
      throw new Error(`Active Bot Skill manifest is ${manifest.status}.`);
    } else {
      activeBotWorkspaceReady = true;
    }
  }

  if (activeBotWorkspaceReady) {
    const workspaceId = createBotSkillWorkspaceService({ runtimeRoot })
      .readState()?.workspaceId;
    await bootstrapDefaultSkillHubSkillsOnce({ workspaceId }).catch(error => {
      Logger.warning(`Default SkillHub bootstrap failed: ${error?.message || String(error)}`);
    });
  }

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

function formatManifestIssues(
  issues: Array<{ code: string; message: string; path?: string }>,
): string {
  return issues
    .map(issue => `[${issue.code}]${issue.path ? ` ${issue.path}:` : ''} ${issue.message}`)
    .join('; ');
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
  });
}
