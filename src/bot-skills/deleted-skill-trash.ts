import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const TRASH_SCHEMA = 'xiaoba.bot-skill-trash.v1';
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

interface TrashedSkillFile {
  path: string;
  size: number;
  sha256: string;
}

export interface TrashedSkillManifest {
  schema: typeof TRASH_SCHEMA;
  backupId: string;
  botId: string;
  localSkillId: string;
  name: string;
  installName: string;
  deletedByOwnerUid: string;
  deletedAt: string;
  expiresAt: string;
  files: TrashedSkillFile[];
}

export interface TrashBotSkillOptions {
  runtimeRoot: string;
  botId: string;
  sourcePath: string;
  localSkillId: string;
  name: string;
  installName: string;
  deletedByOwnerUid: string;
  now?: () => Date;
  /** Test-only concurrency hook; production callers must leave this unset. */
  beforeMove?: () => void;
}

export interface TrashBotSkillResult {
  backupId: string;
  deletedAt: string;
  expiresAt: string;
}

/**
 * Atomically moves one active Skill into a verified recoverable trash entry.
 * Trash is evidence only: Runtime discovery never reads this directory.
 */
export function trashBotSkill(options: TrashBotSkillOptions): TrashBotSkillResult {
  const runtimeRoot = requireSafeDirectory(options.runtimeRoot, 'Runtime root');
  const botId = normalizeScopedId(options.botId, 'Bot ID');
  const sourcePath = requireSafeDirectory(options.sourcePath, 'source Skill');
  const localSkillId = normalizeScopedId(options.localSkillId, 'local Skill ID');
  const deletedByOwnerUid = normalizeScopedId(options.deletedByOwnerUid, 'owner UID');
  const files = listFiles(sourcePath);
  const now = options.now ?? (() => new Date());
  const deletedAtDate = now();
  if (!Number.isFinite(deletedAtDate.getTime())) throw new Error('Skill deletion time is invalid.');
  const deletedAt = deletedAtDate.toISOString();
  const expiresAt = new Date(deletedAtDate.getTime() + TRASH_RETENTION_MS).toISOString();
  const backupId = crypto.randomUUID();
  const trashRoot = ensureTrashBotRoot(runtimeRoot, botId);
  cleanupExpiredTrash(trashRoot, deletedAtDate);

  const finalPath = path.join(trashRoot, backupId);
  const temporary = path.join(
    trashRoot,
    `.tmp-${backupId}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
  );
  const packageRoot = path.join(temporary, 'package');
  let sourceMoved = false;
  fs.mkdirSync(temporary, { recursive: false });
  try {
    options.beforeMove?.();
    // sourcePath and trashRoot both live below the same Runtime root. Moving
    // the directory removes it from discovery atomically without recursively
    // deleting any file that was not captured by the verified manifest.
    fs.renameSync(sourcePath, packageRoot);
    sourceMoved = true;
    const movedFiles = listFiles(packageRoot);
    if (!filesEqual(files, movedFiles) || fs.existsSync(sourcePath)) {
      throw new Error('Skill changed while deletion was being prepared; no files were deleted.');
    }
    const manifest: TrashedSkillManifest = {
      schema: TRASH_SCHEMA,
      backupId,
      botId,
      localSkillId,
      name: String(options.name || '').trim(),
      installName: normalizeInstallName(options.installName),
      deletedByOwnerUid,
      deletedAt,
      expiresAt,
      files: movedFiles,
    };
    fs.writeFileSync(
      path.join(temporary, 'deletion.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    fs.renameSync(temporary, finalPath);
    assertTrashEntry(finalPath, manifest);
    return { backupId, deletedAt, expiresAt };
  } catch (error) {
    if (sourceMoved && fs.existsSync(packageRoot) && !fs.existsSync(sourcePath)) {
      try {
        fs.renameSync(packageRoot, sourcePath);
        sourceMoved = false;
      } catch {
        // If restoration itself fails, preserve the temporary recovery
        // evidence instead of recursively deleting the moved source.
      }
    }
    if (!sourceMoved && fs.existsSync(temporary)) {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    throw error;
  }
}

function cleanupExpiredTrash(trashRoot: string, now: Date): void {
  for (const entry of fs.readdirSync(trashRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.tmp-')) continue;
    const entryPath = path.join(trashRoot, entry.name);
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(entryPath, 'deletion.json'), 'utf8'),
      ) as Partial<TrashedSkillManifest>;
      const manifest = validateManifest(raw, entry.name);
      assertTrashEntry(entryPath, manifest);
      if (Date.parse(manifest.expiresAt) <= now.getTime()) {
        fs.rmSync(entryPath, { recursive: true, force: false });
      }
    } catch {
      // Preserve incomplete or invalid evidence for manual recovery.
    }
  }
}

function assertTrashEntry(entryPath: string, expected: TrashedSkillManifest): void {
  const actual = listFiles(path.join(requireSafeDirectory(entryPath, 'Skill trash entry'), 'package'));
  if (!filesEqual(expected.files, actual)) {
    throw new Error('Deleted Skill backup no longer matches its manifest.');
  }
}

function validateManifest(
  value: Partial<TrashedSkillManifest>,
  directoryName: string,
): TrashedSkillManifest {
  if (
    value.schema !== TRASH_SCHEMA
    || value.backupId !== directoryName
    || !isScopedId(value.botId)
    || !isScopedId(value.localSkillId)
    || !isScopedId(value.deletedByOwnerUid)
    || typeof value.name !== 'string'
    || normalizeInstallName(value.installName) !== value.installName
    || !validIsoDate(value.deletedAt)
    || !validIsoDate(value.expiresAt)
    || !Array.isArray(value.files)
  ) {
    throw new Error('Deleted Skill backup manifest is invalid.');
  }
  return value as TrashedSkillManifest;
}

function ensureTrashBotRoot(runtimeRoot: string, botId: string): string {
  let current = runtimeRoot;
  for (const segment of ['data', 'bot-skills', 'trash', botId]) {
    const child = path.join(current, segment);
    if (!fs.existsSync(child)) {
      try {
        fs.mkdirSync(child, { recursive: false });
      } catch (error: any) {
        // Another Runtime process may have created the same safe scope first.
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    current = requireSafeDirectory(child, 'Skill trash directory');
  }
  return current;
}

function listFiles(root: string): TrashedSkillFile[] {
  const safeRoot = requireSafeDirectory(root, 'Skill backup source');
  const files: TrashedSkillFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(safeRoot, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`Skill backup cannot follow a symbolic link: ${relative}`);
      }
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) files.push(fileRecord(safeRoot, relative));
      else throw new Error(`Skill backup found an unsupported filesystem entry: ${relative}`);
    }
  };
  visit(safeRoot);
  return files.sort((left, right) => compareText(left.path, right.path));
}

function fileRecord(root: string, relative: string): TrashedSkillFile {
  const bytes = fs.readFileSync(path.join(root, ...relative.split('/')));
  return {
    path: relative,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

function requireSafeDirectory(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a safe directory: ${resolved}`);
  }
  return resolved;
}

function normalizeScopedId(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!isScopedId(normalized)) throw new Error(`Invalid ${label} for Skill trash.`);
  return normalized;
}

function isScopedId(value: unknown): boolean {
  const normalized = String(value || '');
  return /^[A-Za-z0-9_.:-]{1,200}$/.test(normalized)
    && normalized !== '.'
    && normalized !== '..';
}

function normalizeInstallName(value: unknown): string {
  const normalized = String(value || '').replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) {
    throw new Error('Invalid install name for Skill trash.');
  }
  return normalized;
}

function validIsoDate(value: unknown): boolean {
  const text = String(value || '');
  try {
    return Boolean(text && new Date(text).toISOString() === text);
  } catch {
    return false;
  }
}

function filesEqual(expected: TrashedSkillFile[], actual: TrashedSkillFile[]): boolean {
  return expected.length === actual.length && expected.every((file, index) => (
    file.path === actual[index]?.path
    && file.size === actual[index]?.size
    && file.sha256 === actual[index]?.sha256
  ));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
