import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { withBotSkillWorkspaceLock } from '../bot-skills/lock';
import { renameBotSkillWorkspaceSync } from '../bot-skills/workspace-fs';

const SNAPSHOT_SCHEMA = 'xiaoba.turn-skill-snapshot.v1';
const LEASE_SCHEMA = 'xiaoba.turn-skill-snapshot-lease.v1';
const USAGE_SCHEMA = 'xiaoba.turn-skill-snapshot-usage.v1';
const SNAPSHOT_FILE = 'snapshot.json';
const SNAPSHOT_DIRECTORY = 'skills';
const DEFAULT_GC_MIN_AGE_MS = 24 * 60 * 60_000;
const SNAPSHOT_ID_PATTERN = /^[a-f0-9]{64}$/;
const LEASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface SnapshotFileEntry {
  path: string;
  size: number;
  sha256: string;
  mode: number;
}

interface ScannedSnapshotFile extends SnapshotFileEntry {
  sourcePath: string;
}

interface WorkspaceTree {
  directories: string[];
  files: ScannedSnapshotFile[];
  contentHash: string;
  totalBytes: number;
}

interface TurnSkillSnapshotManifest {
  schema: typeof SNAPSHOT_SCHEMA;
  snapshotId: string;
  revision: string;
  directories: string[];
  files: SnapshotFileEntry[];
  fileCount: number;
  totalBytes: number;
  createdAt: string;
}

interface TurnSkillSnapshotLeaseRecord {
  schema: typeof LEASE_SCHEMA;
  snapshotId: string;
  leaseId: string;
  pid: number;
  createdAt: string;
}

export interface TurnSkillSnapshotDescriptor {
  snapshotId: string;
  revision: string;
  rootPath: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
  deduplicated: boolean;
}

export interface TurnSkillSnapshotStoreOptions {
  runtimeRoot: string;
  skillsRoot?: string;
  now?: () => Date;
}

export interface TurnSkillSnapshotGcOptions {
  minAgeMs?: number;
}

export interface TurnSkillSnapshotGcResult {
  removed: string[];
  preservedLeased: string[];
  preservedRecent: string[];
  preservedInvalid: string[];
}

/**
 * One reference-counted claim on an immutable turn Skill snapshot.
 *
 * Runtime code passes this opaque lease through ToolExecutionContext. It is
 * generated locally and is never part of model-provided tool arguments.
 */
export class TurnSkillSnapshotLease {
  private released = false;

  constructor(
    private readonly store: TurnSkillSnapshotStore,
    private readonly leaseId: string,
    readonly snapshot: TurnSkillSnapshotDescriptor,
  ) {}

  /** Creates an independent child lease for background/sub-agent work. */
  async retain(): Promise<TurnSkillSnapshotLease> {
    if (this.released) throw new Error('Cannot retain a released turn Skill snapshot lease.');
    return this.store.retainSnapshot(this.snapshot.snapshotId);
  }

  /** Idempotently releases only this claim. */
  async release(): Promise<void> {
    if (this.released) return;
    await this.store.releaseLease(this.snapshot.snapshotId, this.leaseId);
    this.released = true;
  }
}

/**
 * Content-addressed immutable snapshots of the complete active Skill tree.
 *
 * Publication and garbage collection share the Bot Skill workspace lock with
 * activation. Snapshot objects are written to a temporary sibling, verified,
 * and atomically renamed. Persistent per-process lease files keep GC safe even
 * when more than one Runtime process shares the same userData directory.
 */
export class TurnSkillSnapshotStore {
  private readonly runtimeRoot: string;
  private readonly skillsRoot: string;
  private readonly now: () => Date;

  constructor(options: TurnSkillSnapshotStoreOptions) {
    this.runtimeRoot = requireSafeDirectory(options.runtimeRoot, 'Runtime root');
    this.skillsRoot = path.resolve(options.skillsRoot ?? path.join(this.runtimeRoot, 'skills'));
    const plannedStoreRoot = path.join(this.runtimeRoot, 'data', 'bot-skills', 'turn-snapshots');
    if (containsPath(this.skillsRoot, plannedStoreRoot)) {
      throw new Error('Skill workspace cannot contain the turn Skill snapshot store.');
    }
    this.now = options.now ?? (() => new Date());
  }

