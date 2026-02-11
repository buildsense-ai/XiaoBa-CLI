import * as fs from 'fs';
import matter from 'gray-matter';
import { Skill, SkillMetadata, SkillToolPolicy } from '../types/skill';

/**
 * Skill 解析器
 */
export class SkillParser {
  /**
   * 解析 SKILL.md 文件（支持多种格式）
   * @param filePath - SKILL.md 文件路径
   * @returns Skill 对象
   */
  static parse(filePath: string): Skill {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const { data, content } = matter(fileContent);

      // 检测格式类型并解析
      if (this.isClaudeCodeFormat(data)) {
        return this.parseClaudeCodeFormat(filePath, data, content);
      }

      // 默认使用 xiaoba 格式
      return this.parseXiaobaFormat(filePath, data, content);
    } catch (error: any) {
      throw new Error(`Failed to parse skill file ${filePath}: ${error.message}`);
    }
  }

  /**
   * 检测是否为 Claude Code 格式
   */
  private static isClaudeCodeFormat(data: any): boolean {
    // Claude Code 格式特征：使用 invocable 或 autoInvocable 字段
    return !!(data.invocable || data.autoInvocable !== undefined);
  }

  /**
   * 解析 Claude Code 格式
   */
  private static parseClaudeCodeFormat(filePath: string, data: any, content: string): Skill {
    if (!data.name || !data.description) {
      throw new Error(`Invalid skill file: ${filePath}. Missing required fields (name or description).`);
    }

    const toolPolicy = this.parseToolPolicy(data);

    const metadata: SkillMetadata = {
      name: data.name,
      description: data.description,
      argumentHint: data['argument-hint'] || data.argumentHint,
      userInvocable: data.invocable === 'user' || data.invocable === 'both',
      autoInvocable: data.autoInvocable !== false && data.invocable !== 'user',
      maxTurns: data['max-turns'] ? Number(data['max-turns']) : undefined,
      ...(toolPolicy ? { toolPolicy } : {}),
    };

    if (!this.validate(metadata)) {
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
  private static parseXiaobaFormat(filePath: string, data: any, content: string): Skill {
    if (!data.name || !data.description) {
      throw new Error(`Invalid skill file: ${filePath}. Missing required fields (name or description).`);
    }

    const toolPolicy = this.parseToolPolicy(data);

    const metadata: SkillMetadata = {
      name: data.name,
      description: data.description,
      argumentHint: data['argument-hint'],
      userInvocable: data['user-invocable'] !== false,
      autoInvocable: data['auto-invocable'] !== false,
      maxTurns: data['max-turns'] ? Number(data['max-turns']) : undefined,
      ...(toolPolicy ? { toolPolicy } : {}),
    };

    if (!this.validate(metadata)) {
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
   * @param metadata - 元数据对象
   * @returns 是否有效
   */
  static validate(metadata: SkillMetadata): boolean {
    return !!(metadata.name && metadata.description);
  }

  /**
   * 解析工具策略，兼容 kebab-case/camelCase
   */
  private static parseToolPolicy(data: any): SkillToolPolicy | undefined {
    const allowedRaw = data['allowed-tools'] ?? data.allowedTools;
    const disallowedRaw = data['disallowed-tools'] ?? data.disallowedTools;

    const allowedTools = Array.isArray(allowedRaw)
      ? allowedRaw.map((item: any) => String(item).trim()).filter(Boolean)
      : [];

    const disallowedTools = Array.isArray(disallowedRaw)
      ? disallowedRaw.map((item: any) => String(item).trim()).filter(Boolean)
      : [];

    if (allowedTools.length === 0 && disallowedTools.length === 0) {
      return undefined;
    }

    const policy: SkillToolPolicy = {};
    if (allowedTools.length > 0) {
      policy.allowedTools = allowedTools;
    }
    if (disallowedTools.length > 0) {
      policy.disallowedTools = disallowedTools;
    }
    return policy;
  }
}
