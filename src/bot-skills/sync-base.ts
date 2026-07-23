import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotSkillRef } from '../bot-definition/types';
import type {
  LocalSkillManifest,
  LocalSkillManifestEntry,
} from './local-manifest';

export const BOT_SKILL_SYNC_BASE_SCHEMA = 'xiaoba.bot-skill-sync-base.v1';

const MAX_SYNC_BASE_BYTES = 2 * 1024 * 1024;

export interface BotSkillSyncLocalSourceRef {
  skillId: string;
  version: string;
  installedChecksum?: string;
  installedContentHash?: string;
}

export interface BotSkillSyncLocalEntry {
  localSkillId: string;
  name: string;
  path: string;
  enabled: boolean;
  contentHash: string;
  source: 'local' | 'skillhub';
  sourceRef?: BotSkillSyncLocalSourceRef;
}

export interface BotSkillSyncBinding {
  localSkillId: string;
  ref: BotSkillRef;
  storage: 'skillhub-mirror' | 'simulated-private';
  artifactDigest: string;
}

export interface BotSkillSyncProjection<T> {
  entries: T[];
  digest: string;
}

export interface BotSkillSyncBase {
  schema: typeof BOT_SKILL_SYNC_BASE_SCHEMA;
  botId: string;
  workspaceId: string;
  local: BotSkillSyncProjection<BotSkillSyncLocalEntry>;
  bindings: BotSkillSyncBinding[];
  bindingsDigest: string;
  cloud: BotSkillSyncProjection<BotSkillRef>;
  syncedAt: string;
}

export type BotSkillSyncBaseReadResult =
  | { status: 'missing' }
  | { status: 'invalid'; reason: string }
  | { status: 'valid'; base: BotSkillSyncBase };

export interface BotSkillSyncBaseRepository {
  inspect(botId: string, workspaceId: string): BotSkillSyncBaseReadResult;
  write(base: BotSkillSyncBase): void;
}

export interface FileBotSkillSyncBaseRepositoryOptions {
  runtimeRoot: string;
  root?: string;
}

export class FileBotSkillSyncBaseRepository implements BotSkillSyncBaseRepository {
  readonly root: string;

  constructor(options: FileBotSkillSyncBaseRepositoryOptions) {
    const runtimeRoot = path.resolve(options.runtimeRoot);
    this.root = path.resolve(
      options.root ?? path.join(runtimeRoot, 'data', 'bot-definition', 'sync-base'),
    );
    assertContained(runtimeRoot, this.root, 'Bot Skill sync-base root');
  }

