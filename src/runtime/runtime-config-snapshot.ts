import * as fs from 'fs';
import * as path from 'path';
import { SkillManager } from '../skills/skill-manager';
import { ToolManager } from '../tools/tool-manager';
import { resolveDefaultToolNames } from '../tools/default-tool-names';
import { ToolTranscriptMode } from '../types/tool';
import { ChatConfig } from '../types';
import { PathResolver } from '../utils/path-resolver';
import { RuntimeFactory } from './runtime-factory';
import {
  RuntimeProfileConfigInfo,
  resolveRuntimeProfileFromConfig,
} from './runtime-profile-config';
import {
  RuntimeProfile,
  RuntimeProfileValidationIssue,
  RuntimeSurface,
  validateRuntimeProfile,
} from './runtime-profile';

export interface RuntimeToolConfigSnapshot {
  name: string;
  description: string;
  enabled: boolean;
  transcriptMode: ToolTranscriptMode;
}

export interface RuntimeSkillConfigSnapshot {
  name: string;
  description: string;
  userInvocable: boolean;
  filePath: string;
}

export interface RuntimeConfigSnapshot {
  generatedAt: string;
  runtimeRoot: string;
  profileConfig: RuntimeProfileConfigInfo;
  profileEditing: {
    enabled: boolean;
    editableFields: string[];
    readOnlyFields: string[];
    previewEndpoint: string;
    saveEndpoint: string;
    rollbackEndpoint: string;
    appliesTo: 'new-session';
  };
  profile: RuntimeProfile;
  validation: {
    valid: boolean;
    issues: RuntimeProfileValidationIssue[];
  };
  workingDirectory: {
    path: string;
    exists: boolean;
  };
  systemPrompt: {
    source: RuntimeProfile['prompt']['source'];
    length: number;
    text: string;
  };
  tools: {
    registered: RuntimeToolConfigSnapshot[];
    enabled: RuntimeToolConfigSnapshot[];
    disabled: RuntimeToolConfigSnapshot[];
  };
  skills: {
    enabled: boolean;
    path: string;
    loaded: number;
    items: RuntimeSkillConfigSnapshot[];
    loadError?: string;
  };
  logging: {
    sessionEvents: boolean;
    sessionLogDir: string;
    runtimeLogDir: string;
    reportDir: string;
    upload: {
      enabled: boolean;
      serverUrl?: string;
      intervalMinutes?: number;
    };
  };
}

export interface CreateRuntimeConfigSnapshotOptions {
  profile?: RuntimeProfile;
  config?: ChatConfig;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  runtimeRoot?: string;
  workingDirectory?: string;
  surface?: RuntimeSurface;
  profileConfigPath?: string;
  loadSkills?: boolean;
}

export async function createRuntimeConfigSnapshot(
  options: CreateRuntimeConfigSnapshotOptions = {},
): Promise<RuntimeConfigSnapshot> {
  const env = options.env ?? process.env;
  const runtimeRoot = path.resolve(options.runtimeRoot ?? process.cwd());
  const resolved = options.profile
    ? {
      profile: options.profile,
      config: {
        path: '',
        exists: false,
        loaded: false,
        issues: [],
      },
    }
    : resolveRuntimeProfileForSnapshot({
      config: options.config,
      env,
      runtimeRoot,
      workingDirectory: options.workingDirectory,
      surface: options.surface,
      profileConfigPath: options.profileConfigPath,
    });
  const profile = resolved.profile;
  const displayProfile = sanitizeProfileForSnapshot(profile);
  const validationIssues = validateRuntimeProfile(profile);
  const systemPrompt = await Promise.resolve(RuntimeFactory.createSystemPromptProvider(profile)());
  const tools = buildToolSnapshot(profile);
  const skills = await buildSkillSnapshot(options.loadSkills ?? profile.skills.enabled);
  const logUpload = options.config?.catscoLogUpload;

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    runtimeRoot,
    profileConfig: resolved.config,
    profileEditing: {
      enabled: true,
      editableFields: [
        'displayName',
        'workingDirectory',
        'tools.enabled',
        'skills.enabled',
      ],
      readOnlyFields: [
        'surface',
        'model.apiKey',
        'logging',
      ],
      previewEndpoint: '/api/runtime/profile/preview',
      saveEndpoint: '/api/runtime/profile',
      rollbackEndpoint: '/api/runtime/profile/rollback',
      appliesTo: 'new-session',
    },
    profile: displayProfile,
    validation: {
      valid: validationIssues.length === 0,
      issues: validationIssues,
    },
    workingDirectory: {
      path: profile.workingDirectory,
      exists: fs.existsSync(profile.workingDirectory),
    },
    systemPrompt: {
      source: profile.prompt.source,
      length: systemPrompt.length,
      text: systemPrompt,
    },
    tools,
    skills,
    logging: {
      sessionEvents: profile.logging.sessionEvents,
      sessionLogDir: path.resolve(runtimeRoot, 'logs/sessions'),
      runtimeLogDir: path.resolve(runtimeRoot, 'logs'),
      reportDir: path.resolve(runtimeRoot, 'logs/reports'),
      upload: {
        enabled: Boolean(logUpload?.enabled ?? profile.logging.uploadEnabled),
        serverUrl: sanitizeServerUrl(logUpload?.serverUrl),
        intervalMinutes: logUpload?.intervalMinutes,
      },
    },
  };
}

