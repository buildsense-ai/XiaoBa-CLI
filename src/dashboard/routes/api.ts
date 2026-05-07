import { Router } from 'express';
import { SkillManager } from '../../skills/skill-manager';
import type { Skill } from '../../types/skill';
import { ConfigManager } from '../../utils/config';
import { ServiceManager } from '../service-manager';
import type { UpdateController } from '../server';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as https from 'https';
import * as http from 'http';
import { PathResolver } from '../../utils/path-resolver';
import matter from 'gray-matter';
import { execSync } from 'child_process';
import { APP_VERSION } from '../../version';
import { createRuntimeConfigSnapshot } from '../../runtime/runtime-config-snapshot';
import {
  getDashboardReadiness,
  getServicePreflight,
} from '../readiness';
import {
  getDashboardSettings,
  isSensitiveEnvKey,
  updateDashboardSettings,
  writeDashboardEnvUpdates,
} from '../settings';
import {
  RuntimeProfileEditInput,
  hasRuntimeProfileRollback,
  previewRuntimeProfileEdit,
  rollbackRuntimeProfileEdit,
  saveRuntimeProfileEdit,
} from '../../runtime/runtime-profile-editor';
// import { ReportGenerator } from '../../utils/report-generator';
// import { LogUploader } from '../../utils/log-uploader';

const DEFAULT_CATSCO_HTTP_BASE_URL = 'https://app.catsco.cc';
const DEFAULT_CATSCO_WS_URL = 'wss://app.catsco.cc/v0/channels';
const BUNDLED_SKILL_MARKER = '.xiaoba-bundled-skill.json';
const SYSTEM_SKILL_DIRS = new Set(['_tool-skills']);

type SkillSource = 'system' | 'bundled' | 'user';

interface SkillManagementInfo {
  source: SkillSource;
  protected: boolean;
  canDisable: boolean;
  canDelete: boolean;
}

interface CatsAuthState {
  token?: string;
  uid?: string;
  username?: string;
  displayName?: string;
  httpBaseUrl: string;
  serverUrl: string;
  botUid?: string;
  apiKey?: string;
}

function normalizeBaseUrl(value: unknown, fallback: string): string {
  const text = String(value || '').trim().replace(/\/+$/, '');
  return text || fallback;
}

function p2pTopicId(uid1: string | number, uid2: string | number): string {
  const a = Number(uid1);
  const b = Number(uid2);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  const [left, right] = a < b ? [a, b] : [b, a];
  return `p2p_${left}_${right}`;
}

function readEnvFile(): Record<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return {};
  return dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return undefined;
}

function writeEnvUpdates(updates: Record<string, string | undefined>): string[] {
  const envPath = path.join(process.cwd(), '.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const updatedKeys: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const escaped = value.replace(/\n/g, '\\n');
    const line = `${key}=${escaped}`;
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, line);
    } else {
      content += `${content.endsWith('\n') || content.length === 0 ? '' : '\n'}${line}\n`;
    }
    process.env[key] = value;
    updatedKeys.push(key);
  }

  fs.writeFileSync(envPath, content);
  return updatedKeys;
}

function removeEnvKeys(keys: string[]): string[] {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return [];
  let content = fs.readFileSync(envPath, 'utf-8');
  const removed: string[] = [];

  for (const key of keys) {
    const regex = new RegExp(`^${key}=.*(?:\\r?\\n|$)`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, '');
      delete process.env[key];
      removed.push(key);
    }
  }

  fs.writeFileSync(envPath, content);
  return removed;
}

export function getCatsAuthState(overrides: Record<string, unknown> = {}): CatsAuthState {
  const env = readEnvFile();
  return {
    token: firstNonEmpty(
      overrides.token,
      env.CATSCO_USER_TOKEN,
      process.env.CATSCO_USER_TOKEN,
      env.CATSCOMPANY_USER_TOKEN,
      process.env.CATSCOMPANY_USER_TOKEN,
    ),
    uid: firstNonEmpty(
      overrides.uid,
      env.CATSCO_USER_UID,
      process.env.CATSCO_USER_UID,
      env.CATSCOMPANY_USER_UID,
      process.env.CATSCOMPANY_USER_UID,
    ),
    username: firstNonEmpty(
      env.CATSCO_USER_NAME,
      process.env.CATSCO_USER_NAME,
      env.CATSCOMPANY_USER_NAME,
      process.env.CATSCOMPANY_USER_NAME,
    ),
    displayName: firstNonEmpty(
      env.CATSCO_USER_DISPLAY_NAME,
      process.env.CATSCO_USER_DISPLAY_NAME,
      env.CATSCOMPANY_USER_DISPLAY_NAME,
      process.env.CATSCOMPANY_USER_DISPLAY_NAME,
    ),
    httpBaseUrl: normalizeBaseUrl(
      firstNonEmpty(
        overrides.httpBaseUrl,
        env.CATSCO_HTTP_BASE_URL,
        process.env.CATSCO_HTTP_BASE_URL,
        env.CATSCOMPANY_HTTP_BASE_URL,
        process.env.CATSCOMPANY_HTTP_BASE_URL,
      ),
      DEFAULT_CATSCO_HTTP_BASE_URL,
    ),
    serverUrl: normalizeBaseUrl(
      firstNonEmpty(
        overrides.serverUrl,
        env.CATSCO_SERVER_URL,
        process.env.CATSCO_SERVER_URL,
        env.CATSCOMPANY_SERVER_URL,
        process.env.CATSCOMPANY_SERVER_URL,
      ),
      DEFAULT_CATSCO_WS_URL,
    ),
    botUid: firstNonEmpty(
      overrides.botUid,
      env.CATSCO_BOT_UID,
      process.env.CATSCO_BOT_UID,
      env.CATSCOMPANY_BOT_UID,
      process.env.CATSCOMPANY_BOT_UID,
    ),
    apiKey: firstNonEmpty(
      env.CATSCO_API_KEY,
      process.env.CATSCO_API_KEY,
      env.CATSCOMPANY_API_KEY,
      process.env.CATSCOMPANY_API_KEY,
    ),
  };
}

