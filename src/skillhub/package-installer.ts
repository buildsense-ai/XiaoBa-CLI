import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PathResolver } from '../utils/path-resolver';
import {
  BOT_SKILL_LOCAL_IDENTITY_FILE,
  type LocalSkillIdentity,
  readLocalSkillIdentity,
  writeLocalSkillIdentity,
} from '../bot-skills/local-manifest';
import { computeLocalSkillContentHash } from './local-skill-metadata';
import type { SkillHubPackageVerificationResult } from './package-verifier';
import type { SkillHubPackageInstallMarker, SkillHubRegistryEntry } from './types';
import {
  readSkillHubInstallMarker,
  writeSkillHubInstallMarker,
} from './install-marker';

export interface InstallVerifiedSkillHubPackageOptions {
  verification: SkillHubPackageVerificationResult;
  registryEntry: SkillHubRegistryEntry;
  userId?: string;
  allowUpdate?: boolean;
  skillsRoot?: string;
  operationsRoot?: string;
  localIdentity?: LocalSkillIdentity;
  onPhasePersisted?: (phase: SkillHubInstallTransactionPhase) => void;
  now?: () => Date;
}

export interface InstallVerifiedSkillHubPackageResult {
  skillId: string;
  name: string;
  version: string;
  path: string;
  installName: string;
  action: 'installed' | 'updated' | 'unchanged';
}

export interface UninstallSkillHubPackageOptions {
  userId?: string;
  skillId: string;
  installName: string;
  skillsRoot?: string;
}

export interface ClaimSkillHubPackageOwnershipOptions {
  userId: string;
  skillId: string;
  installName: string;
  skillsRoot?: string;
}

export interface UninstallSkillHubPackageResult {
  removed: boolean;
  path: string;
}

export class SkillHubInstallError extends Error {
  readonly status = 409;

  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'SkillHubInstallError';
  }
}

const PACKAGE_METADATA_FILES = new Set([
  'skill.json',
  'REVIEW.json',
  'SBOM.json',
  '.xiaoba-bundled-skill.json',
  '.xiaoba-skillhub-install.json',
  BOT_SKILL_LOCAL_IDENTITY_FILE,
]);

export type SkillHubInstallTransactionPhase =
  | 'prepared'
  | 'target-backed-up'
  | 'target-active';

interface SkillHubInstallTransactionJournal {
  schema: 'xiaoba.skillhub-install-transaction.v1';
  phase: SkillHubInstallTransactionPhase;
  targetDir: string;
  targetExisted: boolean;
  expectedSkillId?: string;
  expectedVersion?: string;
  expectedChecksumSha256?: string;
  expectedLocalSkillId?: string;
}

