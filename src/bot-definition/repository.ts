import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'node:crypto';
import { PathResolver } from '../utils/path-resolver';
import {
  BOT_CATALOG_MODEL_RUNTIME_SCHEMA,
  BOT_CUSTOM_MODEL_PROFILE_SCHEMA,
  type BotCatalogModelRuntime,
  type BotCloudModelOverride,
  type BotCustomModelProfile,
  type BotDefinition,
  type BotSkillRef,
  type CustomBotModelDefinition,
} from './types';
import { isValidBotSkillRef } from './skill-ref';

const MAX_DEFINITION_BYTES = 2 * 1024 * 1024;

export interface BotDefinitionRepository {
  inspectCanonical(botId: string): BotDefinitionReadResult;
  readCanonical(botId: string): BotDefinition | undefined;
  writeCanonical(definition: BotDefinition): void;
  readCache(botId: string): BotDefinition | undefined;
  writeCache(definition: BotDefinition): void;
  /** File implementations serialize field-preserving read/modify/write updates per Bot. */
  withCanonicalLock?<T>(botId: string, action: () => T): T;
}

export type BotDefinitionReadResult =
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'valid'; definition: BotDefinition };

export interface BotCloudModelOverrideRepository {
  read(botId: string): BotCloudModelOverride | undefined;
  write(definition: BotCloudModelOverride): void;
  delete(botId: string): void;
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
  catalogRuntimeRoot?: string;
  cloudOverrideRoot?: string;
  cloudCatalogRuntimeRoot?: string;
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
  if (value.skills !== undefined && !isValidSkillRefs(value.skills)) return false;
  if (value.model.kind === 'catalog') {
    return Boolean(String(value.model.modelId || '').trim());
  }
  if (value.model.kind !== 'custom') return false;
  return isValidCustomModel(value.model);
}

