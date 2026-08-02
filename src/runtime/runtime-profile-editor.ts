import * as fs from 'fs';
import * as path from 'path';
import {
  RuntimeProfile,
  RuntimeProfileValidationIssue,
  assertValidRuntimeProfile,
  resolveDefaultRuntimeProfile,
  validateRuntimeProfile,
} from './runtime-profile';
import {
  RuntimeProfileConfigInfo,
  RuntimeProfileFileConfig,
  RuntimeProfileConfigFile,
  RUNTIME_PROFILE_SCHEMA_VERSION,
  applyRuntimeProfileFileConfig,
  getDefaultRuntimeProfileConfigPath,
  loadRuntimeProfileConfigFile,
} from './runtime-profile-config';

const SAFE_TOP_LEVEL_CONFIG_FIELDS = new Set(['schemaVersion', 'profile']);
const SAFE_EDITABLE_PROFILE_FIELDS = new Set(['displayName', 'workingDirectory', 'tools', 'skills']);
const SAFE_TOOL_FIELDS = new Set(['enabled']);
const SAFE_SKILL_FIELDS = new Set(['enabled']);

export interface RuntimeProfileEditInput {
  displayName?: string;
  workingDirectory?: string;
  tools?: {
    enabled?: string[];
  };
  skills?: {
    enabled?: boolean;
  };
}

