import * as fs from 'fs';
import * as path from 'path';
import { APP_VERSION } from '../version';
import { PathResolver } from '../utils/path-resolver';
import { SkillHubClient } from './client';
import { installVerifiedSkillHubPackage } from './package-installer';
import { verifySkillHubPackage } from './package-verifier';
import { CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS } from './trusted-keys';
import type {
  SkillHubAuthState,
  SkillHubInstallResult,
  SkillHubPackageInstallMarker,
  SkillHubRegistryEntry,
  SkillHubSearchResponse,
} from './types';

export class SkillHubService {
  private readonly client: SkillHubClient;

  constructor(options: { baseUrl?: string } = {}) {
    this.client = new SkillHubClient(options);
  }

  async status(): Promise<SkillHubAuthState & { trustReady: boolean; installed: SkillHubPackageInstallMarker[] }> {
    const status = await this.client.status();
    return {
      ...status,
      trustReady: CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS.length > 0,
      installed: listInstalledSkillHubSkills(),
    };
  }

  register(input: { email: string; password: string; displayName?: string }): Promise<SkillHubAuthState> {
    return this.client.register({
      email: input.email,
      password: input.password,
      displayName: input.displayName || input.email,
    });
  }

  login(input: { email: string; password: string }): Promise<SkillHubAuthState> {
    return this.client.login(input);
  }

  logout(): Promise<{ ok: true }> {
    return this.client.logout();
  }

  async search(query = '', options: { category?: string } = {}): Promise<SkillHubSearchResponse & { installed: SkillHubPackageInstallMarker[] }> {
    const response = await this.client.searchSkills(query, {
      category: options.category,
      agentVersion: APP_VERSION,
      platform: process.platform,
    });
    return {
      ...response,
      installed: listInstalledSkillHubSkills(),
    };
  }

  async install(skillId: string, version?: string): Promise<SkillHubInstallResult> {
    const registryEntry = await this.resolveRegistryEntry(skillId, version);
    const [trust, packageBytes] = await Promise.all([
      this.client.getTrust(),
      this.client.downloadPackage(registryEntry),
    ]);
    const verification = verifySkillHubPackage({
      packageBytes,
      registryEntry,
      trust,
    });
    const installed = installVerifiedSkillHubPackage({
      verification,
      registryEntry,
    });
    return {
      ok: true,
      skill: installed,
      signingKeyId: verification.signingKey.keyId,
      rootKeyId: verification.root.keyId,
    };
  }

  developerDashboard(): Promise<any> {
    return this.client.getDeveloperDashboard();
  }

  applyDeveloper(input: any): Promise<any> {
    return this.client.applyDeveloper({
      displayName: String(input.displayName || '').trim(),
      homepageUrl: String(input.homepageUrl || '').trim(),
      reason: String(input.reason || '').trim(),
    });
  }

  async createManifestDraft(input: any): Promise<any> {
    const files = input.localPath ? collectSkillSourceFiles(String(input.localPath)) : [];
    return this.client.createManifestDraft({
      form: normalizeDeveloperForm(input),
      source: files.length ? { type: 'files', files } : undefined,
    });
  }

  async createSubmission(input: any): Promise<any> {
    const files = collectSkillSourceFiles(String(input.localPath || ''));
    if (!files.length) {
      const error: any = new Error('提交审核需要选择一个包含 SKILL.md 的本地 Skill 文件夹。');
      error.status = 400;
      throw error;
    }
    return this.client.createSubmission({
      manifest: input.manifest || normalizeDeveloperForm(input),
      notes: String(input.notes || ''),
      source: {
        type: 'files',
        files,
      },
    });
  }

  private async resolveRegistryEntry(skillId: string, version?: string): Promise<SkillHubRegistryEntry> {
    if (version) {
      const detail = await this.client.getVersion(skillId, version);
      if (detail.version) return detail.version;
    } else {
      const detail = await this.client.getSkill(skillId);
      if (detail.skill) return detail.skill;
      if (detail.version) return detail.version;
    }
    const error: any = new Error('SkillHub 未找到这个 Skill 版本。');
    error.status = 404;
    throw error;
  }
}

const SOURCE_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'release',
  '__pycache__',
  '.venv',
  'venv',
]);
const MAX_SOURCE_FILES = 200;
const MAX_SOURCE_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_SINGLE_FILE_BYTES = 2 * 1024 * 1024;

