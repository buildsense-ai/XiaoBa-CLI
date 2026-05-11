import * as path from 'path';
import { PromptComposer } from '../runtime/prompt-composer';

/**
 * System Prompt 管理器
 */
export class PromptManager {
  private static promptsDir = path.join(__dirname, '../../prompts');

  /**
   * 获取基础 system prompt
   */
  static getBaseSystemPrompt(): string {
    return PromptComposer.getBaseSystemPrompt(this.promptsDir, this.getDefaultSystemPrompt());
  }

  /**
   * 构建完整 system prompt（包含运行时信息）
   */
  static async buildSystemPrompt(): Promise<string> {
    return PromptComposer.composeSystemPrompt({
      promptsDir: this.promptsDir,
      defaultSystemPrompt: this.getDefaultSystemPrompt(),
    });
  }

  static getPromptsDir(): string {
    return this.promptsDir;
  }

  /**
   * 默认 system prompt（当文件不存在时使用）
   */
  static getDefaultSystemPrompt(): string {
    return `你是用户的私人助理。

你和用户交流时，保持自然、直接、可信。

工作原则：
1. 只根据当前对话、真实上下文和当前运行时提供的能力行动。
2. 不编造自己拥有的工具、技能、历史记忆或已完成的工作。
3. 先理解问题，再决定是否需要行动或回复。
4. 当前这一轮没有新信息时，不要为了显得热情而额外寒暄。`;
  }
}
