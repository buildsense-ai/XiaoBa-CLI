import { Router } from 'express';
import { SkillManager } from '../../skills/skill-manager';
import { ConfigManager } from '../../utils/config';
import { ServiceManager } from '../service-manager';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { PathResolver } from '../../utils/path-resolver';
import matter from 'gray-matter';

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

  // GET /api/store - 可安装的skills（registry中未安装的）
  router.get('/store', async (_req, res) => {
    try {
      const registry = loadRegistry();
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

      if (fs.existsSync(targetDir)) {
        return res.status(400).json({ error: `Skill "${name}" 已存在` });
      }

      if (repo === 'local') {
        // 本地registry的skill，从仓库自带的skills目录复制（已经在了就跳过）
        // 实际上local的skill已经在skills/目录里了，不需要安装
        return res.json({ ok: true, message: 'Skill already bundled' });
      }

      // 从GitHub安装
      const { execSync } = require('child_process');
      PathResolver.ensureDir(skillsPath);
      execSync(`git clone ${repo} "${targetDir}"`, { cwd: skillsPath, timeout: 60000 });

      // 检查python依赖
      const reqFile = path.join(targetDir, 'requirements.txt');
      if (fs.existsSync(reqFile)) {
        try {
          execSync(`pip3 install -r "${reqFile}"`, { cwd: targetDir, timeout: 120000 });
        } catch (pipErr: any) {
          // pip失败不阻塞，记录warning
        }
      }

      // 检查npm依赖
      installSkillNpmDeps(targetDir);

      res.json({ ok: true });
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

      if (fs.existsSync(targetDir)) {
        return res.status(400).json({ error: `目录 "${repoName}" 已存在` });
      }

      const { execSync } = require('child_process');
      PathResolver.ensureDir(skillsPath);
      execSync(`git clone ${url} "${targetDir}"`, { cwd: skillsPath, timeout: 60000 });

      // 检查python依赖
      const reqFile = path.join(targetDir, 'requirements.txt');
      if (fs.existsSync(reqFile)) {
        try {
          execSync(`pip3 install -r "${reqFile}"`, { cwd: targetDir, timeout: 120000 });
        } catch (pipErr: any) {
          // pip失败不阻塞
        }
      }

      // 检查npm依赖
      installSkillNpmDeps(targetDir);

      res.json({ ok: true, name: repoName });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

// ==================== Helpers ====================

function loadRegistry(): any[] {
  const registryPath = path.join(process.cwd(), 'skill-registry.json');
  if (!fs.existsSync(registryPath)) return [];
  return JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
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