export function installVerifiedSkillHubPackage(
  options: InstallVerifiedSkillHubPackageOptions,
): InstallVerifiedSkillHubPackageResult {
  const { verification, registryEntry } = options;
  const packageObject = verification.packageObject;
  const manifest = packageObject.payload.manifest as any;
  const skillId = String(manifest.id || registryEntry.skillId || '').trim();
  const version = String(manifest.version || registryEntry.latestVersion || '').trim();
  const installName = safeSkillDirName(String(manifest.name || registryEntry.name || '').trim());
  if (!skillId || !version || !installName) {
    throw new SkillHubInstallError('SkillHub package manifest is missing id, name, or version.', 'MANIFEST_INCOMPLETE');
  }

  const entryFile = String(manifest.entrypoints?.skillFile || manifest.entry || 'SKILL.md').replace(/\\/g, '/');
  if (!packageObject.payload.files.some(file => file.path === entryFile)) {
    throw new SkillHubInstallError(`SkillHub package is missing entry file ${entryFile}.`, 'ENTRY_FILE_MISSING');
  }

  const skillsRoot = path.resolve(options.skillsRoot ?? PathResolver.getSkillsPath());
  PathResolver.ensureDir(skillsRoot);
  assertRealDirectory(skillsRoot, 'Skill workspace');
  const operationsRoot = path.resolve(
    options.operationsRoot
      ?? PathResolver.getDataPath('bot-skills', 'operations'),
  );
  ensureOperationsRoot(skillsRoot, operationsRoot);
  recoverSkillHubPackageOperations({ skillsRoot, operationsRoot });
  const targetDir = safeJoin(skillsRoot, installName);
  const operationId = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const operationDir = path.join(operationsRoot, `install-${operationId}`);
  const tempDir = path.join(operationDir, 'staged');
  const backupDir = path.join(operationDir, 'backup');
  const journalPath = path.join(operationDir, 'journal.json');
  if (fs.existsSync(targetDir)) assertRealDirectory(targetDir, 'Installed Skill target');
  const existingMarker = fs.existsSync(targetDir) ? readSkillHubInstallMarker(targetDir) : null;
  const existingIdentity = fs.existsSync(targetDir) ? readLocalSkillIdentity(targetDir) : undefined;
  const existingWasDisabled = fs.existsSync(path.join(targetDir, 'SKILL.md.disabled'))
    && !fs.existsSync(path.join(targetDir, 'SKILL.md'));

  if (fs.existsSync(targetDir)) {
    if (!options.allowUpdate) {
      throw new SkillHubInstallError('同名 Skill 目录已存在，请先删除本地目录后再安装。', 'TARGET_CONFLICT');
    }
    if (!existingMarker || existingMarker.skillId !== skillId) {
      throw new SkillHubInstallError('同名 Skill 已被其他本地或 SkillHub Skill 占用。', 'TARGET_CONFLICT');
    }
    if (options.userId && existingMarker.userId && existingMarker.userId !== options.userId) {
      throw new SkillHubInstallError('同名 Skill 已属于另一个 SkillHub 用户。', 'USER_CONFLICT');
    }
    if (
      existingMarker.version === version
      && existingMarker.packageChecksumSha256 === registryEntry.checksumSha256
    ) {
      if (options.userId && !existingMarker.userId) {
        writeSkillHubInstallMarker(targetDir, markerOwnedByUser(existingMarker, options.userId));
      }
      return {
        skillId,
        name: String(manifest.displayName || registryEntry.displayName || registryEntry.name || manifest.name || skillId),
        version,
        path: targetDir,
        installName,
        action: 'unchanged',
      };
    }
    if (!existingMarker.installedContentHash) {
      throw new SkillHubInstallError(
        'This Skill was installed before local-content baselines were recorded; refusing to overwrite it automatically.',
        'LOCAL_BASELINE_MISSING',
      );
    }
    if (computeLocalSkillContentHash(targetDir) !== existingMarker.installedContentHash) {
      throw new SkillHubInstallError(
        'The installed Skill has local changes; refusing to overwrite them with a SkillHub update.',
        'LOCAL_MODIFICATIONS',
      );
    }
  }

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    for (const file of packageObject.payload.files) {
      if (PACKAGE_METADATA_FILES.has(String(file.path || ''))) continue;
      const destination = safeJoin(tempDir, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(file.contentBase64, 'base64'));
    }
    if (existingWasDisabled) {
      const stagedEntry = path.join(tempDir, 'SKILL.md');
      if (!fs.existsSync(stagedEntry)) {
        throw new SkillHubInstallError(
          'The staged Skill is missing its root SKILL.md.',
          'ENTRY_FILE_MISSING',
        );
      }
      fs.renameSync(stagedEntry, `${stagedEntry}.disabled`);
    }

    const displayName = String(manifest.displayName || registryEntry.displayName || registryEntry.name || manifest.name || skillId);
    const installedContentHash = computeLocalSkillContentHash(tempDir);
    writeSkillHubInstallMarker(tempDir, {
      source: 'skillhub',
      userId: String(options.userId || '').trim() || undefined,
      skillId,
      name: displayName,
      installName,
      version,
      packageChecksumSha256: registryEntry.checksumSha256,
      installedContentHash,
      signature: registryEntry.signature,
      packageUrl: registryEntry.packageUrl,
      installedAt: (options.now?.() || new Date()).toISOString(),
    });
    const identity = options.localIdentity ?? existingIdentity;
    if (identity) writeLocalSkillIdentity(tempDir, identity);

    persistInstallJournal(journalPath, {
      schema: 'xiaoba.skillhub-install-transaction.v1',
      phase: 'prepared',
      targetDir,
      targetExisted: fs.existsSync(targetDir),
      expectedSkillId: skillId,
      expectedVersion: version,
      expectedChecksumSha256: registryEntry.checksumSha256,
      expectedLocalSkillId: identity?.localSkillId,
    });
    options.onPhasePersisted?.('prepared');

    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    let action: InstallVerifiedSkillHubPackageResult['action'] = 'installed';
    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, backupDir);
      updateInstallJournal(journalPath, 'target-backed-up');
      options.onPhasePersisted?.('target-backed-up');
      fs.renameSync(tempDir, targetDir);
      action = 'updated';
    } else {
      fs.renameSync(tempDir, targetDir);
    }
    try {
      updateInstallJournal(journalPath, 'target-active');
    } catch {
      // The target rename is the commit point. A stale earlier phase still
      // converges to the active target during recovery.
    }
    options.onPhasePersisted?.('target-active');
    try {
      fs.rmSync(operationDir, { recursive: true, force: true });
    } catch {
      // The target rename is the commit point. Recovery will clean stale
      // operation data without reporting a committed install as failed.
    }
    return {
      skillId,
      name: displayName,
      version,
      path: targetDir,
      installName,
      action,
    };
  } catch (error: any) {
    try {
      recoverSkillHubPackageOperations({ skillsRoot, operationsRoot });
    } catch {
      // Preserve the transaction journal for recovery by the next operation.
    }
    if (error instanceof SkillHubInstallError) throw error;
    throw new SkillHubInstallError(
      error?.message || String(error),
      String(error?.code || 'INSTALL_FAILED'),
    );
  }
}

