import { Skill } from '../types/skill';
import { PathResolver } from '../utils/path-resolver';
import { SkillParser } from './skill-parser';
import { Logger } from '../utils/logger';

/**
 * Skills 管理器
 */
export class SkillManager {
  private skills: Map<string, Skill>;
  private communitySkillsPath: string;
  private projectSkillsPath: string;
  private userSkillsPath: string;

  constructor() {
    this.skills = new Map();
    this.communitySkillsPath = PathResolver.getCommunitySkillsPath();
    this.projectSkillsPath = PathResolver.getProjectSkillsPath();
    this.userSkillsPath = PathResolver.getUserSkillsPath();
  }

  /**
   * 加载所有 skills（npm包 + 用户级 + 社区级 + 项目级）
   */
  async loadSkills(): Promise<void> {
    this.skills.clear();

    // 1. 先加载 npm 包 skills（优先级最低）
    await this.loadNpmSkills();

    // 2. 加载用户级 skills（会覆盖同名的 npm skills）
    await this.loadSkillsFromPath(this.userSkillsPath, 'user');

    // 3. 加载社区级 skills（会覆盖同名的用户级和 npm skills）
    await this.loadSkillsFromPath(this.communitySkillsPath, 'community');

    // 4. 加载项目级 skills（会覆盖同名的社区级、用户级和 npm skills）
    await this.loadSkillsFromPath(this.projectSkillsPath, 'project');
  }

  /**
   * 从 npm 包中加载 skills
   */
  private async loadNpmSkills(): Promise<void> {
    try {
      const npmSkillFiles = PathResolver.findNpmSkills();

      for (const filePath of npmSkillFiles) {
        try {
          const skill = SkillParser.parse(filePath);
          // npm 包的 skill 优先级最低，不覆盖已有的
          if (!this.skills.has(skill.metadata.name)) {
            this.skills.set(skill.metadata.name, skill);
          }
        } catch (error: any) {
          Logger.warning(`Failed to load npm skill from ${filePath}: ${error.message}`);
        }
      }
    } catch (error: any) {
      // 静默处理
    }
  }

  /**
   * 从指定路径加载 skills
   */
  private async loadSkillsFromPath(basePath: string, level: 'user' | 'project'): Promise<void> {
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