  async acquire(): Promise<TurnSkillSnapshotLease> {
    return withBotSkillWorkspaceLock(this.runtimeRoot, () => {
      const storeRoot = this.ensureStoreRoot();
      const tree = scanWorkspaceTree(this.skillsRoot);
      const published = this.publishSnapshot(storeRoot, tree);
      this.writeUsage(storeRoot, published.snapshotId);
      return this.createLease(storeRoot, published);
    });
  }

  async inspect(snapshotIdValue: string): Promise<TurnSkillSnapshotDescriptor> {
    return withBotSkillWorkspaceLock(this.runtimeRoot, () => {
      const storeRoot = this.ensureStoreRoot();
      return this.inspectSnapshot(storeRoot, normalizeSnapshotId(snapshotIdValue), false);
    });
  }

  async collectGarbage(
    options: TurnSkillSnapshotGcOptions = {},
  ): Promise<TurnSkillSnapshotGcResult> {
    const minAgeMs = nonNegativeDuration(options.minAgeMs, DEFAULT_GC_MIN_AGE_MS);
    return withBotSkillWorkspaceLock(this.runtimeRoot, () => {
      const storeRoot = this.ensureStoreRoot();
      const result: TurnSkillSnapshotGcResult = {
        removed: [],
        preservedLeased: [],
        preservedRecent: [],
        preservedInvalid: [],
      };
      const objectsRoot = path.join(storeRoot, 'objects');
      for (const entry of fs.readdirSync(objectsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.tmp-')) {
          continue;
        }
        if (!SNAPSHOT_ID_PATTERN.test(entry.name)) {
          result.preservedInvalid.push(entry.name);
          continue;
        }
        let snapshot: TurnSkillSnapshotDescriptor;
        try {
          snapshot = this.inspectSnapshot(storeRoot, entry.name, false);
        } catch {
          result.preservedInvalid.push(entry.name);
          continue;
        }
        const leaseState = inspectLeases(storeRoot, entry.name);
        if (leaseState.invalid || leaseState.live > 0) {
          result.preservedLeased.push(entry.name);
          continue;
        }
        const lastUsedAt = readLastUsedAt(storeRoot, snapshot);
        if (this.now().getTime() - lastUsedAt < minAgeMs) {
          result.preservedRecent.push(entry.name);
          continue;
        }
        removeSnapshotArtifacts(storeRoot, entry.name);
        result.removed.push(entry.name);
      }
      return result;
    });
  }

  async retainSnapshot(snapshotIdValue: string): Promise<TurnSkillSnapshotLease> {
    return withBotSkillWorkspaceLock(this.runtimeRoot, () => {
      const storeRoot = this.ensureStoreRoot();
      const snapshot = this.inspectSnapshot(
        storeRoot,
        normalizeSnapshotId(snapshotIdValue),
        true,
      );
      this.writeUsage(storeRoot, snapshot.snapshotId);
      return this.createLease(storeRoot, snapshot);
    });
  }

  async releaseLease(snapshotIdValue: string, leaseIdValue: string): Promise<void> {
    const snapshotId = normalizeSnapshotId(snapshotIdValue);
    const leaseId = normalizeLeaseId(leaseIdValue);
    await withBotSkillWorkspaceLock(this.runtimeRoot, () => {
      const storeRoot = this.ensureStoreRoot();
      const leaseRoot = path.join(storeRoot, 'leases', snapshotId);
      if (!fs.existsSync(leaseRoot)) return;
      requireSafeDirectory(leaseRoot, 'turn Skill snapshot lease directory');
      const leasePath = path.join(leaseRoot, `${leaseId}.json`);
      if (!fs.existsSync(leasePath)) return;
      const record = readLeaseRecord(leasePath, snapshotId, leaseId);
      if (record.pid !== process.pid) {
        throw new Error('Cannot release a turn Skill snapshot lease owned by another process.');
      }
      fs.rmSync(leasePath, { force: false });
      if (fs.readdirSync(leaseRoot).length === 0) fs.rmdirSync(leaseRoot);
    });
  }

  private ensureStoreRoot(): string {
    let current = this.runtimeRoot;
    for (const segment of ['data', 'bot-skills', 'turn-snapshots']) {
      current = ensureSafeChildDirectory(current, segment);
    }
    for (const segment of ['objects', 'leases', 'usage']) {
      ensureSafeChildDirectory(current, segment);
    }
    return current;
  }

