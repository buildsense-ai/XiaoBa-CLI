import * as fs from 'fs';
import * as path from 'path';
import { PathResolver } from '../utils/path-resolver';
import {
  BOT_CATALOG_MODEL_RUNTIME_SCHEMA,
  BOT_CUSTOM_MODEL_PROFILE_SCHEMA,
  type BotCatalogModelRuntime,
  type BotCustomModelProfile,
  type BotDefinition,
  type CustomBotModelDefinition,
} from './types';

export interface BotDefinitionRepository {
  readCanonical(botId: string): BotDefinition | undefined;
  writeCanonical(definition: BotDefinition): void;
  readCache(botId: string): BotDefinition | undefined;
  writeCache(definition: BotDefinition): void;
}

/**
 * Per-device catalog runtime material. This is intentionally a separate
 * repository because relay credentials are not part of the portable bot
 * definition.
 */
export interface BotCatalogModelRuntimeRepository {
  read(botId: string): BotCatalogModelRuntime | undefined;
  write(runtime: BotCatalogModelRuntime): void;
}

export interface BotCustomModelProfileRepository {
  read(botId: string): BotCustomModelProfile | undefined;
  write(profile: BotCustomModelProfile): void;
}

export interface FileBotDefinitionRepositoryOptions {
  runtimeRoot?: string;
  simulatedCloudRoot?: string;
  cacheRoot?: string;
}

function normalizeBotId(botId: string): string {
  const value = String(botId || '').trim();
  if (!value) throw new Error('botId is required');
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) {
    throw new Error('botId contains unsupported characters');
  }
  return value;
}

function isValidDefinition(definition: unknown, expectedBotId: string): definition is BotDefinition {
  const value = definition as BotDefinition | undefined;
  if (!value || value.schema !== 'xiaoba.bot-definition.v1' || value.botId !== expectedBotId || !value.model) {
    return false;
  }
  if (value.model.kind === 'catalog') {
    return Boolean(String(value.model.modelId || '').trim());
  }
  if (value.model.kind !== 'custom') return false;
  return isValidCustomModel(value.model);
}

function isValidCustomModel(model: unknown): model is CustomBotModelDefinition {
  const value = model as CustomBotModelDefinition | undefined;
  return (
    value?.kind === 'custom'
    && ['anthropic', 'openai-chat-completions', 'openai-responses'].includes(value.protocol)
    && Boolean(String(value.apiBase || '').trim())
    && Boolean(String(value.model || '').trim())
    && Boolean(String(value.apiKey || '').trim())
    && Number.isFinite(value.contextWindowTokens)
    && value.contextWindowTokens > 0
  );
}

function isValidCatalogRuntime(runtime: unknown, expectedBotId: string): runtime is BotCatalogModelRuntime {
  const value = runtime as BotCatalogModelRuntime | undefined;
  return Boolean(
    value
      && value.schema === BOT_CATALOG_MODEL_RUNTIME_SCHEMA
      && value.botId === expectedBotId
      && String(value.modelId || '').trim()
      && (value.provider === 'anthropic' || value.provider === 'openai')
      && String(value.apiBase || '').trim()
      && String(value.apiKey || '').trim()
      && String(value.model || '').trim()
      && Number.isFinite(value.contextWindowTokens)
      && value.contextWindowTokens > 0,
  );
}

function isValidCustomModelProfile(profile: unknown, expectedBotId: string): profile is BotCustomModelProfile {
  const value = profile as BotCustomModelProfile | undefined;
  return Boolean(
    value
      && value.schema === BOT_CUSTOM_MODEL_PROFILE_SCHEMA
      && value.botId === expectedBotId
      && isValidCustomModel(value.model),
  );
}

function readDefinition(filePath: string, expectedBotId: string): BotDefinition | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as BotDefinition;
    return isValidDefinition(parsed, expectedBotId) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeDefinition(filePath: string, definition: BotDefinition): void {
  if (!isValidDefinition(definition, definition.botId)) {
    throw new Error('BotDefinition is invalid');
  }
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(definition, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Existing installs must remain usable on filesystems without POSIX modes.
    }
  }
}

function writeCatalogRuntime(filePath: string, runtime: BotCatalogModelRuntime): void {
  if (!isValidCatalogRuntime(runtime, runtime.botId)) {
    throw new Error('Bot catalog model runtime is invalid');
  }
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(runtime, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Existing installs must remain usable on filesystems without POSIX modes.
    }
  }
}

