#!/usr/bin/env node

import { Command } from 'commander';
import { Logger } from './utils/logger';
import { chatCommand } from './commands/chat';
import { configCommand } from './commands/config';
import { registerSkillCommand } from './commands/skill';
import { feishuCommand } from './commands/feishu';

function main() {
  const program = new Command();

  // 显示品牌标识
  Logger.brand();

  program
    .name('xiaoba')
    .description('XiaoBa - 您的智能AI命令行助手')
    .version('0.1.0')
    .option('-s, --skill <name>', '启动时绑定指定 skill');

  // 聊天命令
  program
    .command('chat')
    .description('开始与XiaoBa对话')
    .option('-i, --interactive', '进入交互式对话模式')
    .option('-m, --message <message>', '发送单条消息')
    .option('-s, --skill <name>', '启动时绑定指定 skill')
    .action(chatCommand);

  // 配置命令
  program
    .command('config')
    .description('配置XiaoBa的API设置')
    .action(configCommand);

  // 飞书机器人命令
  program
    .command('feishu')
    .description('启动飞书机器人（WebSocket 长连接模式）')
    .action(feishuCommand);

  // Cats Company 机器人命令（懒加载，避免 SDK 缺失时影响其他命令）
  program
    .command('catscompany')
    .description('启动 Cats Company 机器人（WebSocket 长连接模式）')
    .action(async () => {
      try {
        const { catscompanyCommand } = await import('./commands/catscompany');
        await catscompanyCommand();
      } catch (err: any) {
        if (err?.code === 'MODULE_NOT_FOUND' || err?.code === 'ERR_MODULE_NOT_FOUND') {
          Logger.error('CatsCompany SDK 未安装或路径不正确，请检查 @catscompany/bot-sdk 依赖。');
        } else {
          throw err;
        }
      }
    });

  // Skill 管理命令
  registerSkillCommand(program);

  // 默认命令 - 进入交互模式
  program
    .action(() => {
      const opts = program.opts();
      chatCommand({ interactive: true, skill: opts.skill });
    });

  program.parse();
}

main();
