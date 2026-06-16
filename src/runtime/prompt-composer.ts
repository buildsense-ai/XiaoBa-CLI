import { RuntimeProfile } from './runtime-profile';
import { readPromptFile, renderPromptTemplate } from '../utils/prompt-template';

export interface ComposeSystemPromptOptions {
  promptsDir: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface ComposeSystemPromptFromProfileOptions {
  promptsDir: string;
  profile: RuntimeProfile;
  now?: Date;
}

export class PromptComposer {
  static composeSystemPrompt(options: ComposeSystemPromptOptions): string {
    const env = options.env ?? process.env;
    const now = options.now ?? new Date();
    const displayName = (
      env.CURRENT_AGENT_DISPLAY_NAME
      || env.BOT_BRIDGE_NAME
      || ''
    ).trim();
    const platform = (env.CURRENT_PLATFORM || '').trim();

    return this.composeSystemPromptParts({
      promptsDir: options.promptsDir,
      displayName,
      platform,
      now,
    });
  }

  static composeSystemPromptFromProfile(options: ComposeSystemPromptFromProfileOptions): string {
    return this.composeSystemPromptParts({
      promptsDir: options.promptsDir,
      displayName: (options.profile.prompt.displayName || '').trim(),
      platform: (options.profile.prompt.platform || '').trim(),
      workspacePath: options.profile.workingDirectory,
      now: options.now ?? new Date(),
    });
  }

  private static composeSystemPromptParts(options: {
    promptsDir: string;
    displayName: string;
    platform: string;
    workspacePath?: string;
    now: Date;
  }): string {
    const basePrompt = this.getBaseSystemPrompt(options.promptsDir);
    const today = options.now.toISOString().slice(0, 10);
    const runtimeInfo = this.getRuntimeContextPrompt(options.promptsDir, {
      displayName: options.displayName,
      platform: options.platform,
      date: today,
    });

    return [basePrompt, runtimeInfo].filter(Boolean).join('\n\n');
  }

  static getBaseSystemPrompt(promptsDir: string): string {
    return readPromptFile(promptsDir, 'system-prompt.md');
  }

  static getRuntimeContextPrompt(
    promptsDir: string,
    values: { displayName?: string; platform?: string; date: string },
  ): string {
    const template = readPromptFile(
      promptsDir,
      'runtime-context.md',
    );
    return renderPromptTemplate(template, values);
  }
}