async function catsRequest(
  method: string,
  httpBaseUrl: string,
  apiPath: string,
  body?: unknown,
  token?: string,
): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${httpBaseUrl}${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data: any = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const message = data?.error || data?.message || `CatsCo request failed: ${response.status}`;
    const error = new Error(message);
    (error as any).status = response.status;
    (error as any).data = data;
    throw error;
  }

  return data;
}

async function catsApiKeyRequest(
  method: string,
  httpBaseUrl: string,
  apiPath: string,
  apiKey: string,
  body?: unknown,
): Promise<any> {
  const response = await fetch(`${httpBaseUrl}${apiPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `ApiKey ${apiKey}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data: any = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const message = data?.error || data?.message || `CatsCo request failed: ${response.status}`;
    const error = new Error(message);
    (error as any).status = response.status;
    (error as any).data = data;
    throw error;
  }

  return data;
}

function persistCatsUserSession(state: CatsAuthState, login: any): void {
  writeEnvUpdates({
    CATSCOMPANY_HTTP_BASE_URL: state.httpBaseUrl,
    CATSCOMPANY_SERVER_URL: state.serverUrl,
    CATSCOMPANY_USER_TOKEN: login.token,
    CATSCOMPANY_USER_UID: String(login.uid || ''),
    CATSCOMPANY_USER_NAME: login.username || '',
    CATSCOMPANY_USER_DISPLAY_NAME: login.display_name || login.username || '',
  });
}

/**
 * 安装 skill 的 npm 依赖（读取 SKILL.md 的 npm-dependencies 字段）
 */
function installSkillNpmDeps(skillDir: string): void {
  const skillMdPath = ['SKILL.md', 'SKILL.MD'].map(f => path.join(skillDir, f)).find(f => fs.existsSync(f));
  if (!skillMdPath) return;

  try {
    const { data } = matter(fs.readFileSync(skillMdPath, 'utf-8'));
    const deps: string[] = data['npm-dependencies'];
    if (!deps || !Array.isArray(deps) || deps.length === 0) return;

    const { execSync } = require('child_process');
    const projectRoot = process.cwd();
    execSync(`npm install --no-save ${deps.join(' ')}`, { cwd: projectRoot, timeout: 120000 });
  } catch (e: any) {
    // npm 安装失败不阻塞
  }
}

