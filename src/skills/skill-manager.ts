import { Skill } from '../types/skill';
import * as path from 'node:path';
import { PathResolver } from '../utils/path-resolver';
import { SkillParser } from './skill-parser';
import { Logger } from '../utils/logger';
import { loadCurrentSkillRegistry, CurrentSkillRegistryState } from '../utils/skill-evolution';

export interface SkillResolution {
  skill: Skill;
  requestedName: string;
  resolvedName: string;
  redirected: boolean;
}

export class StaleSkillRedirectError extends Error {
  readonly code = 'STALE_SKILL_REDIRECT';

  constructor(public readonly requestedName: string, public readonly capabilityHandle: string) {
    super(`Skill route "${requestedName}" points to stale Capability Handle "${capabilityHandle}".`);
    this.name = 'StaleSkillRedirectError';
  }
}

/**
 * Skills 管理器
 */
export class SkillManager {
  private skills: Map<string, Skill>;
  private skillsPath: string;
  private catalogRevision = -1;
  private registry?: CurrentSkillRegistryState;
  /** Invalid durable Registry state must never widen generated discovery. */
  private registryLoadFailed = false;

  constructor() {
    this.skills = new Map();
    this.skillsPath = PathResolver.getSkillsPath();
  }

  /**
   * 加载所有 skills（只从统一目录加载）
   */
  async loadSkills(): Promise<void> {
    this.skills.clear();

    const skillsPath = PathResolver.getSkillsPath();
    // Load the Registry before walking generated output so discovery can
    // treat it as the source of truth for active generated capabilities.
    this.refreshRegistrySnapshot();

    // 从统一的 skills 目录加载
    await this.loadSkillsFromPath(skillsPath);
  }

  /**
   * 从指定路径加载 skills
   */
  private async loadSkillsFromPath(basePath: string): Promise<void> {
    try {
      const skillFiles = PathResolver.findSkillFiles(basePath);

      for (const filePath of skillFiles) {
        try {
          const skill = SkillParser.parse(filePath);
          if (!this.shouldDiscoverSkill(filePath)) continue;
          this.skills.set(skill.metadata.name, skill);
        } catch (error: any) {
          Logger.warning(`Failed to load skill from ${filePath}: ${error.message}`);
        }
      }
    } catch (error: any) {
      // 目录不存在或无法访问，静默处理
    }
  }

  /**
   * 根据名称获取 skill
   */
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** Resolve an active route, following one durable generated-skill redirect when needed. */
  async resolveSkill(name: string): Promise<SkillResolution | undefined> {
    const requestedName = name.trim();
    await this.refreshCatalogIfChanged();
    const exact = this.skills.get(requestedName);
    if (exact) return { skill: exact, requestedName, resolvedName: exact.metadata.name, redirected: false };

    const registry = this.registry;
    const handle = registry?.routeRedirects[requestedName];
    if (!handle) return undefined;
    const record = registry.capabilities[handle];
    if (!record) throw new StaleSkillRedirectError(requestedName, handle);

    const resolved = this.skills.get(record.routingName);
    if (!resolved) {
      try {
        const loaded = SkillParser.parse(record.skillFilePath);
        this.skills.set(loaded.metadata.name, loaded);
      } catch {
        throw new StaleSkillRedirectError(requestedName, handle);
      }
    }
    const skill = this.skills.get(record.routingName);
    if (!skill) throw new StaleSkillRedirectError(requestedName, handle);
    return { skill, requestedName, resolvedName: skill.metadata.name, redirected: true };
  }

  /**
   * 获取所有可用的 skills
   */
  getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * 获取用户可调用的 skills
   */
  getUserInvocableSkills(): Skill[] {
    return this.getAllSkills().filter(skill => skill.metadata.userInvocable !== false);
  }

  /**
   * 重新加载 skills
   */
  async reload(): Promise<void> {
    await this.loadSkills();
  }

  private refreshRegistrySnapshot(): void {
    try {
      this.registry = loadCurrentSkillRegistry(PathResolver.getSkillEvolutionRegistryPath());
      this.catalogRevision = this.registry.catalogRevision;
      this.registryLoadFailed = false;
    } catch (error: any) {
      this.registry = undefined;
      this.registryLoadFailed = true;
      Logger.warning(`Failed to load generated skill Registry: ${error.message}`);
    }
  }

  private async refreshCatalogIfChanged(): Promise<void> {
    let latest: CurrentSkillRegistryState;
    try {
      latest = loadCurrentSkillRegistry(PathResolver.getSkillEvolutionRegistryPath());
    } catch (error: any) {
      Logger.warning(`Failed to refresh generated skill Registry: ${error.message}`);
      this.registry = undefined;
      this.registryLoadFailed = true;
      this.removeGeneratedSkills();
      return;
    }
    if (latest.catalogRevision === this.catalogRevision) {
      this.registry = latest;
      return;
    }
    this.skills.clear();
    this.registry = latest;
    this.catalogRevision = latest.catalogRevision;
    this.registryLoadFailed = false;
    await this.loadSkillsFromPath(this.skillsPath);
  }

  /**
   * Generated output is registry-owned. Once a non-empty Registry exists,
   * only the active file referenced by a capability is discoverable; stale
   * retired/orphaned files must not become a second public Skill route.
   * Manual skills remain filesystem-discovered and are never filtered here.
   */
  private shouldDiscoverSkill(filePath: string): boolean {
    if (!isGeneratedSkillPath(filePath)) return true;
    if (this.registryLoadFailed) return false;
    const records = Object.values(this.registry?.capabilities ?? {});
    if (records.length === 0) return true;
    const resolvedPath = path.resolve(filePath);
    return records.some(record => path.resolve(record.skillFilePath) === resolvedPath);
  }

  private removeGeneratedSkills(): void {
    for (const [name, skill] of this.skills.entries()) {
      if (isGeneratedSkillPath(skill.filePath)) this.skills.delete(name);
    }
  }

}

function isGeneratedSkillPath(filePath: string): boolean {
  return filePath.split(/[\\/]+/).includes('generated-distilled');
}
