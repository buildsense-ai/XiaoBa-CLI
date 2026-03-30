import { Router } from 'express';
import { SkillManager } from '../../skills/skill-manager';
import { ConfigManager } from '../../utils/config';
import { ServiceManager } from '../service-manager';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as https from 'https';
import * as http from 'http';
import { PathResolver } from '../../utils/path-resolver';
import matter from 'gray-matter';
import { execSync } from 'child_process';
// import { ReportGenerator } from '../../utils/report-generator';
// import { LogUploader } from '../../utils/log-uploader';

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

export function createApiRouter(serviceManager: ServiceManager): Router {
  const router = Router();

  // ==================== 总览 ====================

  router.get('/status', (_req, res) => {
    const config = ConfigManager.getConfig();
    const services = serviceManager.getAll();
    res.json({
      version: '0.1.0',
      hostname: os.hostname(),
      platform: os.platform(),
      nodeVersion: process.version,
      model: config.model,
      provider: config.provider,
      skillsPath: PathResolver.getSkillsPath(),
      services,
    });
  });

  // ==================== 服务管理 ====================

  router.get('/services', (_req, res) => {
    res.json(serviceManager.getAll());
  });

  router.post('/services/:name/start', (req, res) => {
    try {
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
      res.json(serviceManager.restart(req.params.name));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/services/:name/logs', (req, res) => {
    const lines = parseInt(req.query.lines as string) || 100;
    res.json(serviceManager.getLogs(req.params.name, lines));
  });

  // ==================== 配置管理 ====================

  router.get('/config', (_req, res) => {
    try {
      const envPath = path.join(process.cwd(), '.env');
      if (!fs.existsSync(envPath)) return res.json({});
      const content = fs.readFileSync(envPath, 'utf-8');
      const parsed = dotenv.parse(content);

      const sensitiveKeys = ['GAUZ_LLM_API_KEY', 'GAUZ_LLM_BACKUP_API_KEY', 'FEISHU_APP_SECRET', 'CATSCOMPANY_API_KEY'];
      const masked = { ...parsed };
      for (const key of sensitiveKeys) {
        if (masked[key] && masked[key].length > 4) {
          masked[key] = '****' + masked[key].slice(-4);
        }
      }
      res.json(masked);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/config', (req, res) => {
    try {
      const envPath = path.join(process.cwd(), '.env');
      const updates: Record<string, string> = req.body;

      let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
      const updatedKeys: string[] = [];

      for (const [key, value] of Object.entries(updates)) {
        if (typeof value === 'string' && value.startsWith('****')) continue;
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(content)) {
          content = content.replace(regex, `${key}=${value}`);
        } else {
          content += `\n${key}=${value}`;
        }
        updatedKeys.push(key);
      }

      fs.writeFileSync(envPath, content);
      res.json({ ok: true, updated: updatedKeys });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== Skills 管理 ====================

  router.get('/skills-all', async (_req, res) => {
    try {
      const manager = new SkillManager();
      await manager.loadSkills();
      const active = manager.getAllSkills().map(s => ({
        name: s.metadata.name,
        description: s.metadata.description,
        argumentHint: s.metadata.argumentHint || null,
        userInvocable: s.metadata.userInvocable !== false,
        autoInvocable: s.metadata.autoInvocable !== false,
        maxTurns: s.metadata.maxTurns || null,
        path: s.filePath,
        files: getSkillFiles(s.filePath),
        enabled: true,
      }));
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
      res.json({
        name: skill.metadata.name,
        description: skill.metadata.description,
        content: skill.content,
        path: skill.filePath,
        files: getSkillFiles(skill.filePath),
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
          fs.rmSync(path.dirname(disabled), { recursive: true, force: true });
          return res.json({ ok: true });
        }
        return res.status(404).json({ error: 'Skill not found' });
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
      const installed = new Set(manager.getAllSkills().map(s => s.metadata.name));
      // 也算上disabled的
      const disabled = findAllDisabledSkills(PathResolver.getSkillsPath());
      disabled.forEach(s => installed.add(s.name));

      const available = registry.map(entry => ({
        ...entry,
        installed: installed.has(entry.name),
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
      results.push({
        name: nm ? nm[1].trim() : entry.name,
        description: desc ? desc[1].trim() : '',
        enabled: false,
        path: disabledFile,
        files: getSkillFiles(disabledFile),
      });
    }
    results.push(...findAllDisabledSkills(fullPath));
  }
  return results;
}
