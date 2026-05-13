import * as path from 'path';
import { ChatConfig } from '../types';
import { DEFAULT_TOOL_NAMES, KNOWN_TOOL_NAMES, resolveDefaultToolNames } from '../tools/default-tool-names';

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
  'provider' | 'apiUrl' | 'model' | 'temperature' | 'maxTokens'
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
const KNOWN_RUNTIME_TOOL_NAME_SET = new Set<string>(KNOWN_TOOL_NAMES);

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
    workingDirectory: path.resolve(options.workingDirectory ?? process.cwd()),
    model: options.model ?? {},
    prompt: {
      source: 'prompt-manager',
      displayName: envDisplayName || undefined,
      platform,
    },
    tools: {
      enabled: [...(options.tools ?? resolveDefaultToolNames(env))],
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

export function validateRuntimeProfile(profile: RuntimeProfile): RuntimeProfileValidationIssue[] {
  const issues: RuntimeProfileValidationIssue[] = [];
  const seenToolNames = new Set<string>();

  profile.tools.enabled.forEach((toolName, index) => {
    const path = `tools.enabled[${index}]`;
    if (!KNOWN_RUNTIME_TOOL_NAME_SET.has(toolName)) {
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
