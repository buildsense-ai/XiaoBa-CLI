import { RuntimeProfile } from './runtime-profile';
import { loadPromptModePrompt } from './prompt-modes';
import { readRequiredPromptFile, renderPromptTemplate } from '../utils/prompt-template';

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
    const displayName = (
      env.CURRENT_AGENT_DISPLAY_NAME
      || env.BOT_BRIDGE_NAME
      || ''
    ).trim();
    const platform = (env.CURRENT_PLATFORM || '').trim();
    const promptMode = (env.XIAOBA_PROMPT_MODE || '').trim();

    return this.composeSystemPromptParts({
      promptsDir: options.promptsDir,
      displayName,
      platform,
      promptMode,
      now: options.now,
    });
  }

  static composeSystemPromptFromProfile(options: ComposeSystemPromptFromProfileOptions): string {
    return this.composeSystemPromptParts({
      promptsDir: options.promptsDir,
      displayName: (options.profile.prompt.displayName || '').trim(),
      platform: (options.profile.prompt.platform || '').trim(),
      promptMode: options.profile.prompt.mode,
      workspacePath: options.profile.workingDirectory,
      now: options.now,
    });
  }

  private static composeSystemPromptParts(options: {
    promptsDir: string;
    displayName: string;
    platform: string;
    promptMode?: string;
    workspacePath?: string;
    now?: Date;
  }): string {
    const basePrompt = this.getBaseSystemPrompt(options.promptsDir);
    const modePrompt = loadPromptModePrompt(options.promptsDir, options.promptMode);
    const today = (options.now ?? new Date()).toISOString().slice(0, 10);
    const runtimeInfo = this.getRuntimeContextPrompt(options.promptsDir, {
      displayName: options.displayName,
      platform: options.platform,
      date: today,
    });

    return [basePrompt, modePrompt, runtimeInfo].filter(Boolean).join('\n\n');
  }

  static getBaseSystemPrompt(promptsDir: string): string {
    return readRequiredPromptFile(promptsDir, 'system-prompt.md');
  }

  static getRuntimeContextPrompt(
    promptsDir: string,
    values: { displayName?: string; platform?: string; date: string },
  ): string {
    const template = readRequiredPromptFile(
      promptsDir,
      'runtime-context.md',
    );
    return renderPromptTemplate(template, values);
  }
}
