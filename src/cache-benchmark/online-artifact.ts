import { createHash, type Hash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ARTIFACT_DIRECTORIES = ['dist', 'prompts'] as const;
const ARTIFACT_FILES = ['package.json', 'package-lock.json'] as const;
const DEPENDENCY_DIRECTORY = 'node_modules';

export interface OnlineBenchmarkRuntimeContract {
  schema: 'xiaoba.online_benchmark_runtime.v1';
  platform: NodeJS.Platform;
  arch: string;
  release: {
    name: string;
    lts: string | null;
  };
  versions: Record<string, string>;
}

/** Fingerprints the runtime contract independently for focused drift tests. */
export function fingerprintOnlineBenchmarkRuntimeContract(
  contract: OnlineBenchmarkRuntimeContract = currentRuntimeContract(),
): string {
  const hash = createHash('sha256');
  hash.update('xiaoba.online_benchmark_runtime_fingerprint.v1\0');
  hash.update(JSON.stringify(contract));
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Fingerprints executable code, prompts, the pinned graph, the actual installed
 * dependency bytes, and the Node runtime that will execute the benchmark.
 */
export function fingerprintOnlineBenchmarkArtifact(rootDirectory: string): string {
  const root = path.resolve(rootDirectory);
  const rootBefore = checkedDirectory(root);
  const hash = createHash('sha256');
  hash.update('xiaoba.online_benchmark_artifact.v2\0');
  appendJsonRecord(hash, 'runtime', fingerprintOnlineBenchmarkRuntimeContract());
  for (const relative of ARTIFACT_FILES) {
    appendStableFile(hash, path.join(root, relative), relative);
  }
  for (const relative of ARTIFACT_DIRECTORIES) {
    appendStableDirectory(hash, path.join(root, relative), relative, undefined);
  }
  appendInstalledDependencies(hash, root);
  const rootAfter = checkedDirectory(root);
  if (!sameStablePath(rootBefore, rootAfter)) throw new Error('artifact_changed_during_scan');
  return `sha256:${hash.digest('hex')}`;
}

function currentRuntimeContract(): OnlineBenchmarkRuntimeContract {
  const versions = Object.fromEntries(
    Object.entries(process.versions)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .sort(([left], [right]) => compareStrings(left, right)),
  );
  return {
    schema: 'xiaoba.online_benchmark_runtime.v1',
    platform: process.platform,
    arch: process.arch,
    release: {
      name: process.release.name,
      lts: typeof process.release.lts === 'string' ? process.release.lts : null,
    },
    versions,
  };
}

function appendInstalledDependencies(hash: Hash, root: string): void {
  const logicalPath = path.join(root, DEPENDENCY_DIRECTORY);
  const logicalBefore = checkedDependencyRoot(logicalPath);
  const linkBefore = logicalBefore.isSymbolicLink() ? checkedReadlink(logicalPath) : null;
  let physicalRoot: string;
  try {
    physicalRoot = fs.realpathSync(logicalPath);
  } catch {
    throw new Error('artifact_directory_invalid');
  }
  const physicalBefore = checkedDirectory(physicalRoot);
  appendStableDirectory(
    hash,
    physicalRoot,
    DEPENDENCY_DIRECTORY,
    physicalRoot,
  );
  const physicalAfter = checkedDirectory(physicalRoot);
  const logicalAfter = checkedDependencyRoot(logicalPath);
  const linkAfter = logicalAfter.isSymbolicLink() ? checkedReadlink(logicalPath) : null;
  if (
    !sameStablePath(physicalBefore, physicalAfter)
    || !sameStablePath(logicalBefore, logicalAfter)
    || linkBefore !== linkAfter
  ) throw new Error('artifact_changed_during_scan');
}

function appendStableDirectory(
  hash: Hash,
  physicalDirectory: string,
  logicalDirectory: string,
  dependencyRoot: string | undefined,
): void {
  const before = checkedDirectory(physicalDirectory);
  appendJsonRecord(hash, 'directory', {
    path: toPosix(logicalDirectory),
    mode: before.mode & 0o777,
  });
  let names: string[];
  try {
    names = fs.readdirSync(physicalDirectory).sort(compareStrings);
  } catch {
    throw new Error('artifact_directory_invalid');
  }
  for (const name of names) {
    const absolute = path.join(physicalDirectory, name);
    const relative = path.posix.join(toPosix(logicalDirectory), name);
    const stat = checkedEntry(absolute);
    if (stat.isFile()) {
      appendStableFile(hash, absolute, relative);
    } else if (stat.isDirectory()) {
      appendStableDirectory(hash, absolute, relative, dependencyRoot);
    } else if (stat.isSymbolicLink() && dependencyRoot) {
      appendDependencySymlink(hash, absolute, relative, dependencyRoot, stat);
    } else if (stat.isSymbolicLink()) {
      throw new Error('artifact_symlink_invalid');
    } else {
      throw new Error('artifact_entry_invalid');
    }
  }
  const after = checkedDirectory(physicalDirectory);
  if (!sameStablePath(before, after)) throw new Error('artifact_changed_during_scan');
}

function appendStableFile(hash: Hash, absolute: string, relative: string): void {
  const pathBefore = checkedFile(absolute);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || !sameStablePath(pathBefore, before)) {
      throw new Error('artifact_file_invalid');
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const pathAfter = checkedFile(absolute);
    if (!sameStablePath(before, after) || !sameStablePath(pathBefore, pathAfter)) {
      throw new Error('artifact_changed_during_scan');
    }
    appendJsonRecord(hash, 'file', {
      path: toPosix(relative),
      mode: before.mode & 0o777,
      size: content.length,
    });
    hash.update(content);
    hash.update('\0');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('artifact_')) throw error;
    throw new Error('artifact_file_invalid');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function appendDependencySymlink(
  hash: Hash,
  absolute: string,
  relative: string,
  dependencyRoot: string,
  before: fs.Stats,
): void {
  let target: string;
  try {
    target = fs.realpathSync(absolute);
  } catch {
    throw new Error('artifact_symlink_invalid');
  }
  const targetRelative = path.relative(dependencyRoot, target);
  if (targetRelative === '..' || targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative)) {
    throw new Error('artifact_symlink_invalid');
  }
  const linkBefore = checkedReadlink(absolute);
  const after = checkedEntry(absolute);
  const linkAfter = checkedReadlink(absolute);
  if (!after.isSymbolicLink() || !sameStablePath(before, after) || linkBefore !== linkAfter) {
    throw new Error('artifact_changed_during_scan');
  }
  appendJsonRecord(hash, 'symlink', {
    path: toPosix(relative),
    mode: before.mode & 0o777,
    target: toPosix(path.posix.join(DEPENDENCY_DIRECTORY, toPosix(targetRelative))),
  });
}

function appendJsonRecord(hash: Hash, kind: string, value: unknown): void {
  hash.update(JSON.stringify({ kind, value }));
  hash.update('\0');
}

function checkedDependencyRoot(directory: string): fs.Stats {
  const stat = checkedEntry(directory);
  if (!stat.isDirectory() && !stat.isSymbolicLink()) {
    throw new Error('artifact_directory_invalid');
  }
  return stat;
}

function checkedDirectory(directory: string): fs.Stats {
  const stat = checkedEntry(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('artifact_directory_invalid');
  }
  return stat;
}

function checkedFile(file: string): fs.Stats {
  const stat = checkedEntry(file);
  if (stat.isSymbolicLink()) throw new Error('artifact_symlink_invalid');
  if (!stat.isFile()) throw new Error('artifact_file_invalid');
  return stat;
}

function checkedEntry(entry: string): fs.Stats {
  try {
    return fs.lstatSync(entry);
  } catch {
    throw new Error('artifact_entry_invalid');
  }
}

function checkedReadlink(link: string): string {
  try {
    return fs.readlinkSync(link);
  } catch {
    throw new Error('artifact_symlink_invalid');
  }
}

function sameStablePath(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs
    && before.mode === after.mode;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
