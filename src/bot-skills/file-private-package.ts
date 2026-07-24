import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { BotSkillReference } from '../bot-definition/types';
import {
  BOT_SKILL_SOURCE_MAX_FILES,
  BOT_SKILL_SOURCE_MAX_SINGLE_FILE_BYTES,
  BOT_SKILL_SOURCE_MAX_TOTAL_BYTES,
  compareBotSkillSourcePath,
} from './source-snapshot';
import type {
  BotPrivateSkillPackageClient,
  BotPrivateSkillUpsertInput,
  BotPrivateSkillVersion,
  BotSkillDownloadedPackage,
} from './private-package';

const FILE_PRIVATE_PACKAGE_SCHEMA = 'xiaoba.file-private-skill-package.v1';
const MAX_STORED_PACKAGE_JSON_BYTES = 30 * 1024 * 1024;

interface StoredPrivatePackage {
  schema: typeof FILE_PRIVATE_PACKAGE_SCHEMA;
  ownerBotId: string;
  ownerAuthority?: string;
  localSkillId: string;
  name: string;
  contentHash: string;
  skillId: string;
  version: string;
  createdAt: string;
  origin?: { skillId: string; version: string };
  files: Array<{
    path: string;
    size: number;
    sha256: string;
    contentBase64: string;
  }>;
}

export interface FileBotPrivateSkillPackageClientOptions {
  root: string;
  botId: string;
  authority?: string;
  now?: () => Date;
}

export class FileBotPrivateSkillPackageClient implements BotPrivateSkillPackageClient {
  private readonly root: string;
  private readonly botId: string;
  private readonly authority?: string;
  private readonly now: () => Date;

  constructor(options: FileBotPrivateSkillPackageClientOptions) {
    this.root = path.resolve(options.root);
    this.botId = normalizeId(options.botId, 'botId');
    this.authority = cleanOptional(options.authority);
    this.now = options.now ?? (() => new Date());
  }

  async upsert(input: BotPrivateSkillUpsertInput): Promise<BotPrivateSkillVersion> {
    const localSkillId = normalizeId(input.localSkillId, 'localSkillId');
    const contentHash = normalizeHash(input.snapshot.contentHash);
    verifySnapshot(input.snapshot, contentHash);
    const skillId = opaqueSkillId(this.authority, this.botId, localSkillId);
    const version = opaqueVersion(this.authority, this.botId, localSkillId, contentHash);
    const filePath = this.packagePath(skillId, version);
    if (fs.existsSync(filePath)) {
      const stored = readStored(filePath, this.botId, this.authority);
      verifyStoredIdentity(stored, { localSkillId, contentHash, skillId, version });
      verifyStoredFiles(stored);
      return versionFromStored(stored);
    }

    const stored: StoredPrivatePackage = {
      schema: FILE_PRIVATE_PACKAGE_SCHEMA,
      ownerBotId: this.botId,
      ...(this.authority ? { ownerAuthority: this.authority } : {}),
      localSkillId,
      name: String(input.name || '').trim() || localSkillId,
      contentHash,
      skillId,
      version,
      createdAt: this.now().toISOString(),
      ...(input.origin ? {
        origin: {
          skillId: String(input.origin.skillId || '').trim(),
          version: String(input.origin.version || '').trim(),
        },
      } : {}),
      files: input.snapshot.files.map(file => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        contentBase64: file.bytes.toString('base64'),
      })),
    };
    writeStoredAtomic(filePath, stored);
    return versionFromStored(stored);
  }

  async download(reference: BotSkillReference): Promise<BotSkillDownloadedPackage> {
    const skillId = normalizeOpaqueReference(reference.skillId, 'skillId');
    const version = String(reference.version || '').trim();
    normalizeOpaqueReference(version, 'version');
    const filePath = this.packagePath(skillId, version);
    if (!fs.existsSync(filePath)) {
      throw packageError('Private Skill package was not found.', 'PRIVATE_SKILL_NOT_FOUND', 404);
    }
    const stored = readStored(filePath, this.botId, this.authority);
    if (stored.skillId !== reference.skillId || stored.version !== reference.version) {
      throw packageError('Private Skill reference does not match stored content.', 'PRIVATE_SKILL_REFERENCE_MISMATCH', 409);
    }
    const files = decodeStoredFiles(stored.files);
    verifyDownloadedFiles(files, stored.contentHash);
    return {
      ...versionFromStored(stored),
      files,
    };
  }

  getPackagePath(localSkillId: string, contentHash: string): string {
    const normalizedLocalSkillId = normalizeId(localSkillId, 'localSkillId');
    const normalizedContentHash = normalizeHash(contentHash);
    return this.packagePath(
      opaqueSkillId(this.authority, this.botId, normalizedLocalSkillId),
      opaqueVersion(this.authority, this.botId, normalizedLocalSkillId, normalizedContentHash),
    );
  }

  private packagePath(skillId: string, version: string): string {
    return path.join(
      this.root,
      authorityScope(this.authority),
      'bots',
      safeSegment(this.botId),
      'skills',
      skillId,
      `${version}.json`,
    );
  }
}

