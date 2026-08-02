import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ARTIFACT_DIRECTORIES = ['dist', 'prompts'] as const;
const ARTIFACT_FILES = ['package.json', 'package-lock.json'] as const;

/** Fingerprints the executable build, prompt assets, and pinned dependency graph. */
export function fingerprintOnlineBenchmarkArtifact(rootDirectory: string): string {
  const root = path.resolve(rootDirectory);
  assertDirectory(root);
  const files = [
    ...ARTIFACT_FILES.map(file => checkedFile(root, file)),
    ...ARTIFACT_DIRECTORIES.flatMap(directory => collectFiles(root, directory)),
  ].sort((left, right) => left.relative.localeCompare(right.relative));
  if (files.length === 0) throw new Error('artifact_empty');

  const hash = createHash('sha256');
  hash.update('xiaoba.online_benchmark_artifact.v1\0');
  for (const file of files) {
    const content = fs.readFileSync(file.absolute);
    hash.update(String(Buffer.byteLength(file.relative)));
    hash.update(':');
    hash.update(file.relative);
    hash.update(':');
    hash.update(String(content.length));
    hash.update(':');
    hash.update(content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function collectFiles(
  root: string,
  relativeDirectory: string,
): Array<{ relative: string; absolute: string }> {
  const directory = path.join(root, relativeDirectory);
  assertDirectory(directory);
  const result: Array<{ relative: string; absolute: string }> = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.posix.join(relativeDirectory, entry.name);
    const absolute = path.join(root, ...relative.split('/'));
    if (entry.isSymbolicLink()) throw new Error('artifact_symlink_invalid');
    if (entry.isDirectory()) result.push(...collectFiles(root, relative));
    else if (entry.isFile()) result.push(checkedFile(root, relative));
    else throw new Error('artifact_entry_invalid');
  }
  return result;
}

function checkedFile(
  root: string,
  relative: string,
): { relative: string; absolute: string } {
  const absolute = path.join(root, ...relative.split('/'));
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error('artifact_symlink_invalid');
  if (!stat.isFile()) throw new Error('artifact_file_invalid');
  return { relative, absolute };
}

function assertDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('artifact_directory_invalid');
  }
}