  private publishSnapshot(
    storeRoot: string,
    tree: WorkspaceTree,
  ): TurnSkillSnapshotDescriptor {
    const objectsRoot = path.join(storeRoot, 'objects');
    const finalPath = path.join(objectsRoot, tree.contentHash);
    if (fs.existsSync(finalPath)) {
      return this.inspectSnapshot(storeRoot, tree.contentHash, true);
    }

    const temporary = path.join(
      objectsRoot,
      `.tmp-${tree.contentHash}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
    );
    const snapshotRoot = path.join(temporary, SNAPSHOT_DIRECTORY);
    fs.mkdirSync(snapshotRoot, { recursive: true });
    try {
      for (const directory of tree.directories) {
        fs.mkdirSync(path.join(snapshotRoot, ...directory.split('/')), { recursive: true });
      }
      for (const file of tree.files) {
        const target = path.join(snapshotRoot, ...file.path.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(file.sourcePath, target, fs.constants.COPYFILE_EXCL);
        if (process.platform !== 'win32') fs.chmodSync(target, file.mode);
      }

      const copied = scanWorkspaceTree(snapshotRoot);
      if (copied.contentHash !== tree.contentHash) {
        throw new Error('Turn Skill snapshot changed while it was being copied.');
      }
      const createdAt = this.now().toISOString();
      const manifest: TurnSkillSnapshotManifest = {
        schema: SNAPSHOT_SCHEMA,
        snapshotId: tree.contentHash,
        revision: tree.contentHash,
        directories: tree.directories,
        files: tree.files.map(({ path: filePath, size, sha256, mode }) => ({
          path: filePath,
          size,
          sha256,
          mode,
        })),
        fileCount: tree.files.length,
        totalBytes: tree.totalBytes,
        createdAt,
      };
      fs.writeFileSync(
        path.join(temporary, SNAPSHOT_FILE),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      renameBotSkillWorkspaceSync(temporary, finalPath);
      return descriptorFromManifest(finalPath, manifest, false);
    } catch (error) {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
      if (fs.existsSync(finalPath)) {
        return this.inspectSnapshot(storeRoot, tree.contentHash, true);
      }
      throw error;
    }
  }

  private inspectSnapshot(
    storeRoot: string,
    snapshotId: string,
    deduplicated: boolean,
  ): TurnSkillSnapshotDescriptor {
    const objectPath = path.join(storeRoot, 'objects', snapshotId);
    const safeObjectPath = requireSafeDirectory(objectPath, 'turn Skill snapshot object');
    const manifest = readSnapshotManifest(safeObjectPath, snapshotId);
    const snapshotRoot = requireSafeDirectory(
      path.join(safeObjectPath, SNAPSHOT_DIRECTORY),
      'turn Skill snapshot tree',
    );
    const scanned = scanWorkspaceTree(snapshotRoot);
    if (
      scanned.contentHash !== manifest.snapshotId
      || scanned.contentHash !== manifest.revision
      || scanned.files.length !== manifest.fileCount
      || scanned.totalBytes !== manifest.totalBytes
      || !sameDirectories(scanned.directories, manifest.directories)
      || !sameFiles(scanned.files, manifest.files)
    ) {
      throw new Error('Turn Skill snapshot no longer matches its verified manifest.');
    }
    return descriptorFromManifest(safeObjectPath, manifest, deduplicated);
  }

  private createLease(
    storeRoot: string,
    snapshot: TurnSkillSnapshotDescriptor,
  ): TurnSkillSnapshotLease {
    const leaseId = crypto.randomUUID();
    const leaseRoot = ensureSafeChildDirectory(
      path.join(storeRoot, 'leases'),
      snapshot.snapshotId,
    );
    const record: TurnSkillSnapshotLeaseRecord = {
      schema: LEASE_SCHEMA,
      snapshotId: snapshot.snapshotId,
      leaseId,
      pid: process.pid,
      createdAt: this.now().toISOString(),
    };
    fs.writeFileSync(
      path.join(leaseRoot, `${leaseId}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    return new TurnSkillSnapshotLease(this, leaseId, snapshot);
  }

  private writeUsage(storeRoot: string, snapshotId: string): void {
    const usagePath = path.join(storeRoot, 'usage', `${snapshotId}.json`);
    const temporary = `${usagePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({
      schema: USAGE_SCHEMA,
      snapshotId,
      lastUsedAt: this.now().toISOString(),
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, usagePath);
  }
}

function scanWorkspaceTree(rootValue: string): WorkspaceTree {
  const root = path.resolve(rootValue);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return buildWorkspaceTree([], []);
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Skill workspace is not a safe directory: ${root}`);
  }
  const realRoot = fs.realpathSync(root);
  const directories: string[] = [];
  const files: ScannedSnapshotFile[] = [];
  const visit = (directory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new Error(`Skill workspace contains a symbolic link: ${toRelative(root, absolute)}`);
      }
      assertRealPathContained(realRoot, absolute);
      const relative = toRelative(root, absolute);
      if (entry.isDirectory() && stat.isDirectory()) {
        directories.push(relative);
        visit(absolute);
        continue;
      }
      if (!entry.isFile() || !stat.isFile()) {
        throw new Error(`Skill workspace contains an unsupported entry: ${relative}`);
      }
      const bytes = fs.readFileSync(absolute);
      files.push({
        path: relative,
        sourcePath: absolute,
        size: bytes.length,
        sha256: sha256(bytes),
        mode: stat.mode & 0o777,
      });
    }
  };
  visit(root);
  return buildWorkspaceTree(directories, files);
}

