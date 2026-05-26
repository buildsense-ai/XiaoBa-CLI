import * as fs from 'fs';
import * as path from 'path';
import { RuntimeProfile } from './runtime-profile';

export interface ComposeSystemPromptOptions {
  promptsDir: string;
  defaultSystemPrompt: string;
  promptFile?: string;
  runtimeInfo?: boolean;
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
      promptFile: options.promptFile,
      runtimeInfo: options.runtimeInfo,
      displayName,
      platform,
      now,
    });
  }

  static composeSystemPromptFromProfile(options: ComposeSystemPromptFromProfileOptions): string {
    return this.composeSystemPromptParts({
      promptsDir: options.promptsDir,
      defaultSystemPrompt: options.defaultSystemPrompt,
      promptFile: options.profile.prompt.file,
      runtimeInfo: options.profile.prompt.runtimeInfo,
      displayName: (options.profile.prompt.displayName || '').trim(),
      platform: options.profile.prompt.platform || '',
      workspacePath: options.profile.workingDirectory,
      now: options.now ?? new Date(),
    });
  }

  private static composeSystemPromptParts(options: {
    promptsDir: string;
    defaultSystemPrompt: string;
    promptFile?: string;
    runtimeInfo?: boolean;
    displayName: string;
    platform: string;
    workspacePath?: string;
    now: Date;
  }): string {
    const basePrompt = this.getBaseSystemPrompt(
      options.promptsDir,
      options.defaultSystemPrompt,
      options.promptFile,
    ).trim();
    const displayName = options.displayName;
    const platform = options.platform;
    const today = options.now.toISOString().slice(0, 10);
    if (options.runtimeInfo === false) {
      return basePrompt;
    }

    const runtimeInfo = [
      displayName ? `你在这个平台上的名字是：${displayName}` : '',
      platform ? `当前平台：${platform}` : '',
      `当前日期：${today}`,
      'Current directory is provided in a transient message for each model request. Use that current directory for relative file and shell paths.',
      'If the user asks you to inspect a project, repository, or source code, treat the current directory as the likely project root first.',
      'Do not mistake Electron userData, AppData, logs, or cache directories for the source repository unless the user explicitly asks about those runtime files.',
      'If the current directory does not appear to contain the requested product or service, do a small path check or ask for the correct repository instead of repeatedly scanning the wrong directory.',
    ].filter(Boolean).join('\n');

    return [basePrompt, runtimeInfo].filter(Boolean).join('\n\n');
  }

  static getBaseSystemPrompt(
    promptsDir: string,
    defaultSystemPrompt: string,
    promptFile = 'system-prompt.md',
  ): string {
    try {
      return fs.readFileSync(resolvePromptFile(promptsDir, promptFile), 'utf-8');
    } catch {
      return defaultSystemPrompt;
    }
  }
}

function resolvePromptFile(promptsDir: string, promptFile: string): string {
  const normalizedFile = (promptFile || 'system-prompt.md').trim() || 'system-prompt.md';
  const resolvedPromptsDir = path.resolve(promptsDir);
  const resolvedFile = path.resolve(resolvedPromptsDir, normalizedFile);
  const relative = path.relative(resolvedPromptsDir, resolvedFile);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Prompt file must be inside prompts directory: ${normalizedFile}`);
  }

  return resolvedFile;
}
