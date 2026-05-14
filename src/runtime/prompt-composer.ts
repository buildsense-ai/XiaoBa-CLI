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

    const workspaceName = displayName || 'default';
    const workspacePath = options.workspacePath ?? `~/catsco-workspace/${workspaceName}`;

    const runtimeInfo = [
      displayName ? `你在这个平台上的名字是：${displayName}` : '',
      platform ? `当前平台：${platform}` : '',
      `当前日期：${today}`,
      `你的默认工作目录是：\`${workspacePath}\``,
      `文件工具的相对路径会以这个默认工作目录为准。`,
      `如果用户让你检查项目、仓库或源码，先以默认工作目录作为项目根目录；除非用户明确指定，否则不要把 Electron/AppData/userData、日志目录或缓存目录当成源码目录。`,
      `如果默认工作目录看起来不是用户要检查的项目根目录，先用少量目录探测或询问用户确认路径，不要在错误目录里反复深扫。`,
      `如果用户提到另一个产品、网页端或服务端，而当前工作目录没有对应源码目录，不要把“当前仓库缺少该目录”当成产品不存在；请说明你只检查了当前仓库边界，并询问或探测正确仓库路径。`,
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
