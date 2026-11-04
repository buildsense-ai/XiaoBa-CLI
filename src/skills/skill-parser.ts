import * as fs from 'fs';
import matter from 'gray-matter';
import { Skill, SkillMetadata } from '../types/skill';

/**
 * Skill 解析器
 */
export class SkillParser {
  /**
   * 解析 SKILL.md 文件（支持多种格式）
   * @param filePath - SKILL.md 文件路径
   * @returns Skill 对象
   */
  static parse(filePath: string, options: { allowMissingDescription?: boolean } = {}): Skill {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const { data, content } = matter(fileContent);

      // 检测格式类型并解析
      if (this.isClaudeCodeFormat(data)) {
        return this.parseClaudeCodeFormat(filePath, data, content, options);
      }

      // 默认使用 xiaoba 格式
      return this.parseXiaobaFormat(filePath, data, content, options);
    } catch (error: any) {
      throw new Error(`Failed to parse skill file ${filePath}: ${error.message}`);
    }
  }

  /**
   * 检测是否为 Claude Code 格式
   */
  private static isClaudeCodeFormat(data: any): boolean {
    return !!data.invocable;
  }

  /**
   * 解析 Claude Code 格式
   */
  private static parseClaudeCodeFormat(
    filePath: string,
    data: any,
    content: string,
    options: { allowMissingDescription?: boolean },
  ): Skill {
    if (!data.name || (!options.allowMissingDescription && !data.description)) {
      throw new Error(`Invalid skill file: ${filePath}. Missing required fields (name or description).`);
    }

    const metadata: SkillMetadata = {
      name: data.name,
      description: typeof data.description === 'string' ? data.description : '',
      argumentHint: data['argument-hint'] || data.argumentHint,
      userInvocable: data.invocable === 'user' || data.invocable === 'both',
    };

    if (options.allowMissingDescription ? !metadata.name : !this.validate(metadata)) {
      throw new Error(`Invalid skill metadata in file: ${filePath}`);
    }

    return {
      metadata,
      content: content.trim(),
      filePath,
    };
  }

  /**
   * 解析 xiaoba 格式
   */
  private static parseXiaobaFormat(
    filePath: string,
    data: any,
    content: string,
    options: { allowMissingDescription?: boolean },
  ): Skill {
    if (!data.name || (!options.allowMissingDescription && !data.description)) {
      throw new Error(`Invalid skill file: ${filePath}. Missing required fields (name or description).`);
    }

    const metadata: SkillMetadata = {
      name: data.name,
      description: typeof data.description === 'string' ? data.description : '',
      argumentHint: data['argument-hint'],
      userInvocable: data['user-invocable'] !== false,
    };

    if (options.allowMissingDescription ? !metadata.name : !this.validate(metadata)) {
      throw new Error(`Invalid skill metadata in file: ${filePath}`);
    }

    return {
      metadata,
      content: content.trim(),
      filePath,
    };
  }

  /**
   * 验证 Skill 元数据
   */
  static validate(metadata: SkillMetadata): boolean {
    return !!(metadata.name && metadata.description);
  }
}
