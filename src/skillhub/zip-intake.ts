import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createInflateRaw } from 'zlib';
import * as yauzl from 'yauzl';

const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES = 100;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
const MAX_INTAKE_MS = 30_000;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

export interface ExtractedSkillZip {
  directory: string;
  cleanupDirectory: string;
  uncompressedBytes: number;
}

interface CheckedEntry {
  entry: yauzl.Entry;
  relativePath: string;
  isDirectory: boolean;
}

interface ExtractionBudget { entries: number; bytes: number }

export async function extractAuthorizedSkillZip(
  zipPath: string, sourceFileName: string, options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ExtractedSkillZip> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Skill ZIP inspection was cancelled.'));
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, Math.min(MAX_INTAKE_MS, options.timeoutMs!)) : MAX_INTAKE_MS;
  const timer = setTimeout(() => controller.abort(new Error('Skill ZIP inspection timed out; the archive may be damaged.')), timeoutMs);
  let cleanupDirectory: string | undefined;
  try {
    const signal = controller.signal;
    signal.throwIfAborted();
    const stat = await fs.promises.stat(zipPath);
    if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) {
      throw new Error(`ZIP must be a regular file no larger than ${MAX_ARCHIVE_BYTES} bytes.`);
    }

    const budget: ExtractionBudget = { entries: 0, bytes: 0 };
    const entries = await readAndValidateEntries(zipPath, budget, signal);
    cleanupDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xiaoba-skillhub-zip-'));
    const extractionRoot = path.join(cleanupDirectory, safePackageDirectoryName(sourceFileName));
    const directory = await extractSkillLayer(zipPath, entries, extractionRoot, budget, true, signal);
    signal.throwIfAborted();
    return { directory, cleanupDirectory, uncompressedBytes: budget.bytes };
  } catch (error) {
    if (cleanupDirectory) await fs.promises.rm(cleanupDirectory, { recursive: true, force: true });
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}

async function extractSkillLayer(
  zipPath: string, entries: CheckedEntry[], root: string, budget: ExtractionBudget, allowWrapper: boolean, signal: AbortSignal,
): Promise<string> {
  const files = entries.filter(item => !item.isDirectory);
  const skillEntries = files.filter(item => path.posix.basename(item.relativePath).toLowerCase() === 'skill.md');
  if (skillEntries.length === 0 && allowWrapper && files.length === 1 && /\.(skill|zip)$/i.test(files[0].relativePath)) {
    await fs.promises.mkdir(root, { mode: 0o700 });
    await extractEntry(zipPath, files[0], root, signal);
    const nestedPath = path.join(root, files[0].relativePath);
    const nestedEntries = await readAndValidateEntries(nestedPath, budget, signal);
    // A separate root prevents outer and inner paths from colliding. Never recurse again.
    return extractSkillLayer(nestedPath, nestedEntries, path.join(path.dirname(root), 'inner', safePackageDirectoryName(files[0].relativePath)), budget, false, signal);
  }
  if (skillEntries.length !== 1) throw new Error('ZIP must contain exactly one SKILL.md entry, or a single .skill/.zip wrapper (one nested layer only).');
  const skillEntry = skillEntries[0];
  if (path.posix.basename(skillEntry.relativePath) !== 'SKILL.md') throw new Error('The ZIP entry must use the exact filename SKILL.md.');
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  for (const item of files) await extractEntry(zipPath, item, root, signal);
  return path.dirname(path.join(root, skillEntry.relativePath));
}

function safePackageDirectoryName(sourceFileName: string): string {
  const name = path.basename(sourceFileName, path.extname(sourceFileName))
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '-')
    .replace(/[ .]+$/g, '')
    .slice(0, 72);
  return name && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name) ? name : 'skill-package';
}

async function readAndValidateEntries(zipPath: string, budget: ExtractionBudget, signal: AbortSignal): Promise<CheckedEntry[]> {
  const zip = await openZip(zipPath, signal);
  const entries: CheckedEntry[] = [];
  const paths = new Set<string>();
  const files = new Set<string>();
  try {
    for (let entry = await readEntry(zip, signal); entry; entry = await readEntry(zip, signal)) {
      if (++budget.entries > MAX_ENTRIES) throw new Error(`ZIP contains more than ${MAX_ENTRIES} entries across all layers.`);
      if (entry.generalPurposeBitFlag & 0x1) throw new Error('Encrypted ZIP entries are not supported.');
      const relativePath = validateEntryPath(entry.fileName);
      const isDirectory = relativePath.endsWith('/');
      const cleanPath = isDirectory ? relativePath.slice(0, -1) : relativePath;
      const canonical = cleanPath.toLowerCase();
      if (paths.has(canonical)) throw new Error(`ZIP contains duplicate or case-colliding path: ${cleanPath}`);
      paths.add(canonical);
      validateEntryType(entry, isDirectory);
      if (!isDirectory) {
        if (entry.uncompressedSize > MAX_FILE_BYTES) throw new Error(`ZIP entry exceeds the per-file size limit: ${cleanPath}`);
        budget.bytes += entry.uncompressedSize;
        if (budget.bytes > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error('ZIP exceeds the total uncompressed size limit across all layers.');
        files.add(canonical);
      }
      entries.push({ entry, relativePath: cleanPath, isDirectory });
    }
  } finally {
    zip.close();
  }
  for (const file of files) {
    let parent = path.posix.dirname(file);
    while (parent !== '.') {
      if (files.has(parent)) throw new Error(`ZIP path conflicts with a file: ${parent}`);
      parent = path.posix.dirname(parent);
    }
  }
  return entries;
}

function validateEntryPath(fileName: string): string {
  if (!fileName || fileName.includes('\0')) throw new Error('ZIP contains an empty or invalid path.');
  const normalized = fileName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//')) {
    throw new Error(`ZIP contains an absolute path: ${fileName}`);
  }
  const isDirectory = normalized.endsWith('/');
  const parts = normalized.split('/').filter((part, index, all) => !(part === '' && index === all.length - 1 && isDirectory));
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`ZIP contains an unsafe path: ${fileName}`);
  }
  for (const part of parts) {
    const deviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part);
    if (/[\x00-\x1f<>:"|?*]/.test(part) || /[ .]$/.test(part) || deviceName) {
      throw new Error(`ZIP contains a non-portable path: ${fileName}`);
    }
  }
  return parts.join('/') + (isDirectory ? '/' : '');
}