function collectSkillSourceFiles(localPath: string): Array<{ path: string; contentBase64: string }> {
  const root = path.resolve(String(localPath || '').trim());
  if (!root || !fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  const baseDir = stat.isDirectory() ? root : path.dirname(root);
  const files = stat.isDirectory() ? walk(baseDir) : [root];
  let total = 0;
  const result: Array<{ path: string; contentBase64: string }> = [];

  for (const filePath of files) {
    if (result.length >= MAX_SOURCE_FILES) break;
    const fileStat = fs.statSync(filePath);
    if (!fileStat.isFile() || fileStat.size > MAX_SOURCE_SINGLE_FILE_BYTES) continue;
    total += fileStat.size;
    if (total > MAX_SOURCE_TOTAL_BYTES) break;
    const relative = path.relative(baseDir, filePath).replace(/\\/g, '/');
    if (!isSafePackagePath(relative)) continue;
    result.push({
      path: relative,
      contentBase64: fs.readFileSync(filePath).toString('base64'),
    });
  }

  return result;
}

function walk(dir: string): string[] {
  const result: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (result.length >= MAX_SOURCE_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SOURCE_SKIP_DIRS.has(entry.name)) visit(fullPath);
      } else if (entry.isFile()) {
        result.push(fullPath);
      }
    }
  };
  visit(dir);
  return result;
}

function isSafePackagePath(packagePath: string): boolean {
  if (!packagePath || packagePath.includes('\0') || packagePath.includes('\\') || packagePath.startsWith('/') || /^[a-zA-Z]:/.test(packagePath)) return false;
  return !packagePath.split('/').some(part => part === '' || part === '.' || part === '..');
}

function normalizeDeveloperForm(input: any): any {
  const permissions = normalizePermissions(input.permissions);
  return {
    id: stringOrUndefined(input.id),
    name: stringOrUndefined(input.name),
    displayName: stringOrUndefined(input.displayName || input.title || input.name),
    version: stringOrUndefined(input.version),
    description: stringOrUndefined(input.description),
    categories: splitList(input.categories || input.category),
    tags: splitList(input.tags),
    keywords: splitList(input.keywords),
    triggerExamples: splitList(input.triggerExamples),
    authorName: stringOrUndefined(input.authorName),
    homepageUrl: stringOrUndefined(input.homepageUrl),
    repositoryUrl: stringOrUndefined(input.repositoryUrl || input.githubUrl),
    license: stringOrUndefined(input.license),
    permissions,
    runtime: {
      minAgentVersion: stringOrUndefined(input.minAgentVersion),
      platforms: splitList(input.platforms).length ? splitList(input.platforms) : undefined,
    },
    entrypoints: {
      skillFile: stringOrUndefined(input.skillFile || input.entry) || 'SKILL.md',
    },
  };
}

function normalizePermissions(input: any): any {
  if (typeof input === 'object' && input) return input;
  const values = splitList(input);
  return {
    filesystem: values.includes('filesystem.write.workspace')
      ? 'workspace'
      : values.includes('filesystem.read.user_selected')
        ? 'user_selected'
        : 'none',
    network: values.some(value => value.startsWith('network.')) ? 'domain_allowlist' : 'none',
    shell: values.some(value => value.startsWith('shell.')) ? 'specific_commands' : 'none',
    secrets: values.some(value => value.startsWith('secrets.')) ? 'user_selected' : 'none',
  };
}

function splitList(value: any): string[] {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  return String(value || '').split(/[,\n，、;；]+/).map(item => item.trim()).filter(Boolean);
}

function stringOrUndefined(value: any): string | undefined {
  const text = String(value || '').trim();
  return text || undefined;
}

function listInstalledSkillHubSkills(): SkillHubPackageInstallMarker[] {
  const skillsRoot = PathResolver.getSkillsPath();
  if (!fs.existsSync(skillsRoot)) return [];
  const result: SkillHubPackageInstallMarker[] = [];
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const markerPath = path.join(skillsRoot, entry.name, '.xiaoba-skillhub-install.json');
    if (!fs.existsSync(markerPath)) continue;
    try {
      result.push(JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as SkillHubPackageInstallMarker);
    } catch {
      // Ignore invalid markers so one broken install does not break the Skills page.
    }
  }
  return result;
}
