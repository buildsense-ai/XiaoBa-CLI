import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const PUBLICATION_SOURCE_PROBE = 'skillhub.publication.sourceProbe.v1';
export function publicationSourceProbeEnabled(): boolean {
  return /^(1|true)$/i.test((process.env.XIAOBA_SKILLHUB_PUBLICATION_PROBE_ENABLED || '').trim());
}

export class PublicationSourceError extends Error {
  constructor(readonly code: string) {
    super('The publication source could not be verified. No upload was started.');
  }
}

export interface PublicationSourceBinding {
  botUid: string;
  ownerUid: string;
  bodyId: string;
  installationId: string;
}
export interface PublicationSourceDescriptor {
  local_skill_id: string;
  workspace_generation: string;
}

const ignoredDirectories = new Set(['.git', 'node_modules', '.venv', '.cache', '.mypy_cache', '.pytest_cache', '.ruff_cache', '__pycache__']);
const maxEntries = 4096;
const maxDepth = 32;
const maxFileBytes = 5 * 1024 * 1024;
const maxBytes = 20 * 1024 * 1024;
const fail = (code = 'publication.source_unsafe'): never => { throw new PublicationSourceError(code); };
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

function contained(root: string, value: string): void {
  const relative = path.relative(root, value);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail();
}

function directory(root: string, value: string): fs.Stats {
  contained(root, path.resolve(value));
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  contained(fs.realpathSync(root), fs.realpathSync(value));
  return stat;
}

function identity(root: string, value: string): string {
  contained(root, value);
  return `pubsrc-${hash(path.relative(root, value).split(path.sep).join('/')).slice(0, 48)}`;
}

function unchanged(before: fs.Stats, after: fs.Stats): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    fail('publication.source_changed');
  }
}

// Metadata-independent bounded byte fingerprint. Never parse YAML/JS, import,
// run, copy, upload or write markers. The digest is NOT Cloud's candidate hash.
// Call under the active-workspace lock, with a fresh runtime binding.
export function describePublicationSource(
  skillsRoot: string, skillDir: string, binding: PublicationSourceBinding,
  check: () => void = () => {},
): PublicationSourceDescriptor {
  return inspectPublicationSource(skillsRoot, skillDir, binding, check, false).descriptor;
}

// Internal capture primitive. The caller must hold the workspace lock and
// authenticate the binding. Returns bytes only after the complete recheck.
export function capturePublicationSource(
  skillsRoot: string, skillDir: string, binding: PublicationSourceBinding, check: () => void,
): { descriptor: PublicationSourceDescriptor; files: Array<{ path: string; contentBase64: string }> } {
  return inspectPublicationSource(skillsRoot, skillDir, binding, check, true);
}

