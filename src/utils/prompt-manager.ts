import * as fs from 'fs';
import * as path from 'path';
import { SkillManager } from '../skills/skill-manager';

/**
 * System Prompt 管理器
 */
export class PromptManager {
  private static systemPromptPath = path.join(__dirname, '../../prompts/system-prompt.md');

  /**
   * 获取基础 system prompt
   */
  static getBaseSystemPrompt(): string {
    try {
      return fs.readFileSync(this.systemPromptPath, 'utf-8');
    } catch (error) {
      // 如果文件不存在，返回默认prompt
      return this.getDefaultSystemPrompt();
    }
  }

  /**
   * 构建完整的 system prompt（包含动态加载的skills）
   */
  static async buildSystemPrompt(): Promise<string> {
    const basePrompt = this.getBaseSystemPrompt();
    const skillsSection = await this.buildSkillsSection();

    return `${basePrompt}

${skillsSection}`;
  }

  /**
   * 构建skills部分
   */
  private static async buildSkillsSection(): Promise<string> {
    const manager = new SkillManager();
    await manager.loadSkills();

    const skills = manager.getAllSkills();

    if (skills.length === 0) {
      return '## 当前可用的Skills\n\n暂无可用的skills。';
    }

    let section = '## 当前可用的Skills\n\n';
    section += `你当前可以使用以下 ${skills.length} 个skills：\n\n`;

    for (const skill of skills) {
      section += `### ${skill.metadata.name}\n\n`;
      section += `**描述：** ${skill.metadata.description}\n\n`;

      if (skill.metadata.argumentHint) {
        section += `**参数：** ${skill.metadata.argumentHint}\n\n`;
      }

      section += `**调用方式：**\n`;
      const invocable = [];
      if (skill.metadata.userInvocable) invocable.push('用户可调用');
      if (skill.metadata.autoInvocable) invocable.push('自动调用');
      section += `- ${invocable.join('、')}\n\n`;

      section += `**提示词内容：**\n\`\`\`\n${skill.content}\n\`\`\`\n\n`;
      section += '---\n\n';
    }

    return section;
  }

  /**
   * 默认 system prompt（当文件不存在时使用）
   */
  private static getDefaultSystemPrompt(): string {
    return `你是 XiaoBa，一个智能的命令行AI开发助手。

你的核心能力：
- 软件开发：编写、审查、重构代码
- 问题解决：调试、分析、优化
- 项目管理：规划、执行、验证

工作原则：
1. 理解优先，行动在后
2. 最小必要改动
3. 安全第一
4. 清晰沟通`;
  }
}
