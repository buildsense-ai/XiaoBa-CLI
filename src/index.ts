#!/usr/bin/env node

import { Command } from 'commander';
import { Logger } from './utils/logger';
import { chatCommand } from './commands/chat';
import { configCommand } from './commands/config';
import { registerSkillCommand } from './commands/skill';
import { feishuCommand } from './commands/feishu';
import { runtimeCommand } from './commands/runtime';
import { APP_VERSION } from './version';

function main() {
  const program = new Command();

  Logger.brand();

  program
    .name('catsco')
    .description('CatsCo agent CLI')
    .version(APP_VERSION);

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
    .option('--retry-needs-review <entry-id>', 'Mark a Needs Review Queue entry eligible for retry')
    .option('--reason <text>', 'Record why an explicit retry was requested')
    .option('--working-directory <path>', 'Resolve runtime state from this working directory')
    .action(runtimeCommand);

  const externalSource = program
    .command('external-source')
    .description('Manage durable external session log provider controls (issue #91)');

  externalSource
    .command('status')
    .description('Show external source provider status')
    .option('--json', 'Output as JSON')
    .option('--working-directory <path>', 'Resolve provider state from this working directory')
    .action(async (options) => {
      const { externalSourceCommand } = await import('./commands/external-source');
      await externalSourceCommand({ subcommand: 'status', json: options.json, workingDirectory: options.workingDirectory });
    });

  externalSource
    .command('enable <provider>')
    .description('Enable an external session log provider')
    .option('--scope <scope>', 'Scope: global or path', 'global')
    .option('--scope-path <path>', 'Project path when scope is path')
    .option('--history <mode>', 'History mode: future-only or catch-up')
    .option('--working-directory <path>', 'Resolve provider state from this working directory')
    .action(async (provider: string, options) => {
      const { externalSourceCommand } = await import('./commands/external-source');
      await externalSourceCommand({ subcommand: 'enable', provider, scope: options.scope, scopePath: options.scopePath, history: options.history, workingDirectory: options.workingDirectory });
    });

  externalSource
    .command('history <provider> <mode>')
    .description('Set an enabled provider history mode')
    .option('--working-directory <path>', 'Resolve provider state from this working directory')
    .action(async (provider: string, mode: string, options) => {
      const { externalSourceCommand } = await import('./commands/external-source');
      await externalSourceCommand({ subcommand: 'history', provider, history: mode, workingDirectory: options.workingDirectory });
    });

  externalSource
    .command('disable <provider>')
    .description('Disable an external session log provider (preserves state)')
    .option('--working-directory <path>', 'Resolve provider state from this working directory')
    .action(async (provider: string, options) => {
      const { externalSourceCommand } = await import('./commands/external-source');
      await externalSourceCommand({ subcommand: 'disable', provider, workingDirectory: options.workingDirectory });
    });

  externalSource
    .command('reset <provider>')
    .description('Reset a provider to its environment default')
    .option('--working-directory <path>', 'Resolve provider state from this working directory')
    .action(async (provider: string, options) => {
      const { externalSourceCommand } = await import('./commands/external-source');
      await externalSourceCommand({ subcommand: 'reset', provider, workingDirectory: options.workingDirectory });
    });

  externalSource
    .command('rebaseline <provider>')
    .description('Explicit rebaseline: skip unread events to now')
    .option('--skip-to-now', 'Skip to current stable timeline without admission')
    .option('--working-directory <path>', 'Resolve provider state from this working directory')
    .action(async (provider: string, options) => {
      const { externalSourceCommand } = await import('./commands/external-source');
      await externalSourceCommand({ subcommand: 'rebaseline', provider, skipToNow: options.skipToNow, workingDirectory: options.workingDirectory });
    });

  registerSkillCommand(program);

  program.action(() => {
    chatCommand({ interactive: true });
  });

  program.parse();
}

main();
