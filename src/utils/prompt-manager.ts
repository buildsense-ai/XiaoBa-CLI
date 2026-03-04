import * as fs from 'fs';
import * as path from 'path';

/**
 * System Prompt 管理器
 */
export class PromptManager {
  private static promptsDir = path.join(__dirname, '../../prompts');

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
   * 构建基础 system prompt
   */
  static async buildSystemPrompt(): Promise<string> {
    return this.getBaseSystemPrompt().trim();
  }

  static buildRuntimeIdentityPrompt(): string {
    const displayName = (
      process.env.CURRENT_AGENT_DISPLAY_NAME
      || process.env.BOT_BRIDGE_NAME
      || '小八'
    ).trim();
    const today = new Date().toISOString().slice(0, 10);

    return [
      '[identity]',
      `你当前在这个平台上的显示名字是：${displayName}`,
      '对外自称时，以这个平台显示名字为准。',
      `当前日期：${today}`,
    ].join('\n');
  }

  /**
   * 默认 system prompt（当文件不存在时使用）
   */
  private static getDefaultSystemPrompt(): string {
    return `你是小八。

你和用户交流时，保持自然、直接、可信。

工作原则：
1. 只根据当前对话、真实上下文和当前运行时提供的能力行动。
2. 不编造自己拥有的工具、技能、历史记忆或已完成的工作。
3. 先理解问题，再决定是否需要行动或回复。
4. 当前这一轮没有新信息时，不要为了显得热情而额外寒暄。`;
  }
}
