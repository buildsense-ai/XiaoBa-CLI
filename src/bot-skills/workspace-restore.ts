import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { BotSkillReference } from '../bot-definition/types';
import {
  BOT_LOCAL_SKILL_IDENTITY_FILE,
  BOT_SKILL_WORKSPACE_IDENTITY_FILE,
  BotSkillWorkspaceService,
  type BotSkillWorkspaceOwner,
} from './workspace';
import type { BotPrivateSkillPackageClient, BotSkillDownloadedPackage } from './private-package';
import {
  BOT_LOCAL_SKILL_SCHEMA,
  BOT_SKILL_WORKSPACE_SCHEMA,
  type BotSkillSyncBaseEntry,
  type BotSkillWorkspaceIdentity,
} from './types';

export interface BotSkillWorkspaceRestoreOptions {
  skillsRoot: string;
  owner: BotSkillWorkspaceOwner;
  references: BotSkillReference[];
  packageClient: Pick<BotPrivateSkillPackageClient, 'download'>;
  existingWorkspaceId?: string;
  baseEntries?: BotSkillSyncBaseEntry[];
  beforeCommit?: () => Promise<void> | void;
  onPrepared?: (
    result: BotSkillWorkspaceRestoreResult,
    paths: BotSkillRestorePaths,
  ) => Promise<void> | void;
  onPhase?: (
    phase: 'old_parked' | 'activated',
    result: BotSkillWorkspaceRestoreResult,
    paths: BotSkillRestorePaths,
  ) => Promise<void> | void;
  afterActivate?: (result: BotSkillWorkspaceRestoreResult) => Promise<void> | void;
  createId?: () => string;
  now?: () => Date;
}

export interface BotSkillWorkspaceRestoreResult {
  identity: BotSkillWorkspaceIdentity;
  entries: BotSkillSyncBaseEntry[];
}

export interface BotSkillRestorePaths {
  activeRoot: string;
  stagingRoot: string;
  backupRoot: string;
  hadActive: boolean;
}

const MAX_WORKSPACE_SKILLS = 256;
const MAX_WORKSPACE_FILES = 2_000;
const MAX_WORKSPACE_BYTES = 100 * 1024 * 1024;

