import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const LEGACY_RUNTIME_ARTIFACTS = [
  '.env',
  '.xiaoba',
  'branch-agents.json',
  'config.json',
  'data',
  'logs',
  'prompt-overrides',
  'skills',
] as const;

// These are deliberately narrower than the migration allow-list. Source
// checkouts can legitimately contain bundled data/ and skills/ directories,
// so using those as signals would report legacy user data in every worktree.
export const LEGACY_RUNTIME_MARKERS = [
  '.env',
  '.xiaoba',
  'branch-agents.json',
  'config.json',
  'logs',
  'prompt-overrides',
  'data/sessions',
  'data/session-state',
  'data/session-summaries',
  'data/catsco-log-agent-state.json',
] as const;

export type MigrationFileStatus = 'copy' | 'same' | 'conflict' | 'unsupported';

export interface MigrationFilePlan {
  relativePath: string;
  sourcePath: string;
  targetPath: string;
  bytes: number;
  status: MigrationFileStatus;
  reason?: string;
}

export interface RuntimeDataMigrationPlan {
  sourceRoot: string;
  targetRoot: string;
  files: MigrationFilePlan[];
  missingArtifacts: string[];
  totals: Record<MigrationFileStatus, number>;
  copyBytes: number;
}

export interface RuntimeDataMigrationResult extends RuntimeDataMigrationPlan {
  applied: boolean;
  manifestPath?: string;
}

export function planRuntimeDataMigration(sourceRoot: string, targetRoot: string): RuntimeDataMigrationPlan {
  const source = path.resolve(sourceRoot);
  const target = path.resolve(targetRoot);
  assertSeparateRoots(source, target);

  const files: MigrationFilePlan[] = [];
  const missingArtifacts: string[] = [];
  for (const artifact of LEGACY_RUNTIME_ARTIFACTS) {
    const sourcePath = path.join(source, artifact);
    if (!fs.existsSync(sourcePath)) {
      missingArtifacts.push(artifact);
      continue;
    }
    collectMigrationFiles(sourcePath, path.join(target, artifact), artifact, files);
  }

  return summarizePlan(source, target, files, missingArtifacts);
}

export function applyRuntimeDataMigration(plan: RuntimeDataMigrationPlan): RuntimeDataMigrationResult {
  const freshPlan = planRuntimeDataMigration(plan.sourceRoot, plan.targetRoot);
  fs.mkdirSync(freshPlan.targetRoot, { recursive: true });

  for (const file of freshPlan.files) {
    if (file.status !== 'copy') continue;
    fs.mkdirSync(path.dirname(file.targetPath), { recursive: true });
    fs.copyFileSync(file.sourcePath, file.targetPath, fs.constants.COPYFILE_EXCL);
    const sourceMode = fs.statSync(file.sourcePath).mode & 0o777;
    fs.chmodSync(file.targetPath, file.relativePath === '.env' ? 0o600 : sourceMode);
  }

  const manifestDir = path.join(freshPlan.targetRoot, '.xiaoba', 'migrations');
  fs.mkdirSync(manifestDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const manifestPath = path.join(manifestDir, `${timestamp}.json`);
  const manifest = {
    schema: 'xiaoba.runtime-data-migration.v1',
    createdAt: new Date().toISOString(),
    sourceRoot: freshPlan.sourceRoot,
    targetRoot: freshPlan.targetRoot,
    copied: freshPlan.files.filter(file => file.status === 'copy').map(file => file.relativePath),
    same: freshPlan.files.filter(file => file.status === 'same').map(file => file.relativePath),
    conflicts: freshPlan.files.filter(file => file.status === 'conflict').map(file => file.relativePath),
    unsupported: freshPlan.files.filter(file => file.status === 'unsupported').map(file => ({
      path: file.relativePath,
      reason: file.reason,
    })),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  return { ...freshPlan, applied: true, manifestPath };
}

export function findLegacyRuntimeArtifacts(root: string): string[] {
  const resolved = path.resolve(root);
  return LEGACY_RUNTIME_MARKERS.filter(artifact => fs.existsSync(path.join(resolved, artifact)));
}

function collectMigrationFiles(
  sourcePath: string,
  targetPath: string,
  relativePath: string,
  files: MigrationFilePlan[],
): void {
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) {
    files.push({
      relativePath,
      sourcePath,
      targetPath,
      bytes: 0,
      status: 'unsupported',
      reason: 'symbolic links are not copied',
    });
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(sourcePath).sort()) {
      collectMigrationFiles(
        path.join(sourcePath, entry),
        path.join(targetPath, entry),
        path.join(relativePath, entry),
        files,
      );
    }
    return;
  }
  if (!stat.isFile()) {
    files.push({
      relativePath,
      sourcePath,
      targetPath,
      bytes: 0,
      status: 'unsupported',
      reason: 'only regular files are copied',
    });
    return;
  }

  let status: MigrationFileStatus = 'copy';
  if (fs.existsSync(targetPath)) {
    const targetStat = fs.lstatSync(targetPath);
    status = targetStat.isFile() && targetStat.size === stat.size && sameFileContent(sourcePath, targetPath)
      ? 'same'
      : 'conflict';
  }
  files.push({ relativePath, sourcePath, targetPath, bytes: stat.size, status });
}

function summarizePlan(
  sourceRoot: string,
  targetRoot: string,
  files: MigrationFilePlan[],
  missingArtifacts: string[],
): RuntimeDataMigrationPlan {
  const totals: Record<MigrationFileStatus, number> = {
    copy: 0,
    same: 0,
    conflict: 0,
    unsupported: 0,
  };
  let copyBytes = 0;
  for (const file of files) {
    totals[file.status] += 1;
    if (file.status === 'copy') copyBytes += file.bytes;
  }
  return { sourceRoot, targetRoot, files, missingArtifacts, totals, copyBytes };
}

function sameFileContent(left: string, right: string): boolean {
  return hashFile(left) === hashFile(right);
}

function hashFile(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(filePath, 'r');
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function assertSeparateRoots(source: string, target: string): void {
  const sourceToTarget = path.relative(source, target);
  const targetToSource = path.relative(target, source);
  if (
    source === target
    || isInsideRelative(sourceToTarget)
    || isInsideRelative(targetToSource)
  ) {
    throw new Error('Migration source and target must be separate, non-nested directories.');
  }
}

function isInsideRelative(relative: string): boolean {
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
