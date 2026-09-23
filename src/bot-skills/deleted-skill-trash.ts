import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  requireSafeDirectory,
  requireSafeRuntimeDataDirectory,
} from './safe-directory';
import { withBotSkillWorkspaceLock } from './lock';
import { Logger } from '../utils/logger';

const TRASH_SCHEMA = 'xiaoba.bot-skill-trash.v1';
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_TRASH_GC_INTERVAL_MS = 6 * 60 * 60 * 1_000;

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

export interface SkillTrashCleanupResult {
  scanned: number;
  removed: number;
  preserved: number;
}

export interface SkillTrashGarbageCollectorOptions {
  runtimeRoot: string;
  intervalMs?: number;
  initialDelayMs?: number;
  now?: () => Date;
}

export interface SkillTrashGarbageCollectorHandle {
  runNow: () => Promise<SkillTrashCleanupResult>;
  stop: () => void;
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
    // Moving the directory removes it from discovery atomically without
    // recursively deleting any file that was not captured by the verified
    // manifest. A release deployment may share `data` through a link, so the
    // trash root is only guaranteed to be reachable through the Runtime root:
    // the move still needs both sides on one filesystem, which `rename`
    // reports as EXDEV.
    try {
      fs.renameSync(sourcePath, packageRoot);
    } catch (error: any) {
      if (error?.code === 'EXDEV') {
        throw new Error(
          'The shared Runtime data directory must stay on the same filesystem as the Skill '
          + `workspace, because deletion moves the Skill into trash: ${error.message}`,
        );
      }
      throw error;
    }
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
      removeExpiredTrashEntry(entryPath, path.basename(trashRoot), now);
    } catch {
      // Preserve incomplete or invalid evidence for manual recovery.
    }
  }
}

function removeExpiredTrashEntry(entryPath: string, botId: string, now: Date): boolean {
  requireSafeDirectory(entryPath, 'Skill trash entry');
  const children = fs.readdirSync(entryPath).sort();
  if (children.length !== 2 || children[0] !== 'deletion.json' || children[1] !== 'package') {
    throw new Error('Skill trash contains unrecorded recovery evidence.');
  }
  const manifestPath = path.join(entryPath, 'deletion.json');
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe Skill trash manifest.');
  const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), path.basename(entryPath));
  if (manifest.botId !== botId) throw new Error('Skill trash Bot scope does not match.');
  if (Date.parse(manifest.expiresAt) > now.getTime()) return false;
  assertTrashEntry(entryPath, manifest);
  fs.rmSync(entryPath, { recursive: true, force: false });
  return true;
}

function existingTrashRoot(runtimeRoot: string): string | undefined {
  requireSafeDirectory(runtimeRoot, 'Runtime root');
  if (!fs.existsSync(path.join(runtimeRoot, 'data'))) return undefined;
  let current = requireSafeRuntimeDataDirectory(runtimeRoot, 'Skill trash directory');
  for (const segment of ['bot-skills', 'trash']) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) return undefined;
    requireSafeDirectory(current, 'Skill trash directory');
  }
  return current;
}

/**
 * Removes only verified, expired Skill backups across every Bot trash scope.
 * Invalid or incomplete entries are deliberately preserved for manual recovery.
 */
export function cleanupExpiredBotSkillTrash(options: {
  runtimeRoot: string;
  now?: () => Date;
}): SkillTrashCleanupResult {
  const runtimeRoot = requireSafeDirectory(options.runtimeRoot, 'Runtime root');
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Skill trash cleanup time is invalid.');
  const safeTrashRoot = existingTrashRoot(runtimeRoot);
  if (!safeTrashRoot) return { scanned: 0, removed: 0, preserved: 0 };
  let scanned = 0;
  let removed = 0;
  let preserved = 0;
  for (const botEntry of fs.readdirSync(safeTrashRoot, { withFileTypes: true })) {
    if (!botEntry.isDirectory() || botEntry.isSymbolicLink()) continue;
    const botRoot = requireSafeDirectory(path.join(safeTrashRoot, botEntry.name), 'Skill trash Bot scope');
    for (const backupEntry of fs.readdirSync(botRoot, { withFileTypes: true })) {
      if (!backupEntry.isDirectory() || backupEntry.isSymbolicLink() || backupEntry.name.startsWith('.tmp-')) continue;
      scanned += 1;
      const backupPath = path.join(botRoot, backupEntry.name);
      try {
        if (removeExpiredTrashEntry(backupPath, botEntry.name, now)) {
          removed += 1;
        } else {
          preserved += 1;
        }
      } catch {
        preserved += 1;
      }
    }
  }
  return { scanned, removed, preserved };
}

/** Schedules cleanup; a busy workspace defers it to the next interval. */
export function startSkillTrashGarbageCollector(
  options: SkillTrashGarbageCollectorOptions,
): SkillTrashGarbageCollectorHandle {
  const intervalMs = Number.isFinite(options.intervalMs) && Number(options.intervalMs) > 0
    ? Number(options.intervalMs)
    : DEFAULT_TRASH_GC_INTERVAL_MS;
  let stopped = false;
  let running: Promise<SkillTrashCleanupResult> | undefined;
  const empty = (): SkillTrashCleanupResult => ({ scanned: 0, removed: 0, preserved: 0 });
  const runNow = (): Promise<SkillTrashCleanupResult> => {
    if (stopped) return Promise.resolve(empty());
    if (running) return running;
    running = (async () => {
      // Validate every path segment before the lock helper touches the filesystem.
      if (!existingTrashRoot(path.resolve(options.runtimeRoot))) return empty();
      return withBotSkillWorkspaceLock(options.runtimeRoot, () => (
        stopped ? empty() : cleanupExpiredBotSkillTrash(options)
      ), { waitMs: 1_000 });
    })().finally(() => { running = undefined; });
    return running;
  };
  const tick = () => {
    if (stopped) return;
    void runNow().then(result => {
      if (result.removed > 0) Logger.info(`[Skill trash GC] removed ${result.removed} expired backup(s)`);
    }).catch(error => {
      Logger.warning(`[Skill trash GC] cleanup deferred: ${error?.message || String(error)}`);
    });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const initialTimer = setTimeout(tick, options.initialDelayMs ?? 60_000);
  initialTimer.unref?.();
  return {
    runNow,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(initialTimer);
    },
  };
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
    || Date.parse(String(value.expiresAt)) - Date.parse(String(value.deletedAt)) < TRASH_RETENTION_MS
    || !Array.isArray(value.files)
  ) {
    throw new Error('Deleted Skill backup manifest is invalid.');
  }
  return value as TrashedSkillManifest;
}

function ensureTrashBotRoot(runtimeRoot: string, botId: string): string {
  let current = requireSafeRuntimeDataDirectory(runtimeRoot, 'Skill trash directory');
  for (const segment of ['bot-skills', 'trash', botId]) {
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
