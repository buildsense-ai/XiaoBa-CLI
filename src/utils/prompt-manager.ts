import { PromptComposer } from '../runtime/prompt-composer';
import { getPromptBaseDir } from './prompt-template';
import {
  PromptTraceSnapshot,
  buildPromptTraceSnapshot,
} from './prompt-observability';

/**
 * System Prompt 管理器
 */
export class PromptManager {
  private static promptsDir = getPromptBaseDir();
  private static envPromptsDir = PromptManager.promptsDir;

  /**
   * 获取基础 system prompt
   */
  static getBaseSystemPrompt(): string {
    return PromptComposer.getBaseSystemPrompt(this.getPromptsDir());
  }

  /**
   * 构建完整 system prompt（包含运行时信息）
   */
  static async buildSystemPrompt(): Promise<string> {
    return PromptComposer.composeSystemPrompt({
      promptsDir: this.getPromptsDir(),
    });
  }

  static getPromptsDir(): string {
    const currentEnvPromptsDir = getPromptBaseDir();
    if (this.promptsDir === this.envPromptsDir) {
      this.promptsDir = currentEnvPromptsDir;
    }
    this.envPromptsDir = currentEnvPromptsDir;
    return this.promptsDir;
  }

  static buildPromptTraceSnapshot(
    systemPrompt: string,
    options: {
      source?: string;
      loadedFiles?: string[];
      env?: NodeJS.ProcessEnv;
      now?: Date;
    } = {},
  ): PromptTraceSnapshot {
    return buildPromptTraceSnapshot({
      promptsDir: this.getPromptsDir(),
      systemPrompt,
      source: options.source || 'prompt-manager',
      loadedFiles: options.loadedFiles || ['runtime-context.md', 'system-prompt.md'],
      env: options.env,
      now: options.now,
    });
  }
}
