import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import type { Server } from 'http';
import { Logger } from '../utils/logger';
import { ServiceManager } from './service-manager';
import { createDashboardAuth } from './auth';
import { CatsConnectorAutoStart } from './cats-connector-autostart';
import { APP_VERSION } from '../version';
import { resolveCatsCoRuntimeConfig } from '../catscompany/runtime-config';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';

const DEFAULT_PORT = 3800;

export interface ConnectorLiteUpdateController {
  getStatus: () => any;
  checkForUpdates: (manual?: boolean) => Promise<any>;
  downloadUpdate: () => Promise<any>;
  installUpdate: () => void;
}

export interface ConnectorLiteServerOptions {
  updateController?: ConnectorLiteUpdateController;
  projectRoot?: string;
}

export interface ConnectorLiteServerHandle {
  stop: () => Promise<void>;
}

/**
 * Minimal Dashboard API for the packaged Connector Lite product.
 * Keep this module deliberately free of the full Runtime/settings/SkillHub
 * router. The existing Dashboard remains the default development/full build.
 */
export async function startConnectorLiteDashboard(
  port: number = DEFAULT_PORT,
  options: ConnectorLiteServerOptions = {},
): Promise<ConnectorLiteServerHandle> {
  const app = express();
  const projectRoot = options.projectRoot || process.env.XIAOBA_APP_ROOT || process.cwd();
  process.env.XIAOBA_DASHBOARD_PORT = String(port);
  const serviceManager = new ServiceManager(projectRoot);
  app.use(express.json({ limit: '25mb' }));

  const dashboardApiKey = (process.env.DASHBOARD_API_KEY || '').trim();
  const dashboardAuth = createDashboardAuth({ apiKey: dashboardApiKey || undefined });
  const autoStart = new CatsConnectorAutoStart({
    port,
    apiKey: dashboardApiKey || undefined,
  });

  app.use('/api', dashboardAuth.middleware, createConnectorLiteRouter(serviceManager, options.updateController, autoStart));

  const frontendPath = path.join(__dirname, '../../dashboard');
  app.get('/', (_req, res) => res.sendFile(path.join(frontendPath, 'connector.html')));
  app.use(express.static(frontendPath));
  app.use((_req, res) => res.sendFile(path.join(frontendPath, 'connector.html')));

  const servers = [app.listen(port, '127.0.0.1', () => {
    Logger.success('\nCatsCo Connector Lite Dashboard started');
    if (dashboardApiKey) Logger.info('Dashboard API authentication enabled');
    Logger.info(`Open browser: http://127.0.0.1:${port}\n`);
    autoStart.schedule('startup', 100);
  })];
  const ipv6 = app.listen(port, '::1');
  ipv6.on('error', () => undefined);
  servers.push(ipv6);

  const shutdown = () => {
    autoStart.stop();
    serviceManager.stopAll();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return {
    async stop() {
      shutdown();
      await Promise.all(servers.map(closeServer));
    },
  };
}

function createConnectorLiteRouter(
  serviceManager: ServiceManager,
  updateController: ConnectorLiteUpdateController | undefined,
  autoStart: CatsConnectorAutoStart,
): express.Router {
  const router = express.Router();

  router.get('/status', (_req, res) => {
    res.json({ ok: true, version: APP_VERSION, authRequired: Boolean(process.env.DASHBOARD_API_KEY?.trim()) });
  });

  router.get('/cats/status', async (_req, res) => {
    try {
      const runtime = resolveCatsCoRuntimeConfig({ runtimeRoot: runtimeRoot(), config: {}, migrateLegacyEnvBinding: true });
      const state = runtime.auth;
      const service = serviceManager.getService('catscompany');
      let connected = false;
      let authStatus: 'missing' | 'valid' | 'invalid' | 'unchecked' = state.token ? 'unchecked' : 'missing';
      let authError = '';
      let user = state.uid ? { uid: state.uid, username: state.username || '', display_name: state.displayName || state.username || '' } : null;
      if (state.token) {
        try {
          const response = await fetch(`${state.httpBaseUrl}/api/me`, {
            headers: { Authorization: `Bearer ${state.token}` },
            signal: AbortSignal.timeout(4000),
          });
          if (response.status === 401 || response.status === 403) throw Object.assign(new Error('CatsCo 登录态已失效'), { status: response.status });
          if (!response.ok) throw new Error(`CatsCo status HTTP ${response.status}`);
          const me = await response.json() as any;
          const uid = String(me.uid || state.uid || '').trim();
          connected = Boolean(uid);
          authStatus = connected ? 'valid' : 'invalid';
          user = connected ? { uid, username: me.username || state.username || '', display_name: me.display_name || me.username || state.displayName || '' } : null;
        } catch (error: any) {
          if (error?.status === 401 || error?.status === 403) {
            authStatus = 'invalid';
            authError = '本地登录态已失效，请重新登录';
            user = null;
          } else {
            connected = Boolean(state.uid);
            authError = '暂时无法验证 CatsCo 登录态，已保留本地登录态';
          }
        }
      }
      const bodyConfigured = runtime.bodyConfigured;
      const bodyStatus = { state: bodyConfigured ? 'online' : 'unknown', active: bodyConfigured };
      const chatReady = connected && bodyConfigured;
      res.json({
        connected, configured: chatReady, bodyConfigured, connectorReady: runtime.connectorReady, chatReady,
        tokenPresent: Boolean(state.token), authStatus, authError, user,
        botUid: state.botUid || null,
        bot: runtime.localConfig.currentBot || null,
        device: runtime.localConfig.device || null,
        bodyStatus, conflicts: runtime.conflicts,
        topicId: chatReady && user?.uid && state.botUid ? `${user.uid}:${state.botUid}` : '',
        httpBaseUrl: state.httpBaseUrl, serverUrl: state.serverUrl, service: service || null,
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || String(error) });
    }
  });

  router.get('/cats/bootstrap/status', (_req, res) => res.json(autoStart.getSnapshot()));
  router.post('/cats/bootstrap', (req, res) => res.status(202).json({ ok: true, ...autoStart.schedule(String(req.body?.trigger || 'manual'), 0, { force: true }) }));

  router.get('/config', (_req, res) => {
    const env = process.env;
    res.json({
      FEISHU_APP_ID: env.FEISHU_APP_ID || '',
      FEISHU_APP_SECRET: env.FEISHU_APP_SECRET || '',
      FEISHU_BOT_OPEN_ID: env.FEISHU_BOT_OPEN_ID || '',
      FEISHU_BOT_ALIASES: env.FEISHU_BOT_ALIASES || '',
      WEIXIN_TOKEN: env.WEIXIN_TOKEN || '',
    });
  });

  router.put('/config', (req, res) => {
    const allowed = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_BOT_OPEN_ID', 'FEISHU_BOT_ALIASES', 'WEIXIN_TOKEN'];
    const updates: Record<string, string> = {};
    for (const key of allowed) {
      if (typeof req.body?.[key] === 'string') updates[key] = req.body[key].trim();
    }
    try {
      const root = runtimeRoot();
      const filePath = path.join(root, '.env');
      let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
      for (const [key, value] of Object.entries(updates)) {
        const line = `${key}=${value.replace(/\\n/g, '\\\\n')}`;
        const pattern = new RegExp(`^${key}=.*$`, 'm');
        content = pattern.test(content) ? content.replace(pattern, line) : `${content}${content.endsWith('\\n') || !content ? '' : '\\n'}${line}\\n`;
        process.env[key] = value;
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, { mode: 0o600 });
      res.json({ ok: true, updated: Object.keys(updates), cleared: [] });
    } catch (error: any) { sendError(res, error); }
  });

  router.post('/cats/auth/login', async (req, res) => {
    try {
      const state = createCatsCoLocalConfigService({ runtimeRoot: runtimeRoot() }).getAuthState(req.body || {});
      const account = String(req.body?.account || '').trim();
      const password = String(req.body?.password || '');
      if (!account || !password) return res.status(400).json({ error: 'account and password are required' });
      const response = await catsRequest(state.httpBaseUrl, '/api/auth/login', { account, password, persistent: true });
      createCatsCoLocalConfigService({ runtimeRoot: runtimeRoot() }).persistAccountSession(state, response);
      autoStart.invalidateAndSchedule('login', 0, { force: true });
      res.json({ ok: true, user: { uid: response.uid, username: response.username, display_name: response.display_name || response.username } });
    } catch (error: any) { sendError(res, error); }
  });

  router.post('/cats/auth/logout', (_req, res) => {
    try {
      if (serviceManager.getService('catscompany')?.status === 'running') serviceManager.stop('catscompany');
      const removed = createCatsCoLocalConfigService({ runtimeRoot: runtimeRoot() }).clearAccount();
      autoStart.invalidateAndSchedule('logout');
      res.json({ ok: true, removed });
    } catch (error: any) { sendError(res, error); }
  });

  router.post('/cats/connector/start', async (_req, res) => {
    try { res.json(await startConnector(serviceManager)); } catch (error: any) { sendError(res, error); }
  });
  router.post('/cats/connector/stop', (_req, res) => {
    try { res.json({ ok: true, service: serviceManager.stop('catscompany') }); } catch (error: any) { sendError(res, error); }
  });

  router.post('/cats/setup', async (_req, res) => {
    try {
      const localConfig = createCatsCoLocalConfigService({ runtimeRoot: runtimeRoot() });
      const state = localConfig.getAuthState();
      if (!state.token || !state.uid) return res.status(401).json({ error: 'CatsCo user token is missing' });
      const data = await catsRequest(state.httpBaseUrl, '/api/bots', undefined, state.token);
      const bots = (Array.isArray(data?.bots) ? data.bots : []).filter((bot: any) => {
        const owner = String(bot.owner_id || bot.owner_uid || '').trim();
        return !owner || owner === String(state.uid) || bot.is_owner === true || bot.relation === 'owner';
      });
      const target = bots.find((bot: any) => String(bot.id || bot.uid || '') === String(state.botUid || '')) || bots[0];
      if (!target) return res.status(409).json({ error: '当前 CatsCo 账号没有可绑定的 Agent' });
      const botUid = String(target.id || target.uid || '');
      const apiKey = await resolveBotApiKey(state, botUid, target);
      if (!apiKey) return res.status(409).json({ error: '当前 Agent 缺少 Connector 凭证，无法绑定' });
      localConfig.writeBotBinding(state, { userUid: state.uid, botUid, botName: target.display_name || target.username || 'Bot', botUsername: target.username || '', apiKey, bindingSource: 'auto-bootstrap' });
      localConfig.ensureDeviceId();
      const result = await startConnector(serviceManager);
      res.json({ ok: true, botUid, service: result.service });
    } catch (error: any) { sendError(res, error); }
  });

  router.get('/cats/bots', async (_req, res) => {
    try {
      const state = createCatsCoLocalConfigService({ runtimeRoot: runtimeRoot() }).getAuthState();
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });
      const data = await catsRequest(state.httpBaseUrl, '/api/bots', undefined, state.token);
      const bots = (Array.isArray(data?.bots) ? data.bots : []).filter((bot: any) => String(bot.owner_id || bot.owner_uid || '') === String(state.uid || '') || bot.is_owner === true || bot.relation === 'owner');
      res.json({ ok: true, currentBotUid: state.botUid || '', bots: bots.map((bot: any) => ({ uid: String(bot.id || bot.uid || ''), username: String(bot.username || ''), display_name: String(bot.display_name || bot.username || ''), api_key: '', isCurrent: String(bot.id || bot.uid || '') === String(state.botUid || '') })) });
    } catch (error: any) { sendError(res, error); }
  });

  router.post('/cats/switch-bot', async (req, res) => {
    try {
      const service = createCatsCoLocalConfigService({ runtimeRoot: runtimeRoot() });
      const state = service.getAuthState();
      if (!state.token || !state.uid) return res.status(401).json({ error: 'CatsCo user token is missing' });
      const botUid = String(req.body?.botUid || '').trim();
      if (!botUid) return res.status(400).json({ error: 'botUid is required' });
      const data = await catsRequest(state.httpBaseUrl, '/api/bots', undefined, state.token);
      const bots = Array.isArray(data?.bots) ? data.bots : [];
      const target = bots.find((bot: any) => String(bot.id || bot.uid || '') === botUid);
      if (!target) return res.status(404).json({ error: 'Bot not found' });
      const owner = String(target.owner_id || target.owner_uid || '').trim();
      if (owner && owner !== String(state.uid) && target.is_owner !== true && target.relation !== 'owner') return res.status(403).json({ error: '当前账号只能切换到自己拥有的 Agent' });
      const apiKey = await resolveBotApiKey(state, botUid, target);
      if (!apiKey) return res.status(409).json({ error: '所选 Agent 缺少 Connector 凭证，无法绑定' });
      service.writeBotBinding(state, { userUid: state.uid, botUid, botName: target.display_name || target.username || 'Bot', botUsername: target.username || '', apiKey, bindingSource: 'explicit-switch' });
      autoStart.invalidateAndSchedule('switch-bot', 0, { force: true });
      res.json({ ok: true, bot: { uid: botUid, username: target.username || '', display_name: target.display_name || target.username || 'Bot' }, topicId: `${state.uid}:${botUid}` });
    } catch (error: any) { sendError(res, error); }
  });

  router.get('/weixin/channel-binding', (_req, res) => res.json({ configured: false, binding: null, reason: '微信通道管理不属于 Connector Lite' }));
  router.get('/weixin/qrcode', (_req, res) => res.status(501).json({ error: '微信通道管理不属于 Connector Lite' }));
  router.get('/weixin/qrcode-status', (_req, res) => res.status(501).json({ error: '微信通道管理不属于 Connector Lite' }));
  router.get('/services', (_req, res) => res.json(serviceManager.getAll().filter(service => service.name === 'catscompany')));
  router.post('/services/:name/:action', (req, res) => {
    if (req.params.name !== 'catscompany' || !['start', 'stop', 'restart'].includes(req.params.action)) return res.status(404).json({ error: 'service or action not found' });
    try {
      const service = req.params.action === 'start'
        ? serviceManager.start('catscompany')
        : req.params.action === 'stop'
          ? serviceManager.stop('catscompany')
          : serviceManager.restart('catscompany');
      res.json(service);
    } catch (error: any) { sendError(res, error); }
  });
  router.get('/services/:name/logs', (req, res) => res.json(serviceManager.getLogs(req.params.name, Number(req.query.lines || 100))));

  router.get('/update/status', (_req, res) => res.json(updateController ? updateController.getStatus() : { enabled: false, stage: 'disabled', message: '当前环境不可用更新器' }));
  router.post('/update/check', async (_req, res) => { try { res.json(updateController ? await updateController.checkForUpdates(true) : { enabled: false, stage: 'disabled' }); } catch (error: any) { sendError(res, error); } });
  router.post('/update/download', async (_req, res) => { try { if (!updateController) return res.status(400).json({ error: '当前环境不可用更新器' }); res.json(await updateController.downloadUpdate()); } catch (error: any) { sendError(res, error); } });
  router.post('/update/install', (_req, res) => { try { if (!updateController) return res.status(400).json({ error: '当前环境不可用更新器' }); updateController.installUpdate(); res.json({ ok: true }); } catch (error: any) { sendError(res, error); } });

  return router;
}

