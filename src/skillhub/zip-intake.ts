import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import * as yauzl from 'yauzl';

const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES = 100;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;

export interface ExtractedSkillZip {
  directory: string;
  cleanupDirectory: string;
}

interface CheckedEntry {
  entry: yauzl.Entry;
  relativePath: string;
  isDirectory: boolean;
}

export async function extractAuthorizedSkillZip(zipPath: string): Promise<ExtractedSkillZip> {
  const stat = await fs.promises.stat(zipPath);
  if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`ZIP must be a regular file no larger than ${MAX_ARCHIVE_BYTES} bytes.`);
  }

  const entries = await readAndValidateEntries(zipPath);
  const skillEntries = entries.filter(item => !item.isDirectory && item.relativePath.toLowerCase().endsWith('/skill.md')
    || !item.isDirectory && item.relativePath.toLowerCase() === 'skill.md');
  if (skillEntries.length !== 1) {
    throw new Error('ZIP must contain exactly one SKILL.md entry.');
  }

  const cleanupDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xiaoba-skillhub-zip-'));
  try {
    for (const item of entries) {
      if (item.isDirectory) continue;
      await extractEntry(zipPath, item, cleanupDirectory);
    }
    const directory = path.dirname(path.join(cleanupDirectory, skillEntries[0].relativePath));
    return { directory, cleanupDirectory };
  } catch (error) {
    await fs.promises.rm(cleanupDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function readAndValidateEntries(zipPath: string): Promise<CheckedEntry[]> {
  const zip = await openZip(zipPath);
  const entries: CheckedEntry[] = [];
  const paths = new Set<string>();
  const files = new Set<string>();
  let totalBytes = 0;
  try {
    for (let entry = await readEntry(zip); entry; entry = await readEntry(zip)) {
      if (entries.length >= MAX_ENTRIES) throw new Error(`ZIP contains more than ${MAX_ENTRIES} entries.`);
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
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error('ZIP exceeds the total uncompressed size limit.');
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

async function extractEntry(zipPath: string, checked: CheckedEntry, root: string): Promise<void> {
  const destination = path.resolve(root, ...checked.relativePath.split('/'));
  const relative = path.relative(root, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ZIP entry escaped the extraction directory.');
  await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const zip = await openZip(zipPath);
  try {
    const entry = await findEntry(zip, checked.entry.fileName);
    if (!entry) throw new Error(`ZIP entry disappeared during extraction: ${checked.relativePath}`);
    const input = await openEntryStream(zip, entry);
    let actualBytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        actualBytes += chunk.length;
        if (actualBytes > MAX_FILE_BYTES || actualBytes > entry.uncompressedSize) {
          callback(new Error(`ZIP entry exceeded its declared or allowed size: ${checked.relativePath}`));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(input, limiter, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    if (actualBytes !== entry.uncompressedSize) throw new Error(`ZIP entry size did not match its directory record: ${checked.relativePath}`);
  } finally {
    zip.close();
  }
}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) reject(error || new Error('Could not open ZIP.'));
      else resolve(zip);
    });
  });
}

function readEntry(zip: yauzl.ZipFile): Promise<yauzl.Entry | undefined> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: yauzl.Entry) => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(undefined); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      zip.removeListener('entry', onEntry);
      zip.removeListener('end', onEnd);
      zip.removeListener('error', onError);
    };
    zip.once('entry', onEntry);
    zip.once('end', onEnd);
    zip.once('error', onError);
    zip.readEntry();
  });
}

function findEntry(zip: yauzl.ZipFile, fileName: string): Promise<yauzl.Entry | undefined> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: yauzl.Entry) => {
      if (entry.fileName === fileName) { cleanup(); resolve(entry); }
      else zip.readEntry();
    };
    const onEnd = () => { cleanup(); resolve(undefined); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      zip.removeListener('entry', onEntry);
      zip.removeListener('end', onEnd);
      zip.removeListener('error', onError);
    };
    zip.on('entry', onEntry);
    zip.once('end', onEnd);
    zip.once('error', onError);
    zip.readEntry();
  });
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error || new Error('Could not read ZIP entry.'));
      else resolve(stream);
    });
  });
}
