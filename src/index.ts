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
    .command('device-connector')
    .description('Start the lightweight CatsCo local device connector')
    .option('--pair <code>', 'Pair this device with a CatsCo account using a pairing code')
    .option('--name <name>', 'Set the local device display name')
    .option('--allow-write', 'Allow approved remote write_file requests on this device')
    .option('--allow-shell', 'Allow approved remote execute_shell requests on this device')
    .option('--capability <capability...>', 'Expose additional device capabilities')
    .option('--http-base-url <url>', 'CatsCo HTTP API base URL')
    .option('--server-url <url>', 'CatsCo WebSocket URL')
    .option('--runtime-root <path>', 'Runtime directory for CatsCo local connector config')
    .action(async (options) => {
      const { deviceConnectorCommand } = await import('./commands/device-connector');
      await deviceConnectorCommand(options);
    });

  program
    .command('connector')
    .description('Start the lightweight CatsCo local device connector')
    .option('--pair <code>', 'Pair this device with a CatsCo account using a pairing code')
    .option('--name <name>', 'Set the local device display name')
    .option('--allow-write', 'Allow approved remote write_file requests on this device')
    .option('--allow-shell', 'Allow approved remote execute_shell requests on this device')
    .option('--capability <capability...>', 'Expose additional device capabilities')
    .option('--http-base-url <url>', 'CatsCo HTTP API base URL')
    .option('--server-url <url>', 'CatsCo WebSocket URL')
    .option('--runtime-root <path>', 'Runtime directory for CatsCo local connector config')
    .action(async (options) => {
      const { deviceConnectorCommand } = await import('./commands/device-connector');
      await deviceConnectorCommand(options);
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

  program.action(() => {
    chatCommand({ interactive: true });
  });

  program.parse();
}

main();