function readStored(
  filePath: string,
  expectedBotId: string,
  expectedAuthority?: string,
): StoredPrivatePackage {
  let stored: StoredPrivatePackage;
  try {
    if (fs.statSync(filePath).size > MAX_STORED_PACKAGE_JSON_BYTES) {
      throw new Error('stored package too large');
    }
    stored = JSON.parse(fs.readFileSync(filePath, 'utf8')) as StoredPrivatePackage;
  } catch {
    throw packageError('Private Skill package storage is corrupt.', 'PRIVATE_SKILL_STORAGE_CORRUPT');
  }
  if (
    stored?.schema !== FILE_PRIVATE_PACKAGE_SCHEMA
    || stored.ownerBotId !== expectedBotId
    || cleanOptional(stored.ownerAuthority) !== expectedAuthority
    || !stored.localSkillId
    || !stored.skillId
    || !stored.version
    || !Array.isArray(stored.files)
    || !Number.isFinite(Date.parse(stored.createdAt))
  ) {
    throw packageError('Private Skill package storage is corrupt.', 'PRIVATE_SKILL_STORAGE_CORRUPT');
  }
  return stored;
}

function verifyStoredIdentity(
  stored: StoredPrivatePackage,
  expected: { localSkillId: string; contentHash: string; skillId: string; version: string },
): void {
  if (
    stored.localSkillId !== expected.localSkillId
    || stored.contentHash !== expected.contentHash
    || stored.skillId !== expected.skillId
    || stored.version !== expected.version
  ) {
    throw packageError('Private Skill package identity is corrupt.', 'PRIVATE_SKILL_STORAGE_CORRUPT');
  }
}

function verifyStoredFiles(stored: StoredPrivatePackage): void {
  const files = decodeStoredFiles(stored.files);
  verifyDownloadedFiles(files, stored.contentHash);
}

function decodeStoredFiles(files: StoredPrivatePackage['files']): Array<{
  path: string;
  size: number;
  sha256: string;
  bytes: Buffer;
}> {
  if (files.length > BOT_SKILL_SOURCE_MAX_FILES) {
    throw packageError('Private Skill package file count is invalid.', 'PRIVATE_SKILL_PACKAGE_INVALID');
  }
  let declaredTotal = 0;
  return files.map(file => {
    if (
      !Number.isInteger(file.size)
      || file.size < 0
      || file.size > BOT_SKILL_SOURCE_MAX_SINGLE_FILE_BYTES
      || typeof file.contentBase64 !== 'string'
      || file.contentBase64.length > Math.ceil(file.size / 3) * 4 + 4
    ) {
      throw packageError('Private Skill package file metadata is invalid.', 'PRIVATE_SKILL_PACKAGE_INVALID');
    }
    declaredTotal += file.size;
    if (declaredTotal > BOT_SKILL_SOURCE_MAX_TOTAL_BYTES) {
      throw packageError('Private Skill package is too large.', 'PRIVATE_SKILL_PACKAGE_INVALID');
    }
    return {
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      bytes: Buffer.from(file.contentBase64, 'base64'),
    };
  });
}

function writeStoredAtomic(filePath: string, stored: StoredPrivatePackage): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function versionFromStored(stored: StoredPrivatePackage): BotPrivateSkillVersion {
  return {
    reference: { skillId: stored.skillId, version: stored.version },
    localSkillId: stored.localSkillId,
    name: stored.name,
    contentHash: stored.contentHash,
    createdAt: stored.createdAt,
    ...(stored.origin ? { origin: stored.origin } : {}),
  };
}

