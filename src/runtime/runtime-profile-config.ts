import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ResolveRuntimeProfileOptions,
  RuntimeBrandingProfile,
  RuntimeLoggingProfile,
  RuntimeModelProfile,
  RuntimeProfile,
  RuntimeSurface,
  resolveDefaultRuntimeProfile,
} from './runtime-profile';

export const RUNTIME_PROFILE_SCHEMA_VERSION = 1;
export const DEFAULT_RUNTIME_PROFILE_FILENAME = 'runtime-profile.json';

const PROFILE_PATH_ENV_KEYS = ['XIAOBA_RUNTIME_PROFILE_PATH', 'XIAOBA_PROFILE_PATH'];

export interface RuntimeProfileFileModelConfig extends Pick<RuntimeModelProfile,
  'provider' | 'apiUrl' | 'model' | 'temperature' | 'maxTokens'
> {}

export interface RuntimeProfileFilePromptConfig {
  file?: string;
  contextFiles?: string[];
  runtimeInfo?: boolean;
  surfaceInfo?: boolean;
  displayName?: string;
  platform?: string;
}

export interface RuntimeProfileFileToolConfig {
  enabled?: string[];
}

export interface RuntimeProfileFileSkillConfig {
  enabled?: boolean;
}

export interface RuntimeProfileFileBrandingConfig extends Partial<RuntimeBrandingProfile> {}

export interface RuntimeProfileFileConfig {
  id?: string;
  displayName?: string;
  surface?: RuntimeSurface;
  workingDirectory?: string;
  model?: RuntimeProfileFileModelConfig;
  prompt?: RuntimeProfileFilePromptConfig;
  tools?: RuntimeProfileFileToolConfig;
  skills?: RuntimeProfileFileSkillConfig;
  logging?: Partial<RuntimeLoggingProfile>;
  branding?: RuntimeProfileFileBrandingConfig;
}

export interface RuntimeProfileConfigFile {
  schemaVersion: typeof RUNTIME_PROFILE_SCHEMA_VERSION;
  profile?: RuntimeProfileFileConfig;
}

export interface RuntimeProfileConfigIssue {
  path: string;
  message: string;
}

export interface RuntimeProfileConfigInfo {
  path: string;
  exists: boolean;
  loaded: boolean;
  schemaVersion?: number;
  issues: RuntimeProfileConfigIssue[];
}

export interface RuntimeProfileResolution {
  profile: RuntimeProfile;
  config: RuntimeProfileConfigInfo;
}

export interface ResolveRuntimeProfileFromConfigOptions extends ResolveRuntimeProfileOptions {
  configPath?: string;
  runtimeRoot?: string;
  homeDir?: string;
}

interface LoadedRuntimeProfileConfig {
  info: RuntimeProfileConfigInfo;
  profileConfig?: RuntimeProfileFileConfig;
}

export function getDefaultRuntimeProfileConfigPath(
  options: Pick<ResolveRuntimeProfileFromConfigOptions, 'env' | 'runtimeRoot' | 'homeDir' | 'configPath'> = {},
): string {
  const env = options.env ?? process.env;
  const runtimeRoot = options.runtimeRoot ?? process.cwd();
  const explicitPath = options.configPath || PROFILE_PATH_ENV_KEYS
    .map(key => env[key])
    .find(value => typeof value === 'string' && value.trim().length > 0);

  if (explicitPath) {
    return resolvePath(explicitPath, runtimeRoot, options.homeDir);
  }

  return path.join(options.homeDir ?? os.homedir(), '.xiaoba', DEFAULT_RUNTIME_PROFILE_FILENAME);
}

