#!/usr/bin/env node

import { Command } from 'commander';
import { Logger } from './utils/logger';
import { chatCommand } from './commands/chat';
import { configCommand } from './commands/config';
import { registerSkillCommand } from './commands/skill';

function main() {
  const program = new Command();

  // 显示品牌标识
  Logger.brand();

  program
    .name('xiaoba')
    .description('XiaoBa - 您的智能AI命令行助手')
    .version('0.1.0');

  // 聊天命令
  program
    .command('chat')
    .description('开始与XiaoBa对话')
    .option('-i, --interactive', '进入交互式对话模式')
    .option('-m, --message <message>', '发送单条消息')
    .action(chatCommand);

  // 配置命令
  program
    .command('config')
    .description('配置XiaoBa的API设置')
    .action(configCommand);

  // Skill 管理命令
  registerSkillCommand(program);

  // 默认命令 - 进入交互模式
  program
    .action(() => {
      chatCommand({ interactive: true });
    });

  program.parse();
}

main();