function sanitizeProfileForSnapshot(profile: RuntimeProfile): RuntimeProfile {
  return {
    id: profile.id,
    displayName: profile.displayName,
    surface: profile.surface,
    workingDirectory: profile.workingDirectory,
    model: {
      ...profile.model,
      apiUrl: sanitizeServerUrl(profile.model.apiUrl),
    },
    prompt: { ...profile.prompt },
    tools: { enabled: [...profile.tools.enabled] },
    skills: { ...profile.skills },
    logging: { ...profile.logging },
  };
}

function sanitizeServerUrl(serverUrl?: string): string | undefined {
  const raw = (serverUrl || '').trim();
  if (!raw) return undefined;

  try {
    const parsed = new URL(raw);
    return parsed.origin;
  } catch {
    return '[configured]';
  }
}

function resolveRuntimeProfileForSnapshot(options: {
  config?: ChatConfig;
  env: NodeJS.ProcessEnv;
  runtimeRoot: string;
  workingDirectory?: string;
  surface?: RuntimeSurface;
  profileConfigPath?: string;
}): ReturnType<typeof resolveRuntimeProfileFromConfig> {
  return resolveRuntimeProfileFromConfig({
    env: options.env,
    configPath: options.profileConfigPath,
    runtimeRoot: options.runtimeRoot,
    surface: options.surface,
    workingDirectory: options.workingDirectory ?? options.runtimeRoot,
    model: {
      provider: options.config?.provider,
      apiUrl: sanitizeServerUrl(options.config?.apiUrl),
      model: options.config?.model,
      temperature: options.config?.temperature,
      maxTokens: options.config?.maxTokens,
    },
    logging: {
      uploadEnabled: options.config?.catscoLogUpload?.enabled,
    },
  });
}

function buildToolSnapshot(profile: RuntimeProfile): RuntimeConfigSnapshot['tools'] {
  const enabledNames = new Set(profile.tools.enabled);
  const registeredToolNames = Array.from(new Set([
    ...resolveDefaultToolNames(),
    ...profile.tools.enabled,
  ]));
  const registered = new ToolManager(profile.workingDirectory, {}, { enabledToolNames: registeredToolNames })
    .getToolDefinitions()
    .map(definition => ({
      name: definition.name,
      description: definition.description,
      enabled: enabledNames.has(definition.name),
      transcriptMode: definition.transcriptMode ?? 'default',
    }));

  return {
    registered,
    enabled: registered.filter(tool => tool.enabled),
    disabled: registered.filter(tool => !tool.enabled),
  };
}

async function buildSkillSnapshot(loadSkills: boolean): Promise<RuntimeConfigSnapshot['skills']> {
  const skillsPath = PathResolver.getSkillsPath();

  if (!loadSkills) {
    return {
      enabled: false,
      path: skillsPath,
      loaded: 0,
      items: [],
    };
  }

  const manager = new SkillManager();

  try {
    await manager.loadSkills();
  } catch (error: any) {
    return {
      enabled: true,
      path: skillsPath,
      loaded: 0,
      items: [],
      loadError: error?.message || String(error),
    };
  }

  const items = manager.getAllSkills().map(skill => ({
    name: skill.metadata.name,
    description: skill.metadata.description,
    userInvocable: skill.metadata.userInvocable !== false,
    filePath: skill.filePath,
  }));

  return {
    enabled: true,
    path: skillsPath,
    loaded: items.length,
    items,
  };
}