export function loadRuntimeProfileConfigFile(
  options: ResolveRuntimeProfileFromConfigOptions = {},
): LoadedRuntimeProfileConfig {
  const configPath = getDefaultRuntimeProfileConfigPath(options);
  const baseInfo: RuntimeProfileConfigInfo = {
    path: configPath,
    exists: fs.existsSync(configPath),
    loaded: false,
    issues: [],
  };

  if (!baseInfo.exists) {
    return { info: baseInfo };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (error: any) {
    return {
      info: {
        ...baseInfo,
        issues: [{
          path: '$',
          message: `Invalid JSON: ${error?.message || String(error)}`,
        }],
      },
    };
  }

  const parsed = parseRuntimeProfileConfig(raw);
  return {
    info: {
      ...baseInfo,
      loaded: Boolean(parsed.profileConfig),
      schemaVersion: parsed.schemaVersion,
      issues: parsed.issues,
    },
    profileConfig: parsed.profileConfig,
  };
}

export function resolveRuntimeProfileFromConfig(
  options: ResolveRuntimeProfileFromConfigOptions = {},
): RuntimeProfileResolution {
  const baseProfile = resolveDefaultRuntimeProfile(options);
  const loaded = loadRuntimeProfileConfigFile(options);
  const configDir = path.dirname(loaded.info.path);
  const profile = loaded.profileConfig
    ? applyRuntimeProfileFileConfig(baseProfile, loaded.profileConfig, {
      configDir,
      homeDir: options.homeDir,
      surfaceOverride: options.surface,
    })
    : baseProfile;

  return {
    profile,
    config: loaded.info,
  };
}

export function applyRuntimeProfileFileConfig(
  baseProfile: RuntimeProfile,
  config: RuntimeProfileFileConfig,
  options: { configDir: string; homeDir?: string; surfaceOverride?: RuntimeSurface },
): RuntimeProfile {
  const profile: RuntimeProfile = {
    id: baseProfile.id,
    displayName: baseProfile.displayName,
    surface: baseProfile.surface,
    workingDirectory: baseProfile.workingDirectory,
    model: { ...baseProfile.model },
    prompt: { ...baseProfile.prompt },
    tools: { enabled: [...baseProfile.tools.enabled] },
    skills: { ...baseProfile.skills },
    logging: { ...baseProfile.logging },
    branding: { ...baseProfile.branding },
  };

  const hasConfigId = isNonEmptyString(config.id);

  if (hasConfigId) {
    profile.id = config.id!.trim();
  }
  if (isNonEmptyString(config.displayName)) {
    profile.displayName = config.displayName.trim();
    profile.prompt.displayName = config.displayName.trim();
  }
  if (config.surface) {
    profile.surface = config.surface;
  }
  if (isNonEmptyString(config.workingDirectory)) {
    profile.workingDirectory = resolvePath(config.workingDirectory, options.configDir, options.homeDir);
  }
  if (config.model) {
    profile.model = {
      ...profile.model,
      ...filterModelConfig(config.model),
    };
  }
  if (config.prompt) {
    if (isNonEmptyString(config.prompt.file)) {
      profile.prompt.file = config.prompt.file.trim();
    }
    if (config.prompt.contextFiles) {
      profile.prompt.contextFiles = config.prompt.contextFiles
        .map(item => resolvePath(item, options.configDir, options.homeDir));
    }
    if (typeof config.prompt.runtimeInfo === 'boolean') {
      profile.prompt.runtimeInfo = config.prompt.runtimeInfo;
    }
    if (typeof config.prompt.surfaceInfo === 'boolean') {
      profile.prompt.surfaceInfo = config.prompt.surfaceInfo;
    }
    if (isNonEmptyString(config.prompt.displayName)) {
      profile.prompt.displayName = config.prompt.displayName.trim();
    }
    if (isNonEmptyString(config.prompt.platform)) {
      profile.prompt.platform = config.prompt.platform.trim();
    }
  }
  if (config.tools?.enabled) {
    profile.tools.enabled = [...config.tools.enabled];
  }
  if (typeof config.skills?.enabled === 'boolean') {
    profile.skills.enabled = config.skills.enabled;
  }
  if (config.logging) {
    profile.logging = {
      ...profile.logging,
      ...config.logging,
    };
  }
  if (typeof config.branding?.enabled === 'boolean') {
    profile.branding.enabled = config.branding.enabled;
  }

  if (options.surfaceOverride) {
    profile.surface = options.surfaceOverride;
  }
  if (!hasConfigId) {
    profile.id = `xiaoba-${profile.surface}`;
  }

  return profile;
}

function parseRuntimeProfileConfig(raw: unknown): {
  schemaVersion?: number;
  profileConfig?: RuntimeProfileFileConfig;
  issues: RuntimeProfileConfigIssue[];
} {
  const issues: RuntimeProfileConfigIssue[] = [];

  if (!isRecord(raw)) {
    return {
      issues: [{ path: '$', message: 'Runtime profile file must be a JSON object' }],
    };
  }

  const schemaVersion = typeof raw.schemaVersion === 'number'
    ? raw.schemaVersion
    : undefined;

  if (schemaVersion !== RUNTIME_PROFILE_SCHEMA_VERSION) {
    return {
      schemaVersion,
      issues: [{
        path: 'schemaVersion',
        message: `Expected schemaVersion ${RUNTIME_PROFILE_SCHEMA_VERSION}`,
      }],
    };
  }

  if (raw.profile === undefined) {
    return {
      schemaVersion,
      profileConfig: {},
      issues,
    };
  }

  if (!isRecord(raw.profile)) {
    return {
      schemaVersion,
      issues: [{ path: 'profile', message: 'profile must be an object' }],
    };
  }

  const profile = raw.profile;
  const profileConfig: RuntimeProfileFileConfig = {};

  copyString(profile, profileConfig as Record<string, unknown>, 'id', 'profile.id', issues);
  copyString(profile, profileConfig as Record<string, unknown>, 'displayName', 'profile.displayName', issues);
  copySurface(profile, profileConfig, issues);
  copyString(profile, profileConfig as Record<string, unknown>, 'workingDirectory', 'profile.workingDirectory', issues);
  copyModel(profile, profileConfig, issues);
  copyPrompt(profile, profileConfig, issues);
  copyTools(profile, profileConfig, issues);
  copySkills(profile, profileConfig, issues);
  copyLogging(profile, profileConfig, issues);
  copyBranding(profile, profileConfig, issues);

  return {
    schemaVersion,
    profileConfig,
    issues,
  };
}

function copyString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  issuePath: string,
  issues: RuntimeProfileConfigIssue[],
): void {
  if (source[key] === undefined) return;
  if (typeof source[key] !== 'string') {
    issues.push({ path: issuePath, message: 'Expected string' });
    return;
  }
  target[key] = source[key];
}