function writeCustomModelProfile(filePath: string, profile: BotCustomModelProfile): void {
  if (!isValidCustomModelProfile(profile, profile.botId)) {
    throw new Error('Bot custom model profile is invalid');
  }
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Existing installs must remain usable on filesystems without POSIX modes.
    }
  }
}

/**
 * File-backed stand-in for the future cloud BotDefinition API. The interface
 * keeps the application code independent from whether the canonical record is
 * a file today or a CatsCompany endpoint later.
 */
export class FileBotDefinitionRepository implements BotDefinitionRepository {
  private readonly canonicalRoot: string;
  private readonly cacheRoot: string;

  constructor(options: FileBotDefinitionRepositoryOptions = {}) {
    const runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
    this.canonicalRoot = path.resolve(
      options.simulatedCloudRoot
        ?? process.env.XIAOBA_BOT_DEFINITION_SIMULATED_CLOUD_DIR
        ?? path.join(runtimeRoot, 'data', 'bot-definition-simulated-cloud'),
    );
    this.cacheRoot = path.resolve(
      options.cacheRoot
        ?? path.join(runtimeRoot, 'data', 'bot-definition-cache'),
    );
  }

  readCanonical(botId: string): BotDefinition | undefined {
    const normalized = normalizeBotId(botId);
    return readDefinition(this.definitionPath(this.canonicalRoot, normalized), normalized);
  }

  writeCanonical(definition: BotDefinition): void {
    const botId = normalizeBotId(definition.botId);
    writeDefinition(this.definitionPath(this.canonicalRoot, botId), definition);
  }

  readCache(botId: string): BotDefinition | undefined {
    const normalized = normalizeBotId(botId);
    return readDefinition(this.definitionPath(this.cacheRoot, normalized), normalized);
  }

  writeCache(definition: BotDefinition): void {
    const botId = normalizeBotId(definition.botId);
    writeDefinition(this.definitionPath(this.cacheRoot, botId), definition);
  }

  getCanonicalPath(botId: string): string {
    return this.definitionPath(this.canonicalRoot, normalizeBotId(botId));
  }

  getCachePath(botId: string): string {
    return this.definitionPath(this.cacheRoot, normalizeBotId(botId));
  }

  private definitionPath(root: string, botId: string): string {
    return path.join(root, 'bots', `${botId}.json`);
  }
}

export class FileBotCatalogModelRuntimeRepository implements BotCatalogModelRuntimeRepository {
  private readonly root: string;

  constructor(options: FileBotDefinitionRepositoryOptions = {}) {
    const runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
    this.root = path.resolve(path.join(runtimeRoot, 'data', 'bot-catalog-model-runtime'));
  }

  read(botId: string): BotCatalogModelRuntime | undefined {
    const normalized = normalizeBotId(botId);
    const filePath = this.runtimePath(normalized);
    if (!fs.existsSync(filePath)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as BotCatalogModelRuntime;
      return isValidCatalogRuntime(parsed, normalized) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  write(runtime: BotCatalogModelRuntime): void {
    const botId = normalizeBotId(runtime.botId);
    writeCatalogRuntime(this.runtimePath(botId), runtime);
  }

  getPath(botId: string): string {
    return this.runtimePath(normalizeBotId(botId));
  }

  private runtimePath(botId: string): string {
    return path.join(this.root, 'bots', `${botId}.json`);
  }
}

export class FileBotCustomModelProfileRepository implements BotCustomModelProfileRepository {
  private readonly root: string;

  constructor(options: FileBotDefinitionRepositoryOptions = {}) {
    const runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
    this.root = path.resolve(path.join(runtimeRoot, 'data', 'bot-custom-model-profile'));
  }

  read(botId: string): BotCustomModelProfile | undefined {
    const normalized = normalizeBotId(botId);
    const filePath = this.profilePath(normalized);
    if (!fs.existsSync(filePath)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as BotCustomModelProfile;
      return isValidCustomModelProfile(parsed, normalized) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  write(profile: BotCustomModelProfile): void {
    const botId = normalizeBotId(profile.botId);
    writeCustomModelProfile(this.profilePath(botId), { ...profile, botId });
  }

  getPath(botId: string): string {
    return this.profilePath(normalizeBotId(botId));
  }

  private profilePath(botId: string): string {
    return path.join(this.root, 'bots', `${botId}.json`);
  }
}
