import * as fs from 'fs';
import * as path from 'path';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { SkillParser } from '../skills/skill-parser';
import type { Skill } from '../types/skill';
import { PathResolver } from '../utils/path-resolver';
import { SkillHubClient } from './client';
import {
  writeSkillHubLocalMetadata,
} from './local-skill-metadata';
import {
  claimSkillHubPackageOwnership,
  installVerifiedSkillHubPackage,
  uninstallSkillHubPackage,
} from './package-installer';
import { listInstalledSkillHubSkills } from './install-marker';
import { verifySkillHubPackage } from './package-verifier';
import { CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS } from './trusted-keys';
import type {
  SkillHubAuthState,
  SkillHubInstallResult,
  SkillHubPackageInstallMarker,
  SkillHubRegistryEntry,
  SkillHubSearchResponse,
  SkillHubSubscriptionScope,
  SkillHubUser,
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
    return this.client.login({
      email: input.email,
      password: input.password,
    });
  }

  loginWithCatsCo(input: {
    token: string;
    baseUrl: string;
    user?: { uid?: string; username?: string; displayName?: string };
  }): Promise<SkillHubAuthState> {
    const token = String(input.token || '').trim();
    const baseUrl = String(input.baseUrl || '').trim();
    if (!token || !baseUrl) {
      const error: any = new Error('CatsCo login is required before connecting SkillHub.');
      error.status = 401;
      error.code = 'skillhub.catsco_login_required';
      throw error;
    }
    return this.client.loginWithCatsCo({
      token,
      baseUrl,
      user: input.user,
    });
  }

  async requireAuthenticatedUser(): Promise<SkillHubUser> {
    let auth = await this.client.status();
    if (!auth.authenticated || !String(auth.user?.id || '').trim()) {
      const cats = createCatsCoLocalConfigService({
        runtimeRoot: PathResolver.getRuntimeDataRoot(),
      }).getAuthState();
      if (!cats.token) throw skillHubLoginRequired();
      auth = await this.loginWithCatsCo({
        token: cats.token,
        baseUrl: cats.httpBaseUrl,
        user: {
          uid: cats.uid,
          username: cats.username,
          displayName: cats.displayName,
        },
      });
    }
    const user = auth.user;
    const userId = String(user?.id || '').trim();
    if (!auth.authenticated || !user || !userId) {
      throw skillHubLoginRequired();
    }
    return { ...user, id: userId };
  }

  async resolveSubscriptionScope(): Promise<SkillHubSubscriptionScope> {
    const cats = createCatsCoLocalConfigService({
      runtimeRoot: PathResolver.getRuntimeDataRoot(),
    }).getAuthState();
    if (!String(cats.token || '').trim() && String(cats.apiKey || '').trim()) {
      return { kind: 'runtime' };
    }
    const user = await this.requireAuthenticatedUser();
    return { kind: 'user', userId: user.id };
  }

  logout(): Promise<{ ok: true }> {
    return this.client.logout();
  }

  async search(query = '', options: { category?: string } = {}): Promise<SkillHubSearchResponse & { installed: SkillHubPackageInstallMarker[] }> {
    const response = await this.client.searchSkills(query, {
      category: options.category,
    });
    return {
      ...response,
      installed: listInstalledSkillHubSkills(),
    };
  }

  async versions(skillId: string): Promise<any> {
    return this.client.getSkill(skillId);
  }

  async install(
    skillId: string,
    version?: string,
    options: { userId?: string; allowUpdate?: boolean } = {},
  ): Promise<SkillHubInstallResult> {
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
      userId: options.userId,
      allowUpdate: options.allowUpdate,
    });
    return {
      ok: true,
      skill: installed,
      signingKeyId: verification.signingKey.keyId,
      rootKeyId: verification.root.keyId,
    };
  }

  uninstall(input: { userId?: string; skillId: string; installName: string }): { removed: boolean; path: string } {
    return uninstallSkillHubPackage(input);
  }

  claimInstalledSkillOwnership(input: { userId: string; skillId: string; installName: string }): boolean {
    return claimSkillHubPackageOwnership(input);
  }

  developerDashboard(): Promise<any> {
    return this.client.getDeveloperDashboard();
  }

  applyDeveloper(input: any): Promise<any> {
    const namespace = String(input.namespace || '').trim();
    const contact = String(input.contact || '').trim();
    if (!namespace) {
      const error: any = new Error('申请开发者需要填写命名空间。');
      error.status = 400;
      throw error;
    }
    if (!contact) {
      const error: any = new Error('申请开发者需要填写联系方式。');
      error.status = 400;
      throw error;
    }
    return this.client.applyDeveloper({
      namespace,
      displayName: String(input.displayName || '').trim(),
      contact,
      websiteUrl: String(input.websiteUrl || input.homepageUrl || '').trim(),
      reason: String(input.reason || '').trim(),
    });
  }

  yankOwnPackageVersion(packageVersionId: string, reason = ''): Promise<any> {
    return this.client.yankOwnPackageVersion(packageVersionId, reason);
  }

  restoreOwnPackageVersion(packageVersionId: string): Promise<any> {
    return this.client.restoreOwnPackageVersion(packageVersionId);
  }

  deleteOwnPackageVersion(packageVersionId: string): Promise<any> {
    return this.client.deleteOwnPackageVersion(packageVersionId);
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

  async shareLocalSkill(input: any): Promise<any> {
    const skillName = String(input.skillName || input.skill || input.name || '').trim();
    if (!skillName) {
      const error: any = new Error('skillName required');
      error.status = 400;
      error.code = 'skillhub.skill_name_required';
      throw error;
    }

    const localSkill = findLocalShareableSkill(skillName);
    if (!localSkill) {
      const available = listLocalSkillNames().join(', ');
      const error: any = new Error(`Local skill not found: ${skillName}${available ? `. Available skills: ${available}` : ''}`);
      error.status = 404;
      error.code = 'skillhub.local_skill_not_found';
      throw error;
    }

    const { skill } = localSkill;
    const localPath = path.dirname(skill.filePath);
    const files = collectSkillSourceFiles(localPath);
    if (!files.length) {
      const error: any = new Error('Local skill package has no shareable files.');
      error.status = 400;
      error.code = 'skillhub.local_skill_empty';
      throw error;
    }
    const submission = await this.client.quickShare({
      manifest: {
        id: skill.metadata.name,
        name: skill.metadata.name,
        displayName: skill.metadata.name,
        version: '1.0.0',
        description: skill.metadata.description,
        keywords: [skill.metadata.name, ...splitWords(skill.metadata.description)].slice(0, 8),
        triggerExamples: skill.metadata.argumentHint ? [`/${skill.metadata.name} ${skill.metadata.argumentHint}`] : [`/${skill.metadata.name}`],
        minAgentVersion: '0.0.0',
        platforms: [],
      },
      notes: String(input.notes || 'Quick shared from local XiaoBa Skills.'),
      confirmVersionPublish: input.confirmVersionPublish === true || input.confirmPublish === true,
      source: {
        type: 'files',
        files,
      },
    });
    const skillHubMetadata = skillHubMetadataFromShareResponse(submission);
    if (skillHubMetadata) {
      writeSkillHubLocalMetadata(skill.filePath, skillHubMetadata);
    }

    return {
      ok: true,
      skill: {
        id: submission?.skill?.skillId || submission?.upload?.skillId || submission?.submission?.normalizedManifest?.id || skill.metadata.name,
        name: skill.metadata.name,
        description: skill.metadata.description,
        path: localPath,
      },
      submission: submission?.submission || submission,
      existing: submission?.existing,
      requiresConfirmation: submission?.requiresConfirmation,
      latestVersion: submission?.latestVersion,
      contentHash: submission?.contentHash,
    };
  }

  async getPublishedVersion(skillId: string, version: string): Promise<SkillHubRegistryEntry | undefined> {
    const detail = await this.client.getVersion(skillId, version);
    return normalizeRegistryEntryVersion(detail.version || detail.skill, version);
  }

  private async resolveRegistryEntry(skillId: string, version?: string): Promise<SkillHubRegistryEntry> {
    if (version) {
      const detail = await this.client.getVersion(skillId, version);
      const entry = normalizeRegistryEntryVersion(detail.version || detail.skill, version);
      if (entry) return assertRegistryEntryMatchesRequest(entry, skillId, version);
    } else {
      const detail = await this.client.getSkill(skillId);
      if (detail.skill) return assertRegistryEntryMatchesRequest(detail.skill, skillId);
      if (detail.version) return assertRegistryEntryMatchesRequest(detail.version, skillId);
    }
    const error: any = new Error('SkillHub 未找到这个 Skill 版本。');
    error.status = 404;
    throw error;
  }
}

