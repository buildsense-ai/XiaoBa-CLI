#!/usr/bin/env node

import { Command } from 'commander';
import { Logger } from './utils/logger';
import { APP_VERSION } from './version';
import { applyRuntimeDataOptionsFromArgv } from './runtime/runtime-data-bootstrap';
import { findLegacyRuntimeArtifacts } from './runtime/data-migration';
import { resolveRuntimeIdentity } from './runtime/runtime-identity';

async function main() {
  applyRuntimeDataOptionsFromArgv(process.argv);
  const [
    { chatCommand },
    { configCommand },
    { registerSkillCommand },
    { feishuCommand },
    { runtimeCommand },
    { registerDataCommand },
  ] = await Promise.all([
    import('./commands/chat'),
    import('./commands/config'),
    import('./commands/skill'),
    import('./commands/feishu'),
    import('./commands/runtime'),
    import('./commands/data'),
  ]);
  const program = new Command();

  Logger.brand();
  logRuntimeIdentity();

  program
    .name('catsco')
    .description('CatsCo agent CLI')
    .version(APP_VERSION)
    .option('--data-dir <path>', 'Use an explicit runtime data directory')
    .option('--profile <name>', 'Use a named runtime data profile');

  program
    .command('chat')
    .description('Start a CatsCo local chat session')
    .option('-i, --interactive', 'Enter interactive mode')
    .option('-m, --message <message>', 'Send a single message')
    .action(chatCommand);

  program
    .command('config')
    .description('Configure CatsCo API settings')
    .action(configCommand);

  program
    .command('feishu')
    .description('Start the Feishu bot')
    .action(feishuCommand);

  program
    .command('catscompany')
    .description('Start the CatsCo agent connector (legacy alias)')
    .action(async () => {
      const { catscompanyCommand } = await import('./commands/catscompany');
      await catscompanyCommand();
    });

  program
    .command('connect')
    .description('Start the CatsCo webapp connector')
    .action(async () => {
      const { catscompanyCommand } = await import('./commands/catscompany');
      await catscompanyCommand();
    });

  program
    .command('catsco')
    .description('Start the CatsCo webapp connector (compatibility alias)')
    .action(async () => {
      const { catscompanyCommand } = await import('./commands/catscompany');
      await catscompanyCommand();
    });

  program
    .command('weixin')
    .description('Start the Weixin bot')
    .action(async () => {
      const { weixinCommand } = await import('./commands/weixin');
      await weixinCommand();
    });

  program
    .command('dashboard')
    .description('Start the CatsCo Dashboard')
    .option('-p, --port <port>', 'Specify the port number', '3800')
    .action(async (options) => {
      const { dashboardCommand } = await import('./commands/dashboard');
      await dashboardCommand(options);
    });

  program
    .command('runtime')
    .description('Show the resolved node, python, and git runtimes')
    .action(runtimeCommand);

  registerSkillCommand(program);
  registerDataCommand(program);

  program.action(() => {
    chatCommand({ interactive: true });
  });

  await program.parseAsync();
}

function logRuntimeIdentity(): void {
  const identity = resolveRuntimeIdentity();
  const codeLabel = identity.code.commit
    ? `${identity.code.branch || 'detached'}@${identity.code.commit.slice(0, 8)}${identity.code.dirty ? ' (dirty)' : ''}`
    : 'not a Git checkout';
  Logger.info(`Code root: ${identity.codeRoot} · ${codeLabel}`);
  Logger.info(`Workspace root: ${identity.workspaceRoot}`);
  Logger.info(`Data root: ${identity.dataRoot} · profile=${identity.profile} · source=${identity.dataRootSource}`);
  if (identity.workspaceRoot !== identity.dataRoot) {
    const legacyArtifacts = findLegacyRuntimeArtifacts(identity.workspaceRoot);
    if (legacyArtifacts.length > 0) {
      Logger.warning(`Legacy runtime data detected in the workspace: ${legacyArtifacts.join(', ')}`);
      Logger.info('Run `catsco data migrate` to preview a safe, copy-only migration.');
    }
  }
}

main().catch(error => {
  Logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
