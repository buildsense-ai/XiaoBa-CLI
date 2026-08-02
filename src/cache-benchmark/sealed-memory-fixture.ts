import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SealedMemoryLogSource } from '../core/memory-log-store';

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface DirectoryIdentity extends FileIdentity {
  path: string;
}

export interface SealedMemoryFixture extends SealedMemoryLogSource {
  fixtureFingerprint: string;
  assertUntampered(): void;
  close(): void;
}

/**
 * Creates a benchmark-only memory source whose inode remains open for the
 * entire round. MemoryLogStore reads the held descriptor, never a mutable
 * path lookup, while path and directory identities detect replacement.
 */
export function createSealedMemoryFixture(input: {
  workspace: string;
  nonce: string;
  canonicalPath: string;
  source: string;
}): SealedMemoryFixture {
  const workspace = path.resolve(input.workspace);
  const canonicalSegments = input.canonicalPath.split('/');
  if (
    canonicalSegments.length !== 3
    || canonicalSegments.some(segment => !segment || segment === '.' || segment === '..')
  ) throw new Error('benchmark_memory_fixture_path_invalid');

  const container = path.join(workspace, 'sealed-memory');
  ensureOwnedPrivateDirectory(container);
  const root = path.join(container, input.nonce);
  fs.mkdirSync(root, { mode: 0o700 });
  const first = path.join(root, canonicalSegments[0]);
  const second = path.join(first, canonicalSegments[1]);
  fs.mkdirSync(first, { mode: 0o700 });
  fs.mkdirSync(second, { mode: 0o700 });
  const filePath = path.join(second, canonicalSegments[2]);

  let writer: number | undefined;
  let reader: number | undefined;
  try {
    writer = fs.openSync(
      filePath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    fs.writeFileSync(writer, input.source, { encoding: 'utf8' });
    fs.fsyncSync(writer);
    if (process.platform !== 'win32') fs.fchmodSync(writer, 0o400);
    fs.closeSync(writer);
    writer = undefined;
    fsyncDirectory(second);

    reader = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const expectedFile = fileIdentity(fs.fstatSync(reader, { bigint: true }));
    if (!isRegularMode(expectedFile.mode)) throw new Error('benchmark_memory_fixture_invalid');
    const directories = [root, first, second].map(directory => ({
      path: directory,
      ...fileIdentity(fs.lstatSync(directory, { bigint: true })),
    }));
    const expectedBytes = Buffer.from(input.source, 'utf8');
    const fixtureFingerprint = fingerprint(expectedBytes);

    const readVerifiedBytes = (): Buffer => {
      if (reader === undefined) throw new Error('benchmark_memory_fixture_closed');
      const before = fileIdentity(fs.fstatSync(reader, { bigint: true }));
      if (!sameIdentity(before, expectedFile)) throw new Error('benchmark_memory_fixture_tampered');
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(reader, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) throw new Error('benchmark_memory_fixture_tampered');
        offset += count;
      }
      const after = fileIdentity(fs.fstatSync(reader, { bigint: true }));
      if (!sameIdentity(before, after) || fingerprint(bytes) !== fixtureFingerprint) {
        throw new Error('benchmark_memory_fixture_tampered');
      }
      const pathStat = fs.lstatSync(filePath, { bigint: true });
      if (
        pathStat.isSymbolicLink()
        || !pathStat.isFile()
        || pathStat.dev !== after.dev
        || pathStat.ino !== after.ino
      ) throw new Error('benchmark_memory_fixture_tampered');
      for (const expected of directories) {
        const current = fs.lstatSync(expected.path, { bigint: true });
        if (
          current.isSymbolicLink()
          || !current.isDirectory()
          || !sameIdentity(fileIdentity(current), expected)
        ) throw new Error('benchmark_memory_fixture_tampered');
      }
      return bytes;
    };

    const handle: SealedMemoryFixture = {
      root,
      filePath,
      fixtureFingerprint,
      readVerifiedUtf8: () => readVerifiedBytes().toString('utf8'),
      assertUntampered: () => { readVerifiedBytes(); },
      close: () => {
        if (reader === undefined) return;
        fs.closeSync(reader);
        reader = undefined;
      },
    };
    handle.assertUntampered();
    return handle;
  } catch (error) {
    if (writer !== undefined) {
      try { fs.closeSync(writer); } catch { /* best effort */ }
    }
    if (reader !== undefined) {
      try { fs.closeSync(reader); } catch { /* best effort */ }
    }
    throw error;
  }
}

function ensureOwnedPrivateDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('benchmark_memory_fixture_path_invalid');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('benchmark_memory_fixture_path_invalid');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
    throw new Error('benchmark_memory_fixture_path_invalid');
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function fileIdentity(stat: fs.BigIntStats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameIdentity(actual: FileIdentity, expected: FileIdentity): boolean {
  return actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.mode === expected.mode
    && actual.nlink === expected.nlink
    && actual.size === expected.size
    && actual.mtimeNs === expected.mtimeNs
    && actual.ctimeNs === expected.ctimeNs;
}

function isRegularMode(mode: bigint): boolean {
  return (mode & BigInt(fs.constants.S_IFMT)) === BigInt(fs.constants.S_IFREG);
}

function fingerprint(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
