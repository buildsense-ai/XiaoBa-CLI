import * as path from 'path';
import { ChatConfig } from '../types';
import { DEFAULT_TOOL_NAMES } from '../tools/default-tool-names';

export type RuntimeSurface = 'cli' | 'feishu' | 'catscompany' | 'weixin' | 'agent' | 'unknown';

export interface RuntimePromptProfile {
  source: 'prompt-manager';
  displayName?: string;
  platform?: string;
}

export interface RuntimeToolProfile {
  enabled: string[];
}

export interface RuntimeSkillProfile {
  enabled: boolean;
}

export interface RuntimeLoggingProfile {
  sessionEvents: boolean;
  uploadEnabled?: boolean;
}

export interface RuntimeModelProfile extends Partial<Pick<ChatConfig,
  'provider' | 'apiUrl' | 'model' | 'temperature' | 'maxTokens' | 'reasoningEffort' | 'openaiApiMode'
>> {}

export interface RuntimeProfile {
  id: string;
  displayName: string;
  surface: RuntimeSurface;
  workingDirectory: string;
  model: RuntimeModelProfile;
  prompt: RuntimePromptProfile;
  tools: RuntimeToolProfile;
  skills: RuntimeSkillProfile;
  logging: RuntimeLoggingProfile;
}

export const DEFAULT_RUNTIME_TOOL_NAMES = [...DEFAULT_TOOL_NAMES];
const DEFAULT_RUNTIME_TOOL_NAME_SET = new Set<string>(DEFAULT_RUNTIME_TOOL_NAMES);
const LEGACY_DISABLED_RUNTIME_TOOL_NAME_SET = new Set<string>(['prompt_mode']);

export interface RuntimeProfileValidationIssue {
  path: string;
  message: string;
  value?: unknown;
}

export interface ResolveRuntimeProfileOptions {
  id?: string;
  displayName?: string;
  surface?: RuntimeSurface;
  workingDirectory?: string;
  model?: RuntimeModelProfile;
  tools?: string[];
  skillsEnabled?: boolean;
  logging?: Partial<RuntimeLoggingProfile>;
  env?: NodeJS.ProcessEnv;
}

export function resolveDefaultRuntimeProfile(
  options: ResolveRuntimeProfileOptions = {},
): RuntimeProfile {
  const env = options.env ?? process.env;
  const envDisplayName = (env.CURRENT_AGENT_DISPLAY_NAME || env.BOT_BRIDGE_NAME || '').trim();
  const displayName = (options.displayName || envDisplayName || 'CatsCo').trim();
  const surface = options.surface ?? resolveSurfaceFromEnv(env);
  const platform = env.CURRENT_PLATFORM || undefined;

  return {
    id: options.id ?? `xiaoba-${surface}`,
    displayName,
    surface,
    workingDirectory: resolveDefaultWorkingDirectory(options, env),
    model: options.model ?? {},
    prompt: {
      source: 'prompt-manager',
      displayName: envDisplayName || undefined,
      platform,
    },
    tools: {
      enabled: [...(options.tools ?? DEFAULT_RUNTIME_TOOL_NAMES)],
    },
    skills: {
      enabled: options.skillsEnabled ?? true,
    },
    logging: {
      sessionEvents: options.logging?.sessionEvents ?? true,
      uploadEnabled: options.logging?.uploadEnabled,
    },
  };
}

function resolveDefaultWorkingDirectory(
  options: ResolveRuntimeProfileOptions,
  env: NodeJS.ProcessEnv,
): string {
  if (options.workingDirectory) {
    return path.resolve(options.workingDirectory);
  }

  const appRoot = (env.XIAOBA_APP_ROOT || '').trim();
  const isPackaged = (env.XIAOBA_IS_PACKAGED || '').trim();

  // Electron dev may run from userData so app config/logs are colocated, but
  // the source project root remains XIAOBA_APP_ROOT. Use it as the default tool
  // cwd only for dev; packaged apps should not default to the installed bundle.
  if (appRoot && isPackaged === '0') {
    return path.resolve(appRoot);
  }

  return path.resolve(process.cwd());
}

export function validateRuntimeProfile(profile: RuntimeProfile): RuntimeProfileValidationIssue[] {
  const issues: RuntimeProfileValidationIssue[] = [];
  const seenToolNames = new Set<string>();

  profile.tools.enabled.forEach((toolName, index) => {
    const path = `tools.enabled[${index}]`;
    if (!DEFAULT_RUNTIME_TOOL_NAME_SET.has(toolName)) {
      if (LEGACY_DISABLED_RUNTIME_TOOL_NAME_SET.has(toolName)) {
        return;
      }
      issues.push({
        path,
        message: `Unknown runtime tool: ${toolName}`,
        value: toolName,
      });
      return;
    }

    if (seenToolNames.has(toolName)) {
      issues.push({
        path,
        message: `Duplicate runtime tool: ${toolName}`,
        value: toolName,
      });
      return;
    }

    seenToolNames.add(toolName);
  });

  return issues;
}

export function assertValidRuntimeProfile(profile: RuntimeProfile): void {
  const issues = validateRuntimeProfile(profile);
  if (issues.length === 0) return;

  const details = issues
    .map(issue => `${issue.path}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid runtime profile "${profile.id}": ${details}`);
}

function resolveSurfaceFromEnv(env: NodeJS.ProcessEnv): RuntimeSurface {
  const rawSurface = (env.XIAOBA_RUNTIME_SURFACE || env.CURRENT_PLATFORM || '')
    .trim()
    .toLowerCase();

  if (rawSurface.includes('feishu') || rawSurface.includes('飞书')) return 'feishu';
  if (rawSurface.includes('catsco') || rawSurface.includes('catscompany') || rawSurface.includes('cats company')) return 'catscompany';
  if (rawSurface.includes('weixin') || rawSurface.includes('微信')) return 'weixin';
  if (rawSurface.includes('agent')) return 'agent';
  if (rawSurface.includes('cli')) return 'cli';
  return 'cli';
}
