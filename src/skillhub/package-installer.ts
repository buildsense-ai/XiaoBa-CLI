import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PathResolver } from '../utils/path-resolver';
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
}

export interface ClaimSkillHubPackageOwnershipOptions {
  userId: string;
  skillId: string;
  installName: string;
}

export interface UninstallSkillHubPackageResult {
  removed: boolean;
  path: string;
}

export class SkillHubInstallError extends Error {
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
]);

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

  const skillsRoot = path.resolve(PathResolver.getSkillsPath());
  PathResolver.ensureDir(skillsRoot);
  const targetDir = safeJoin(skillsRoot, installName);
  const operationId = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const tempDir = safeJoin(skillsRoot, `.skillhub-install-${operationId}`);
  const backupDir = safeJoin(skillsRoot, `.skillhub-backup-${operationId}`);
  const existingMarker = fs.existsSync(targetDir) ? readSkillHubInstallMarker(targetDir) : null;

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
  }

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    for (const file of packageObject.payload.files) {
      if (PACKAGE_METADATA_FILES.has(String(file.path || ''))) continue;
      const destination = safeJoin(tempDir, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(file.contentBase64, 'base64'));
    }

    const displayName = String(manifest.displayName || registryEntry.displayName || registryEntry.name || manifest.name || skillId);
    writeSkillHubInstallMarker(tempDir, {
      source: 'skillhub',
      userId: String(options.userId || '').trim() || undefined,
      skillId,
      name: displayName,
      installName,
      version,
      packageChecksumSha256: registryEntry.checksumSha256,
      signature: registryEntry.signature,
      packageUrl: registryEntry.packageUrl,
      installedAt: (options.now?.() || new Date()).toISOString(),
    });

    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    let action: InstallVerifiedSkillHubPackageResult['action'] = 'installed';
    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, backupDir);
      disableBackupSkill(backupDir);
      try {
        fs.renameSync(tempDir, targetDir);
        action = 'updated';
      } catch (error) {
        restoreBackupSkill(backupDir, targetDir);
        throw error;
      }
      try {
        fs.rmSync(backupDir, { recursive: true, force: true });
      } catch {
        // The active update has succeeded. A disabled backup is safe to leave for later cleanup.
      }
    } else {
      fs.renameSync(tempDir, targetDir);
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
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    restoreBackupSkill(backupDir, targetDir);
    if (error instanceof SkillHubInstallError) throw error;
    throw new SkillHubInstallError(error?.message || String(error), 'INSTALL_FAILED');
  }
}

export function uninstallSkillHubPackage(
  options: UninstallSkillHubPackageOptions,
): UninstallSkillHubPackageResult {
  const skillsRoot = path.resolve(PathResolver.getSkillsPath());
  const targetDir = safeJoin(skillsRoot, options.installName);
  if (!fs.existsSync(targetDir)) return { removed: false, path: targetDir };

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
  const skillsRoot = path.resolve(PathResolver.getSkillsPath());
  const targetDir = safeJoin(skillsRoot, options.installName);
  if (!fs.existsSync(targetDir)) return false;

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

function disableBackupSkill(backupDir: string): void {
  const activeSkillFile = path.join(backupDir, 'SKILL.md');
  if (fs.existsSync(activeSkillFile)) fs.renameSync(activeSkillFile, `${activeSkillFile}.disabled`);
}

function restoreBackupSkill(backupDir: string, targetDir: string): void {
  if (fs.existsSync(targetDir) || !fs.existsSync(backupDir)) return;
  const disabledSkillFile = path.join(backupDir, 'SKILL.md.disabled');
  if (fs.existsSync(disabledSkillFile)) fs.renameSync(disabledSkillFile, path.join(backupDir, 'SKILL.md'));
  fs.renameSync(backupDir, targetDir);
}

function safeSkillDirName(value: string): string {
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) return value;
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return ascii || `skill-${Buffer.from(value).toString('hex').slice(0, 24)}`;
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
