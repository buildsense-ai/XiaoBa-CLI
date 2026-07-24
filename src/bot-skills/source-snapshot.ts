import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const BOT_SKILL_SOURCE_MAX_FILES = 200;
export const BOT_SKILL_SOURCE_MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024;
export const BOT_SKILL_SOURCE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export interface BotSkillSourceFile {
  path: string;
  size: number;
  sha256: string;
  bytes: Buffer;
}

export interface BotSkillSourceSnapshot {
  root: string;
  contentHash: string;
  totalBytes: number;
  files: BotSkillSourceFile[];
}

export function computeBotSkillFilesContentHash(
  files: ReadonlyArray<Pick<BotSkillSourceFile, 'path' | 'size' | 'sha256'>>,
): string {
  return contentHashOf([...files].sort((a, b) => compareBotSkillSourcePath(a.path, b.path)));
}

/**
 * Canonical Skill file ordering must not depend on the host ICU locale.
 * Relational string comparison is stable UTF-16 code-unit ordering.
 */
export function compareBotSkillSourcePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class BotSkillSourceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly relativePaths: string[] = [],
  ) {
    super(message);
    this.name = 'BotSkillSourceError';
  }
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  'release',
]);

const FORBIDDEN_DIRECTORIES = new Set([
  '.ssh',
  '.aws',
  '.kube',
  '.gnupg',
]);

const GENERATED_FILES = new Set([
  'skill.json',
  'REVIEW.json',
  'SBOM.json',
  '.xiaoba-bundled-skill.json',
  '.xiaoba-skillhub-install.json',
  '.xiaoba-local-skill.json',
]);

export function buildBotSkillSourceSnapshot(skillDirectory: string): BotSkillSourceSnapshot {
  const root = path.resolve(skillDirectory);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new BotSkillSourceError('Skill source root must be a real directory.', 'SKILL_SOURCE_ROOT_INVALID');
  }

  const filePaths = walkSourceFiles(root);
  if (filePaths.length > BOT_SKILL_SOURCE_MAX_FILES) {
    throw new BotSkillSourceError(
      `Skill source contains more than ${BOT_SKILL_SOURCE_MAX_FILES} files.`,
      'SKILL_SOURCE_FILE_LIMIT',
    );
  }

  let totalBytes = 0;
  const files: BotSkillSourceFile[] = [];
  const sensitivePaths: string[] = [];
  for (const filePath of filePaths) {
    const relative = safeRelativePath(root, filePath);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new BotSkillSourceError('Skill source contains an unsupported filesystem entry.', 'SKILL_SOURCE_ENTRY_UNSAFE', [relative]);
    }
    if (stat.size > BOT_SKILL_SOURCE_MAX_SINGLE_FILE_BYTES) {
      throw new BotSkillSourceError(
        `Skill source file exceeds ${BOT_SKILL_SOURCE_MAX_SINGLE_FILE_BYTES} bytes.`,
        'SKILL_SOURCE_FILE_TOO_LARGE',
        [relative],
      );
    }
    const bytes = readStableFile(filePath, BOT_SKILL_SOURCE_MAX_SINGLE_FILE_BYTES, stat);
    totalBytes += bytes.length;
    if (totalBytes > BOT_SKILL_SOURCE_MAX_TOTAL_BYTES) {
      throw new BotSkillSourceError(
        `Skill source exceeds ${BOT_SKILL_SOURCE_MAX_TOTAL_BYTES} bytes.`,
        'SKILL_SOURCE_TOTAL_TOO_LARGE',
      );
    }
    if (isSensitiveFileName(relative) || containsHighConfidenceSecret(bytes)) {
      sensitivePaths.push(relative);
      continue;
    }
    files.push({
      path: relative,
      size: bytes.length,
      sha256: sha256(bytes),
      bytes,
    });
  }

  if (sensitivePaths.length > 0) {
    throw new BotSkillSourceError(
      'Skill source contains sensitive material and was not uploaded.',
      'SKILL_SOURCE_SENSITIVE',
      sensitivePaths.sort(),
    );
  }
  if (!files.some(file => file.path === 'SKILL.md')) {
    throw new BotSkillSourceError('Skill source is missing SKILL.md.', 'SKILL_SOURCE_ENTRY_MISSING');
  }
  files.sort((a, b) => compareBotSkillSourcePath(a.path, b.path));
  return {
    root,
    contentHash: contentHashOf(files),
    totalBytes,
    files,
  };
}

/**
 * Local dirty detection uses the same byte and path canonicalization as an
 * upload snapshot, but deliberately does not run the sensitive-content gate.
 * A sensitive local Skill remains usable and visible as dirty while upload is
 * blocked later.
 */
