import * as fs from 'fs';
import * as path from 'path';
import { PathResolver } from '../utils/path-resolver';
import type { SkillHubPackageVerificationResult } from './package-verifier';
import type { SkillHubPackageInstallMarker, SkillHubRegistryEntry } from './types';

export interface InstallVerifiedSkillHubPackageOptions {
  verification: SkillHubPackageVerificationResult;
  registryEntry: SkillHubRegistryEntry;
  overwrite?: boolean;
}

export interface InstallVerifiedSkillHubPackageResult {
  skillId: string;
  name: string;
  version: string;
  path: string;
}

export class SkillHubInstallError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'SkillHubInstallError';
  }
}

const INSTALL_MARKER = '.xiaoba-skillhub-install.json';

export function installVerifiedSkillHubPackage(
  options: InstallVerifiedSkillHubPackageOptions,
): InstallVerifiedSkillHubPackageResult {
  const { verification, registryEntry } = options;
  const packageObject = verification.packageObject;
  const manifest = packageObject.payload.manifest as any;
  const skillId = String(manifest.id || registryEntry.skillId || '').trim();
  const version = String(manifest.version || registryEntry.latestVersion || '').trim();
  const installName = slugForInstallDir(String(manifest.name || registryEntry.name || skillId));
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
  const tempDir = safeJoin(skillsRoot, `.skillhub-install-${process.pid}-${Date.now()}`);
  const backupDir = safeJoin(skillsRoot, `.skillhub-backup-${installName}-${process.pid}-${Date.now()}`);
  const marker: SkillHubPackageInstallMarker = {
    source: 'skillhub',
    skillId,
    name: String(manifest.displayName || registryEntry.displayName || registryEntry.name || manifest.name || skillId),
    version,
    packageChecksumSha256: registryEntry.checksumSha256,
    signature: registryEntry.signature,
    packageUrl: registryEntry.packageUrl,
    installedAt: new Date().toISOString(),
  };

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    for (const file of packageObject.payload.files) {
      const destination = safeJoin(tempDir, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(file.contentBase64, 'base64'));
    }
    fs.writeFileSync(path.join(tempDir, INSTALL_MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf-8');

    if (fs.existsSync(targetDir)) {
      if (!isExistingSkillHubInstall(targetDir, skillId)) {
        throw new SkillHubInstallError('同名 Skill 已存在，且不是来自 SkillHub 的同一个 Skill。', 'TARGET_CONFLICT');
      }
      fs.renameSync(targetDir, backupDir);
    }

    fs.renameSync(tempDir, targetDir);
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
    return { skillId, name: marker.name, version, path: targetDir };
  } catch (error: any) {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    if (!fs.existsSync(targetDir) && fs.existsSync(backupDir)) {
      fs.renameSync(backupDir, targetDir);
    } else if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
    if (error instanceof SkillHubInstallError) throw error;
    throw new SkillHubInstallError(error?.message || String(error), 'INSTALL_FAILED');
  }
}

function isExistingSkillHubInstall(targetDir: string, skillId: string): boolean {
  const markerPath = path.join(targetDir, INSTALL_MARKER);
  if (!fs.existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as SkillHubPackageInstallMarker;
    return marker.source === 'skillhub' && marker.skillId === skillId;
  } catch {
    return false;
  }
}

function slugForInstallDir(value: string): string {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (ascii) return ascii;
  return `skill-${Buffer.from(value).toString('hex').slice(0, 24)}`;
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