function runtimeRoot(): string { return process.env.XIAOBA_RUNTIME_ROOT || process.env.XIAOBA_USER_DATA_DIR || process.cwd(); }

async function resolveBotApiKey(state: ReturnType<ReturnType<typeof createCatsCoLocalConfigService>['getAuthState']>, botUid: string, bot: any): Promise<string> {
  const embedded = String(bot?.api_key || bot?.apiKey || '').trim();
  if (embedded) return embedded;
  try {
    const data = await catsRequest(state.httpBaseUrl, `/api/bots/api-key?uid=${encodeURIComponent(botUid)}`, undefined, state.token);
    return String(data?.api_key || data?.apiKey || data?.key || '').trim();
  } catch {
    return '';
  }
}

async function catsRequest(baseUrl: string, pathname: string, body?: unknown, token?: string): Promise<any> {
  const response = await fetch(`${baseUrl}${pathname}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const data = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) throw Object.assign(new Error(String(data?.error || data?.message || `HTTP ${response.status}`)), { status: response.status, data });
  return data;
}

async function startConnector(serviceManager: ServiceManager): Promise<Record<string, unknown>> {
  const runtime = resolveCatsCoRuntimeConfig({ runtimeRoot: runtimeRoot(), config: {}, migrateLegacyEnvBinding: true });
  if (!runtime.connector) throw Object.assign(new Error(`CatsCo connector 配置缺失：${runtime.missing.join(', ') || 'binding'}`), { status: 409 });
  const service = serviceManager.getService('catscompany');
  if (!service) throw Object.assign(new Error('CatsCompany connector service is unavailable'), { status: 409 });
  const result = service.status === 'running' ? service : serviceManager.start('catscompany');
  return { ok: true, botUid: runtime.auth.botUid, service: result, connectorStarted: service.status !== 'running', connectorAlreadyRunning: service.status === 'running' };
}

function sendError(res: express.Response, error: any): void { res.status(Number(error?.status) || 500).json({ error: error?.message || String(error), data: error?.data }); }

function closeServer(server: Server): Promise<void> { return new Promise(resolve => server.close(() => resolve())); }
