import * as path from 'path';
import type { Command } from 'commander';
import { Logger } from '../utils/logger';
import { PathResolver } from '../utils/path-resolver';
import { resolveRuntimeIdentity } from '../runtime/runtime-identity';
import {
  applyRuntimeDataMigration,
  findLegacyRuntimeArtifacts,
  planRuntimeDataMigration,
  RuntimeDataMigrationPlan,
} from '../runtime/data-migration';

export function registerDataCommand(program: Command): void {
  const data = program.command('data').description('Inspect or migrate XiaoBa runtime data');

  data
    .command('status', { isDefault: true })
    .description('Show code, workspace, and runtime data roots')
    .action(showDataStatus);

  data
    .command('migrate')
    .description('Safely copy legacy runtime data without deleting or overwriting files')
    .option('--from <path>', 'Legacy runtime root; defaults to the current workspace')
    .option('--apply', 'Apply the migration; without this flag only a preview is shown')
    .action((options: { from?: string; apply?: boolean }) => migrateData(options));
}

function showDataStatus(): void {
  const identity = resolveRuntimeIdentity();
  const legacyArtifacts = identity.workspaceRoot === identity.dataRoot
    ? []
    : findLegacyRuntimeArtifacts(identity.workspaceRoot);
  Logger.title('Runtime Data');
  Logger.info(`Code root: ${identity.codeRoot}`);
  Logger.info(`Workspace root: ${identity.workspaceRoot}`);
  Logger.info(`Data root: ${identity.dataRoot}`);
  Logger.info(`Profile: ${identity.profile} (${identity.dataRootSource})`);
  if (legacyArtifacts.length > 0) {
    Logger.warning(`Legacy runtime artifacts remain in the workspace: ${legacyArtifacts.join(', ')}`);
    Logger.info('Preview a safe copy with: catsco data migrate');
  } else {
    Logger.success('No legacy runtime artifacts were detected in the workspace.');
  }
}

function migrateData(options: { from?: string; apply?: boolean }): void {
  const sourceRoot = path.resolve(options.from || process.cwd());
  const targetRoot = PathResolver.getRuntimeDataRoot();
  const plan = planRuntimeDataMigration(sourceRoot, targetRoot);
  printMigrationPlan(plan);

  if (!options.apply) {
    Logger.info('Preview only. Re-run with --apply to copy files. The source is never deleted.');
    return;
  }
  const result = applyRuntimeDataMigration(plan);
  Logger.success(`Migration copied ${result.totals.copy} files without overwriting existing data.`);
  if (result.totals.conflict > 0) {
    Logger.warning(`${result.totals.conflict} conflicting files were left unchanged.`);
  }
  Logger.info(`Migration manifest: ${result.manifestPath}`);
}

function printMigrationPlan(plan: RuntimeDataMigrationPlan): void {
  Logger.title('Runtime Data Migration');
  Logger.info(`Source: ${plan.sourceRoot}`);
  Logger.info(`Target: ${plan.targetRoot}`);
  Logger.info(`Copy: ${plan.totals.copy} files (${formatBytes(plan.copyBytes)})`);
  Logger.info(`Already identical: ${plan.totals.same}`);
  if (plan.totals.conflict > 0) Logger.warning(`Conflicts (will not overwrite): ${plan.totals.conflict}`);
  if (plan.totals.unsupported > 0) Logger.warning(`Unsupported entries (will skip): ${plan.totals.unsupported}`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