function verifySnapshot(
  snapshot: BotPrivateSkillUpsertInput['snapshot'],
  expectedContentHash: string,
): void {
  verifyDownloadedFiles(snapshot.files, expectedContentHash);
  if (snapshot.totalBytes !== snapshot.files.reduce((sum, file) => sum + file.size, 0)) {
    throw packageError('Private Skill snapshot size is inconsistent.', 'PRIVATE_SKILL_SNAPSHOT_INVALID');
  }
}

function verifyDownloadedFiles(
  files: Array<{ path: string; size: number; sha256: string; bytes: Buffer }>,
  expectedContentHash: string,
): void {
  if (files.length === 0 || files.length > BOT_SKILL_SOURCE_MAX_FILES) {
    throw packageError('Private Skill package file count is invalid.', 'PRIVATE_SKILL_PACKAGE_INVALID');
  }
  let total = 0;
  const seen = new Set<string>();
  const canonical: Array<{ path: string; size: number; sha256: string }> = [];
  for (const file of files) {
    validatePackagePath(file.path);
    if (seen.has(file.path) || file.bytes.length !== file.size || file.size > BOT_SKILL_SOURCE_MAX_SINGLE_FILE_BYTES) {
      throw packageError('Private Skill package file metadata is invalid.', 'PRIVATE_SKILL_PACKAGE_INVALID');
    }
    const actualSha = sha256(file.bytes);
    if (actualSha !== file.sha256) {
      throw packageError('Private Skill package checksum mismatch.', 'PRIVATE_SKILL_PACKAGE_CHECKSUM_MISMATCH');
    }
    seen.add(file.path);
    total += file.size;
    if (total > BOT_SKILL_SOURCE_MAX_TOTAL_BYTES) {
      throw packageError('Private Skill package is too large.', 'PRIVATE_SKILL_PACKAGE_INVALID');
    }
    canonical.push({ path: file.path, size: file.size, sha256: file.sha256 });
  }
  canonical.sort((a, b) => compareBotSkillSourcePath(a.path, b.path));
  if (!seen.has('SKILL.md') || sha256(Buffer.from(JSON.stringify(canonical), 'utf8')) !== expectedContentHash) {
    throw packageError('Private Skill package content hash mismatch.', 'PRIVATE_SKILL_PACKAGE_CHECKSUM_MISMATCH');
  }
}

function opaqueSkillId(authority: string | undefined, botId: string, localSkillId: string): string {
  return `priv_${opaqueHash('skill', authority, botId, localSkillId).slice(0, 40)}`;
}

function opaqueVersion(
  authority: string | undefined,
  botId: string,
  localSkillId: string,
  contentHash: string,
): string {
  return `v_${opaqueHash('version', authority, botId, localSkillId, contentHash).slice(0, 48)}`;
}

function opaqueHash(...parts: Array<string | undefined>): string {
  return crypto.createHash('sha256').update(parts.map(part => part || '').join('\0')).digest('hex');
}

function normalizeOpaqueReference(value: string, label: string): string {
  const normalized = String(value || '').trim();
  const pattern = label === 'skillId' ? /^priv_[a-f0-9]{40}$/ : /^v_[a-f0-9]{48}$/;
  if (!pattern.test(normalized)) {
    throw packageError(`Private Skill ${label} is invalid.`, 'PRIVATE_SKILL_REFERENCE_INVALID', 400);
  }
  return normalized;
}

function normalizeId(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(normalized)) throw new Error(`${label} contains unsupported characters`);
  return normalized;
}

function normalizeHash(value: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error('contentHash is invalid');
  return normalized;
}

function safeSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function cleanOptional(value: unknown): string | undefined {
  const text = String(value || '').trim();
  return text || undefined;
}

function authorityScope(authority?: string): string {
  return authority ? `authority-${opaqueHash(authority).slice(0, 24)}` : 'default';
}

function validatePackagePath(value: string): void {
  const pathValue = String(value || '');
  if (
    !pathValue
    || pathValue.includes('\0')
    || pathValue.includes('\\')
    || pathValue.startsWith('/')
    || /^[a-zA-Z]:/.test(pathValue)
    || pathValue.split('/').some(part => part === '' || part === '.' || part === '..')
  ) {
    throw packageError('Private Skill package path is unsafe.', 'PRIVATE_SKILL_PACKAGE_PATH_UNSAFE');
  }
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function packageError(message: string, code: string, status?: number): Error {
  const error: any = new Error(message);
  error.code = code;
  if (status) error.status = status;
  return error;
}
