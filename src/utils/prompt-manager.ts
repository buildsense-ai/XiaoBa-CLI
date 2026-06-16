import { PromptComposer } from '../runtime/prompt-composer';
import { DEFAULT_PROMPTS_DIR } from './prompt-template';

/**
 * System Prompt 管理器
 */
export class PromptManager {
  private static promptsDir = DEFAULT_PROMPTS_DIR;

  /**
   * 获取基础 system prompt
   */
  static getBaseSystemPrompt(): string {
    return PromptComposer.getBaseSystemPrompt(this.promptsDir);
  }

  /**
   * 构建完整 system prompt（包含运行时信息）
   */
  static async buildSystemPrompt(): Promise<string> {
    return PromptComposer.composeSystemPrompt({
      promptsDir: this.promptsDir,
    });
  }

  static getPromptsDir(): string {
    return this.promptsDir;
  }
}