  inspect(botId: string, workspaceId: string): BotSkillSyncBaseReadResult {
    const filePath = this.filePath(botId, workspaceId);
    try {
      const stat = fs.lstatSync(filePath);
      assertRealDirectory(path.dirname(filePath), 'sync-base directory');
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { status: 'invalid', reason: 'sync-base is not a regular file' };
      }
      if (stat.size > MAX_SYNC_BASE_BYTES) {
        return { status: 'invalid', reason: 'sync-base exceeds the size limit' };
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      const base = parseSyncBase(parsed, botId, workspaceId);
      return base
        ? { status: 'valid', base }
        : { status: 'invalid', reason: 'sync-base schema or digest is invalid' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'missing' };
      return {
        status: 'invalid',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  write(base: BotSkillSyncBase): void {
    const normalized = createBotSkillSyncBase({
      botId: base.botId,
      workspaceId: base.workspaceId,
      localEntries: base.local.entries,
      bindings: base.bindings,
      cloudSkills: base.cloud.entries,
      syncedAt: base.syncedAt,
    });
    const filePath = this.filePath(normalized.botId, normalized.workspaceId);
    writeJsonAtomic(this.root, filePath, normalized, MAX_SYNC_BASE_BYTES);
  }

  getPath(botId: string, workspaceId: string): string {
    return this.filePath(botId, workspaceId);
  }

  private filePath(botId: string, workspaceId: string): string {
    const botScope = sha256(required(botId, 'botId'));
    const workspaceScope = sha256(required(workspaceId, 'workspaceId'));
    return path.join(this.root, `b_${botScope}`, `w_${workspaceScope}.json`);
  }
}

export function projectLocalManifest(
  manifest: LocalSkillManifest,
): BotSkillSyncLocalEntry[] {
  if (manifest.status !== 'complete') {
    throw new Error(`Cannot project an incomplete Local Skill manifest: ${manifest.status}`);
  }
  return normalizeLocalEntries(manifest.entries.map(projectLocalEntry));
}

export function projectCloudSkills(
  skills: readonly BotSkillRef[],
): BotSkillRef[] {
  const versions = new Map<string, string>();
  for (const raw of skills) {
    const skillId = required(raw?.skillId, 'skillId');
    const version = required(raw?.version, 'version');
    const previous = versions.get(skillId);
    if (previous && previous !== version) {
      throw new Error(`Cloud Skill ${skillId} has multiple versions`);
    }
    versions.set(skillId, version);
  }
  return [...versions.entries()]
    .map(([skillId, version]) => ({ skillId, version }))
    .sort((left, right) =>
      compareUtf8(left.skillId, right.skillId)
      || compareUtf8(left.version, right.version));
}

export function createBotSkillSyncBase(options: {
  botId: string;
  workspaceId: string;
  localEntries: readonly BotSkillSyncLocalEntry[];
  bindings: readonly BotSkillSyncBinding[];
  cloudSkills: readonly BotSkillRef[];
  syncedAt?: string;
}): BotSkillSyncBase {
  const localEntries = normalizeLocalEntries(options.localEntries);
  const cloudSkills = projectCloudSkills(options.cloudSkills);
  const bindings = normalizeBindings(options.bindings, localEntries);
  validateBindingProjection(localEntries, bindings, cloudSkills);
  const syncedAt = new Date(options.syncedAt ?? new Date().toISOString()).toISOString();
  return {
    schema: BOT_SKILL_SYNC_BASE_SCHEMA,
    botId: required(options.botId, 'botId'),
    workspaceId: required(options.workspaceId, 'workspaceId'),
    local: {
      entries: localEntries,
      digest: digest(localEntries),
    },
    bindings,
    bindingsDigest: digest(bindings),
    cloud: {
      entries: cloudSkills,
      digest: digest(cloudSkills),
    },
    syncedAt,
  };
}

export function localProjectionDigest(
  entries: readonly BotSkillSyncLocalEntry[],
): string {
  return digest(normalizeLocalEntries(entries));
}

export function cloudProjectionDigest(skills: readonly BotSkillRef[]): string {
  return digest(projectCloudSkills(skills));
}

function projectLocalEntry(entry: LocalSkillManifestEntry): BotSkillSyncLocalEntry {
  return {
    localSkillId: required(entry.localSkillId, 'localSkillId'),
    name: required(entry.name, 'name').normalize('NFC'),
    path: normalizeRelativePath(entry.path),
    enabled: entry.enabled === true,
    contentHash: requiredHash(entry.contentHash, 'contentHash'),
    source: entry.source,
    ...(entry.source === 'skillhub' ? {
      sourceRef: {
        skillId: required(entry.skillId, 'skillId'),
        version: required(entry.version, 'version'),
        ...(entry.installedChecksum
          ? { installedChecksum: requiredHash(entry.installedChecksum, 'installedChecksum') }
          : {}),
        ...(entry.installedContentHash
          ? { installedContentHash: requiredHash(entry.installedContentHash, 'installedContentHash') }
          : {}),
      },
    } : {}),
  };
}

function normalizeLocalEntries(
  entries: readonly BotSkillSyncLocalEntry[],
): BotSkillSyncLocalEntry[] {
  const seen = new Set<string>();
  const normalized = entries.map(raw => {
    const localSkillId = required(raw?.localSkillId, 'localSkillId');
    if (seen.has(localSkillId)) throw new Error(`Duplicate localSkillId: ${localSkillId}`);
    seen.add(localSkillId);
    const source = raw?.source;
    if (source !== 'local' && source !== 'skillhub') {
      throw new Error(`Invalid Local Skill source for ${localSkillId}`);
    }
    const sourceRef = raw.sourceRef && {
      skillId: required(raw.sourceRef.skillId, 'sourceRef.skillId'),
      version: required(raw.sourceRef.version, 'sourceRef.version'),
      ...(raw.sourceRef.installedChecksum
        ? { installedChecksum: requiredHash(raw.sourceRef.installedChecksum, 'installedChecksum') }
        : {}),
      ...(raw.sourceRef.installedContentHash
        ? { installedContentHash: requiredHash(raw.sourceRef.installedContentHash, 'installedContentHash') }
        : {}),
    };
    if (source === 'skillhub' && !sourceRef) {
      throw new Error(`SkillHub Local Skill ${localSkillId} is missing sourceRef`);
    }
    return {
      localSkillId,
      name: required(raw.name, 'name').normalize('NFC'),
      path: normalizeRelativePath(raw.path),
      enabled: raw.enabled === true,
      contentHash: requiredHash(raw.contentHash, 'contentHash'),
      source,
      ...(sourceRef ? { sourceRef } : {}),
    } satisfies BotSkillSyncLocalEntry;
  });
  return normalized.sort((left, right) => compareUtf8(left.localSkillId, right.localSkillId));
}

function normalizeBindings(
  bindings: readonly BotSkillSyncBinding[],
  localEntries: readonly BotSkillSyncLocalEntry[],
): BotSkillSyncBinding[] {
  const localIds = new Set(localEntries.map(entry => entry.localSkillId));
  const seen = new Set<string>();
  return bindings.map(raw => {
    const localSkillId = required(raw?.localSkillId, 'binding.localSkillId');
    if (!localIds.has(localSkillId)) {
      throw new Error(`Binding references unknown localSkillId: ${localSkillId}`);
    }
    if (seen.has(localSkillId)) throw new Error(`Duplicate binding: ${localSkillId}`);
    seen.add(localSkillId);
    if (raw.storage !== 'skillhub-mirror' && raw.storage !== 'simulated-private') {
      throw new Error(`Invalid binding storage: ${String(raw.storage)}`);
    }
    return {
      localSkillId,
      ref: {
        skillId: required(raw.ref?.skillId, 'binding.ref.skillId'),
        version: required(raw.ref?.version, 'binding.ref.version'),
      },
      storage: raw.storage,
      artifactDigest: requiredHash(raw.artifactDigest, 'binding.artifactDigest'),
    } satisfies BotSkillSyncBinding;
  }).sort((left, right) => compareUtf8(left.localSkillId, right.localSkillId));
}

function parseSyncBase(
  value: unknown,
  expectedBotId: string,
  expectedWorkspaceId: string,
): BotSkillSyncBase | undefined {
  const raw = value as Partial<BotSkillSyncBase> | null;
  if (
    raw?.schema !== BOT_SKILL_SYNC_BASE_SCHEMA
    || raw.botId !== expectedBotId
    || raw.workspaceId !== expectedWorkspaceId
    || !raw.local
    || !raw.cloud
    || !Array.isArray(raw.local.entries)
    || !Array.isArray(raw.cloud.entries)
    || !Array.isArray(raw.bindings)
    || typeof raw.bindingsDigest !== 'string'
    || typeof raw.syncedAt !== 'string'
  ) {
    return undefined;
  }
  try {
    const base = createBotSkillSyncBase({
      botId: raw.botId,
      workspaceId: raw.workspaceId,
      localEntries: raw.local.entries,
      bindings: raw.bindings,
      cloudSkills: raw.cloud.entries,
      syncedAt: raw.syncedAt,
    });
    if (
      base.local.digest !== raw.local.digest
      || base.bindingsDigest !== raw.bindingsDigest
      || base.cloud.digest !== raw.cloud.digest
    ) {
      return undefined;
    }
    return base;
  } catch {
    return undefined;
  }
}

function validateBindingProjection(
  localEntries: readonly BotSkillSyncLocalEntry[],
  bindings: readonly BotSkillSyncBinding[],
  cloudSkills: readonly BotSkillRef[],
): void {
  if (bindings.length !== localEntries.length) {
    throw new Error('Every Local Skill must have exactly one Cloud artifact binding');
  }
  const bindingByLocalId = new Map(bindings.map(binding => [binding.localSkillId, binding]));
  for (const local of localEntries) {
    if (!bindingByLocalId.has(local.localSkillId)) {
      throw new Error(`Local Skill has no artifact binding: ${local.localSkillId}`);
    }
  }
  const expectedActiveRefs = projectCloudSkills(
    localEntries
      .filter(local => local.enabled)
      .map(local => bindingByLocalId.get(local.localSkillId)!.ref),
  );
  if (digest(expectedActiveRefs) !== digest(cloudSkills)) {
    throw new Error('Enabled Local Skill bindings do not match Cloud Skill refs');
  }
}

function digest(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function required(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 1024) throw new Error(`${field} is required or too long`);
  return text;
}

function requiredHash(value: unknown, field: string): string {
  const text = required(value, field).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${field} must be SHA-256`);
  return text;
}

function normalizeRelativePath(value: unknown): string {
  const text = required(value, 'path').replace(/\\/g, '/').normalize('NFC');
  if (
    path.posix.isAbsolute(text)
    || text === '.'
    || text.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid relative Skill path: ${text}`);
  }
  return text;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function writeJsonAtomic(
  safeRoot: string,
  filePath: string,
  value: unknown,
  maxBytes: number,
): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`JSON record exceeds ${maxBytes} bytes`);
  }
  ensureSafeDirectory(safeRoot, path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // The rename is the commit point; permission hardening is best effort.
    }
  }
}

function ensureSafeDirectory(safeRoot: string, directory: string): void {
  const root = path.resolve(safeRoot);
  const target = path.resolve(directory);
  assertContained(root, target, 'sync-base directory');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(root);
  if (
    !rootStat.isDirectory()
    || rootStat.isSymbolicLink()
    || !samePath(root, fs.realpathSync.native(root))
  ) {
    throw new Error(`Unsafe sync-base root: ${root}`);
  }
  let current = root;
  const relative = path.relative(root, target);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || !samePath(current, fs.realpathSync.native(current))
    ) {
      throw new Error(`Unsafe sync-base directory: ${current}`);
    }
  }
}

function assertRealDirectory(directory: string, label: string): void {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || !samePath(resolved, fs.realpathSync.native(resolved))
  ) {
    throw new Error(`Unsafe ${label}: ${directory}`);
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function assertContained(root: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its root`);
  }
}
