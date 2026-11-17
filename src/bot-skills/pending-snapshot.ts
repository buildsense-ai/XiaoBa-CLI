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
  /** Links are recorded as inert manifest data, never copied into package/. */
  linkCount?: number;
}

interface PendingSnapshotFile {
  path: string;
  size: number;
  sha256: string;
}

interface PendingSnapshotLink {
  path: string;
  target: string;
}

interface PendingSnapshotContent {
  files: PendingSnapshotFile[];
  links: PendingSnapshotLink[];
}

interface PendingSnapshotManifest {
  schema: 'xiaoba.bot-skill-local-pending.v1' | 'xiaoba.bot-skill-local-pending.v2';
  botId: string;
  sourcePath: string;
  reason: BotSkillPendingSnapshotOptions['reason'];
  detectedAt: string;
  fingerprint: string;
  cloudRevision: number;
  baseRevision?: number;
  files: PendingSnapshotFile[];
  /** v2 only. Recovery metadata, not permission to follow or recreate links. */
  links?: PendingSnapshotLink[];
}

/**
 * Preserves durable local Skill workspace content before Cloud-authoritative
 * activation replaces it. Regenerable runtime directories are excluded. The
 * snapshot is evidence only and is never loaded as an active Skill workspace.
 * Nested symbolic links are recorded with readlink, without reading their
 * targets or creating runnable links in the evidence package. A linked root
 * is still rejected because ownership of its contents cannot be established.
 */
export async function snapshotPendingBotSkillWorkspace(
  options: BotSkillPendingSnapshotOptions,
): Promise<BotSkillPendingSnapshotResult> {
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const sourcePath = path.resolve(options.sourcePath);
  const recordedSourcePath = path.resolve(options.recordedSourcePath ?? sourcePath);
  const botId = normalizeBotId(options.botId);
  const content = await listWorkspaceContent(sourcePath);
  const { files, links } = content;
  const linkMetadata = links.length > 0 ? { links } : {};
  const linkCount = links.length > 0 ? { linkCount: links.length } : {};
  const fingerprint = pendingFingerprint({
    botId,
    sourcePath: recordedSourcePath,
    reason: options.reason,
    ...(options.baseRevision !== undefined ? { baseRevision: options.baseRevision } : {}),
    cloudRevision: options.cloudRevision,
    files,
    ...linkMetadata,
  });
  const root = path.join(runtimeRoot, 'data', 'bot-skills', 'local-pending', botId);
  const existing = await findExistingSnapshot(root, fingerprint);
  if (existing) {
    await verifySourceUnchanged(sourcePath, content);
    return { path: existing, fingerprint, fileCount: files.length, deduplicated: true, ...linkCount };
  }

  const detectedAt = (options.now ?? (() => new Date()))().toISOString();
  const directoryName = `${detectedAt.replace(/[:.]/g, '-')}-${fingerprint}`;
  const finalPath = path.join(root, directoryName);
  const temporary = path.join(root, `.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  const packageRoot = path.join(temporary, 'package');
  const manifest: PendingSnapshotManifest = {
    schema: links.length > 0 ? 'xiaoba.bot-skill-local-pending.v2' : 'xiaoba.bot-skill-local-pending.v1',
    botId,
    sourcePath: recordedSourcePath,
    reason: options.reason,
    detectedAt,
    fingerprint,
    cloudRevision: options.cloudRevision,
    ...(options.baseRevision !== undefined ? { baseRevision: options.baseRevision } : {}),
    files,
    ...linkMetadata,
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
    await verifySourceUnchanged(sourcePath, content);
    await fs.promises.writeFile(
      path.join(temporary, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.rename(temporary, finalPath);
    return { path: finalPath, fingerprint, fileCount: files.length, deduplicated: false, ...linkCount };
  } catch (error) {
    await fs.promises.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function verifySourceUnchanged(root: string, content: PendingSnapshotContent): Promise<void> {
  // Async I/O allows other handlers/editors to run. Do not replace Local using
  // evidence that missed an edit/new file made while copying or deduplicating.
  const current = await listWorkspaceContent(root);
  if (!snapshotFilesEqual(content.files, current.files) || !snapshotLinksEqual(content.links, current.links)) {
    throw new Error('Bot Skill workspace changed during pending snapshot; retry while idle.');
  }
}

async function listWorkspaceContent(root: string): Promise<PendingSnapshotContent> {
  let rootStats: fs.Stats;
  try {
    rootStats = await fs.promises.lstat(root);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { files: [], links: [] };
    throw error;
  }
  if (rootStats.isSymbolicLink()) {
    throw new Error('Bot Skill pending snapshot cannot follow a symbolic link at its root.');
  }
  if (!rootStats.isDirectory()) throw new Error('Bot Skill workspace is not a directory.');

  const files: PendingSnapshotFile[] = [];
  const links: PendingSnapshotLink[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      // Only skip real runtime directories. Links with ephemeral names must
      // still be preserved as metadata, without traversing their targets.
      if (entry.isDirectory() && isEphemeralSkillDirectory(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stats = await fs.promises.lstat(absolute);
      if (stats.isSymbolicLink()) {
        links.push({ path: relative, target: await fs.promises.readlink(absolute) });
        continue;
      }
      if (stats.isDirectory()) await visit(absolute);
      else if (stats.isFile()) files.push(await fileRecord(root, relative));
      else throw new Error(`Bot Skill pending snapshot found an unsupported file: ${relative}`);
    }
  };
  await visit(root);
  return {
    files: files.sort((left, right) => compareText(left.path, right.path)),
    links: links.sort((left, right) => compareText(left.path, right.path)),
  };
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
      if ((manifest.schema !== 'xiaoba.bot-skill-local-pending.v1'
        && manifest.schema !== 'xiaoba.bot-skill-local-pending.v2')
        || manifest.fingerprint !== fingerprint || !Array.isArray(manifest.files)) continue;
      if (manifest.schema === 'xiaoba.bot-skill-local-pending.v2'
        && (!Array.isArray(manifest.links) || manifest.links.length === 0)) continue;
      if (manifest.schema === 'xiaoba.bot-skill-local-pending.v1' && manifest.links !== undefined) continue;
      const packageContent = await listWorkspaceContent(path.join(candidate, 'package'));
      if (
        packageContent.links.length === 0
        && snapshotFilesEqual(manifest.files, packageContent.files)
        && pendingFingerprint({
          botId: String(manifest.botId || ''),
          sourcePath: String(manifest.sourcePath || ''),
          reason: manifest.reason as PendingSnapshotManifest['reason'],
          ...(manifest.baseRevision !== undefined ? { baseRevision: manifest.baseRevision } : {}),
          cloudRevision: Number(manifest.cloudRevision),
          files: packageContent.files,
          ...(manifest.links ? { links: manifest.links } : {}),
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
    'botId' | 'sourcePath' | 'reason' | 'baseRevision' | 'cloudRevision' | 'files' | 'links'
  >,
): string {
  return sha256(Buffer.from(JSON.stringify({
    botId: value.botId,
    sourcePath: value.sourcePath,
    reason: value.reason,
    ...(value.baseRevision !== undefined ? { baseRevision: value.baseRevision } : {}),
    cloudRevision: value.cloudRevision,
    files: value.files,
    ...(value.links?.length ? { links: value.links } : {}),
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

function snapshotLinksEqual(expected: PendingSnapshotLink[], actual: PendingSnapshotLink[]): boolean {
  return expected.length === actual.length && expected.every((link, index) => (
    link?.path === actual[index]?.path && link?.target === actual[index]?.target
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