export interface RuntimeProfileEditOptions {
  configPath?: string;
  runtimeRoot?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RuntimeProfileEditDiff {
  path: string;
  before: unknown;
  after: unknown;
}

export interface RuntimeProfileEditPreview {
  configPath: string;
  draft: RuntimeProfileConfigFile;
  profile: RuntimeProfile;
  validation: {
    valid: boolean;
    issues: RuntimeProfileValidationIssue[];
  };
  config: RuntimeProfileConfigInfo;
  diff: RuntimeProfileEditDiff[];
}

export interface RuntimeProfileEditSaveResult extends RuntimeProfileEditPreview {
  ok: true;
  rollbackAvailable: boolean;
}

export interface RuntimeProfileRollbackResult {
  ok: true;
  restored: boolean;
  deleted: boolean;
  configPath: string;
}

interface RuntimeProfileRollbackState {
  schemaVersion: 1;
  createdAt: string;
  configPath: string;
  existed: boolean;
  content?: string;
}

export function previewRuntimeProfileEdit(
  input: RuntimeProfileEditInput,
  options: RuntimeProfileEditOptions = {},
): RuntimeProfileEditPreview {
  const normalizedInput = normalizeRuntimeProfileEditInput(input);
  const loaded = loadRuntimeProfileConfigFile(options);
  const configPath = getDefaultRuntimeProfileConfigPath(options);
  const configDir = path.dirname(configPath);
  const baseProfile = resolveDefaultRuntimeProfile({
    env: options.env,
    workingDirectory: process.cwd(),
  });
  const currentFileConfig = loaded.profileConfig ?? {};
  const safeCurrentFileConfig = stripToEditableProfileConfig(currentFileConfig);
  const draftProfileConfig = mergeEditableProfileConfig(currentFileConfig, normalizedInput);
  const draft: RuntimeProfileConfigFile = {
    schemaVersion: RUNTIME_PROFILE_SCHEMA_VERSION,
    profile: draftProfileConfig,
  };
  const profile = applyRuntimeProfileFileConfig(baseProfile, draftProfileConfig, {
    configDir,
    homeDir: options.homeDir,
  });
  const issues = validateRuntimeProfile(profile);

  return {
    configPath,
    draft,
    profile,
    validation: {
      valid: issues.length === 0,
      issues,
    },
    config: loaded.info,
    diff: buildRuntimeProfileEditDiff(safeCurrentFileConfig, draftProfileConfig),
  };
}

export function saveRuntimeProfileEdit(
  input: RuntimeProfileEditInput,
  options: RuntimeProfileEditOptions = {},
): RuntimeProfileEditSaveResult {
  const preview = previewRuntimeProfileEdit(input, options);
  if (preview.config.exists && preview.config.issues.length > 0) {
    throw new Error(`Runtime profile contains invalid or unsafe config: ${preview.config.issues
      .map(issue => issue.path)
      .join(', ')}. Fix it before saving from Dashboard.`);
  }
  const unsafeFields = findUnsafeExistingProfileFields(preview.configPath);
  if (unsafeFields.length > 0) {
    throw new Error(`Runtime profile contains non-editable or unsafe fields: ${unsafeFields.join(', ')}. Remove them before saving from Dashboard.`);
  }
  assertValidRuntimeProfile(preview.profile);

  const configPath = preview.configPath;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeRollbackState(configPath);
  fs.writeFileSync(configPath, JSON.stringify(preview.draft, null, 2) + '\n', 'utf-8');

  return {
    ...preview,
    ok: true,
    rollbackAvailable: true,
  };
}

export function rollbackRuntimeProfileEdit(
  options: RuntimeProfileEditOptions = {},
): RuntimeProfileRollbackResult {
  const configPath = getDefaultRuntimeProfileConfigPath(options);
  const rollbackPath = getRollbackPath(configPath);

  if (!fs.existsSync(rollbackPath)) {
    throw new Error('No runtime profile rollback state is available');
  }

  const state = JSON.parse(fs.readFileSync(rollbackPath, 'utf-8')) as RuntimeProfileRollbackState;
  if (state.configPath !== configPath) {
    throw new Error('Runtime profile rollback state does not match current profile path');
  }

  if (state.existed) {
    fs.writeFileSync(configPath, state.content ?? '', 'utf-8');
  } else if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
  fs.unlinkSync(rollbackPath);

  return {
    ok: true,
    restored: state.existed,
    deleted: !state.existed,
    configPath,
  };
}

export function hasRuntimeProfileRollback(
  options: RuntimeProfileEditOptions = {},
): boolean {
  return fs.existsSync(getRollbackPath(getDefaultRuntimeProfileConfigPath(options)));
}

function normalizeRuntimeProfileEditInput(input: RuntimeProfileEditInput): RuntimeProfileEditInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Runtime profile edit payload must be an object');
  }

  const normalized: RuntimeProfileEditInput = {};

  if (input.displayName !== undefined) {
    if (typeof input.displayName !== 'string' || input.displayName.trim().length === 0) {
      throw new Error('displayName must be a non-empty string');
    }
    normalized.displayName = input.displayName.trim();
  }

  if (input.workingDirectory !== undefined) {
    if (typeof input.workingDirectory !== 'string' || input.workingDirectory.trim().length === 0) {
      throw new Error('workingDirectory must be a non-empty string');
    }
    normalized.workingDirectory = input.workingDirectory.trim();
  }

  if (input.tools !== undefined) {
    if (!input.tools || typeof input.tools !== 'object' || Array.isArray(input.tools)) {
      throw new Error('tools must be an object');
    }
    if (input.tools.enabled !== undefined) {
      if (!Array.isArray(input.tools.enabled)) {
        throw new Error('tools.enabled must be a string array');
      }
      const enabled = input.tools.enabled.map((toolName, index) => {
        if (typeof toolName !== 'string' || toolName.trim().length === 0) {
          throw new Error(`tools.enabled[${index}] must be a non-empty string`);
        }
        return toolName.trim();
      });
      normalized.tools = { enabled };
    }
  }

  if (input.skills !== undefined) {
    if (!input.skills || typeof input.skills !== 'object' || Array.isArray(input.skills)) {
      throw new Error('skills must be an object');
    }
    if (input.skills.enabled !== undefined) {
      if (typeof input.skills.enabled !== 'boolean') {
        throw new Error('skills.enabled must be a boolean');
      }
      normalized.skills = { enabled: input.skills.enabled };
    }
  }

  return normalized;
}

