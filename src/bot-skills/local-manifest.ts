import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { readSkillHubInstallMarker } from '../skillhub/install-marker';
import type { BotSkillRef } from '../bot-definition/types';
import { canonicalizeBotSkillRefs } from './canonical';
import type {
  BotSkillLocalMarker,
  BotSkillPackageFile,
  LocalBotSkillManifestEntry,
  SkillHubPackageRef,
} from './types';

export const BOT_SKILL_LOCAL_MARKER_FILE = '.xiaoba-bot-skill.json';
const BOT_SKILL_LOCAL_MARKER_SCHEMA = 'xiaoba.bot-skill-local.v1';
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);
const FORBIDDEN_CREDENTIAL_DIRECTORIES = new Set(['.ssh', '.aws', '.kube', '.gnupg']);
const SKIP_FILES = new Set([
  BOT_SKILL_LOCAL_MARKER_FILE,
  '.xiaoba-skillhub-install.json',
  '.xiaoba-bundled-skill.json',
  'skill.json',
  'REVIEW.json',
  'SBOM.json',
]);
const MAX_FILES = 200;
const MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const ARCHIVE_FILE_EXTENSIONS = [
  '.7z',
  '.a',
  '.apk',
  '.ar',
  '.bz2',
  '.cab',
  '.cpio',
  '.deb',
  '.dmg',
  '.gz',
  '.img',
  '.iso',
  '.jar',
  '.lz',
  '.lz4',
  '.lzma',
  '.rar',
  '.rpm',
  '.tar',
  '.tbz',
  '.tbz2',
  '.tgz',
  '.txz',
  '.war',
  '.whl',
  '.xz',
  '.zip',
  '.zst',
] as const;

export function scanBotSkillWorkspace(skillsRoot: string): LocalBotSkillManifestEntry[] {
  const root = path.resolve(skillsRoot);
  if (!fs.existsSync(root)) {
    throw new Error(`Bot Skill workspace does not exist: ${root}`);
  }
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Bot Skill workspace is not a safe directory: ${root}`);
  }
  const realRoot = fs.realpathSync(root);

  const entries: LocalBotSkillManifestEntry[] = [];
  const localSkillIds = new Set<string>();
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const skillDir = path.join(current, entry.name);
      assertRealPathContained(realRoot, skillDir);
      if (fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
        const manifestEntry = scanLocalBotSkill(skillDir, root);
        if (localSkillIds.has(manifestEntry.localSkillId)) {
          throw new Error(`Bot Skill workspace contains a duplicate localSkillId: ${manifestEntry.localSkillId}`);
        }
        localSkillIds.add(manifestEntry.localSkillId);
        entries.push(manifestEntry);
      }
      if (!SKIP_DIRECTORIES.has(entry.name)) visit(skillDir);
    }
  };
  visit(root);
  return entries.sort((left, right) => compareText(left.localSkillId, right.localSkillId));
}

export function scanLocalBotSkill(
  skillDir: string,
  workspaceRoot?: string,
): LocalBotSkillManifestEntry {
  const root = path.resolve(skillDir);
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Skill path is not a safe directory: ${root}`);
  }
  const skillFile = path.join(root, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    throw new Error(`Skill is missing SKILL.md: ${root}`);
  }
  const skillStat = fs.lstatSync(skillFile);
  if (skillStat.isSymbolicLink() || !skillStat.isFile()) {
    throw new Error(`Skill has an unsafe SKILL.md: ${root}`);
  }
  assertRealPathContained(fs.realpathSync(root), skillFile);
  const marker = ensureBotSkillLocalMarker(root);
  const files = collectPackageFiles(root);
  const contentHash = computeBotSkillPackageHash(files);
  const reference = marker.reference?.contentHash === contentHash
    ? marker.reference
    : undefined;
  const parsed = matter(fs.readFileSync(skillFile, 'utf8'));
  const name = String(parsed.data?.name || path.basename(root)).trim() || path.basename(root);
  return {
    localSkillId: marker.localSkillId,
    name,
    installName: workspaceRoot
      ? path.relative(path.resolve(workspaceRoot), root).replace(/\\/g, '/')
      : path.basename(root),
    path: root,
    contentHash,
    files,
    ...(reference ? { reference } : {}),
    ...(marker.origin ? { origin: marker.origin } : {}),
  };
}

