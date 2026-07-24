import { Skill } from '../types/skill';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultDistilledOutputDir, PathResolver } from '../utils/path-resolver';
import { SkillParser } from './skill-parser';
import { Logger } from '../utils/logger';
import {
  loadCurrentSkillRegistry,
  reconcileActiveGeneratedSkillArtifacts,
  saveCurrentSkillRegistry,
  CurrentSkillRegistryState,
} from '../utils/skill-evolution';

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
        if (!fs.existsSync(record.skillFilePath)) {
          throw new Error(
            `active generated skill artifact is missing for ${handle}: ${record.skillFilePath}`,
          );
        }
        const loaded = SkillParser.parse(record.skillFilePath);
        if (loaded.metadata.name !== record.routingName) {
          throw new Error(
            `active generated skill route mismatch for ${handle}: file=${loaded.metadata.name} registry=${record.routingName}`,
          );
        }
        this.skills.set(loaded.metadata.name, loaded);
      } catch (error: any) {
        // Fail closed: do not silently drop an active registry route.
        throw new Error(
          `Active generated skill is unusable for redirect ${requestedName} → ${handle}: ${error.message}`,
        );
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
    // This API is intentionally synchronous because it is used by prompt
    // construction, command discovery, and dashboard snapshots. Reconcile
    // the durable Registry here so those callers do not keep exposing a
    // retired generated route until the next async resolveSkill call.
    this.refreshCatalogSynchronously();
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
      this.registry = this.loadAndEnforceActiveSkillInvariants();
      this.catalogRevision = this.registry.catalogRevision;
      this.registryLoadFailed = false;
    } catch (error: any) {
      this.registry = undefined;
      this.registryLoadFailed = true;
      Logger.warning(`Failed to load generated skill Registry: ${error.message}`);
    }
  }

  private loadAndEnforceActiveSkillInvariants(): CurrentSkillRegistryState {
    const registryPath = PathResolver.getSkillEvolutionRegistryPath();
    const loaded = loadCurrentSkillRegistry(registryPath);
    // Fail closed / restore from authoritative history only. Never invent guidance.
    const reconciled = reconcileActiveGeneratedSkillArtifacts(
      loaded,
      defaultDistilledOutputDir(PathResolver.getSkillsPath()),
    );
    if (reconciled.repaired) {
      try {
        // Persist restored paths only after successful artifact recovery.
        saveCurrentSkillRegistry(registryPath, reconciled.state);
      } catch (error: any) {
        Logger.warning(`Failed to persist repaired generated skill Registry: ${error.message}`);
      }
    }
    return reconciled.state;
  }

  private async refreshCatalogIfChanged(): Promise<void> {
    let latest: CurrentSkillRegistryState;
    try {
      latest = this.loadAndEnforceActiveSkillInvariants();
    } catch (error: any) {
      Logger.warning(`Failed to refresh generated skill Registry: ${error.message}`);
      this.registry = undefined;
      this.registryLoadFailed = true;
      this.removeGeneratedSkills();
      return;
    }
    if (!this.registryLoadFailed && latest.catalogRevision === this.catalogRevision) {
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
   * Synchronous counterpart used by discovery/listing consumers. The
   * Registry's catalogRevision is the durable invalidation token; when it
   * changes, keep manual filesystem skills and replace only generated
   * entries with the active Registry-referenced files.
   */
  private refreshCatalogSynchronously(): void {
    let latest: CurrentSkillRegistryState;
    try {
      latest = this.loadAndEnforceActiveSkillInvariants();
    } catch (error: any) {
      Logger.warning(`Failed to refresh generated skill Registry: ${error.message}`);
      this.registry = undefined;
      this.registryLoadFailed = true;
      this.removeGeneratedSkills();
      return;
    }

    if (!this.registryLoadFailed && latest.catalogRevision === this.catalogRevision) {
      this.registry = latest;
      return;
    }

    this.registry = latest;
    this.catalogRevision = latest.catalogRevision;
    this.registryLoadFailed = false;
    this.removeGeneratedSkills();

    for (const record of Object.values(latest.capabilities)) {
      if (!isGeneratedSkillPath(record.skillFilePath)) continue;
      try {
        if (!fs.existsSync(record.skillFilePath)) {
          throw new Error(`SKILL.md missing at ${record.skillFilePath}`);
        }
        const skill = SkillParser.parse(record.skillFilePath);
        // A stale or manually edited generated file must not reintroduce an
        // old public route. Only the route named by the current Registry is
        // admitted synchronously.
        if (skill.metadata.name !== record.routingName) {
          throw new Error(
            `Generated skill route does not match Registry: file=${skill.metadata.name} registry=${record.routingName}`,
          );
        }
        this.skills.set(skill.metadata.name, skill);
      } catch (error: any) {
        // Fail closed with an actionable diagnostic. Do not silently omit an
        // active Registry capability from discovery.
        Logger.error(
          `Active generated skill invariant failed for ${record.handle}: ${error.message}`,
        );
        throw error;
      }
    }
  }

  /**
   * Generated output is registry-owned. Only an active file referenced by a
   * capability is discoverable; an empty Registry admits no generated files.
   * Manual skills remain filesystem-discovered and are never filtered here.
   */
  private shouldDiscoverSkill(filePath: string): boolean {
    if (!isGeneratedSkillPath(filePath)) return true;
    if (this.registryLoadFailed) return false;
    const records = Object.values(this.registry?.capabilities ?? {});
    if (records.length === 0) return false;
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
