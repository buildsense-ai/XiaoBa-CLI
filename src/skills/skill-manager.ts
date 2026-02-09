import { Skill } from '../types/skill';
import { PathResolver } from '../utils/path-resolver';
import { SkillParser } from './skill-parser';
import { Logger } from '../utils/logger';

/**
 * Skills 管理器
 */
export class SkillManager {
  private skills: Map<string, Skill>;
  private skillsPath: string;

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
   * 获取自动可调用的 skills
   */
  getAutoInvocableSkills(): Skill[] {
    return this.getAllSkills().filter(skill => skill.metadata.autoInvocable !== false);
  }

  /**
   * 重新加载 skills
   */
  async reload(): Promise<void> {
    await this.loadSkills();
  }
}
