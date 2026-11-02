import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isEphemeralSkillDirectory } from './local-manifest';

export interface BotSkillPendingSnapshotOptions {
  runtimeRoot: string;
  botId: string;
  sourcePath: string;
  recordedSourcePath?: string;
  reason:
    | 'activation_local_changed'
    | 'activation_without_base'
    | 'activation_cloud_reconcile';
  baseRevision?: number;
  cloudRevision: number;
  now?: () => Date;
}

export interface BotSkillPendingSnapshotResult {
  path: string;
  fingerprint: string;
  fileCount: number;
  deduplicated: boolean;
}

interface PendingSnapshotFile {
  path: string;
  size: number;
  sha256: string;
}

interface PendingSnapshotManifest {
  schema: 'xiaoba.bot-skill-local-pending.v1';
  botId: string;
  sourcePath: string;
  reason: BotSkillPendingSnapshotOptions['reason'];
  detectedAt: string;
  fingerprint: string;
  cloudRevision: number;
  baseRevision?: number;
  files: PendingSnapshotFile[];
}

/**
 * Preserves durable local Skill workspace content before Cloud-authoritative
 * activation replaces it. Regenerable runtime directories are excluded. The
 * snapshot is evidence only and is never loaded as an active Skill workspace.
 */
export async function snapshotPendingBotSkillWorkspace(
  options: BotSkillPendingSnapshotOptions,
): Promise<BotSkillPendingSnapshotResult> {
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const sourcePath = path.resolve(options.sourcePath);
  const recordedSourcePath = path.resolve(options.recordedSourcePath ?? sourcePath);
  const botId = normalizeBotId(options.botId);
  const files = await listWorkspaceFiles(sourcePath);
  const fingerprint = pendingFingerprint({
    botId,
    sourcePath: recordedSourcePath,
    reason: options.reason,
    ...(options.baseRevision !== undefined ? { baseRevision: options.baseRevision } : {}),
    cloudRevision: options.cloudRevision,
    files,
  });
  const root = path.join(runtimeRoot, 'data', 'bot-skills', 'local-pending', botId);
  const existing = await findExistingSnapshot(root, fingerprint);
  if (existing) {
    await verifySourceUnchanged(sourcePath, files);
    return { path: existing, fingerprint, fileCount: files.length, deduplicated: true };
  }

  const detectedAt = (options.now ?? (() => new Date()))().toISOString();
  const directoryName = `${detectedAt.replace(/[:.]/g, '-')}-${fingerprint}`;
  const finalPath = path.join(root, directoryName);
  const temporary = path.join(root, `.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  const packageRoot = path.join(temporary, 'package');
  const manifest: PendingSnapshotManifest = {
    schema: 'xiaoba.bot-skill-local-pending.v1',
    botId,
    sourcePath: recordedSourcePath,
    reason: options.reason,
    detectedAt,
    fingerprint,
    cloudRevision: options.cloudRevision,
    ...(options.baseRevision !== undefined ? { baseRevision: options.baseRevision } : {}),
    files,
  };

  try {
    await fs.promises.mkdir(packageRoot, { recursive: true });
    for (const file of files) {
      const source = path.join(sourcePath, ...file.path.split('/'));
      const target = path.join(packageRoot, ...file.path.split('/'));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
      const copied = await fileRecord(packageRoot, file.path);
      if (copied.size !== file.size || copied.sha256 !== file.sha256) {
        throw new Error(`Bot Skill pending snapshot verification failed: ${file.path}`);
      }
    }
    await verifySourceUnchanged(sourcePath, files);
    await fs.promises.writeFile(
      path.join(temporary, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.rename(temporary, finalPath);
    return { path: finalPath, fingerprint, fileCount: files.length, deduplicated: false };
  } catch (error) {
    await fs.promises.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function verifySourceUnchanged(root: string, files: PendingSnapshotFile[]): Promise<void> {
  // Async I/O allows other handlers/editors to run. Do not replace Local using
  // evidence that missed an edit/new file made while copying or deduplicating.
  if (!snapshotFilesEqual(files, await listWorkspaceFiles(root))) {
    throw new Error('Bot Skill workspace changed during pending snapshot; retry while idle.');
  }
}

async function listWorkspaceFiles(root: string): Promise<PendingSnapshotFile[]> {
  let rootStats: fs.Stats;
  try {
    rootStats = await fs.promises.lstat(root);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (rootStats.isSymbolicLink()) {
    throw new Error('Bot Skill pending snapshot cannot follow a symbolic link at its root.');
  }
  if (!rootStats.isDirectory()) throw new Error('Bot Skill workspace is not a directory.');

  const files: PendingSnapshotFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      // Only skip real runtime directories. A symlink with an ephemeral name
      // still reaches lstat below and is rejected fail-closed.
      if (entry.isDirectory() && isEphemeralSkillDirectory(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stats = await fs.promises.lstat(absolute);
      if (stats.isSymbolicLink()) {
        throw new Error(`Bot Skill pending snapshot cannot follow a symbolic link: ${relative}`);
      }
      if (stats.isDirectory()) await visit(absolute);
      else if (stats.isFile()) files.push(await fileRecord(root, relative));
      else throw new Error(`Bot Skill pending snapshot found an unsupported file: ${relative}`);
    }
  };
  await visit(root);
  return files.sort((left, right) => compareText(left.path, right.path));
}

async function fileRecord(root: string, relative: string): Promise<PendingSnapshotFile> {
  const absolute = path.join(root, ...relative.split('/'));
  // Bound memory and yield to WebSocket heartbeat/message handlers even for
  // large evidence files. The fingerprint format remains byte-for-byte stable.
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(absolute, { highWaterMark: 256 * 1024 })) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { path: relative, size, sha256: hash.digest('hex') };
}

async function findExistingSnapshot(root: string, fingerprint: string): Promise<string | undefined> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.tmp-')) continue;
    const candidate = path.join(root, entry.name);
    try {
      const manifest = JSON.parse(
        await fs.promises.readFile(path.join(candidate, 'manifest.json'), 'utf8'),
      ) as Partial<PendingSnapshotManifest>;
      // Most historic snapshots cannot match. Never reread their package bytes
      // just to discover this; matching manifests still require full verification.
      if (manifest.schema !== 'xiaoba.bot-skill-local-pending.v1'
        || manifest.fingerprint !== fingerprint || !Array.isArray(manifest.files)) continue;
      const packageFiles = await listWorkspaceFiles(path.join(candidate, 'package'));
      if (
        manifest.schema === 'xiaoba.bot-skill-local-pending.v1'
        && manifest.fingerprint === fingerprint
        && Array.isArray(manifest.files)
        && snapshotFilesEqual(manifest.files, packageFiles)
        && pendingFingerprint({
          botId: String(manifest.botId || ''),
          sourcePath: String(manifest.sourcePath || ''),
          reason: manifest.reason as PendingSnapshotManifest['reason'],
          ...(manifest.baseRevision !== undefined ? { baseRevision: manifest.baseRevision } : {}),
          cloudRevision: Number(manifest.cloudRevision),
          files: packageFiles,
        }) === fingerprint
      ) return candidate;
    } catch {
      // Invalid old evidence must not suppress creation of a verified snapshot.
    }
  }
  return undefined;
}

function pendingFingerprint(
  value: Pick<
    PendingSnapshotManifest,
    'botId' | 'sourcePath' | 'reason' | 'baseRevision' | 'cloudRevision' | 'files'
  >,
): string {
  return sha256(Buffer.from(JSON.stringify({
    botId: value.botId,
    sourcePath: value.sourcePath,
    reason: value.reason,
    ...(value.baseRevision !== undefined ? { baseRevision: value.baseRevision } : {}),
    cloudRevision: value.cloudRevision,
    files: value.files,
  })));
}

function snapshotFilesEqual(
  expected: PendingSnapshotFile[],
  actual: PendingSnapshotFile[],
): boolean {
  return expected.length === actual.length && expected.every((file, index) => (
    file?.path === actual[index]?.path
    && file?.size === actual[index]?.size
    && file?.sha256 === actual[index]?.sha256
  ));
}

function normalizeBotId(value: string): string {
  const botId = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,160}$/.test(botId)) {
    throw new Error('Invalid Bot ID for pending Skill evidence.');
  }
  return botId;
}

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
