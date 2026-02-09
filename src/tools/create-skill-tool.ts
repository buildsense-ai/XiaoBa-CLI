import * as fs from 'fs';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { SkillManager } from '../skills/skill-manager';
import { SkillParser } from '../skills/skill-parser';
import { PathResolver } from '../utils/path-resolver';
import { Logger } from '../utils/logger';
import { isToolAllowed } from '../utils/safety';

/**
 * CreateSkill 工具 - 创建新的 skill
 * 让 XiaoBa 能够在对话中自我进化，创建新的 skills
 */
export class CreateSkillTool implements Tool {
  definition: ToolDefinition = {
    name: 'create_skill',
    description: '创建新的 skill。用于将重复的任务模式固化为可复用的 skill，实现自我进化。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill 名称（使用小写字母和连字符，如 "data-analysis"）'
        },
        description: {
          type: 'string',
          description: 'Skill 描述（简短说明 skill 的用途）'
        },
        content: {
          type: 'string',
          description: 'Skill 的提示词内容（详细的执行步骤和指导）'
        },
        invocable: {
          type: 'string',
          enum: ['user', 'auto', 'both'],
          description: '调用方式：user=仅用户调用, auto=仅自动调用, both=两者都可（默认 user）'
        },
        argument_hint: {
          type: 'string',
          description: '参数提示（可选，说明 skill 接受的参数）'
        }
      },
      required: ['name', 'description', 'content']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const {
      name,
      description,
      content,
      invocable = 'user',
      argument_hint
    } = args;

    try {
      const toolPermission = isToolAllowed(this.definition.name);
      if (!toolPermission.allowed) {
        return `执行被阻止: ${toolPermission.reason}`;
      }

      // 1. 验证 skill 名称
      if (!this.isValidSkillName(name)) {
        return `错误：Skill 名称不合法。请使用小写字母、数字和连字符，如 "data-analysis"`;
      }

      Logger.info(`创建新 Skill: ${name}`);

      // 2. 检查是否已存在同名 skill
      const skillManager = new SkillManager();
      await skillManager.loadSkills();

      if (skillManager.getSkill(name)) {
        return `错误：Skill "${name}" 已存在。请使用不同的名称或先删除现有 skill。`;
      }

      // 3. 确定保存位置（项目级 skills 目录）
      const skillsDir = PathResolver.getCommunitySkillsPath();
      const skillDir = path.join(skillsDir, name);
      const skillFile = path.join(skillDir, 'SKILL.md');

      // 4. 检查目录是否已存在
      if (fs.existsSync(skillDir)) {
        return `错误：目录 "${skillDir}" 已存在。`;
      }

      // 5. 创建 skill 目录
      Logger.info(`创建目录: ${path.relative(context.workingDirectory, skillDir)}`);
      fs.mkdirSync(skillDir, { recursive: true });

      // 6. 生成 SKILL.md 内容
      const skillContent = this.generateSkillContent(
        name,
        description,
        content,
        invocable,
        argument_hint
      );

      // 7. 写入文件
      fs.writeFileSync(skillFile, skillContent, 'utf-8');
      Logger.success(`✓ 成功创建 Skill 文件: ${path.relative(context.workingDirectory, skillFile)}`);

      // 8. 验证 skill 可以被正确解析
      try {
        const parsedSkill = SkillParser.parse(skillFile);
        Logger.info(`✓ Skill 验证通过`);
        Logger.info(`  名称: ${parsedSkill.metadata.name}`);
        Logger.info(`  描述: ${parsedSkill.metadata.description}`);
        Logger.info(`  用户可调用: ${parsedSkill.metadata.userInvocable ? '是' : '否'}`);
        Logger.info(`  自动可调用: ${parsedSkill.metadata.autoInvocable ? '是' : '否'}`);
      } catch (error: any) {
        Logger.warning(`Skill 验证失败: ${error.message}`);
        return `警告：Skill 文件已创建，但验证失败: ${error.message}`;
      }

      return `成功创建 Skill: ${name}\n\n` +
             `位置: ${skillFile}\n` +
             `描述: ${description}\n\n` +
             `Skill 已保存并可以立即使用。使用 skill 工具调用: {"skill": "${name}"}`;
    } catch (error: any) {
      Logger.error(`创建 Skill 失败: ${error.message}`);
      return `创建 Skill 失败: ${error.message}`;
    }
  }

  /**
   * 验证 skill 名称是否合法
   */
  private isValidSkillName(name: string): boolean {
    // 只允许小写字母、数字和连字符
    return /^[a-z0-9-]+$/.test(name);
  }

  /**
   * 生成 SKILL.md 文件内容
   */
  private generateSkillContent(
    name: string,
    description: string,
    content: string,
    invocable: string,
    argumentHint?: string
  ): string {
    let frontmatter = `---\n`;
    frontmatter += `name: ${name}\n`;
    frontmatter += `description: ${description}\n`;
    frontmatter += `invocable: ${invocable}\n`;

    if (argumentHint) {
      frontmatter += `argument-hint: ${argumentHint}\n`;
    }

    frontmatter += `---\n\n`;

    return frontmatter + content;
  }
}