function inspectPublicationSource(
  skillsRoot: string, skillDir: string, binding: PublicationSourceBinding, check: () => void, capture: boolean,
): { descriptor: PublicationSourceDescriptor; files: Array<{ path: string; contentBase64: string }> } {
  const root = path.resolve(skillsRoot);
  const source = path.resolve(skillDir);
  directory(root, root);
  if (root === source) fail();
  // Check every ancestor, not only the leaf, before opening any file.
  const segments = path.relative(root, source).split(path.sep);
  let ancestor = root;
  for (const segment of segments) { ancestor = path.join(ancestor, segment); directory(root, ancestor); }
  const sourceStat = directory(root, source);
  const skillFile = path.join(source, 'SKILL.md');
  if (!fs.existsSync(skillFile)) fail('publication.source_missing');
  const manifestStat = fs.lstatSync(skillFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) fail();
  let count = 0;
  let bytes = 0;
  const facts: Array<[string, string]> = [];
  const files: Array<{ path: string; contentBase64: string }> = [];
  const observations: Array<[string, fs.Stats]> = [];
  const visit = (current: string, depth: number): void => {
    check();
    if (depth > maxDepth) fail();
    const beforeDir = directory(root, current);
    // Streaming enumeration bounds directory allocation as well as traversal.
    const handle = fs.opendirSync(current);
    const names: string[] = [];
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        check();
        if (++count > maxEntries) fail();
        names.push(entry.name);
      }
    } finally { handle.closeSync(); }
    names.sort();
    for (const name of names) {
      check();
      const full = path.join(current, name);
      const stat = fs.lstatSync(full);
      // Reject links even in excluded directories; never follow them.
      if (stat.isSymbolicLink()) fail();
      if (stat.isDirectory()) {
        if (!ignoredDirectories.has(name)) visit(full, depth + 1);
        continue;
      }
      if (!stat.isFile() || stat.nlink > 1 || stat.size > maxFileBytes || bytes + stat.size > maxBytes) fail();
      contained(fs.realpathSync(root), fs.realpathSync(full));
      const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile()) fail();
        unchanged(stat, opened);
        const digest = createHash('sha256');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const chunks: Buffer[] = [];
        let size = 0;
        for (;;) {
          check();
          const n = fs.readSync(fd, buffer, 0, buffer.length, null);
          if (!n) break;
          size += n;
          bytes += n;
          if (size > maxFileBytes || bytes > maxBytes) fail();
          digest.update(buffer.subarray(0, n));
          if (capture) chunks.push(Buffer.from(buffer.subarray(0, n)));
        }
        if (size !== stat.size) fail('publication.source_changed');
        unchanged(opened, fs.fstatSync(fd));
        unchanged(stat, fs.lstatSync(full));
        contained(fs.realpathSync(root), fs.realpathSync(full));
        facts.push([path.relative(source, full).split(path.sep).join('/'), digest.digest('hex')]);
        if (capture) files.push({ path: path.relative(source, full).split(path.sep).join('/'), contentBase64: Buffer.concat(chunks).toString('base64') });
        observations.push([full, stat]);
      } finally { fs.closeSync(fd); }
    }
    unchanged(beforeDir, fs.lstatSync(current));
  };
  visit(source, 0);
  // A previously read file may change while a later file is being hashed.
  // Recheck the complete bounded observation set, not just the last open fd.
  for (const [file, stat] of observations) {
    check();
    unchanged(stat, fs.lstatSync(file));
    contained(fs.realpathSync(root), fs.realpathSync(file));
  }
  unchanged(sourceStat, fs.lstatSync(source));
  check();
  return { files, descriptor: {
    local_skill_id: identity(root, source),
    workspace_generation: hash(JSON.stringify({
      domain: 'xiaoba-publication-source-v1', binding, root: fs.realpathSync(root),
      source: path.relative(root, source).split(path.sep).join('/'),
      dev: sourceStat.dev, ino: sourceStat.ino, facts,
    })),
  } };
}

// Resolve only a scoped opaque reference, never a caller-provided path. This
// bounded discovery reads directory names only; no Skill metadata or scripts.
export function discoverPublicationSources(skillsRoot: string, check: () => void): Map<string, string> {
  const root = path.resolve(skillsRoot);
  directory(root, root);
  let count = 0;
  const sources = new Map<string, string>();
  const visit = (current: string, depth: number): void => {
    check();
    if (depth > maxDepth) fail();
    directory(root, current);
    const handle = fs.opendirSync(current);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        check();
        if (++count > maxEntries) fail();
        if (!entry.isDirectory() || entry.isSymbolicLink() || ignoredDirectories.has(entry.name) || entry.name.startsWith('.')) continue;
        const full = path.join(current, entry.name);
        const id = identity(root, full);
        if (sources.has(id)) fail();
        directory(root, full);
        sources.set(id, full);
        visit(full, depth + 1);
      }
    } finally { handle.closeSync(); }
  };
  visit(root, 0);
  return sources;
}

export function findPublicationSource(skillsRoot: string, localSkillId: string, check: () => void): string {
  if (!/^pubsrc-[a-f0-9]{48}$/.test(localSkillId)) fail('publication.source_missing');
  const found = discoverPublicationSources(skillsRoot, check).get(localSkillId);
  if (!found) fail('publication.source_missing');
  return found!;
}