export async function restoreBotSkillWorkspace(
  options: BotSkillWorkspaceRestoreOptions,
): Promise<BotSkillWorkspaceRestoreResult> {
  const skillsRoot = path.resolve(options.skillsRoot);
  const parent = path.dirname(skillsRoot);
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const operationId = `${process.pid}-${Date.now()}-${createId()}`;
  const staging = path.join(parent, `.bot-skill-restore-${operationId}`);
  const backup = path.join(parent, `.bot-skill-backup-${operationId}`);
  if (fs.existsSync(staging) || fs.existsSync(backup)) {
    throw restoreError('Bot Skill restore path collision.', 'BOT_SKILL_RESTORE_PATH_COLLISION');
  }
  fs.mkdirSync(parent, { recursive: true });

  const baseByReference = new Map(
    (options.baseEntries ?? []).map(entry => [
      `${entry.cloudSkillId}\0${entry.cloudVersion}`,
      entry,
    ]),
  );
  const baseBySkillId = new Map(
    (options.baseEntries ?? []).map(entry => [entry.cloudSkillId, entry]),
  );
  try {
    if (options.references.length > MAX_WORKSPACE_SKILLS) {
      throw restoreError('Cloud Definition contains too many Skills.', 'BOT_SKILL_RESTORE_SKILL_LIMIT');
    }
    fs.mkdirSync(staging, { recursive: false });
    const usedNames = new Set<string>();
    const usedLocalIds = new Set<string>();
    const entries: BotSkillSyncBaseEntry[] = [];
    let totalFiles = 0;
    let totalBytes = 0;
    for (const reference of options.references) {
      const item = await options.packageClient.download(reference);
      validateDownloadBinding(reference, item);
      totalFiles += item.files.length;
      totalBytes += item.files.reduce((sum, file) => sum + file.size, 0);
      if (totalFiles > MAX_WORKSPACE_FILES || totalBytes > MAX_WORKSPACE_BYTES) {
        throw restoreError('Downloaded Skill workspace exceeds its aggregate budget.', 'BOT_SKILL_RESTORE_BUDGET_EXCEEDED');
      }
      const installName = safeSkillDirectoryName(item.name);
      const portableInstallName = installName.toLocaleLowerCase('en-US');
      if (usedNames.has(portableInstallName)) {
        throw restoreError(`Duplicate Skill install name: ${installName}`, 'BOT_SKILL_RESTORE_NAME_CONFLICT');
      }
      const previous = baseByReference.get(`${item.reference.skillId}\0${item.reference.version}`)
        ?? baseBySkillId.get(item.reference.skillId);
      const localSkillId = previous?.localSkillId || item.localSkillId || createId();
      if (usedLocalIds.has(localSkillId)) {
        throw restoreError('Duplicate localSkillId in downloaded workspace.', 'BOT_SKILL_RESTORE_ID_CONFLICT');
      }
      usedNames.add(portableInstallName);
      usedLocalIds.add(localSkillId);
      const target = path.join(staging, installName);
      fs.mkdirSync(target);
      for (const file of item.files) {
        const destination = safeJoin(target, file.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, file.bytes);
      }
      writeJsonAtomic(path.join(target, BOT_LOCAL_SKILL_IDENTITY_FILE), {
        schema: BOT_LOCAL_SKILL_SCHEMA,
        localSkillId,
        createdAt: now().toISOString(),
      });
      entries.push({
        localSkillId,
        localContentHash: item.contentHash,
        cloudSkillId: item.reference.skillId,
        cloudVersion: item.reference.version,
      });
    }
    const identity: BotSkillWorkspaceIdentity = {
      schema: BOT_SKILL_WORKSPACE_SCHEMA,
      workspaceId: options.existingWorkspaceId || createId(),
      workspaceOwnerBotId: String(options.owner.botId).trim(),
      ...(String(options.owner.authority || '').trim()
        ? { authority: String(options.owner.authority).trim() }
        : {}),
      ...(String(options.owner.ownerUserId || '').trim()
        ? { ownerUserId: String(options.owner.ownerUserId).trim() }
        : {}),
      createdAt: now().toISOString(),
    };
    writeJsonAtomic(path.join(staging, BOT_SKILL_WORKSPACE_IDENTITY_FILE), identity);

    const stagedInspection = new BotSkillWorkspaceService({
      skillsRoot: staging,
      createId,
      now,
    }).inspect(options.owner);
    if (stagedInspection.kind !== 'valid') {
      throw restoreError('Downloaded Skill workspace failed validation.', 'BOT_SKILL_RESTORE_VALIDATION_FAILED');
    }
    const actualHashById = new Map(stagedInspection.skills.map(skill => [skill.localSkillId, skill.contentHash]));
    if (entries.some(entry => actualHashById.get(entry.localSkillId) !== entry.localContentHash)) {
      throw restoreError('Downloaded Skill workspace content hash does not match its package.', 'BOT_SKILL_RESTORE_HASH_MISMATCH');
    }
    const result = {
      identity,
      entries: entries.sort((a, b) => a.localSkillId.localeCompare(b.localSkillId)),
    };
    await options.beforeCommit?.();
    const hadActive = fs.existsSync(skillsRoot);
    const restorePaths = {
      activeRoot: skillsRoot,
      stagingRoot: staging,
      backupRoot: backup,
      hadActive,
    };
    await options.onPrepared?.(result, restorePaths);
    if (hadActive) fs.renameSync(skillsRoot, backup);
    if (hadActive) await options.onPhase?.('old_parked', result, restorePaths);
    try {
      fs.renameSync(staging, skillsRoot);
    } catch (error) {
      if (hadActive && !fs.existsSync(skillsRoot) && fs.existsSync(backup)) {
        fs.renameSync(backup, skillsRoot);
      }
      throw error;
    }
    await options.onPhase?.('activated', result, restorePaths);
    await options.afterActivate?.(result);
    if (hadActive && fs.existsSync(backup)) {
      try {
        fs.rmSync(backup, { recursive: true, force: true });
      } catch {
        // A disabled backup is safer than risking the newly activated workspace.
      }
    }
    return result;
  } catch (error) {
    try {
      if (fs.existsSync(backup)) {
        if (fs.existsSync(skillsRoot)) {
          const failedActive = `${staging}.failed-active`;
          if (fs.existsSync(failedActive)) fs.rmSync(failedActive, { recursive: true, force: true });
          fs.renameSync(skillsRoot, failedActive);
          fs.renameSync(backup, skillsRoot);
          fs.rmSync(failedActive, { recursive: true, force: true });
        } else {
          fs.renameSync(backup, skillsRoot);
        }
      }
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // Preserve every remaining directory for startup recovery.
    }
    throw error;
  }
}

function validateDownloadBinding(
  requested: BotSkillReference,
  downloaded: BotSkillDownloadedPackage,
): void {
  if (
    downloaded.reference.skillId !== requested.skillId
    || downloaded.reference.version !== requested.version
    || !/^[a-f0-9]{64}$/.test(downloaded.contentHash)
    || !downloaded.files.some(file => file.path === 'SKILL.md')
  ) {
    throw restoreError('Downloaded Skill package does not match its Cloud reference.', 'BOT_SKILL_RESTORE_REFERENCE_MISMATCH');
  }
}

function safeSkillDirectoryName(value: string): string {
  const raw = String(value || '').trim();
  if (
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(raw)
    && portableWindowsSegment(raw)
  ) return raw;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!normalized || !portableWindowsSegment(normalized)) {
    throw restoreError('Downloaded Skill name is unsafe.', 'BOT_SKILL_RESTORE_NAME_INVALID');
  }
  return normalized;
}

function safeJoin(root: string, relativePath: string): string {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (
    !normalized
    || normalized.includes('\0')
    || normalized.startsWith('/')
    || /^[a-zA-Z]:/.test(normalized)
    || normalized.split('/').some(part => (
      part === ''
      || part === '.'
      || part === '..'
      || !portableWindowsSegment(part)
    ))
  ) {
    throw restoreError('Downloaded Skill path is unsafe.', 'BOT_SKILL_RESTORE_PATH_UNSAFE');
  }
  const resolved = path.resolve(root, ...normalized.split('/'));
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw restoreError('Downloaded Skill path escapes its directory.', 'BOT_SKILL_RESTORE_PATH_UNSAFE');
  }
  return resolved;
}

function portableWindowsSegment(value: string): boolean {
  if (!value || /[<>:"|?*]/.test(value) || /[. ]$/.test(value)) return false;
  const stem = value.split('.')[0].toUpperCase();
  return !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function restoreError(message: string, code: string): Error {
  const error: any = new Error(message);
  error.code = code;
  return error;
}
