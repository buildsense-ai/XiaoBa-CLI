import * as fs from 'fs';
import * as path from 'path';

/**
 * System Prompt 管理器
 */
export class PromptManager {
  private static promptsDir = path.join(__dirname, '../../prompts');

  /**
   * 获取基础 system prompt
   */
  static getBaseSystemPrompt(): string {
    try {
      return fs.readFileSync(path.join(this.promptsDir, 'system-prompt.md'), 'utf-8');
    } catch (error) {
      return this.getDefaultSystemPrompt();
    }
  }

  /**
   * 获取 soul prompt（bot 专属行为风格）
   */
  static getSoulPrompt(): string {
    try {
      return fs.readFileSync(path.join(this.promptsDir, 'soul.md'), 'utf-8');
    } catch {
      return '';
    }
  }

  /**
   * 构建完整 system prompt（包含运行时信息）
   */
  static async buildSystemPrompt(): Promise<string> {
    const basePrompt = this.getBaseSystemPrompt().trim();
    const soulPrompt = this.getSoulPrompt().trim();
    const displayName = (
      process.env.CURRENT_AGENT_DISPLAY_NAME
      || process.env.BOT_BRIDGE_NAME
      || ''
    ).trim();
    const today = new Date().toISOString().slice(0, 10);

    const runtimeInfo = [
      displayName ? `你在这个平台上的名字是：${displayName}` : '',
      `当前日期：${today}`,
    ].filter(Boolean).join('\n');

    return [basePrompt, soulPrompt, runtimeInfo].filter(Boolean).join('\n\n');
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