function copySurface(
  source: Record<string, unknown>,
  target: RuntimeProfileFileConfig,
  issues: RuntimeProfileConfigIssue[],
): void {
  if (source.surface === undefined) return;
  if (!isRuntimeSurface(source.surface)) {
    issues.push({ path: 'profile.surface', message: 'Unknown runtime surface' });
    return;
  }
  target.surface = source.surface;
}

function copyModel(
  source: Record<string, unknown>,
  target: RuntimeProfileFileConfig,
  issues: RuntimeProfileConfigIssue[],
): void {
  if (source.model === undefined) return;
  if (!isRecord(source.model)) {
    issues.push({ path: 'profile.model', message: 'model must be an object' });
    return;
  }

  const model: RuntimeProfileFileModelConfig = {};
  copyString(source.model, model as Record<string, unknown>, 'provider', 'profile.model.provider', issues);
  copyString(source.model, model as Record<string, unknown>, 'apiUrl', 'profile.model.apiUrl', issues);
  copyString(source.model, model as Record<string, unknown>, 'model', 'profile.model.model', issues);
  copyNumber(source.model, model as Record<string, unknown>, 'temperature', 'profile.model.temperature', issues);
  copyNumber(source.model, model as Record<string, unknown>, 'maxTokens', 'profile.model.maxTokens', issues);

  if (source.model.apiKey !== undefined) {
    issues.push({
      path: 'profile.model.apiKey',
      message: 'Secrets are not allowed in runtime profile files; keep API keys in env or user config',
    });
  }

  target.model = model;
}

function copyPrompt(
  source: Record<string, unknown>,
  target: RuntimeProfileFileConfig,
  issues: RuntimeProfileConfigIssue[],
): void {
  if (source.prompt === undefined) return;
  if (!isRecord(source.prompt)) {
    issues.push({ path: 'profile.prompt', message: 'prompt must be an object' });
    return;
  }

  const prompt: RuntimeProfileFilePromptConfig = {};
  copyString(source.prompt, prompt as Record<string, unknown>, 'file', 'profile.prompt.file', issues);
  copyStringArray(source.prompt, prompt as Record<string, unknown>, 'contextFiles', 'profile.prompt.contextFiles', issues);
  copyBoolean(source.prompt, prompt as Record<string, unknown>, 'runtimeInfo', 'profile.prompt.runtimeInfo', issues);
  copyBoolean(source.prompt, prompt as Record<string, unknown>, 'surfaceInfo', 'profile.prompt.surfaceInfo', issues);
  copyString(source.prompt, prompt as Record<string, unknown>, 'displayName', 'profile.prompt.displayName', issues);
  copyString(source.prompt, prompt as Record<string, unknown>, 'platform', 'profile.prompt.platform', issues);
  target.prompt = prompt;
}