function buildWorkspaceTree(
  directories: string[],
  files: ScannedSnapshotFile[],
): WorkspaceTree {
  const sortedDirectories = [...directories].sort(compareText);
  const sortedFiles = [...files].sort((left, right) => compareText(left.path, right.path));
  const hashInput = {
    directories: sortedDirectories,
    files: sortedFiles.map(({ path: filePath, size, sha256: fileHash, mode }) => ({
      path: filePath,
      size,
      sha256: fileHash,
      mode,
    })),
  };
  return {
    directories: sortedDirectories,
    files: sortedFiles,
    contentHash: sha256(Buffer.from(JSON.stringify(hashInput), 'utf8')),
    totalBytes: sortedFiles.reduce((total, file) => total + file.size, 0),
  };
}

function readSnapshotManifest(
  objectPath: string,
  snapshotId: string,
): TurnSkillSnapshotManifest {
  let value: Partial<TurnSkillSnapshotManifest>;
  try {
    value = JSON.parse(fs.readFileSync(path.join(objectPath, SNAPSHOT_FILE), 'utf8'));
  } catch {
    throw new Error('Turn Skill snapshot manifest cannot be read safely.');
  }
  if (
    value.schema !== SNAPSHOT_SCHEMA
    || value.snapshotId !== snapshotId
    || value.revision !== snapshotId
    || !Array.isArray(value.directories)
    || !Array.isArray(value.files)
    || !Number.isInteger(value.fileCount)
    || Number(value.fileCount) < 0
    || !Number.isSafeInteger(value.totalBytes)
    || Number(value.totalBytes) < 0
    || !validIsoDate(value.createdAt)
  ) {
    throw new Error('Turn Skill snapshot manifest is invalid.');
  }
  return value as TurnSkillSnapshotManifest;
}

function readLeaseRecord(
  leasePath: string,
  snapshotId: string,
  leaseId: string,
): TurnSkillSnapshotLeaseRecord {
  let value: Partial<TurnSkillSnapshotLeaseRecord>;
  try {
    value = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
  } catch {
    throw new Error('Turn Skill snapshot lease cannot be read safely.');
  }
  if (
    value.schema !== LEASE_SCHEMA
    || value.snapshotId !== snapshotId
    || value.leaseId !== leaseId
    || !Number.isInteger(value.pid)
    || Number(value.pid) <= 0
    || !validIsoDate(value.createdAt)
  ) {
    throw new Error('Turn Skill snapshot lease is invalid.');
  }
  return value as TurnSkillSnapshotLeaseRecord;
}

