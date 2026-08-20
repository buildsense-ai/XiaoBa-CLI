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
    .description('Start the CatsCo Connector')
    .option('-p, --port <port>', 'Specify the port number', '3800')
    .action(async (options) => {
      const { dashboardCommand } = await import('./commands/dashboard');
      await dashboardCommand(options);
    });

  program
    .command('runtime')
    .description('Show the resolved node, python, and git runtimes')
    .action(runtimeCommand);

  const catslog = program
    .command('catslog')
    .description('Operate the CatsLog v2 device integration');

  catslog
    .command('skills')
    .description('Read this device-bound agent\'s Runtime Learning Skills')
    .option('--handle <handle>', 'Read one Skill handle')
    .option('--search <terms>', 'Search Skill handles and descriptions')
    .option('--content', 'Include Skill content (untrusted runtime data)')
    .option('--trace <mode>', 'Trace mode: none, summary, or full')
    .option('--limit <count>', 'Maximum Skills to return')
    .option('--cursor <cursor>', 'Continue an authenticated CatsLog page')
    .action(async (options) => {
      const { catslogSkillsCommand } = await import('./commands/catslog');
      const limit = options.limit === undefined ? undefined : Number(options.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
        throw new Error('--limit must be an integer from 1 to 100');
      }
      if (options.trace && !['none', 'summary', 'full'].includes(options.trace)) {
        throw new Error('--trace must be one of: none, summary, full');
      }
      await catslogSkillsCommand({
        handle: options.handle,
        search: options.search,
        includeContent: Boolean(options.content),
        includeTrace: options.trace,
        limit,
        cursor: options.cursor,
      });
    });

  registerSkillCommand(program);

  program.action(() => {
    chatCommand({ interactive: true });
  });

  program.parse();
}

main();
