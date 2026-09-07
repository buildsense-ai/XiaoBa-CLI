import express, { Express } from 'express';
import * as path from 'path';
import type { Server } from 'http';
import { Logger } from '../utils/logger';
import { createApiRouter } from './routes/api';
import { ServiceManager } from './service-manager';
import { bootstrapDefaultSkillHubSkillsOnce } from '../skillhub/default-skill-bootstrap';
import { createDashboardAuth } from './auth';
import { CatsConnectorAutoStart } from './cats-connector-autostart';

/** Environment variable for CORS allowed origins (comma-separated) */
const CORS_ORIGINS_ENV = 'DASHBOARD_CORS_ORIGINS';

/**
 * Check if running in production mode (based on common environment indicators).
 * Production mode is detected if:
 * - NODE_ENV is set to 'production'
 * - XIAOBA_PRODUCTION is set to '1', 'true', or 'yes'
 * - Running as packaged app (XIAOBA_IS_PACKAGED is set)
 */
function isProductionMode(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return true;
  }
  if (/^(1|true|yes)$/i.test(process.env.XIAOBA_PRODUCTION || '')) {
    return true;
  }
  if (/^(1|true|yes)$/i.test(process.env.XIAOBA_IS_PACKAGED || '')) {
    return true;
  }
  return false;
}

/**
 * Configure CORS for the dashboard server.
 * By default, only localhost origins are allowed for security.
 * Set DASHBOARD_CORS_ORIGINS to allow specific origins (comma-separated).
 * 
 * SECURITY: Wildcard CORS (*) is blocked in production mode.
 */
function setupCors(app: Express): void {
  const allowedOrigins = process.env[CORS_ORIGINS_ENV];
  const productionMode = isProductionMode();
  
  if (!allowedOrigins) {
    // Default: only allow localhost for security
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      const localhostOrigins = [
        'http://127.0.0.1',
        'http://localhost',
        'https://localhost',
        'http://[::1]'
      ];
      
      if (origin && localhostOrigins.some(allowed => origin.startsWith(allowed))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      
      // Always set these headers for preflight
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
      res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
      
      next();
    });
  } else {
    // Custom origins configured
    const origins = allowedOrigins.split(',').map(o => o.trim()).filter(Boolean);
    
    if (origins.length === 1 && origins[0] === '*') {
      // Wildcard CORS - check production mode
      if (productionMode) {
        // Block wildcard CORS in production for security
        Logger.error('[Dashboard] CORS  wildcard (*) not allowed in production mode. Using localhost-only fallback.');
        app.use((req, res, next) => {
          const origin = req.headers.origin;
          const localhostOrigins = [
            'http://127.0.0.1',
            'http://localhost',
            'https://localhost',
            'http://[::1]'
          ];
          
          if (origin && localhostOrigins.some(allowed => origin.startsWith(allowed))) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
          }
          
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
          next();
        });
      } else {
        // Wildcard - allow all origins (not recommended for production)
        Logger.warning('[Dashboard] CORS 配置为允许所有来源 (*)，不建议在生产环境中使用');
        app.use((req, res, next) => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
          next();
        });
      }
    } else {
      // Specific origins
      Logger.info(`[Dashboard] CORS 已配置，允许来源: ${origins.join(', ')}`);
      app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && origins.includes(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
        next();
      });
    }
  }
}

const DEFAULT_PORT = 3800;
const activeServers: Server[] = [];
export interface UpdateController {
  getStatus: () => any;
  checkForUpdates: (manual?: boolean) => Promise<any>;
  downloadUpdate: () => Promise<any>;
  installUpdate: () => any;
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
  process.env.XIAOBA_DASHBOARD_PORT = String(port);
  const serviceManager = new ServiceManager(projectRoot);

  // Setup CORS before other middleware
  setupCors(app);
  
  // Handle preflight requests
  app.options('*', (req, res) => {
    res.sendStatus(200);
  });

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
  const catsConnectorAutoStart = new CatsConnectorAutoStart({
    port,
    apiKey: dashboardApiKey || undefined,
  });

  // API routes (with auth protection)
  app.use('/api', dashboardAuth.middleware, createApiRouter(serviceManager, controllers.updateController, {
    getAuthStatus: dashboardAuth.getStatus,
    catsConnectorAutoStart,
  }));

  // Serve frontend
  const frontendPath = path.join(__dirname, '../../dashboard');
  app.get('/', (_req, res) => {
    res.sendFile(path.join(frontendPath, 'connector.html'));
  });
  app.use(express.static(frontendPath));

  // SPA fallback
  app.use((_req, res) => {
    res.sendFile(path.join(frontendPath, 'connector.html'));
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
    Logger.success(`\nCatsCo Connector started`);
    if (dashboardApiKey) {
      Logger.info(`API authentication enabled — provide DASHBOARD_API_KEY as Bearer token or X-API-Key header`);
    }
    Logger.info(`Open browser: http://127.0.0.1:${port} or http://localhost:${port}\n`);
    catsConnectorAutoStart.schedule('startup', 100);
  });
  activeServers.push(server);

  const localhostIpv6Server = app.listen(port, '::1');
  localhostIpv6Server.on('error', () => {
    // Some environments do not expose IPv6 loopback. The IPv4 listener above is enough.
  });
  activeServers.push(localhostIpv6Server);

  return {
    async stop(): Promise<void> {
      catsConnectorAutoStart.stop();
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
