import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SkillParser } from '../skills/skill-parser';
import {
  SKILLHUB_INSTALL_MARKER_FILE,
  readSkillHubInstallMarker,
} from '../skillhub/install-marker';
import { computeLocalSkillContentHash } from '../skillhub/local-skill-metadata';

export const BOT_SKILL_LOCAL_MANIFEST_SCHEMA = 'xiaoba.bot-skill-local-manifest.v1';
export const BOT_SKILL_LOCAL_IDENTITY_SCHEMA = 'xiaoba.local-skill-identity.v1';
export const BOT_SKILL_LOCAL_IDENTITY_FILE = '.xiaoba-local-skill.json';

const MAX_IDENTITY_BYTES = 64 * 1024;
const LOCAL_SKILL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
]);

export type LocalSkillManifestStatus =
  | 'missing'
  | 'complete'
  | 'partial'
  | 'unreadable';

export interface LocalSkillManifestIssue {
  code: string;
  message: string;
  path?: string;
}

export interface LocalSkillManifestEntry {
  localSkillId: string;
  key: string;
  name: string;
  path: string;
  enabled: boolean;
  contentHash: string;
  source: 'skillhub' | 'local';
  skillId?: string;
  version?: string;
  installedChecksum?: string;
  installedContentHash?: string;
  sourceVisibility?: 'public' | 'private';
}

export interface LocalSkillManifest {
  schema: typeof BOT_SKILL_LOCAL_MANIFEST_SCHEMA;
  status: LocalSkillManifestStatus;
  botId?: string;
  workspaceId?: string;
  entries: LocalSkillManifestEntry[];
  issues: LocalSkillManifestIssue[];
}

export interface LocalSkillIdentity {
  schema: typeof BOT_SKILL_LOCAL_IDENTITY_SCHEMA;
  localSkillId: string;
  workspaceId?: string;
  identityName: string;
  createdAt: string;
}

export interface ScanLocalSkillManifestOptions {
  skillsRoot: string;
  botId?: string;
  workspaceId?: string;
  createIdentities?: boolean;
}

export function scanLocalSkillManifest(
  options: ScanLocalSkillManifestOptions,
): LocalSkillManifest {
  const root = path.resolve(options.skillsRoot);
  const base = (): LocalSkillManifest => ({
    schema: BOT_SKILL_LOCAL_MANIFEST_SCHEMA,
    status: 'complete',
    botId: normalizedOptional(options.botId),
    workspaceId: normalizedOptional(options.workspaceId),
    entries: [],
    issues: [],
  });
  if (!fs.existsSync(root)) return { ...base(), status: 'missing' };

  try {
    assertRealDirectory(root, root, 'Skill workspace root');
    fs.accessSync(root, fs.constants.R_OK);
  } catch (error) {
    return {
      ...base(),
      status: 'unreadable',
      issues: [issue('ROOT_UNREADABLE', error, root)],
    };
  }

  const result = base();
  let skillFiles: Array<{ filePath: string; enabled: boolean }> = [];
  try {
    skillFiles = findSkillFilesStrict(root, result.issues);
  } catch (error) {
    return {
      ...result,
      status: 'unreadable',
      issues: [...result.issues, issue('ROOT_SCAN_FAILED', error, root)],
    };
  }

  const seenLocalIds = new Map<string, string>();
  const seenKeys = new Map<string, string>();
  const seenNames = new Map<string, string>();
  for (const candidate of skillFiles) {
    const skillDir = path.dirname(candidate.filePath);
    const relativeDir = normalizedRelativePath(root, skillDir);
    try {
      assertRealDirectory(root, skillDir, 'Skill directory');
      const skillFileStat = fs.lstatSync(candidate.filePath);
      if (!skillFileStat.isFile() || skillFileStat.isSymbolicLink()) {
        throw new Error('Skill entry file must be a regular file.');
      }
      const skill = SkillParser.parse(candidate.filePath);
      const name = String(skill.metadata.name || '').trim();
      const identity = resolveLocalSkillIdentity({
        skillDir,
        name,
        workspaceId: options.workspaceId,
        create: options.createIdentities !== false,
      });
      if (!identity) {
        throw new Error(`Local Skill identity is missing: ${BOT_SKILL_LOCAL_IDENTITY_FILE}`);
      }

      const duplicateIdentityPath = seenLocalIds.get(identity.localSkillId);
      if (duplicateIdentityPath) {
        result.issues.push({
          code: 'DUPLICATE_LOCAL_SKILL_ID',
          message: `Local Skill identity is also used by ${duplicateIdentityPath}.`,
          path: relativeDir,
        });
        continue;
      }

      const markerPath = path.join(skillDir, SKILLHUB_INSTALL_MARKER_FILE);
      const marker = readSkillHubInstallMarker(skillDir);
      if (fs.existsSync(markerPath) && !marker) {
        throw new Error('SkillHub install marker is invalid.');
      }
      if (marker && marker.installName !== path.basename(skillDir)) {
        throw new Error('SkillHub install marker installName does not match its directory.');
      }

      const key = marker ? `skillhub:${marker.skillId}` : `local:${name}`;
      const duplicateKeyPath = seenKeys.get(portableKey(key));
      const duplicateNamePath = seenNames.get(nameKey(name));
      if (duplicateKeyPath || duplicateNamePath) {
        result.issues.push({
          code: duplicateKeyPath ? 'DUPLICATE_SKILL_KEY' : 'DUPLICATE_SKILL_NAME',
          message: duplicateKeyPath
            ? `Skill key is also used by ${duplicateKeyPath}.`
            : `Skill name is also used by ${duplicateNamePath}.`,
          path: relativeDir,
        });
        continue;
      }

      assertTreeHasNoLinks(skillDir);
      const entry: LocalSkillManifestEntry = {
        localSkillId: identity.localSkillId,
        key,
        name,
        path: relativeDir,
        enabled: candidate.enabled,
        contentHash: computeLocalSkillContentHash(skillDir),
        source: marker ? 'skillhub' : 'local',
        ...(marker ? {
          skillId: marker.skillId,
          version: marker.version,
          installedChecksum: marker.packageChecksumSha256,
          installedContentHash: marker.installedContentHash,
          sourceVisibility: marker.visibility ?? 'public',
        } : {}),
      };
      result.entries.push(entry);
      seenLocalIds.set(identity.localSkillId, relativeDir);
      seenKeys.set(portableKey(key), relativeDir);
      seenNames.set(nameKey(name), relativeDir);
    } catch (error) {
      result.issues.push(issue('SKILL_SCAN_FAILED', error, relativeDir));
    }
  }

  result.entries.sort((left, right) =>
    left.key.localeCompare(right.key) || left.path.localeCompare(right.path));
  result.status = result.issues.length ? 'partial' : 'complete';
  return result;
}

