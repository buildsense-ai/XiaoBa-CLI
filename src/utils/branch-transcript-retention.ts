import * as fs from 'fs';
import * as path from 'path';

export interface BranchTranscriptAuditLink {
  involvedCapabilityHandles: readonly string[];
  branchTranscriptPaths: readonly string[];
  /** Optional hashes retained with newer Transition Audit entries. */
  branchTranscriptHashes?: readonly string[];
}

export interface BranchTranscriptCleanupOptions {
  branchLogRoot: string;
  auditEntries: readonly BranchTranscriptAuditLink[];
  activeCapabilityHandles: ReadonlySet<string>;
  now?: Date;
  retentionDays?: number;
}

export interface BranchTranscriptCleanupResult {
  removedPaths: string[];
  retainedPaths: string[];
}

const DEFAULT_RETENTION_DAYS = 30;
const PROTECTED_DIRECTORY_NAMES = new Set([
  'sessions',
  'data',
  'skills',
  'reports',
  'provider-messages',
  'context-debug',
  'distillation',
]);

/**
 * Remove only old branch JSONL transcripts. Active Capability audit links are
 * retained; all non-branch runtime state remains outside this traversal.
 */
export function cleanupBranchTranscripts(
  options: BranchTranscriptCleanupOptions,
): BranchTranscriptCleanupResult {
  const root = path.resolve(options.branchLogRoot);
  const result: BranchTranscriptCleanupResult = { removedPaths: [], retainedPaths: [] };
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return result;

  const protectedPaths = new Set<string>();
  for (const entry of options.auditEntries) {
    if (!entry.involvedCapabilityHandles.some(handle => options.activeCapabilityHandles.has(handle))) continue;
    for (const transcriptPath of entry.branchTranscriptPaths) {
      const resolved = path.resolve(transcriptPath);
      if (isPathInside(resolved, root)) protectedPaths.add(resolved);
    }
  }

  const retentionDays = Math.max(1, options.retentionDays ?? DEFAULT_RETENTION_DAYS);
  const cutoff = (options.now ?? new Date()).getTime() - retentionDays * 24 * 60 * 60 * 1000;
  for (const filePath of collectJsonlFiles(root)) {
    if (protectedPaths.has(filePath)) {
      result.retainedPaths.push(filePath);
      continue;
    }
    try {
      if (fs.statSync(filePath).mtimeMs >= cutoff) continue;
      fs.unlinkSync(filePath);
      result.removedPaths.push(filePath);
    } catch {
      // Cleanup is best-effort. A concurrent writer or permission change must
      // not affect the runtime learning wake.
    }
  }

  removeEmptyDirectories(root);
  return result;
}

function collectJsonlFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (PROTECTED_DIRECTORY_NAMES.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...collectJsonlFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.resolve(fullPath));
  }
  return files;
}

function removeEmptyDirectories(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (PROTECTED_DIRECTORY_NAMES.has(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const fullPath = path.join(dir, entry.name);
    removeEmptyDirectories(fullPath);
    try {
      if (fs.readdirSync(fullPath).length === 0) fs.rmdirSync(fullPath);
    } catch {
      // Best effort only.
    }
  }
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (
    !!relative
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}