export function computeBotSkillSourceContentHash(skillDirectory: string): string {
  const root = path.resolve(skillDirectory);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new BotSkillSourceError('Skill source root must be a real directory.', 'SKILL_SOURCE_ROOT_INVALID');
  }
  const filePaths = walkSourceFiles(root);
  if (filePaths.length > BOT_SKILL_SOURCE_MAX_FILES) {
    throw new BotSkillSourceError('Skill source contains too many files.', 'SKILL_SOURCE_FILE_LIMIT');
  }
  let totalBytes = 0;
  const files = filePaths.map(filePath => {
    const relative = safeRelativePath(root, filePath);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new BotSkillSourceError(
        'Skill source contains an unsupported filesystem entry.',
        'SKILL_SOURCE_ENTRY_UNSAFE',
        [relative],
      );
    }
    const bytes = readStableFile(filePath, BOT_SKILL_SOURCE_MAX_SINGLE_FILE_BYTES, stat);
    totalBytes += bytes.length;
    if (totalBytes > BOT_SKILL_SOURCE_MAX_TOTAL_BYTES) {
      throw new BotSkillSourceError('Skill source is too large.', 'SKILL_SOURCE_TOTAL_TOO_LARGE');
    }
    return {
      path: relative,
      size: bytes.length,
      sha256: sha256(bytes),
      bytes,
    };
  }).sort((a, b) => compareBotSkillSourcePath(a.path, b.path));
  return contentHashOf(files);
}

function walkSourceFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (current: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relative = safeRelativePath(root, fullPath);
      if (entry.isSymbolicLink()) {
        throw new BotSkillSourceError('Skill source contains a symbolic link.', 'SKILL_SOURCE_SYMLINK', [relative]);
      }
      if (entry.isDirectory()) {
        if (FORBIDDEN_DIRECTORIES.has(entry.name.toLowerCase())) {
          throw new BotSkillSourceError(
            'Skill source contains a sensitive credential directory.',
            'SKILL_SOURCE_SENSITIVE',
            [relative],
          );
        }
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(fullPath);
        continue;
      }
      if (entry.isFile() && !GENERATED_FILES.has(entry.name)) {
        result.push(fullPath);
        if (result.length > BOT_SKILL_SOURCE_MAX_FILES) return;
      }
    }
  };
  visit(root);
  return result;
}

function readStableFile(filePath: string, maxBytes: number, expected?: fs.Stats): Buffer {
  const flags = fs.constants.O_RDONLY | Number((fs.constants as any).O_NOFOLLOW || 0);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, flags);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > maxBytes) {
      throw new BotSkillSourceError('Skill source file exceeds its limit.', 'SKILL_SOURCE_FILE_TOO_LARGE');
    }
    if (expected && !sameFileIdentity(expected, before)) {
      throw new BotSkillSourceError('Skill source changed while being read.', 'SKILL_SOURCE_CHANGED_DURING_READ');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(filePath);
    if (
      bytes.length > maxBytes
      || bytes.length !== before.size
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || (before.ino !== 0 && after.ino !== before.ino)
      || current.isSymbolicLink()
      || !current.isFile()
      || !sameFileIdentity(after, current)
    ) {
      throw new BotSkillSourceError('Skill source changed while being read.', 'SKILL_SOURCE_CHANGED_DURING_READ');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0 && right.ino !== 0 && left.ino !== right.ino) return false;
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function contentHashOf(files: Array<Pick<BotSkillSourceFile, 'path' | 'size' | 'sha256'>>): string {
  return sha256(Buffer.from(JSON.stringify(files.map(file => ({
    path: file.path,
    size: file.size,
    sha256: file.sha256,
  }))), 'utf8'));
}

function safeRelativePath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath).replace(/\\/g, '/');
  const segments = relative.split('/');
  if (
    !relative
    || relative.length > 1024
    || segments.length > 64
    || relative.includes('\0')
    || relative.startsWith('/')
    || segments.some(part => (
      part === ''
      || part === '.'
      || part === '..'
      || !portableWindowsSegment(part)
    ))
  ) {
    throw new BotSkillSourceError('Skill source path escapes its root.', 'SKILL_SOURCE_PATH_UNSAFE');
  }
  return relative;
}

function portableWindowsSegment(value: string): boolean {
  if (!value || /[<>:"|?*]/.test(value) || /[. ]$/.test(value)) return false;
  const stem = value.split('.')[0].toUpperCase();
  return !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}

function isSensitiveFileName(relativePath: string): boolean {
  const name = path.posix.basename(relativePath).toLowerCase();
  return (
    name === '.env'
    || name.startsWith('.env.')
    || name === '.npmrc'
    || name === '.pypirc'
    || name === 'credentials'
    || name === 'credentials.json'
    || name === 'kubeconfig'
    || name === 'id_rsa'
    || name === 'id_ed25519'
    || name.endsWith('.pem')
    || name.endsWith('.key')
    || name.endsWith('.p12')
    || name.endsWith('.pfx')
  );
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
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']?([^\s"'#]{16,})/gi,
  );
  for (const match of assignments) {
    const candidate = String(match[1] || '').toLowerCase();
    if (!/(example|placeholder|dummy|changeme|your[_-]|test[_-]|\*{3,})/.test(candidate)) return true;
  }
  return false;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