export function readLocalSkillIdentity(skillDir: string): LocalSkillIdentity | undefined {
  const markerPath = path.join(skillDir, BOT_SKILL_LOCAL_IDENTITY_FILE);
  if (!fs.existsSync(markerPath)) return undefined;
  const stat = fs.lstatSync(markerPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_IDENTITY_BYTES) {
    throw new Error(`Local Skill identity is invalid: ${markerPath}`);
  }
  let value: Partial<LocalSkillIdentity>;
  try {
    value = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Partial<LocalSkillIdentity>;
  } catch (error) {
    throw new Error(`Local Skill identity is not valid JSON: ${errorMessage(error)}`);
  }
  if (
    value.schema !== BOT_SKILL_LOCAL_IDENTITY_SCHEMA
    || !LOCAL_SKILL_ID_PATTERN.test(stringValue(value.localSkillId))
    || !stringValue(value.identityName)
    || stringValue(value.identityName).length > 256
    || !stringValue(value.createdAt)
    || (value.workspaceId !== undefined && !stringValue(value.workspaceId))
  ) {
    throw new Error(`Local Skill identity has invalid fields: ${markerPath}`);
  }
  return value as LocalSkillIdentity;
}

export function writeLocalSkillIdentity(
  skillDir: string,
  identity: LocalSkillIdentity,
): void {
  if (
    identity.schema !== BOT_SKILL_LOCAL_IDENTITY_SCHEMA
    || !LOCAL_SKILL_ID_PATTERN.test(stringValue(identity.localSkillId))
    || !stringValue(identity.identityName)
    || !stringValue(identity.createdAt)
  ) {
    throw new Error('Local Skill identity is invalid.');
  }
  atomicWriteJson(path.join(skillDir, BOT_SKILL_LOCAL_IDENTITY_FILE), identity);
}

export function newLocalSkillIdentity(
  name: string,
  workspaceId?: string,
  localSkillId: string = crypto.randomUUID(),
): LocalSkillIdentity {
  return {
    schema: BOT_SKILL_LOCAL_IDENTITY_SCHEMA,
    localSkillId,
    workspaceId: normalizedOptional(workspaceId),
    identityName: stringValue(name),
    createdAt: new Date().toISOString(),
  };
}

