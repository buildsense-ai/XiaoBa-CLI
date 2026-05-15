import * as fs from 'fs';
import * as path from 'path';
import { RuntimeProfile } from './runtime-profile';

export interface ComposeSystemPromptOptions {
  promptsDir: string;
  defaultSystemPrompt: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface ComposeSystemPromptFromProfileOptions {
  promptsDir: string;
  defaultSystemPrompt: string;
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
    const platform = env.CURRENT_PLATFORM || '';

    return this.composeSystemPromptParts({
      promptsDir: options.promptsDir,
      defaultSystemPrompt: options.defaultSystemPrompt,
      displayName,
      platform,
      now,
    });
  }

  static composeSystemPromptFromProfile(options: ComposeSystemPromptFromProfileOptions): string {
    return this.composeSystemPromptParts({
      promptsDir: options.promptsDir,
      defaultSystemPrompt: options.defaultSystemPrompt,
      displayName: (options.profile.prompt.displayName || '').trim(),
      platform: options.profile.prompt.platform || '',
      workspacePath: options.profile.workingDirectory,
      now: options.now ?? new Date(),
    });
  }

  private static composeSystemPromptParts(options: {
    promptsDir: string;
    defaultSystemPrompt: string;
    displayName: string;
    platform: string;
    workspacePath?: string;
    now: Date;
  }): string {
    const basePrompt = this.getBaseSystemPrompt(options.promptsDir, options.defaultSystemPrompt).trim();
    const displayName = options.displayName;
    const platform = options.platform;
    const today = options.now.toISOString().slice(0, 10);

    const runtimeInfo = [
      displayName ? `你在这个平台上的名字是：${displayName}` : '',
      platform ? `当前平台：${platform}` : '',
      `当前日期：${today}`,
      'Current directory is provided in a transient message for each model request. Use that current directory for relative file and shell paths.',
    ].filter(Boolean).join('\n');

    return [basePrompt, runtimeInfo].filter(Boolean).join('\n\n');
  }

  static getBaseSystemPrompt(promptsDir: string, defaultSystemPrompt: string): string {
    try {
      return fs.readFileSync(path.join(promptsDir, 'system-prompt.md'), 'utf-8');
    } catch {
      return defaultSystemPrompt;
    }
  }
}