function assertRegistryEntryMatchesRequest(
  entry: SkillHubRegistryEntry,
  requestedSkillId: string,
  requestedVersion?: string,
): SkillHubRegistryEntry {
  const actualSkillId = String(entry.skillId || '').trim();
  const expectedSkillId = String(requestedSkillId || '').trim();
  const actualVersion = String(entry.latestVersion || (entry as any).version || '').trim();
  const expectedVersion = String(requestedVersion || '').trim();
  if (actualSkillId !== expectedSkillId || (expectedVersion && actualVersion !== expectedVersion)) {
    const error: any = new Error('SkillHub 返回的 Skill 版本与请求不一致，已停止安装。');
    error.status = 409;
    error.code = 'skillhub.registry_entry_mismatch';
    throw error;
  }
  return entry;
}

function normalizeRegistryEntryVersion(entry: SkillHubRegistryEntry | undefined, requestedVersion?: string): SkillHubRegistryEntry | undefined {
  if (!entry) return undefined;
  const version = String(entry.latestVersion || (entry as any).version || requestedVersion || '').trim();
  return {
    ...entry,
    latestVersion: version,
  };
}

const SOURCE_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
]);
const SOURCE_SKIP_FILES = new Set([
  'skill.json',
  'REVIEW.json',
  'SBOM.json',
  '.xiaoba-bundled-skill.json',
  '.xiaoba-skillhub-install.json',
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
      } else if (entry.isFile() && !SOURCE_SKIP_FILES.has(entry.name)) {
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

function splitWords(text: string): string[] {
  return String(text || '')
    .split(/[\s,，。；;、/|]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
}

function findLocalShareableSkill(skillName: string): { skill: Skill } | undefined {
  for (const skillFile of listLocalSkillFiles()) {
    try {
      const skill = SkillParser.parse(skillFile);
      const dirName = path.basename(path.dirname(skillFile));
      if (skill.metadata.name === skillName || dirName === skillName) {
        return { skill };
      }
    } catch {
      // Ignore broken local skills so one bad folder does not block sharing others.
    }
  }
  return undefined;
}

function listLocalSkillNames(): string[] {
  const names: string[] = [];
  for (const skillFile of listLocalSkillFiles()) {
    try {
      const skill = SkillParser.parse(skillFile);
      names.push(skill.metadata.name);
    } catch {
      names.push(path.basename(path.dirname(skillFile)));
    }
  }
  return Array.from(new Set(names)).sort();
}

function listLocalSkillFiles(): string[] {
  const roots = [PathResolver.getSkillsPath()];
  const files: string[] = [];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    files.push(...PathResolver.findSkillFiles(root));
  }
  return Array.from(new Set(files));
}

function findSkillRoot(skillFilePath: string): string | undefined {
  return [PathResolver.getSkillsPath()].find(root => {
    const relative = path.relative(path.resolve(root), path.resolve(skillFilePath));
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

function skillHubMetadataFromShareResponse(response: any): { author: string; version: string; uploadedAt: string } | undefined {
  const metadata = response?.skillHub || response?.submission?.skillHub || response?.submission?.normalizedManifest?.skillHub;
  const author = String(metadata?.author || '').trim();
  const version = String(metadata?.version || response?.latestVersion || response?.packageVersion?.latestVersion || '').trim();
  const uploadedAt = String(metadata?.uploadedAt || metadata?.uploaded_at || response?.submission?.normalizedManifest?.skillhub_uploaded_at || '').trim();
  if (author && version && uploadedAt) {
    return { author, version, uploadedAt };
  }
  return undefined;
}

function skillHubLoginRequired(): Error {
  const error: any = new Error('请先登录 CatsCo 并连接 SkillHub。');
  error.status = 401;
  error.code = 'skillhub.login_required';
  return error;
}