function resolveLocalSkillIdentity(options: {
  skillDir: string;
  name: string;
  workspaceId?: string;
  create: boolean;
}): LocalSkillIdentity | undefined {
  const existing = readLocalSkillIdentity(options.skillDir);
  const expectedWorkspaceId = normalizedOptional(options.workspaceId);
  if (
    existing
    && (
      !expectedWorkspaceId
      || !existing.workspaceId
      || existing.workspaceId === expectedWorkspaceId
    )
  ) {
    if (
      options.create
      && (
        existing.identityName !== options.name
        || (!existing.workspaceId && expectedWorkspaceId)
      )
    ) {
      const updated = {
        ...existing,
        identityName: options.name,
        workspaceId: existing.workspaceId ?? expectedWorkspaceId,
      };
      writeLocalSkillIdentity(options.skillDir, updated);
      return updated;
    }
    return existing;
  }
  if (!options.create) return existing;
  const identity = newLocalSkillIdentity(options.name, expectedWorkspaceId);
  writeLocalSkillIdentity(options.skillDir, identity);
  return identity;
}

function findSkillFilesStrict(
  root: string,
  issues: LocalSkillManifestIssue[],
): Array<{ filePath: string; enabled: boolean }> {
  const results: Array<{ filePath: string; enabled: boolean }> = [];
  const visit = (directory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        issues.push({
          code: 'SYMLINK_UNSUPPORTED',
          message: 'Skill workspaces cannot contain symlinks or junctions.',
          path: normalizedRelativePath(root, fullPath),
        });
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRECTORIES.has(entry.name) || isOperationDirectory(entry.name)) continue;
      try {
        assertRealDirectory(root, fullPath, 'Skill workspace child');
      } catch (error) {
        issues.push(issue('UNSAFE_DIRECTORY', error, normalizedRelativePath(root, fullPath)));
        continue;
      }
      const active = path.join(fullPath, 'SKILL.md');
      const disabled = path.join(fullPath, 'SKILL.md.disabled');
      if (fs.existsSync(active) && fs.existsSync(disabled)) {
        issues.push({
          code: 'AMBIGUOUS_SKILL_STATE',
          message: 'Both SKILL.md and SKILL.md.disabled exist.',
          path: normalizedRelativePath(root, fullPath),
        });
      } else if (fs.existsSync(active)) {
        results.push({ filePath: active, enabled: true });
      } else if (fs.existsSync(disabled)) {
        results.push({ filePath: disabled, enabled: false });
      }
      if (fs.existsSync(active) || fs.existsSync(disabled)) {
        for (const nested of findNestedSkillEntries(fullPath)) {
          issues.push({
            code: 'NESTED_SKILL_UNSUPPORTED',
            message: 'A Skill directory cannot contain another Skill entrypoint.',
            path: normalizedRelativePath(root, nested),
          });
        }
      } else {
        visit(fullPath);
      }
    }
  };
  visit(root);
  return results;
}

function assertTreeHasNoLinks(root: string): void {
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Skill contains a symlink or junction: ${fullPath}`);
      }
      if (stat.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) visit(fullPath);
    }
  };
  visit(root);
}

function assertRealDirectory(root: string, target: string, label: string): void {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${target}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the Skill workspace: ${target}`);
  }
  const realRoot = fs.realpathSync.native(resolvedRoot);
  const realTarget = fs.realpathSync.native(resolvedTarget);
  const realRelative = path.relative(realRoot, realTarget);
  if (
    realRelative === '..'
    || realRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(realRelative)
    || !samePath(resolvedTarget, realTarget)
  ) {
    throw new Error(`${label} traverses a symlink or junction: ${target}`);
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const parent = path.dirname(filePath);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`Local Skill identity parent is unsafe: ${parent}`);
  }
  const temporary = path.join(
    parent,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function normalizedRelativePath(root: string, target: string): string {
  const relative = path.relative(root, target).replace(/\\/g, '/');
  return relative || '.';
}

function nameKey(value: string): string {
  return portableKey(value);
}

function portableKey(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function findNestedSkillEntries(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_DIRECTORIES.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      const active = path.join(child, 'SKILL.md');
      const disabled = path.join(child, 'SKILL.md.disabled');
      if (fs.existsSync(active)) found.push(active);
      if (fs.existsSync(disabled)) found.push(disabled);
      visit(child);
    }
  };
  visit(root);
  return found;
}

function isOperationDirectory(name: string): boolean {
  return /^\.skillhub-(install|backup|trash)-/.test(name)
    || /^\.xiaoba-skill-(install|backup|trash)-/.test(name);
}

function normalizedOptional(value: unknown): string | undefined {
  return stringValue(value) || undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function issue(code: string, error: unknown, issuePath?: string): LocalSkillManifestIssue {
  return {
    code,
    message: errorMessage(error),
    path: issuePath,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