function isValidSkillRefs(skills: unknown): skills is BotSkillRef[] {
  if (!Array.isArray(skills) || skills.length > 256) return false;
  const versionsBySkillId = new Map<string, string>();
  for (const entry of skills) {
    if (!isValidBotSkillRef(entry)) return false;
    const skillId = entry.skillId.trim();
    const version = entry.version.trim();
    const previousVersion = versionsBySkillId.get(skillId);
    if (previousVersion && previousVersion !== version) return false;
    versionsBySkillId.set(skillId, version);
  }
  return true;
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

function inspectDefinition(filePath: string, expectedBotId: string): BotDefinitionReadResult {
  try {
    assertDefinitionDirectorySafe(path.dirname(filePath));
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DEFINITION_BYTES) {
      return { status: 'invalid' };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as BotDefinition;
    return isValidDefinition(parsed, expectedBotId)
      ? { status: 'valid', definition: parsed }
      : { status: 'invalid' };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { status: 'missing' };
    return { status: 'invalid' };
  }
}

function readDefinition(filePath: string, expectedBotId: string): BotDefinition | undefined {
  const result = inspectDefinition(filePath, expectedBotId);
  return result.status === 'valid' ? result.definition : undefined;
}

function writeDefinition(filePath: string, definition: BotDefinition): void {
  if (!isValidDefinition(definition, definition.botId)) {
    throw new Error('BotDefinition is invalid');
  }
  const serialized = `${JSON.stringify(definition, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DEFINITION_BYTES) {
    throw new Error('BotDefinition exceeds the local size limit');
  }
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  assertDefinitionDirectorySafe(directory);
  if (fs.existsSync(filePath)) {
    const current = fs.lstatSync(filePath);
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new Error(`BotDefinition path is unsafe: ${filePath}`);
    }
  }
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, serialized, {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
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
  private readonly lockRoot: string;

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
    this.lockRoot = path.join(this.canonicalRoot, '.locks');
  }

  inspectCanonical(botId: string): BotDefinitionReadResult {
    const normalized = normalizeBotId(botId);
    return inspectDefinition(this.definitionPath(this.canonicalRoot, normalized), normalized);
  }

  readCanonical(botId: string): BotDefinition | undefined {
    const result = this.inspectCanonical(botId);
    return result.status === 'valid' ? result.definition : undefined;
  }

  writeCanonical(definition: BotDefinition): void {
    const botId = normalizeBotId(definition.botId);
    writeDefinition(this.definitionPath(this.canonicalRoot, botId), { ...definition, botId });
  }

  readCache(botId: string): BotDefinition | undefined {
    const normalized = normalizeBotId(botId);
    return readDefinition(this.definitionPath(this.cacheRoot, normalized), normalized);
  }

  writeCache(definition: BotDefinition): void {
    const botId = normalizeBotId(definition.botId);
    writeDefinition(this.definitionPath(this.cacheRoot, botId), { ...definition, botId });
  }

  withCanonicalLock<T>(botId: string, action: () => T): T {
    const normalized = normalizeBotId(botId);
    const lockPath = path.join(
      this.lockRoot,
      `b_${cryptoHash(normalized)}.lock`,
    );
    fs.mkdirSync(this.lockRoot, { recursive: true, mode: 0o700 });
    assertDefinitionDirectorySafe(this.lockRoot);
    const lockId = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    while (true) {
      try {
        fs.mkdirSync(lockPath, { mode: 0o700 });
        writeDefinitionLockOwner(lockPath, lockId);
        break;
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        if (reclaimStaleDefinitionLock(lockPath)) continue;
        throw new Error(`BotDefinition update is busy for ${normalized}`);
      }
    }
    try {
      return action();
    } finally {
      const owner = readDefinitionLockOwner(lockPath);
      if (owner?.lockId === lockId && owner.pid === process.pid) {
        fs.rmSync(lockPath, { recursive: true, force: true });
      }
    }
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

/** Device-local cloud override. The canonical/cache repositories remain the user's local preference. */
export class FileBotCloudModelOverrideRepository implements BotCloudModelOverrideRepository {
  private readonly root: string;

  constructor(options: FileBotDefinitionRepositoryOptions = {}) {
    const runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
    this.root = path.resolve(
      options.cloudOverrideRoot ?? path.join(runtimeRoot, 'data', 'bot-cloud-model-override'),
    );
  }

  read(botId: string): BotCloudModelOverride | undefined {
    const normalized = normalizeBotId(botId);
    const definition = readDefinition(this.overridePath(normalized), normalized);
    return definition && {
      schema: definition.schema,
      botId: definition.botId,
      model: definition.model,
    };
  }

  write(definition: BotCloudModelOverride): void {
    const botId = normalizeBotId(definition.botId);
    writeDefinition(this.overridePath(botId), {
      schema: definition.schema,
      botId,
      model: definition.model,
    });
  }

  delete(botId: string): void {
    const normalized = normalizeBotId(botId);
    fs.rmSync(this.overridePath(normalized), { force: true });
  }

  getPath(botId: string): string {
    return this.overridePath(normalizeBotId(botId));
  }

  private overridePath(botId: string): string {
    return path.join(this.root, 'bots', `${botId}.json`);
  }
}

export class FileBotCatalogModelRuntimeRepository implements BotCatalogModelRuntimeRepository {
  private readonly root: string;

  constructor(options: FileBotDefinitionRepositoryOptions = {}) {
    const runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
    this.root = path.resolve(
      options.catalogRuntimeRoot ?? path.join(runtimeRoot, 'data', 'bot-catalog-model-runtime'),
    );
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

export class FileBotCloudCatalogModelRuntimeRepository extends FileBotCatalogModelRuntimeRepository {
  constructor(options: FileBotDefinitionRepositoryOptions = {}) {
    const runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
    super({
      ...options,
      catalogRuntimeRoot: options.cloudCatalogRuntimeRoot
        ?? path.join(runtimeRoot, 'data', 'bot-cloud-catalog-model-runtime'),
    });
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

function cryptoHash(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertDefinitionDirectorySafe(directory: string): void {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  const real = fs.realpathSync.native(resolved);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || !samePath(resolved, real)
  ) {
    throw new Error(`BotDefinition directory is unsafe: ${directory}`);
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function writeDefinitionLockOwner(lockPath: string, lockId: string): void {
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
    lockId,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function readDefinitionLockOwner(
  lockPath: string,
): { lockId: string; pid: number; acquiredAt: string } | undefined {
  try {
    const ownerPath = path.join(lockPath, 'owner.json');
    const stat = fs.lstatSync(ownerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return undefined;
    const value = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as any;
    if (
      typeof value?.lockId !== 'string'
      || !Number.isSafeInteger(value?.pid)
      || typeof value?.acquiredAt !== 'string'
    ) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function reclaimStaleDefinitionLock(lockPath: string): boolean {
  const owner = readDefinitionLockOwner(lockPath);
  if (!owner) {
    try {
      const age = Date.now() - fs.lstatSync(lockPath).mtimeMs;
      if (age <= 5000) return false;
    } catch (error: any) {
      return error?.code === 'ENOENT';
    }
  }
  const acquiredAt = Date.parse(String(owner?.acquiredAt || ''));
  const stale = (
    !owner
    || !Number.isFinite(acquiredAt)
    || !isProcessAlive(owner.pid)
  );
  if (!stale) return false;
  const stalePath = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockPath, stalePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
  fs.rmSync(stalePath, { recursive: true, force: true });
  return true;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}
