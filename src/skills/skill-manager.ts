import * as fs from 'fs';
import { Skill } from '../types/skill';
import { PathResolver } from '../utils/path-resolver';
import { SkillParser } from './skill-parser';
import { Logger } from '../utils/logger';

/**
 * Skills 管理器
 */
export class SkillManager {
  private skills: Map<string, Skill>;
  private readonly fixedSkillsPath?: string;

  constructor(skillsPath?: string) {
    this.skills = new Map();
    this.fixedSkillsPath = skillsPath;
  }

  /**
   * 加载所有 skills（只从统一目录加载）
   */
  async loadSkills(): Promise<void> {
    const skillsPath = this.fixedSkillsPath ?? PathResolver.getSkillsPath();

    // 从统一的 skills 目录加载
    const nextSkills = await this.loadSkillsFromPath(skillsPath);
    if (nextSkills) {
      // Readers keep seeing the previous complete snapshot while files are
      // enumerated and parsed. Publish the new snapshot in one assignment.
      this.skills = nextSkills;
    }
  }

  /**
   * 从指定路径加载 skills
   */
  private async loadSkillsFromPath(basePath: string): Promise<Map<string, Skill> | undefined> {
    try {
      if (!fs.statSync(basePath).isDirectory()) {
        return undefined;
      }

      const skillFiles = PathResolver.findSkillFiles(basePath);
      const nextSkills = new Map<string, Skill>();

      for (const filePath of skillFiles) {
        try {
          const skill = SkillParser.parse(filePath);
          nextSkills.set(skill.metadata.name, skill);
        } catch (error: any) {
          Logger.warning(`Failed to load skill from ${filePath}: ${error.message}`);
        }
      }

      // findSkillFiles() intentionally returns [] for a missing path. Recheck
      // the root so a directory removed during the scan is not mistaken for a
      // successfully empty Skill workspace.
      if (!fs.statSync(basePath).isDirectory()) {
        return undefined;
      }

      return nextSkills;
    } catch (error: any) {
      // 目录不存在或无法访问，静默处理
      return undefined;
    }
  }

  /**
   * 根据名称获取 skill
   */
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
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

}