function inspectLeases(
  storeRoot: string,
  snapshotId: string,
): { live: number; invalid: boolean } {
  const leaseRoot = path.join(storeRoot, 'leases', snapshotId);
  if (!fs.existsSync(leaseRoot)) return { live: 0, invalid: false };
  try {
    requireSafeDirectory(leaseRoot, 'turn Skill snapshot lease directory');
  } catch {
    return { live: 0, invalid: true };
  }
  let live = 0;
  let invalid = false;
  for (const entry of fs.readdirSync(leaseRoot, { withFileTypes: true })) {
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/
      .exec(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !match) {
      invalid = true;
      continue;
    }
    const leasePath = path.join(leaseRoot, entry.name);
    try {
      const record = readLeaseRecord(leasePath, snapshotId, match[1]);
      if (isProcessAlive(record.pid)) {
        live += 1;
      } else {
        fs.rmSync(leasePath, { force: false });
      }
    } catch {
      invalid = true;
    }
  }
  if (!invalid && live === 0 && fs.readdirSync(leaseRoot).length === 0) {
    fs.rmdirSync(leaseRoot);
  }
  return { live, invalid };
}

function readLastUsedAt(
  storeRoot: string,
  snapshot: TurnSkillSnapshotDescriptor,
): number {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(storeRoot, 'usage', `${snapshot.snapshotId}.json`), 'utf8'),
    ) as { schema?: string; snapshotId?: string; lastUsedAt?: string };
    if (
      value.schema === USAGE_SCHEMA
      && value.snapshotId === snapshot.snapshotId
      && validIsoDate(value.lastUsedAt)
    ) {
      return Date.parse(value.lastUsedAt!);
    }
  } catch {
    // A missing/corrupt usage record never changes snapshot validity.
  }
  return Date.parse(snapshot.createdAt);
}

function removeSnapshotArtifacts(storeRoot: string, snapshotId: string): void {
  const objectPath = path.resolve(storeRoot, 'objects', snapshotId);
  const objectsRoot = path.resolve(storeRoot, 'objects');
  assertDirectChild(objectsRoot, objectPath);
  fs.rmSync(objectPath, { recursive: true, force: false });
  fs.rmSync(path.join(storeRoot, 'usage', `${snapshotId}.json`), { force: true });
}

function descriptorFromManifest(
  objectPath: string,
  manifest: TurnSkillSnapshotManifest,
  deduplicated: boolean,
): TurnSkillSnapshotDescriptor {
  return {
    snapshotId: manifest.snapshotId,
    revision: manifest.revision,
    rootPath: path.join(objectPath, SNAPSHOT_DIRECTORY),
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    createdAt: manifest.createdAt,
    deduplicated,
  };
}

function sameDirectories(left: string[], right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameFiles(left: ScannedSnapshotFile[], right: SnapshotFileEntry[]): boolean {
  return JSON.stringify(left.map(({ path: filePath, size, sha256: fileHash, mode }) => ({
    path: filePath,
    size,
    sha256: fileHash,
    mode,
  }))) === JSON.stringify(right);
}

function ensureSafeChildDirectory(parentValue: string, name: string): string {
  const parent = requireSafeDirectory(parentValue, 'turn Skill snapshot parent directory');
  const child = path.join(parent, name);
  if (!fs.existsSync(child)) {
    try {
      fs.mkdirSync(child, { recursive: false });
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return requireSafeDirectory(child, 'turn Skill snapshot directory');
}

function requireSafeDirectory(value: string, label: string): string {
  const resolved = path.resolve(value);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a safe directory.`);
  }
  return resolved;
}

function assertRealPathContained(realRoot: string, candidate: string): void {
  const realCandidate = fs.realpathSync(candidate);
  const relative = path.relative(realRoot, realCandidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error('Skill workspace entry escapes its root.');
}

function assertDirectChild(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error('Refusing to remove a turn Skill snapshot outside the object store.');
  }
}

function containsPath(parentValue: string, candidateValue: string): boolean {
  const relative = path.relative(path.resolve(parentValue), path.resolve(candidateValue));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toRelative(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Skill workspace entry escapes its root.');
  }
  return relative.split(path.sep).join('/');
}

function normalizeSnapshotId(value: string): string {
  const snapshotId = String(value || '').trim();
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) throw new Error('Invalid turn Skill snapshot ID.');
  return snapshotId;
}

function normalizeLeaseId(value: string): string {
  const leaseId = String(value || '').trim().toLowerCase();
  if (!LEASE_ID_PATTERN.test(leaseId)) throw new Error('Invalid turn Skill snapshot lease ID.');
  return leaseId;
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== 'ESRCH';
  }
}

function validIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nonNegativeDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