function copyTools(
  source: Record<string, unknown>,
  target: RuntimeProfileFileConfig,
  issues: RuntimeProfileConfigIssue[],
): void {
  if (source.tools === undefined) return;
  if (!isRecord(source.tools)) {
    issues.push({ path: 'profile.tools', message: 'tools must be an object' });
    return;
  }
  if (source.tools.enabled === undefined) {
    target.tools = {};
    return;
  }
  if (!Array.isArray(source.tools.enabled)) {
    issues.push({ path: 'profile.tools.enabled', message: 'Expected string array' });
    return;
  }

  const enabled: string[] = [];
  source.tools.enabled.forEach((value, index) => {
    if (typeof value !== 'string') {
      issues.push({ path: `profile.tools.enabled[${index}]`, message: 'Expected string' });
      return;
    }
    enabled.push(value);
  });
  target.tools = { enabled };
}

function copyStringArray(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  issuePath: string,
  issues: RuntimeProfileConfigIssue[],
): void {
  if (source[key] === undefined) return;
  if (!Array.isArray(source[key])) {
    issues.push({ path: issuePath, message: 'Expected string array' });
    return;
  }

  const values: string[] = [];
  source[key].forEach((value, index) => {
    if (typeof value !== 'string') {
      issues.push({ path: `${issuePath}[${index}]`, message: 'Expected string' });
      return;
    }
    values.push(value);
  });
  target[key] = values;
}

function copySkills(
  source: Record<string, unknown>,
  target: RuntimeProfileFileConfig,
  issues: RuntimeProfileConfigIssue[],
): void {
  if (source.skills === undefined) return;
  if (!isRecord(source.skills)) {
    issues.push({ path: 'profile.skills', message: 'skills must be an object' });
    return;
  }
  if (source.skills.enabled !== undefined && typeof source.skills.enabled !== 'boolean') {
    issues.push({ path: 'profile.skills.enabled', message: 'Expected boolean' });
    return;
  }
  target.skills = { enabled: source.skills.enabled as boolean | undefined };
}

function copyLogging(
  source: Record<string, unknown>,
  target: RuntimeProfileFileConfig,
  issues: RuntimeProfileConfigIssue[],
): void {
  if (source.logging === undefined) return;
  if (!isRecord(source.logging)) {
    issues.push({ path: 'profile.logging', message: 'logging must be an object' });
    return;
  }

  const logging: Partial<RuntimeLoggingProfile> = {};
  copyBoolean(source.logging, logging as Record<string, unknown>, 'sessionEvents', 'profile.logging.sessionEvents', issues);
  copyBoolean(source.logging, logging as Record<string, unknown>, 'uploadEnabled', 'profile.logging.uploadEnabled', issues);
  target.logging = logging;
}

function copyBranding(
  source: Record<string, unknown>,
  target: RuntimeProfileFileConfig,
  issues: RuntimeProfileConfigIssue[],
): void {
  if (source.branding === undefined) return;
  if (!isRecord(source.branding)) {
    issues.push({ path: 'profile.branding', message: 'branding must be an object' });
    return;
  }

  const branding: RuntimeProfileFileBrandingConfig = {};
  copyBoolean(source.branding, branding as Record<string, unknown>, 'enabled', 'profile.branding.enabled', issues);
  target.branding = branding;
}

function copyNumber(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  issuePath: string,
  issues: RuntimeProfileConfigIssue[],
): void {
  if (source[key] === undefined) return;
  if (typeof source[key] !== 'number' || Number.isNaN(source[key])) {
    issues.push({ path: issuePath, message: 'Expected number' });
    return;
  }
  target[key] = source[key];
}

function copyBoolean(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  issuePath: string,
  issues: RuntimeProfileConfigIssue[],
): void {
  if (source[key] === undefined) return;
  if (typeof source[key] !== 'boolean') {
    issues.push({ path: issuePath, message: 'Expected boolean' });
    return;
  }
  target[key] = source[key];
}

function filterModelConfig(model: RuntimeProfileFileModelConfig): RuntimeProfileFileModelConfig {
  return {
    ...(model.provider !== undefined ? { provider: model.provider } : {}),
    ...(model.apiUrl !== undefined ? { apiUrl: model.apiUrl } : {}),
    ...(model.model !== undefined ? { model: model.model } : {}),
    ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
  };
}

function resolvePath(value: string, baseDir: string, homeDir?: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') {
    return homeDir ?? os.homedir();
  }
  if (trimmed.startsWith('~/')) {
    return path.resolve(homeDir ?? os.homedir(), trimmed.slice(2));
  }
  return path.resolve(baseDir, trimmed);
}

function isRuntimeSurface(value: unknown): value is RuntimeSurface {
  return value === 'cli'
    || value === 'feishu'
    || value === 'catscompany'
    || value === 'weixin'
    || value === 'agent'
    || value === 'unknown';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
