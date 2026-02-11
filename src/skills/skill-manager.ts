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
   * 根据用户文本匹配可自动触发的 skill
   *
   * 触发策略（保守）：
   * - 必须出现 skill 名称（支持原名、空格变体、下划线变体）
   * - 只匹配 autoInvocable skill
   * - 若多个命中，优先选择名称更长（更具体）的 skill
   */
  findAutoInvocableSkillByText(text: string): Skill | undefined {
    const normalizedText = this.normalizeText(text);
    if (!normalizedText) return undefined;

    const candidates = this.getAutoInvocableSkills()
      .filter(skill => this.isSkillMentioned(normalizedText, skill.metadata.name));

    if (candidates.length === 0) {
      return undefined;
    }

    candidates.sort((a, b) => b.metadata.name.length - a.metadata.name.length);
    return candidates[0];
  }

  /**
   * 重新加载 skills
   */
  async reload(): Promise<void> {
    await this.loadSkills();
  }

  private normalizeText(text: string): string {
    return text.trim().toLowerCase();
  }

  private isSkillMentioned(text: string, skillName: string): boolean {
    const lowerName = skillName.toLowerCase();
    const variants = Array.from(new Set([
      lowerName,
      lowerName.replace(/-/g, ' '),
      lowerName.replace(/-/g, '_'),
    ])).filter(Boolean);

    return variants.some(variant => this.containsToken(text, variant));
  }

  private containsToken(text: string, token: string): boolean {
    if (!token) return false;

    // 包含空格的短语直接做子串匹配
    if (token.includes(' ')) {
      return text.includes(token);
    }

    // 英文/数字 token 使用边界匹配，避免误匹配子串
    if (/^[a-z0-9_-]+$/.test(token)) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(^|[^a-z0-9_-])${escaped}([^a-z0-9_-]|$)`, 'i');
      return regex.test(text);
    }

    // 其他字符集合（如中文）退化为 includes
    return text.includes(token);
  }
}