export function readBotSkillLocalMarker(skillDir: string): BotSkillLocalMarker | undefined {
  const markerPath = path.join(skillDir, BOT_SKILL_LOCAL_MARKER_FILE);
  if (!fs.existsSync(markerPath)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as BotSkillLocalMarker;
    if (
      value?.schema !== BOT_SKILL_LOCAL_MARKER_SCHEMA
      || !/^[A-Za-z0-9._:-]+$/.test(String(value.localSkillId || ''))
      || (value.reference && !validRef(value.reference))
      || (value.origin && !validPackageRef(value.origin))
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export function writeBotSkillLocalMarker(skillDir: string, marker: BotSkillLocalMarker): void {
  if (
    marker.schema !== BOT_SKILL_LOCAL_MARKER_SCHEMA
    || !/^[A-Za-z0-9._:-]+$/.test(marker.localSkillId)
    || (marker.reference && !validRef(marker.reference))
    || (marker.origin && !validPackageRef(marker.origin))
  ) {
    throw new Error('Bot Skill local marker is invalid');
  }
  fs.mkdirSync(skillDir, { recursive: true });
  const markerPath = path.join(skillDir, BOT_SKILL_LOCAL_MARKER_FILE);
  const temporary = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, markerPath);
}

export function computeBotSkillPackageHash(files: readonly BotSkillPackageFile[]): string {
  const entries = [...files]
    .map(file => ({ path: file.path, size: file.size, sha256: file.sha256 }))
    .sort((left, right) => compareText(left.path, right.path));
  return sha256(Buffer.from(JSON.stringify(entries), 'utf8'));
}

function ensureBotSkillLocalMarker(skillDir: string): BotSkillLocalMarker {
  const existing = readBotSkillLocalMarker(skillDir);
  if (existing) return existing;
  if (fs.existsSync(path.join(skillDir, BOT_SKILL_LOCAL_MARKER_FILE))) {
    throw new Error(`Bot Skill local marker cannot be read safely: ${skillDir}`);
  }
  const installed = readSkillHubInstallMarker(skillDir);
  const origin = installed
    ? { skillId: installed.skillId, version: installed.version }
    : undefined;
  const marker: BotSkillLocalMarker = {
    schema: BOT_SKILL_LOCAL_MARKER_SCHEMA,
    localSkillId: crypto.randomUUID(),
    ...(origin ? { origin } : {}),
  };
  writeBotSkillLocalMarker(skillDir, marker);
  return marker;
}

function collectPackageFiles(root: string): BotSkillPackageFile[] {
  const realRoot = fs.realpathSync(root);
  const files: BotSkillPackageFile[] = [];
  let totalBytes = 0;
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      const entryStat = fs.lstatSync(fullPath);
      if (entryStat.isSymbolicLink()) continue;
      assertRealPathContained(realRoot, fullPath);
      if (entry.isDirectory()) {
        if (FORBIDDEN_CREDENTIAL_DIRECTORIES.has(entry.name.toLowerCase())) {
          throw new Error(`Skill contains a forbidden credential directory: ${entry.name}`);
        }
        if (
          !SKIP_DIRECTORIES.has(entry.name)
          && !fs.existsSync(path.join(fullPath, 'SKILL.md'))
        ) {
          visit(fullPath);
        }
        continue;
      }
      if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue;
      const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
      if (!isPortablePackagePath(relativePath)) {
        throw new Error(`Skill contains an unsafe path: ${relativePath}`);
      }
      const bytes = fs.readFileSync(fullPath);
      rejectSensitiveMaterial(relativePath, bytes);
      if (bytes.length > MAX_SINGLE_FILE_BYTES) {
        throw new Error(`Skill file is too large: ${relativePath}`);
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Skill package is too large');
      files.push({
        path: relativePath,
        size: bytes.length,
        sha256: sha256(bytes),
        contentBase64: bytes.toString('base64'),
      });
      if (files.length > MAX_FILES) throw new Error('Skill package contains too many files');
    }
  };
  visit(root);
  return files.sort((left, right) => compareText(left.path, right.path));
}

function rejectSensitiveMaterial(filePath: string, bytes: Buffer): void {
  const name = path.posix.basename(filePath).toLowerCase();
  if (isArchiveFile(name, bytes)) {
    throw new Error(`Skill contains an archive file and cannot be uploaded automatically: ${filePath}`);
  }
  if (
    name === '.env'
    || name.startsWith('.env.')
    || ['.npmrc', '.pypirc', 'credentials', 'credentials.json', 'kubeconfig', 'id_rsa', 'id_ed25519'].includes(name)
    || /\.(?:pem|key|p12|pfx)$/i.test(name)
    || /\.(?:exe|dll|so|dylib|msi|apk|appimage)$/i.test(name)
    || containsHighConfidenceSecret(bytes)
  ) {
    throw new Error(`Skill contains sensitive material and cannot be uploaded: ${filePath}`);
  }
}

function isArchiveFile(name: string, bytes: Buffer): boolean {
  if (ARCHIVE_FILE_EXTENSIONS.some(extension => name.endsWith(extension))) return true;
  if (
    hasMagic(bytes, [0x50, 0x4b, 0x03, 0x04])
    || hasMagic(bytes, [0x50, 0x4b, 0x05, 0x06])
    || hasMagic(bytes, [0x50, 0x4b, 0x07, 0x08])
    || hasMagic(bytes, [0x1f, 0x8b])
    || hasMagic(bytes, [0x42, 0x5a, 0x68])
    || hasMagic(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
    || hasMagic(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])
    || hasMagic(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])
    || hasMagic(bytes, [0x28, 0xb5, 0x2f, 0xfd])
    || hasMagic(bytes, [0x4d, 0x53, 0x43, 0x46])
    || bytes.subarray(0, 8).toString('ascii') === '!<arch>\n'
    || /^(?:070701|070702|070707)$/.test(bytes.subarray(0, 6).toString('ascii'))
  ) {
    return true;
  }
  return bytes.length >= 262 && bytes.subarray(257, 262).toString('ascii') === 'ustar';
}