export function uninstallSkillHubPackage(
  options: UninstallSkillHubPackageOptions,
): UninstallSkillHubPackageResult {
  const skillsRoot = path.resolve(options.skillsRoot ?? PathResolver.getSkillsPath());
  assertRealDirectory(skillsRoot, 'Skill workspace');
  const targetDir = safeJoin(skillsRoot, options.installName);
  if (!fs.existsSync(targetDir)) return { removed: false, path: targetDir };
  assertRealDirectory(targetDir, 'Skill uninstall target');

  const marker = readSkillHubInstallMarker(targetDir);
  if (!marker || marker.skillId !== options.skillId) {
    throw new SkillHubInstallError('目标目录不是当前订阅的 SkillHub Skill，已拒绝删除。', 'UNINSTALL_TARGET_MISMATCH');
  }
  if (options.userId && marker.userId && marker.userId !== options.userId) {
    throw new SkillHubInstallError('目标 Skill 不属于当前 SkillHub 用户，已拒绝删除。', 'USER_CONFLICT');
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  return { removed: true, path: targetDir };
}

export function claimSkillHubPackageOwnership(options: ClaimSkillHubPackageOwnershipOptions): boolean {
  const skillsRoot = path.resolve(options.skillsRoot ?? PathResolver.getSkillsPath());
  assertRealDirectory(skillsRoot, 'Skill workspace');
  const targetDir = safeJoin(skillsRoot, options.installName);
  if (!fs.existsSync(targetDir)) return false;
  assertRealDirectory(targetDir, 'Skill ownership target');

  const marker = readSkillHubInstallMarker(targetDir);
  if (!marker || marker.skillId !== options.skillId) return false;
  if (marker.userId && marker.userId !== options.userId) {
    throw new SkillHubInstallError('目标 Skill 已属于另一个 SkillHub 用户。', 'USER_CONFLICT');
  }
  if (marker.userId === options.userId && !('agentId' in marker)) return true;
  writeSkillHubInstallMarker(targetDir, markerOwnedByUser(marker, options.userId));
  return true;
}

function markerOwnedByUser(
  marker: SkillHubPackageInstallMarker,
  userId: string,
): SkillHubPackageInstallMarker {
  const { agentId: _legacyOwner, ...current } = marker as typeof marker & { agentId?: string };
  return { ...current, userId };
}

export function recoverSkillHubPackageOperations(options: {
  skillsRoot: string;
  operationsRoot: string;
}): void {
  const skillsRoot = path.resolve(options.skillsRoot);
  const operationsRoot = path.resolve(options.operationsRoot);
  if (!fs.existsSync(operationsRoot)) return;
  assertRealDirectory(operationsRoot, 'Skill operation root');
  for (const entry of fs.readdirSync(operationsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('install-')) continue;
    const operationDir = path.join(operationsRoot, entry.name);
    const journalPath = path.join(operationDir, 'journal.json');
    const staged = path.join(operationDir, 'staged');
    const backup = path.join(operationDir, 'backup');
    if (!fs.existsSync(journalPath)) {
      fs.rmSync(operationDir, { recursive: true, force: true });
      continue;
    }
    const journal = readInstallJournal(journalPath);
    assertContained(skillsRoot, journal.targetDir, 'Recovered Skill target');
    if (fs.existsSync(staged)) assertRealDirectory(staged, 'Recovered staged Skill');
    if (fs.existsSync(backup)) assertRealDirectory(backup, 'Recovered backup Skill');
    if (journal.phase === 'prepared' || journal.phase === 'target-backed-up') {
      if (!fs.existsSync(journal.targetDir) && fs.existsSync(backup)) {
        fs.renameSync(backup, journal.targetDir);
      }
    }
    if (
      journal.phase === 'target-active'
      && !fs.existsSync(journal.targetDir)
      && fs.existsSync(backup)
    ) {
      throw new SkillHubInstallError(
        'The committed Skill target is missing while its backup still exists.',
        'INSTALL_RECOVERY_AMBIGUOUS',
      );
    }
    const targetExists = fs.existsSync(journal.targetDir);
    const backupExists = fs.existsSync(backup);
    if (
      targetExists
      && (
        backupExists
        || !journal.targetExisted
        || journal.phase === 'target-active'
      )
    ) {
      assertRecoveredPackageTarget(journal.targetDir, journal, backupExists);
    }
    if (fs.existsSync(staged)) fs.rmSync(staged, { recursive: true, force: true });
    if (fs.existsSync(backup) && fs.existsSync(journal.targetDir)) {
      fs.rmSync(backup, { recursive: true, force: true });
    }
    fs.rmSync(operationDir, { recursive: true, force: true });
  }
}

function assertRecoveredPackageTarget(
  targetDir: string,
  journal: SkillHubInstallTransactionJournal,
  hasBackup: boolean,
): void {
  assertRealDirectory(targetDir, 'Recovered active Skill');
  if (
    !journal.expectedSkillId
    || !journal.expectedVersion
    || !journal.expectedChecksumSha256
  ) {
    if (hasBackup) {
      throw new SkillHubInstallError(
        'Cannot verify the recovered active Skill while a unique backup exists.',
        'INSTALL_RECOVERY_AMBIGUOUS',
      );
    }
    return;
  }
  const marker = readSkillHubInstallMarker(targetDir);
  const identity = readLocalSkillIdentity(targetDir);
  if (
    !marker
    || marker.skillId !== journal.expectedSkillId
    || marker.version !== journal.expectedVersion
    || marker.packageChecksumSha256 !== journal.expectedChecksumSha256
    || (
      journal.expectedLocalSkillId
      && identity?.localSkillId !== journal.expectedLocalSkillId
    )
  ) {
    throw new SkillHubInstallError(
      'Recovered active Skill does not match its transaction journal.',
      'INSTALL_RECOVERY_AMBIGUOUS',
    );
  }
}

function ensureOperationsRoot(skillsRoot: string, operationsRoot: string): void {
  if (path.parse(skillsRoot).root.toLowerCase() !== path.parse(operationsRoot).root.toLowerCase()) {
    throw new SkillHubInstallError(
      'Skill staging must use the same filesystem as the active workspace.',
      'INSTALL_FILESYSTEM_MISMATCH',
    );
  }
  ensureDirectoryWithoutLinks(operationsRoot);
  assertRealDirectory(operationsRoot, 'Skill operation root');
  if (fs.statSync(skillsRoot).dev !== fs.statSync(operationsRoot).dev) {
    throw new SkillHubInstallError(
      'Skill staging must use the same filesystem as the active workspace.',
      'INSTALL_FILESYSTEM_MISMATCH',
    );
  }
}

function persistInstallJournal(
  journalPath: string,
  journal: SkillHubInstallTransactionJournal,
): void {
  const temporary = `${journalPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  fs.renameSync(temporary, journalPath);
}

function updateInstallJournal(
  journalPath: string,
  phase: SkillHubInstallTransactionPhase,
): void {
  const journal = readInstallJournal(journalPath);
  persistInstallJournal(journalPath, { ...journal, phase });
}

function readInstallJournal(journalPath: string): SkillHubInstallTransactionJournal {
  const stat = fs.lstatSync(journalPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    throw new SkillHubInstallError('Skill install transaction journal is invalid.', 'INSTALL_JOURNAL_INVALID');
  }
  const value = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as SkillHubInstallTransactionJournal;
  if (
    value?.schema !== 'xiaoba.skillhub-install-transaction.v1'
    || !['prepared', 'target-backed-up', 'target-active'].includes(value.phase)
    || typeof value.targetDir !== 'string'
    || typeof value.targetExisted !== 'boolean'
    || (value.expectedSkillId !== undefined && typeof value.expectedSkillId !== 'string')
    || (value.expectedVersion !== undefined && typeof value.expectedVersion !== 'string')
    || (
      value.expectedChecksumSha256 !== undefined
      && typeof value.expectedChecksumSha256 !== 'string'
    )
    || (
      value.expectedLocalSkillId !== undefined
      && typeof value.expectedLocalSkillId !== 'string'
    )
  ) {
    throw new SkillHubInstallError('Skill install transaction journal is invalid.', 'INSTALL_JOURNAL_INVALID');
  }
  return value;
}

function assertRealDirectory(target: string, label: string): void {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SkillHubInstallError(`${label} must be a real directory.`, 'INSTALL_PATH_UNSAFE');
  }
  if (!samePath(path.resolve(target), fs.realpathSync.native(target))) {
    throw new SkillHubInstallError(`${label} traverses a symlink or junction.`, 'INSTALL_PATH_UNSAFE');
  }
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function assertContained(root: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SkillHubInstallError(`${label} escapes the Skill workspace.`, 'INSTALL_PATH_UNSAFE');
  }
}

function ensureDirectoryWithoutLinks(target: string): void {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    assertRealDirectory(current, 'Skill operation path');
  }
}

function safeSkillDirName(value: string): string {
  if (
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)
    && !/[. ]$/.test(value)
    && !isWindowsReservedName(value)
  ) return value;
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  const candidate = ascii || `skill-${Buffer.from(value).toString('hex').slice(0, 24)}`;
  return isWindowsReservedName(candidate) ? `skill-${candidate}` : candidate;
}

function isWindowsReservedName(value: string): boolean {
  const stem = value.replace(/[. ]+$/g, '').split('.')[0].toUpperCase();
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}

function safeJoin(root: string, relativePath: string): string {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new SkillHubInstallError(`Unsafe install path: ${relativePath}`, 'INSTALL_PATH_UNSAFE');
  }
  const parts = normalized.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new SkillHubInstallError(`Unsafe install path: ${relativePath}`, 'INSTALL_PATH_UNSAFE');
  }
  const resolved = path.resolve(root, ...parts);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SkillHubInstallError(`Unsafe install path: ${relativePath}`, 'INSTALL_PATH_UNSAFE');
  }
  return resolved;
}
