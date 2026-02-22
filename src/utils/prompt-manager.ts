import * as fs from 'fs';
import * as path from 'path';
import { SkillManager } from '../skills/skill-manager';

/**
 * System Prompt 管理器
 */
export class PromptManager {
  private static promptsDir = path.join(__dirname, '../../prompts');
  private static cachedSkillManager: SkillManager | null = null;

  /**
   * 获取基础 system prompt
   * 优先加载 system-prompt-{botName}.md，找不到则回退到 system-prompt.md
   */
  static getBaseSystemPrompt(): string {
    const botName = (process.env.BOT_BRIDGE_NAME || '').trim().toLowerCase();

    // 尝试加载 bot 专属 prompt
    if (botName) {
      const botPromptPath = path.join(this.promptsDir, `system-prompt-${botName}.md`);
      try {
        const content = fs.readFileSync(botPromptPath, 'utf-8');
        return content;
      } catch {
        // bot 专属文件不存在，回退到默认
      }
    }

    // 回退到通用 system-prompt.md
    try {
      return fs.readFileSync(path.join(this.promptsDir, 'system-prompt.md'), 'utf-8');
    } catch (error) {
      return this.getDefaultSystemPrompt();
    }
  }

  /**
   * 构建完整的 system prompt（包含动态加载的skills）
   */
  static async buildSystemPrompt(): Promise<string> {
    const basePrompt = this.getBaseSystemPrompt();
    const skillsSection = await this.buildSkillsSection();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    return `${basePrompt}

## 环境信息

当前日期: ${today}

${skillsSection}`;
  }

  /**
   * 构建skills部分
   */
  private static async buildSkillsSection(): Promise<string> {
    if (!this.cachedSkillManager) {
      this.cachedSkillManager = new SkillManager();
      await this.cachedSkillManager.loadSkills();
    }
    const manager = this.cachedSkillManager;

    const skills = manager.getAllSkills();

    if (skills.length === 0) {
      return '## 当前可用的Skills\n\n暂无可用的skills。';
    }

    let section = '## 当前可用的Skills\n\n';
    section += `你当前可以使用以下 ${skills.length} 个skills：\n\n`;

    for (const skill of skills) {
      section += `- **${skill.metadata.name}**: ${skill.metadata.description}`;

      if (skill.metadata.argumentHint) {
        section += ` (参数: ${skill.metadata.argumentHint})`;
      }

      section += '\n';
    }

    section += '\n**使用方式：** 当用户请求匹配某个 skill 的描述时，使用 `skill` 工具调用该 skill。\n';

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
