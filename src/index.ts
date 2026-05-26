#!/usr/bin/env node

import { Command } from 'commander';
import { Logger } from './utils/logger';
import { chatCommand } from './commands/chat';
import { configCommand } from './commands/config';
import { registerSkillCommand } from './commands/skill';
import { feishuCommand } from './commands/feishu';
import { runtimeCommand } from './commands/runtime';
import { resolveRuntimeProfileFromConfig } from './runtime/runtime-profile-config';
import { APP_VERSION } from './version';

function main() {
  const program = new Command();

  if (shouldShowStartupBrand(process.argv)) {
    Logger.brand();
  }

  program
    .name('catsco')
    .description('CatsCo agent CLI')
    .version(APP_VERSION);

  program
    .command('chat')
    .description('Start a CatsCo local chat session')
    .option('-i, --interactive', 'Enter interactive mode')
    .option('-m, --message <message>', 'Send a single message')
    .option('--profile <path>', 'Use a runtime profile config file')
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
    .option('--profile <path>', 'Use a runtime profile config file')
    .action(async (options) => {
      const { catscompanyCommand } = await import('./commands/catscompany');
      await catscompanyCommand(options);
    });

  program
    .command('connect')
    .description('Start the CatsCo webapp connector')
    .option('--profile <path>', 'Use a runtime profile config file')
    .action(async (options) => {
      const { catscompanyCommand } = await import('./commands/catscompany');
      await catscompanyCommand(options);
    });

  program
    .command('catsco')
    .description('Start the CatsCo webapp connector (compatibility alias)')
    .option('--profile <path>', 'Use a runtime profile config file')
    .action(async (options) => {
      const { catscompanyCommand } = await import('./commands/catscompany');
      await catscompanyCommand(options);
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

function shouldShowStartupBrand(argv: string[]): boolean {
  try {
    const profilePath = readOptionValue(argv, '--profile');
    const { profile } = resolveRuntimeProfileFromConfig({
      configPath: profilePath,
      workingDirectory: process.cwd(),
    });
    return profile.branding.enabled !== false;
  } catch {
    return true;
  }
}

function readOptionValue(argv: string[], longName: string): string | undefined {
  const prefix = `${longName}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === longName) {
      return argv[index + 1];
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}