function hasMagic(bytes: Buffer, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);
}

function containsHighConfidenceSecret(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text)) return true;
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) return true;
  if (/\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text)) return true;
  if (/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/.test(text)) return true;
  if (/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(text)) return true;
  const assignments = text.matchAll(
    /(?=(?:^|[^A-Za-z0-9_-])["']?(?<key>[A-Za-z_][A-Za-z0-9_.-]{0,127})["']?\]?\s*(?:[?+]?=|:)\s*(?:"(?<double>[^"\r\n]*)"|'(?<single>[^'\r\n]*)'|(?<bare>[^\s#,;]+)))/gm,
  );
  for (const match of assignments) {
    const key = String(match.groups?.key || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    if (!/(?:apikey|accesstoken|authtoken|clientsecret|secretaccesskey|secretkey|password|passwd|token|secret)$/.test(key)) {
      continue;
    }
    const candidate = String(
      match.groups?.double ?? match.groups?.single ?? match.groups?.bare ?? '',
    ).toLowerCase();
    if (!isExplicitSafeCredentialValue(key, candidate)) return true;
  }
  return false;
}

function isExplicitSafeCredentialValue(key: string, candidate: string): boolean {
  return (
    candidate === ''
    || /^\$\{[a-z_][a-z0-9_]*\}$/.test(candidate)
    || (
      /(?:password|passwd)$/.test(key)
      && /^(?:minimum|maximum)[-_]length[-_]\d+$/.test(candidate)
    )
    || /^(?:string|number|boolean|unknown|null|undefined|z\.string\(\)(?:\.min\(\d+\))?)$/.test(candidate)
    || /^(?:example[-_](?:api[-_]?key|token|secret|password)|placeholder(?:[-_]value)?|dummy[-_]value|changeme(?:[-_]please)?|your[-_](?:api[-_]?key|token|secret|password)[-_]here|\*{3,})$/.test(candidate)
  );
}

function validRef(ref: BotSkillRef): boolean {
  try {
    canonicalizeBotSkillRefs([ref]);
    return true;
  } catch {
    return false;
  }
}

function validPackageRef(ref: SkillHubPackageRef): boolean {
  const skillId = String(ref?.skillId || '').trim();
  const version = String(ref?.version || '').trim();
  return Boolean(
    skillId
    && version
    && !skillId.split('/').some(part => !part || part === '.' || part === '..')
    && version !== '.'
    && version !== '..'
  );
}

export function isPortablePackagePath(value: string): boolean {
  const normalized = String(value || '').replace(/\\/g, '/');
  const parts = normalized.split('/');
  return Boolean(
    normalized
    && normalized.length <= 1024
    && parts.length <= 64
    && !normalized.includes('\0')
    && !Array.from(normalized).some(char => {
      const code = char.codePointAt(0) ?? 0;
      return (
        code <= 0x1f
        || (code >= 0x7f && code <= 0x9f)
        || (char.length === 1 && code >= 0xd800 && code <= 0xdfff)
      );
    })
    && !normalized.startsWith('/')
    && !/^[A-Za-z]:/.test(normalized)
    && !parts.some(part => (
      !part
      || part === '.'
      || part === '..'
      || /[<>:"|?*]/.test(part)
      || /[. ]$/.test(part)
      || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)
    ))
  );
}

function assertRealPathContained(realRoot: string, candidate: string): void {
  const realCandidate = fs.realpathSync(candidate);
  if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`Skill path escaped its workspace: ${candidate}`);
  }
}

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
