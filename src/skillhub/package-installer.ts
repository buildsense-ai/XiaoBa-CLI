import * as fs from 'fs';
import * as path from 'path';
import { PathResolver } from '../utils/path-resolver';
import type { SkillHubPackageVerificationResult } from './package-verifier';
import type { SkillHubRegistryEntry } from './types';

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

const PACKAGE_METADATA_FILES = new Set([
  'skill.json',
  'REVIEW.json',
  'SBOM.json',
]);

export function installVerifiedSkillHubPackage(
  options: InstallVerifiedSkillHubPackageOptions,
): InstallVerifiedSkillHubPackageResult {
  const { verification, registryEntry } = options;
  const packageObject = verification.packageObject;
  const manifest = packageObject.payload.manifest as any;
  const skillId = String(manifest.id || registryEntry.skillId || '').trim();
  const version = String(manifest.version || registryEntry.latestVersion || '').trim();
  const installPath = installPathFromSkillId(skillId);
  if (!skillId || !version || !installPath) {
    throw new SkillHubInstallError('SkillHub package manifest is missing id, name, or version.', 'MANIFEST_INCOMPLETE');
  }

  const entryFile = String(manifest.entrypoints?.skillFile || manifest.entry || 'SKILL.md').replace(/\\/g, '/');
  if (!packageObject.payload.files.some(file => file.path === entryFile)) {
    throw new SkillHubInstallError(`SkillHub package is missing entry file ${entryFile}.`, 'ENTRY_FILE_MISSING');
  }

  const skillsRoot = path.resolve(PathResolver.getSkillsPath());
  PathResolver.ensureDir(skillsRoot);
  const targetDir = safeJoin(skillsRoot, installPath);
  const tempDir = safeJoin(skillsRoot, `.skillhub-install-${process.pid}-${Date.now()}`);

  try {
    if (fs.existsSync(targetDir)) {
      throw new SkillHubInstallError('同名 Skill 目录已存在，请先删除本地目录后再安装。', 'TARGET_CONFLICT');
    }
    fs.mkdirSync(tempDir, { recursive: true });
    for (const file of packageObject.payload.files) {
      if (PACKAGE_METADATA_FILES.has(String(file.path || ''))) continue;
      const destination = safeJoin(tempDir, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(file.contentBase64, 'base64'));
    }

    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.renameSync(tempDir, targetDir);
    return {
      skillId,
      name: String(manifest.displayName || registryEntry.displayName || registryEntry.name || manifest.name || skillId),
      version,
      path: targetDir,
    };
  } catch (error: any) {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    if (error instanceof SkillHubInstallError) throw error;
    throw new SkillHubInstallError(error?.message || String(error), 'INSTALL_FAILED');
  }
}

function installPathFromSkillId(value: string): string {
  const parts = String(value || '').split('/').map(part => part.trim()).filter(Boolean);
  if (parts.length !== 2) {
    throw new SkillHubInstallError('SkillHub package id must be namespace/skill.', 'MANIFEST_ID_INVALID');
  }
  if (!parts.every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(part))) {
    throw new SkillHubInstallError(`Unsafe SkillHub package id: ${value}`, 'MANIFEST_ID_INVALID');
  }
  if (parts[0] === PathResolver.BASE_SKILL_NAMESPACE) {
    throw new SkillHubInstallError('SkillHub packages cannot install into _base.', 'MANIFEST_ID_INVALID');
  }
  return parts.join('/');
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