export function createApiRouter(serviceManager: ServiceManager, updateController?: UpdateController): Router {
  const router = Router();

  // ==================== 总览 ====================

  
  router.get('/status', (_req, res) => {
    const config = ConfigManager.getConfigReadonly();
    const services = serviceManager.getAll();
    res.json({
      version: APP_VERSION,
      hostname: os.hostname(),
      platform: os.platform(),
      nodeVersion: process.version,
      model: config.model,
      provider: config.provider,
      skillsPath: PathResolver.getSkillsPath(),
      services,
    });
  });

  router.get('/runtime/config', async (_req, res) => {
    try {
      res.json(await createRuntimeConfigSnapshot({
        config: ConfigManager.getConfigReadonly(),
      }));
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.get('/readiness', async (_req, res) => {
    try {
      res.json(await getDashboardReadiness(serviceManager, {
        runtimeRoot: process.cwd(),
        config: ConfigManager.getConfigReadonly(),
      }));
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.get('/runtime/profile/edit', (_req, res) => {
    try {
      const preview = previewRuntimeProfileEdit({}, { runtimeRoot: process.cwd() });
      res.json(sanitizeRuntimeProfileEditResponse({
        ...preview,
        rollbackAvailable: hasRuntimeProfileRollback({ runtimeRoot: process.cwd() }),
      }));
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.post('/runtime/profile/preview', (req, res) => {
    try {
      const preview = previewRuntimeProfileEdit(req.body as RuntimeProfileEditInput, {
        runtimeRoot: process.cwd(),
      });
      res.json(sanitizeRuntimeProfileEditResponse({
        ...preview,
        rollbackAvailable: hasRuntimeProfileRollback({ runtimeRoot: process.cwd() }),
      }));
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  router.put('/runtime/profile', (req, res) => {
    try {
      const result = saveRuntimeProfileEdit(req.body as RuntimeProfileEditInput, {
        runtimeRoot: process.cwd(),
      });
      res.json(sanitizeRuntimeProfileEditResponse(result));
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  router.post('/runtime/profile/rollback', (_req, res) => {
    try {
      res.json(rollbackRuntimeProfileEdit({ runtimeRoot: process.cwd() }));
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  const updaterUnavailable = () => ({
    enabled: false,
    stage: 'disabled',
    message: '当前环境不可用更新器',
  });

  router.get('/update/status', (_req, res) => {
    if (!updateController) {
      return res.json(updaterUnavailable());
    }
    try {
      return res.json(updateController.getStatus());
    } catch (e: any) {
      return res.status(500).json({
        ...updaterUnavailable(),
        stage: 'error',
        error: e?.message || String(e),
      });
    }
  });

  router.post('/update/check', async (_req, res) => {
    if (!updateController) {
      return res.json(updaterUnavailable());
    }
    try {
      const status = await updateController.checkForUpdates(true);
      return res.json(status);
    } catch (e: any) {
      return res.status(500).json({
        error: e?.message || String(e),
        reason: e?.reason || 'UPDATE_CHECK_FAILED',
      });
    }
  });

  router.post('/update/download', async (_req, res) => {
    if (!updateController) {
      return res.status(400).json({
        error: '当前环境不可用更新器',
        reason: 'UPDATER_UNAVAILABLE',
      });
    }
    try {
      const status = await updateController.downloadUpdate();
      return res.json(status);
    } catch (e: any) {
      return res.status(500).json({
        error: e?.message || String(e),
        reason: e?.reason || 'UPDATE_DOWNLOAD_FAILED',
      });
    }
  });

  router.post('/update/install', (_req, res) => {
    if (!updateController) {
      return res.status(400).json({
        error: '当前环境不可用更新器',
        reason: 'UPDATER_UNAVAILABLE',
      });
    }
    try {
      updateController.installUpdate();
      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(500).json({
        error: e?.message || String(e),
        reason: e?.reason || 'UPDATE_INSTALL_FAILED',
      });
    }
  });

  // ==================== 服务管理 ====================

  router.get('/services', (_req, res) => {
    res.json(serviceManager.getAll());
  });

  router.post('/services/:name/preflight', (req, res) => {
    try {
      res.json(getServicePreflight(serviceManager, req.params.name, {
        runtimeRoot: process.cwd(),
        config: ConfigManager.getConfigReadonly(),
      }));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/services/:name/start', (req, res) => {
    try {
      const preflight = getServicePreflight(serviceManager, req.params.name, {
        runtimeRoot: process.cwd(),
        config: ConfigManager.getConfigReadonly(),
      });
      if (preflight.status === 'blocked' && req.body?.force !== true) {
        return res.status(400).json({
          error: 'Service preflight blocked',
          preflight,
        });
      }
      res.json(serviceManager.start(req.params.name));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/services/:name/stop', (req, res) => {
    try {
      res.json(serviceManager.stop(req.params.name));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/services/:name/restart', (req, res) => {
    try {
      const preflight = getServicePreflight(serviceManager, req.params.name, {
        runtimeRoot: process.cwd(),
        config: ConfigManager.getConfigReadonly(),
      });
      if (preflight.status === 'blocked' && req.body?.force !== true) {
        return res.status(400).json({
          error: 'Service preflight blocked',
          preflight,
        });
      }
      res.json(serviceManager.restart(req.params.name));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/services/:name/logs', (req, res) => {
    const lines = parseInt(req.query.lines as string) || 100;
    res.json(serviceManager.getLogs(req.params.name, lines));
  });

  // ==================== Typed settings ====================

  router.get('/settings', (_req, res) => {
    try {
      res.json(getDashboardSettings({ runtimeRoot: process.cwd() }));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/settings', (req, res) => {
    try {
      res.json(updateDashboardSettings(req.body, { runtimeRoot: process.cwd() }));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // ==================== 配置管理 ====================

  router.get('/config', (_req, res) => {
    try {
      const envPath = path.join(process.cwd(), '.env');
      if (!fs.existsSync(envPath)) return res.json({});
      const content = fs.readFileSync(envPath, 'utf-8');
      const parsed = dotenv.parse(content);

      const masked = { ...parsed };
      for (const key of Object.keys(masked)) {
        if (isSensitiveEnvKey(key)) {
          masked[key] = masked[key] && masked[key].length > 4
            ? `****${masked[key].slice(-4)}`
            : '****';
        }
      }
      res.json(masked);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/config', (req, res) => {
    try {
      const updates: Record<string, string> = req.body;
      const allowedKeys = new Set([
        'GAUZ_LLM_PROVIDER',
        'GAUZ_LLM_API_BASE',
        'GAUZ_LLM_API_KEY',
        'GAUZ_LLM_MODEL',
        'CATSCO_API_KEY',
        'CATSCO_HTTP_BASE_URL',
        'CATSCO_SERVER_URL',
        'CATSCOMPANY_API_KEY',
        'CATSCOMPANY_HTTP_BASE_URL',
        'CATSCOMPANY_SERVER_URL',
        'FEISHU_APP_ID',
        'FEISHU_APP_SECRET',
        'FEISHU_BOT_OPEN_ID',
        'FEISHU_BOT_ALIASES',
        'WEIXIN_TOKEN',
      ]);
      const safeUpdates: Record<string, string> = {};

      for (const [key, value] of Object.entries(updates)) {
        if (!allowedKeys.has(key)) {
          return res.status(400).json({ error: `Unknown config key: ${key}` });
        }
        if (typeof value !== 'string') continue;
        if (value.startsWith('****')) continue;
        if (/[\r\n]/.test(value)) {
          return res.status(400).json({ error: `Config value for ${key} must not contain newlines` });
        }
        safeUpdates[key] = value;
      }

      const result = writeDashboardEnvUpdates(process.cwd(), safeUpdates);
      for (const [key, value] of Object.entries(safeUpdates)) {
        process.env[key] = value;
      }
      res.json({ ok: true, updated: result.updated });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== Skills 管理 ====================

  router.get('/skills-all', async (_req, res) => {
    try {
      const manager = new SkillManager();
      await manager.loadSkills();
      const active = manager.getAllSkills().map(skillToDashboardPayload);
      const disabled = findAllDisabledSkills(PathResolver.getSkillsPath());
      res.json([...active, ...disabled]);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/skills', async (_req, res) => {
    try {
      const manager = new SkillManager();
      await manager.loadSkills();
      res.json(manager.getAllSkills().map(s => ({
        name: s.metadata.name,
        description: s.metadata.description,
        argumentHint: s.metadata.argumentHint || null,
        userInvocable: s.metadata.userInvocable !== false,
        autoInvocable: s.metadata.autoInvocable !== false,
        maxTurns: s.metadata.maxTurns || null,
        path: s.filePath,
        files: getSkillFiles(s.filePath),
      })));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/skills/:name', async (req, res) => {
    try {
      const manager = new SkillManager();
      await manager.loadSkills();
      const skill = manager.getSkill(req.params.name);
      if (!skill) return res.status(404).json({ error: 'Skill not found' });
      const management = getSkillManagementInfo(skill.filePath);
      res.json({
        name: skill.metadata.name,
        description: skill.metadata.description,
        content: skill.content,
        path: skill.filePath,
        files: getSkillFiles(skill.filePath),
        ...management,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/skills/:name', async (req, res) => {
    try {
      const manager = new SkillManager();
      await manager.loadSkills();
      const skill = manager.getSkill(req.params.name);
      if (!skill) {
        const disabled = findDisabledSkillByName(PathResolver.getSkillsPath(), req.params.name);
        if (disabled) {
          const management = getSkillManagementInfo(disabled);
          if (!management.canDelete) {
            return res.status(403).json({ error: formatSkillDeleteBlockedMessage(management) });
          }
          fs.rmSync(path.dirname(disabled), { recursive: true, force: true });
          return res.json({ ok: true });
        }
        return res.status(404).json({ error: 'Skill not found' });
      }
      const management = getSkillManagementInfo(skill.filePath);
      if (!management.canDelete) {
        return res.status(403).json({ error: formatSkillDeleteBlockedMessage(management) });
      }
      fs.rmSync(path.dirname(skill.filePath), { recursive: true, force: true });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/skills/:name/disable', async (req, res) => {
    try {
      const manager = new SkillManager();
      await manager.loadSkills();
      const skill = manager.getSkill(req.params.name);
      if (!skill) return res.status(404).json({ error: 'Skill not found' });
      const management = getSkillManagementInfo(skill.filePath);
      if (!management.canDisable) {
        return res.status(403).json({ error: '系统 Skill 不能禁用。' });
      }
      fs.renameSync(skill.filePath, skill.filePath + '.disabled');
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/skills/:name/enable', async (req, res) => {
    try {
      const f = findDisabledSkillByName(PathResolver.getSkillsPath(), req.params.name);
      if (!f) return res.status(404).json({ error: 'Disabled skill not found' });
      fs.renameSync(f, f.replace('.disabled', ''));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== Skill Store ====================

  // GET /api/store - 可安装的skills（本地+远程registry合并）
  // ?refresh=1 强制刷新远程缓存
  router.get('/store', async (req, res) => {
    try {
      if (req.query.refresh === '1') {
        remoteRegistryCache = null;
        remoteRegistryCacheTime = 0;
      }
      const local = loadRegistry();
      const remote = await fetchRemoteRegistry();
      const registry = mergeRegistries(local, remote);
      const manager = new SkillManager();
      await manager.loadSkills();
      const installed = new Map<string, any>();
      manager.getAllSkills().forEach(s => installed.set(s.metadata.name, skillToDashboardPayload(s)));
      // 也算上disabled的
      const disabled = findAllDisabledSkills(PathResolver.getSkillsPath());
      disabled.forEach(s => installed.set(s.name, s));

      const available = registry.map(entry => ({
        ...entry,
        installed: installed.has(entry.name),
        installedSkill: installed.get(entry.name) || null,
      }));
      res.json(available);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/store/install - 安装skill
  router.post('/store/install', async (req, res) => {
    try {
      const { name, repo, dir } = req.body;
      const skillsPath = PathResolver.getSkillsPath();
      const targetDir = path.join(skillsPath, dir || name);

      // 防止路径逃逸
      if (!targetDir.startsWith(skillsPath)) {
        return res.status(400).json({ error: '非法路径' });
      }

      if (fs.existsSync(targetDir)) {
        return res.status(400).json({ error: `Skill "${name}" 已存在` });
      }

      if (repo === 'local') {
        return res.json({ ok: true, message: 'Skill already bundled' });
      }

      PathResolver.ensureDir(skillsPath);
      const warnings: string[] = [];

      // 优先用 ZIP 下载（不需要 git），失败时回退 git clone
      const installed = await installFromGitHub(repo, targetDir, warnings);
      if (!installed) {
        return res.status(500).json({ error: 'Skill 安装失败，请检查 URL 是否正确' });
      }

      // 安装依赖
      installPythonDeps(targetDir, warnings);
      installSkillNpmDeps(targetDir);

      res.json({ ok: true, warnings: warnings.length > 0 ? warnings : undefined });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/store/install-github - 手动输入GitHub地址安装
  router.post('/store/install-github', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: 'URL is required' });

      // 从URL提取仓库名
      const repoName = url.replace(/\.git$/, '').split('/').pop();
      if (!repoName) return res.status(400).json({ error: 'Invalid URL' });

      const skillsPath = PathResolver.getSkillsPath();
      const targetDir = path.join(skillsPath, repoName);

      // 防止路径逃逸
      if (!targetDir.startsWith(skillsPath)) {
        return res.status(400).json({ error: '非法路径' });
      }

      if (fs.existsSync(targetDir)) {
        return res.status(400).json({ error: `目录 "${repoName}" 已存在` });
      }

      PathResolver.ensureDir(skillsPath);
      const warnings: string[] = [];

      const installed = await installFromGitHub(url, targetDir, warnings);
      if (!installed) {
        return res.status(500).json({ error: 'Skill 安装失败，请检查 URL 是否正确' });
      }

      // 安装依赖
      installPythonDeps(targetDir, warnings);
      installSkillNpmDeps(targetDir);

      res.json({ ok: true, name: repoName, warnings: warnings.length > 0 ? warnings : undefined });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== 微信 Token 获取 ====================

  router.get('/weixin/qrcode', async (_req, res) => {
    try {
      const response = await fetch('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
      const data = await response.json();
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/weixin/qrcode-status', async (req, res) => {
    try {
      const qrcode = req.query.qrcode as string;
      if (!qrcode) return res.status(400).json({ error: 'qrcode required' });
      const response = await fetch(`https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${qrcode}`);
      const data = await response.json();
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== CatsCo webapp 本地连接器 ====================

  router.get('/cats/status', (_req, res) => {
    const state = getCatsAuthState();
    const service = serviceManager.getService('catscompany');
    res.json({
      connected: Boolean(state.token),
      configured: Boolean(state.apiKey && state.serverUrl),
      tokenPresent: Boolean(state.token),
      user: state.uid ? {
        uid: state.uid,
        username: state.username || '',
        display_name: state.displayName || state.username || '',
      } : null,
      botUid: state.botUid || null,
      topicId: state.uid && state.botUid ? p2pTopicId(state.uid, state.botUid) : '',
      httpBaseUrl: state.httpBaseUrl,
      serverUrl: state.serverUrl,
      service: service || null,
    });
  });

  router.post('/cats/auth/send-code', async (req, res) => {
    try {
      const state = getCatsAuthState(req.body || {});
      const email = String(req.body?.email || '').trim();
      if (!email) return res.status(400).json({ error: 'email required' });
      const data = await catsRequest('POST', state.httpBaseUrl, '/api/auth/send-code', { email });
      res.json(data);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message, data: e.data });
    }
  });

  router.post('/cats/auth/register', async (req, res) => {
    try {
      const state = getCatsAuthState(req.body || {});
      const email = String(req.body?.email || '').trim();
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');
      const code = String(req.body?.code || '').trim();
      if (!email || !username || !password || !code) {
        return res.status(400).json({ error: 'email, username, password and code are required' });
      }

      await catsRequest('POST', state.httpBaseUrl, '/api/auth/register', {
        email,
        username,
        password,
        code,
      });
      const login = await catsRequest('POST', state.httpBaseUrl, '/api/auth/login', {
        account: email,
        password,
      });
      persistCatsUserSession(state, login);
      res.json({
        ok: true,
        user: {
          uid: login.uid,
          username: login.username,
          display_name: login.display_name || login.username,
        },
      });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message, data: e.data });
    }
  });

  router.post('/cats/auth/login', async (req, res) => {
    try {
      const state = getCatsAuthState(req.body || {});
      const account = String(req.body?.account || '').trim();
      const password = String(req.body?.password || '');
      if (!account || !password) return res.status(400).json({ error: 'account and password are required' });

      const login = await catsRequest('POST', state.httpBaseUrl, '/api/auth/login', { account, password });
      persistCatsUserSession(state, login);
      res.json({
        ok: true,
        user: {
          uid: login.uid,
          username: login.username,
          display_name: login.display_name || login.username,
        },
      });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message, data: e.data });
    }
  });

  router.post('/cats/auth/logout', (_req, res) => {
    const removed = removeEnvKeys([
      'CATSCO_USER_TOKEN',
      'CATSCO_USER_UID',
      'CATSCO_USER_NAME',
      'CATSCO_USER_DISPLAY_NAME',
      'CATSCOMPANY_USER_TOKEN',
      'CATSCOMPANY_USER_UID',
      'CATSCOMPANY_USER_NAME',
      'CATSCOMPANY_USER_DISPLAY_NAME',
    ]);
    res.json({ ok: true, removed });
  });

  router.post('/cats/setup', async (req, res) => {
    try {
      const state = getCatsAuthState(req.body || {});
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });

      const me = await catsRequest('GET', state.httpBaseUrl, '/api/me', undefined, state.token);
      const userUid = String(me.uid || state.uid || '');
      if (!userUid) return res.status(500).json({ error: 'CatsCo user uid missing' });

      const botsResponse = await catsRequest('GET', state.httpBaseUrl, '/api/bots', undefined, state.token);
      const bots = Array.isArray(botsResponse?.bots) ? botsResponse.bots : [];
      const preferredUsername = String(req.body?.botUsername || `catsco_${userUid}`).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const preferredName = String(req.body?.botDisplayName || 'CatsCo').trim() || 'CatsCo';
      const legacyUsername = `xiaoba_${userUid}`;
      const legacyName = 'XiaoBa';
      let bot = bots.find((item: any) => String(item.id || item.uid) === String(state.botUid || ''))
        || bots.find((item: any) => String(item.username || '') === preferredUsername)
        || bots.find((item: any) => String(item.display_name || '') === preferredName)
        || bots.find((item: any) => String(item.username || '') === legacyUsername)
        || bots.find((item: any) => String(item.display_name || '') === legacyName);

      if (!bot) {
        const created = await catsRequest('POST', state.httpBaseUrl, '/api/bots', {
          username: preferredUsername,
          display_name: preferredName,
        }, state.token);
        bot = {
          id: created.uid,
          uid: created.uid,
          username: created.username || preferredUsername,
          display_name: preferredName,
          api_key: created.api_key,
        };
      }

      const botUid = String(bot.id || bot.uid || '');
      if (!botUid) return res.status(500).json({ error: 'CatsCo bot uid missing' });

      let apiKey = String(bot.api_key || '');
      if (!apiKey) {
        const keyResponse = await catsRequest('GET', state.httpBaseUrl, `/api/bots/api-key?uid=${encodeURIComponent(botUid)}`, undefined, state.token);
        apiKey = String(keyResponse.api_key || '');
      }
      if (!apiKey) return res.status(500).json({ error: 'CatsCo bot api key missing' });

      const warnings: string[] = [];
      try {
        await catsRequest('POST', state.httpBaseUrl, '/api/friends/request', {
          user_id: Number(botUid),
          message: 'Connect CatsCo desktop agent',
        }, state.token);
      } catch (friendRequestError: any) {
        const msg = String(friendRequestError?.message || '');
        if (!/duplicate|already|exists/i.test(msg)) {
          warnings.push(`friend request: ${msg}`);
        }
      }
      try {
        await catsApiKeyRequest('POST', state.httpBaseUrl, '/api/friends/accept', apiKey, {
          user_id: Number(userUid),
        });
      } catch (friendAcceptError: any) {
        const msg = String(friendAcceptError?.message || '');
        if (!/duplicate|already|exists/i.test(msg)) {
          warnings.push(`friend accept: ${msg}`);
        }
      }

      const updated = writeEnvUpdates({
        CATSCOMPANY_HTTP_BASE_URL: state.httpBaseUrl,
        CATSCOMPANY_SERVER_URL: state.serverUrl,
        CATSCOMPANY_USER_TOKEN: state.token,
        CATSCOMPANY_USER_UID: userUid,
        CATSCOMPANY_USER_NAME: me.username || state.username || '',
        CATSCOMPANY_USER_DISPLAY_NAME: me.display_name || me.username || state.displayName || '',
        CATSCOMPANY_BOT_UID: botUid,
        CATSCOMPANY_API_KEY: apiKey,
      });

      let service = serviceManager.getService('catscompany');
      let preflight;
      if (service && service.status !== 'running') {
        preflight = getServicePreflight(serviceManager, 'catscompany', {
          runtimeRoot: process.cwd(),
          config: ConfigManager.getConfigReadonly(),
        });
        if (preflight.status !== 'blocked') {
          service = serviceManager.start('catscompany');
        }
      }

      res.json({
        ok: true,
        updated,
        user: {
          uid: userUid,
          username: me.username || state.username || '',
          display_name: me.display_name || me.username || state.displayName || '',
        },
        bot: {
          uid: botUid,
          username: bot.username || preferredUsername,
          display_name: bot.display_name || preferredName,
        },
        topicId: p2pTopicId(userUid, botUid),
        service,
        preflight,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message, data: e.data });
    }
  });

  router.get('/cats/conversations', async (_req, res) => {
    try {
      const state = getCatsAuthState();
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });
      const data = await catsRequest('GET', state.httpBaseUrl, '/api/conversations', undefined, state.token);
      res.json(data);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message, data: e.data });
    }
  });

  router.get('/cats/messages', async (req, res) => {
    try {
      const state = getCatsAuthState();
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });
      const topic = String(req.query.topic || '').trim();
      if (!topic) return res.status(400).json({ error: 'topic required' });
      const limit = String(req.query.limit || '50');
      const offset = String(req.query.offset || '0');
      const data = await catsRequest('GET', state.httpBaseUrl, `/api/messages?topic_id=${encodeURIComponent(topic)}&limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}&latest=1`, undefined, state.token);
      res.json(data);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message, data: e.data });
    }
  });

  router.post('/cats/messages/send', async (req, res) => {
    try {
      const state = getCatsAuthState();
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });
      const topicId = String(req.body?.topic_id || '').trim();
      const content = String(req.body?.content || '').trim();
      if (!topicId || !content) return res.status(400).json({ error: 'topic_id and content are required' });
      const data = await catsRequest('POST', state.httpBaseUrl, '/api/messages/send', {
        topic_id: topicId,
        type: 'text',
        content,
      }, state.token);
      res.json(data);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message, data: e.data });
    }
  });

  // ==================== 日志和报告 ====================
  // 注释：以下功能需要 report-generator 和 log-uploader 模块，暂时禁用

  /*
  router.post('/logs/upload', async (req, res) => {
    try {
      const { date } = req.body;
      if (!date) return res.status(400).json({ error: 'date required' });

      const serverUrl = process.env.LOG_SERVER_URL;
      const apiKey = process.env.LOG_API_KEY;
      if (!serverUrl || !apiKey) {
        return res.status(500).json({ error: '未配置日志服务器' });
      }

      const uploader = new LogUploader(serverUrl, apiKey);
      await uploader.uploadLogs(path.resolve('logs/sessions'), date);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/reports/daily', (req, res) => {
    try {
      const date = req.query.date as string;
      if (!date) return res.status(400).json({ error: 'date required' });

      const generator = new ReportGenerator();
      const report = generator.generateDailyReport(date);
      res.json(report);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/reports/generate', (req, res) => {
    try {
      const { date, output } = req.body;
      if (!date) return res.status(400).json({ error: 'date required' });

      const generator = new ReportGenerator();
      const report = generator.generateDailyReport(date);

      const outputPath = output || path.resolve(`logs/reports/${date}.json`);
      generator.saveReport(report, outputPath);

      res.json({ ok: true, path: outputPath, report });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
  */

  return router;
}

function sanitizeRuntimeProfileEditResponse<T extends Record<string, any>>(payload: T): T {
  const copy = JSON.parse(JSON.stringify(payload));
  if (copy.profile?.model?.apiUrl) {
    copy.profile.model.apiUrl = sanitizeServerUrl(copy.profile.model.apiUrl);
  }
  if (copy.draft?.profile?.model?.apiUrl) {
    copy.draft.profile.model.apiUrl = sanitizeServerUrl(copy.draft.profile.model.apiUrl);
  }
  if (copy.draft?.profile?.model?.apiKey) {
    delete copy.draft.profile.model.apiKey;
  }
  return copy;
}

function sanitizeServerUrl(serverUrl?: string): string | undefined {
  const raw = (serverUrl || '').trim();
  if (!raw) return undefined;

  try {
    return new URL(raw).origin;
  } catch {
    return '[configured]';
  }
}

// ==================== Helpers ====================

const REMOTE_REGISTRY_URL = 'https://raw.githubusercontent.com/buildsense-ai/XiaoBa-Skill-Hub/main/registry.json';
let remoteRegistryCache: any[] | null = null;
let remoteRegistryCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function loadRegistry(): any[] {
  const registryPath = path.join(process.cwd(), 'skill-registry.json');
  if (!fs.existsSync(registryPath)) return [];
  return JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
}

function fetchRemoteRegistry(): Promise<any[]> {
  return new Promise((resolve) => {
    // Use cache if fresh
    if (remoteRegistryCache && (Date.now() - remoteRegistryCacheTime < CACHE_TTL)) {
      return resolve(remoteRegistryCache);
    }

    const doFetch = (url: string, redirects: number = 0) => {
      if (redirects > 5) return resolve([]);
      const protocol = url.startsWith('https') ? https : http;
      const req = protocol.get(url, { timeout: 8000 }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doFetch(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) { return resolve([]); }
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            remoteRegistryCache = Array.isArray(parsed) ? parsed : [];
            remoteRegistryCacheTime = Date.now();
            resolve(remoteRegistryCache);
          } catch { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
    };
    doFetch(REMOTE_REGISTRY_URL);
  });
}

function mergeRegistries(local: any[], remote: any[]): any[] {
  const map = new Map<string, any>();
  for (const entry of local) map.set(entry.name, entry);
  for (const entry of remote) {
    if (!map.has(entry.name)) map.set(entry.name, entry);
  }
  return Array.from(map.values());
}

/**
 * 从 GitHub 下载 ZIP 并解压到 targetDir，不依赖 git
 * 优先 ZIP 下载，失败则回退 git clone
 */
async function installFromGitHub(repoUrl: string, targetDir: string, warnings: string[]): Promise<boolean> {
  // 解析 GitHub URL → ZIP 下载地址
  // 支持格式: https://github.com/user/repo, https://github.com/user/repo.git
  const zipUrl = githubUrlToZip(repoUrl);

  if (zipUrl) {
    try {
      await downloadAndExtractZip(zipUrl, targetDir);
      return true;
    } catch (e: any) {
      warnings.push(`ZIP 下载失败 (${e.message})，尝试 git clone...`);
    }
  }

  // 回退：git clone
  try {
    execSync(`git clone ${repoUrl} "${targetDir}"`, { timeout: 60000 });
    return true;
  } catch (e: any) {
    warnings.push(`git clone 也失败: ${e.message}`);
    return false;
  }
}

/**
 * 将 GitHub 仓库 URL 转换为 ZIP 下载地址
 */
function githubUrlToZip(url: string): string | null {
  // https://github.com/user/repo(.git) → https://github.com/user/repo/archive/refs/heads/main.zip
  const match = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!match) return null;
  const [, user, repo] = match;
  return `https://github.com/${user}/${repo}/archive/refs/heads/main.zip`;
}

/**
 * 下载 ZIP 并解压到目标目录
 * GitHub ZIP 格式: repo-main/ 下面才是文件，需要提升一层
 */
function downloadAndExtractZip(url: string, targetDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmpZip = path.join(os.tmpdir(), `xiaoba-skill-${Date.now()}.zip`);
    const file = fs.createWriteStream(tmpZip);

    const doRequest = (reqUrl: string, redirectCount: number = 0) => {
      if (redirectCount > 5) {
        fs.unlinkSync(tmpZip);
        return reject(new Error('Too many redirects'));
      }

      const protocol = reqUrl.startsWith('https') ? https : http;
      protocol.get(reqUrl, (response) => {
        // 跟随重定向
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return doRequest(response.headers.location, redirectCount + 1);
        }
        if (response.statusCode !== 200) {
          file.close();
          if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
          // 如果 main 分支不存在，尝试 master
          if (redirectCount === 0 && url.includes('/main.zip')) {
            const masterUrl = url.replace('/main.zip', '/master.zip');
            return doRequest(masterUrl, redirectCount + 1);
          }
          return reject(new Error(`HTTP ${response.statusCode}`));
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            try {
              extractZip(tmpZip, targetDir);
              resolve();
            } catch (e) {
              reject(e);
            } finally {
              if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
            }
          });
        });
      }).on('error', (err) => {
        file.close();
        if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
        reject(err);
      });
    };

    doRequest(url);
  });
}

/**
 * 使用内置工具解压 ZIP：优先 PowerShell（Windows 自带），回退 unzip
 */
function extractZip(zipPath: string, targetDir: string): void {
  const tmpExtract = path.join(os.tmpdir(), `xiaoba-extract-${Date.now()}`);
  fs.mkdirSync(tmpExtract, { recursive: true });

  try {
    if (process.platform === 'win32') {
      // PowerShell Expand-Archive（Windows 自带，无需额外安装）
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpExtract}' -Force"`,
        { timeout: 60000 }
      );
    } else {
      execSync(`unzip -o "${zipPath}" -d "${tmpExtract}"`, { timeout: 60000 });
    }

    // GitHub ZIP 里有一层 repo-branch/ 目录，提升到 targetDir
    const entries = fs.readdirSync(tmpExtract);
    const innerDir = entries.length === 1
      ? path.join(tmpExtract, entries[0])
      : tmpExtract;

    // 如果 innerDir 是单个目录，把里面的内容移出来
    if (fs.statSync(innerDir).isDirectory() && innerDir !== tmpExtract) {
      fs.renameSync(innerDir, targetDir);
    } else {
      fs.renameSync(tmpExtract, targetDir);
    }
  } finally {
    // 清理临时目录
    if (fs.existsSync(tmpExtract)) {
      fs.rmSync(tmpExtract, { recursive: true, force: true });
    }
  }
}

/**
 * 安装 Python 依赖：pip3 → pip → python -m pip 逐个尝试
 */
function installPythonDeps(skillDir: string, warnings: string[]): void {
  const reqFile = path.join(skillDir, 'requirements.txt');
  if (!fs.existsSync(reqFile)) return;

  const pipCommands = ['pip3', 'pip', 'python -m pip', 'python3 -m pip'];
  for (const cmd of pipCommands) {
    try {
      execSync(`${cmd} install -r "${reqFile}"`, { cwd: skillDir, timeout: 120000, stdio: 'pipe' });
      return; // 成功就返回
    } catch {
      // 继续尝试下一个
    }
  }
  warnings.push('Python 依赖安装失败：未找到 pip。请手动运行 pip install -r requirements.txt');
}

function getSkillFiles(skillFilePath: string): string[] {
  try {
    const dir = path.dirname(skillFilePath);
    return fs.readdirSync(dir).filter(e => !e.startsWith('.') && e !== '__pycache__');
  } catch { return []; }
}

function skillToDashboardPayload(skill: Skill): any {
  return {
    name: skill.metadata.name,
    description: skill.metadata.description,
    argumentHint: skill.metadata.argumentHint || null,
    userInvocable: skill.metadata.userInvocable !== false,
    autoInvocable: skill.metadata.autoInvocable !== false,
    maxTurns: skill.metadata.maxTurns || null,
    path: skill.filePath,
    files: getSkillFiles(skill.filePath),
    enabled: true,
    ...getSkillManagementInfo(skill.filePath),
  };
}

function getSkillManagementInfo(skillFilePath: string): SkillManagementInfo {
  const dir = path.dirname(skillFilePath);
  const skillsRoot = PathResolver.getSkillsPath();
  const relative = path.relative(skillsRoot, dir);
  const parts = relative.split(path.sep).filter(Boolean);
  const source: SkillSource = parts.some(part => SYSTEM_SKILL_DIRS.has(part))
    ? 'system'
    : fs.existsSync(path.join(dir, BUNDLED_SKILL_MARKER))
      ? 'bundled'
      : 'user';

  return {
    source,
    protected: source === 'system',
    canDisable: source !== 'system',
    canDelete: source === 'user',
  };
}

function formatSkillDeleteBlockedMessage(management: SkillManagementInfo): string {
  if (management.source === 'system') {
    return '系统 Skill 不能删除。';
  }
  if (management.source === 'bundled') {
    return '内置 Skill 不能删除，可在界面中禁用；这样升级后也不会被自动恢复成启用状态。';
  }
  return '该 Skill 当前不能删除。';
}

function findDisabledSkillByName(basePath: string, name: string): string | null {
  if (!fs.existsSync(basePath)) return null;
  for (const entry of fs.readdirSync(basePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const disabledFile = path.join(basePath, entry.name, 'SKILL.md.disabled');
    if (fs.existsSync(disabledFile)) {
      const content = fs.readFileSync(disabledFile, 'utf-8');
      const m = content.match(/name:\s*(.+)/);
      if (m && m[1].trim() === name) return disabledFile;
    }
    const found = findDisabledSkillByName(path.join(basePath, entry.name), name);
    if (found) return found;
  }
  return null;
}

function findAllDisabledSkills(basePath: string): any[] {
  const results: any[] = [];
  if (!fs.existsSync(basePath)) return results;
  for (const entry of fs.readdirSync(basePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(basePath, entry.name);
    const disabledFile = path.join(fullPath, 'SKILL.md.disabled');
    if (fs.existsSync(disabledFile)) {
      const content = fs.readFileSync(disabledFile, 'utf-8');
      const nm = content.match(/name:\s*(.+)/);
      const desc = content.match(/description:\s*(.+)/);
      const management = getSkillManagementInfo(disabledFile);
      results.push({
        name: nm ? nm[1].trim() : entry.name,
        description: desc ? desc[1].trim() : '',
        enabled: false,
        path: disabledFile,
        files: getSkillFiles(disabledFile),
        ...management,
      });
    }
    results.push(...findAllDisabledSkills(fullPath));
  }
  return results;
}