function validateEntryType(entry: yauzl.Entry, isDirectory: boolean): void {
  const madeBy = (entry.versionMadeBy >>> 8) & 0xff;
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if (madeBy === 3 || madeBy === 19) {
    const type = mode & 0o170000;
    if (type === 0o120000) throw new Error(`ZIP symbolic links are not supported: ${entry.fileName}`);
    if (type && type !== (isDirectory ? 0o040000 : 0o100000)) {
      throw new Error(`ZIP contains a special file: ${entry.fileName}`);
    }
  }
  if (isDirectory && entry.uncompressedSize !== 0) throw new Error(`ZIP directory entry has content: ${entry.fileName}`);
}

async function extractEntry(zipPath: string, checked: CheckedEntry, root: string, signal: AbortSignal): Promise<void> {
  const destination = path.resolve(root, ...checked.relativePath.split('/'));
  const relative = path.relative(root, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ZIP entry escaped the extraction directory.');
  await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const zip = await openZip(zipPath, signal);
  try {
    let entry: yauzl.Entry | undefined;
    while ((entry = await readEntry(zip, signal)) && entry.fileName !== checked.entry.fileName) { /* bounded by the validated directory */ }
    if (!entry) throw new Error(`ZIP entry disappeared during extraction: ${checked.relativePath}`);
    const input = await openEntryStream(zip, entry, signal);
    let actualBytes = 0;
    let crc = 0xffffffff;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        actualBytes += chunk.length;
        if (actualBytes > MAX_FILE_BYTES || actualBytes > entry.uncompressedSize) {
          callback(new Error(`ZIP entry exceeded its declared or allowed size: ${checked.relativePath}`));
          return;
        }
        for (const byte of chunk) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
        callback(null, chunk);
      },
      flush(callback) {
        if (actualBytes !== entry!.uncompressedSize) return callback(new Error(`ZIP entry size did not match its directory record: ${checked.relativePath}`));
        if (((crc ^ 0xffffffff) >>> 0) !== entry!.crc32) return callback(new Error(`ZIP entry checksum did not match; the archive is damaged: ${checked.relativePath}`));
        callback();
      },
    });
    // Own the inflater in this pipeline. yauzl's decompressed endpoint overrides
    // destroy() without completing Node's stream lifecycle on some size errors.
    const streams = entry.compressionMethod === 8 ? [input, createInflateRaw(), limiter] : [input, limiter];
    await pipeline([...streams, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 })], { signal });
  } finally {
    zip.close();
  }
}

function openZip(zipPath: string, signal: AbortSignal): Promise<yauzl.ZipFile> {
  return abortableCallback(signal, finish => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, strictFileNames: true }, (error, zip) => {
      finish(error || (!zip ? new Error('Could not open ZIP.') : null), zip);
    });
  }, zip => zip.close());
}

function readEntry(zip: yauzl.ZipFile, signal: AbortSignal): Promise<yauzl.Entry | undefined> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onEntry = (entry: yauzl.Entry) => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(undefined); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => onError(new Error('ZIP closed before its directory could be read.'));
    const onAbort = () => onError(signal.reason);
    const cleanup = () => {
      zip.removeListener('entry', onEntry);
      zip.removeListener('end', onEnd);
      zip.removeListener('error', onError);
      zip.removeListener('close', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    zip.once('entry', onEntry);
    zip.once('end', onEnd);
    zip.once('error', onError);
    zip.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    zip.readEntry();
  });
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry, signal: AbortSignal): Promise<Readable> {
  return abortableCallback(signal, finish => {
    zip.openReadStream(entry, { decompress: entry.compressionMethod === 8 ? false : null, decrypt: null, start: null, end: null }, (error, stream) => {
      finish(error || (!stream ? new Error('Could not read ZIP entry.') : null), stream);
    });
  }, stream => stream.destroy());
}

/** Close handles arriving after cancellation instead of leaking them. */
function abortableCallback<T>(
  signal: AbortSignal, start: (finish: (error: Error | null, value?: T) => void) => void, dispose: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    let settled = false;
    const finish = (error: Error | null, value?: T) => {
      if (settled) { if (value !== undefined) dispose(value); return; }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) { if (value !== undefined) dispose(value); reject(error); }
      else resolve(value!);
    };
    const onAbort = () => finish(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try { start(finish); } catch (error) { finish(error as Error); }
  });
}