function mergeEditableProfileConfig(
  current: RuntimeProfileFileConfig,
  input: RuntimeProfileEditInput,
): RuntimeProfileFileConfig {
  const safeCurrent = stripToEditableProfileConfig(current);
  return {
    ...safeCurrent,
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    ...(input.workingDirectory !== undefined ? { workingDirectory: input.workingDirectory } : {}),
    ...(input.tools?.enabled !== undefined
      ? { tools: { ...(safeCurrent.tools || {}), enabled: [...input.tools.enabled] } }
      : {}),
    ...(input.skills?.enabled !== undefined
      ? { skills: { ...(safeCurrent.skills || {}), enabled: input.skills.enabled } }
      : {}),
  };
}

function stripToEditableProfileConfig(config: RuntimeProfileFileConfig): RuntimeProfileFileConfig {
  return {
    ...(config.displayName !== undefined ? { displayName: config.displayName } : {}),
    ...(config.workingDirectory !== undefined ? { workingDirectory: config.workingDirectory } : {}),
    ...(config.tools?.enabled !== undefined ? { tools: { enabled: [...config.tools.enabled] } } : {}),
    ...(config.skills?.enabled !== undefined ? { skills: { enabled: config.skills.enabled } } : {}),
  };
}

function findUnsafeExistingProfileFields(configPath: string): string[] {
  if (!fs.existsSync(configPath)) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return ['$'];
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return ['$'];
  }

  const unsafe = Object.keys(parsed)
    .filter(key => !SAFE_TOP_LEVEL_CONFIG_FIELDS.has(key))
    .map(key => key);

  const profile = parsed.profile;
  if (profile === undefined) return unsafe.sort();
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    unsafe.push('profile');
    return Array.from(new Set(unsafe)).sort();
  }

  unsafe.push(...Object.keys(profile)
    .filter(key => !SAFE_EDITABLE_PROFILE_FIELDS.has(key))
    .map(key => `profile.${key}`));

  if (profile.tools !== undefined) {
    if (!profile.tools || typeof profile.tools !== 'object' || Array.isArray(profile.tools)) {
      unsafe.push('profile.tools');
    } else {
      unsafe.push(...Object.keys(profile.tools)
        .filter(key => !SAFE_TOOL_FIELDS.has(key))
        .map(key => `profile.tools.${key}`));
    }
  }

  if (profile.skills !== undefined) {
    if (!profile.skills || typeof profile.skills !== 'object' || Array.isArray(profile.skills)) {
      unsafe.push('profile.skills');
    } else {
      unsafe.push(...Object.keys(profile.skills)
        .filter(key => !SAFE_SKILL_FIELDS.has(key))
        .map(key => `profile.skills.${key}`));
    }
  }

  if (profile.model?.apiKey !== undefined) {
    unsafe.push('profile.model.apiKey');
  }

  return Array.from(new Set(unsafe)).sort();
}

function buildRuntimeProfileEditDiff(
  before: RuntimeProfileFileConfig,
  after: RuntimeProfileFileConfig,
): RuntimeProfileEditDiff[] {
  const fields: Array<{ path: string; get: (profile: RuntimeProfileFileConfig) => unknown }> = [
    { path: 'displayName', get: profile => profile.displayName },
    { path: 'workingDirectory', get: profile => profile.workingDirectory },
    { path: 'tools.enabled', get: profile => profile.tools?.enabled },
    { path: 'skills.enabled', get: profile => profile.skills?.enabled },
  ];

  return fields
    .map(field => ({
      path: field.path,
      before: field.get(before),
      after: field.get(after),
    }))
    .filter(item => JSON.stringify(item.before) !== JSON.stringify(item.after));
}

function writeRollbackState(configPath: string): void {
  const state: RuntimeProfileRollbackState = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    configPath,
    existed: fs.existsSync(configPath),
    ...(fs.existsSync(configPath)
      ? { content: fs.readFileSync(configPath, 'utf-8') }
      : {}),
  };

  fs.writeFileSync(getRollbackPath(configPath), JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

function getRollbackPath(configPath: string): string {
  return `${configPath}.rollback.json`;
}
