import * as readline from 'readline';
import inquirer from 'inquirer';
import ora from 'ora';
import { Logger } from '../utils/logger';
import { CommandOptions } from '../types';
import { styles } from '../theme/colors';
import { AgentSession, SessionCallbacks } from '../core/agent-session';
import type { ToolExecutionConfirmationRequest, ToolExecutionConfirmationResult } from '../types/tool';
import { startRuntimeCommandSupport, stopRuntimeCommandSupport } from '../utils/runtime-command-support';
import { RuntimeFactory } from '../runtime/runtime-factory';
import { resolveRuntimeProfileFromConfig } from '../runtime/runtime-profile-config';

export async function chatCommand(options: CommandOptions): Promise<void> {
  Logger.openLogFile('cli', undefined, true);
  await startRuntimeCommandSupport();

  const runtime = await RuntimeFactory.createSession({
    profile: resolveRuntimeProfileFromConfig({
      surface: 'cli',
      workingDirectory: process.cwd(),
    }).profile,
    sessionKey: 'cli',
    sessionType: 'cli',
    loadSkills: false,
  });
  const { session, services } = runtime;
  const { toolManager } = services;

  Logger.info(`已注册 ${toolManager.getToolCount()} 个基础工具 (message mode)`);
  Logger.info(`运行时可用工具数量将根据 skill toolPolicy 动态过滤`);
  if (runtime.profile.skills.enabled) {
    await RuntimeFactory.loadSkills(services.skillManager);
  }

  if (options.skill) {
    Logger.warning('--skill 启动绑定已停用；请在对话中让 agent 通过 skill 工具调用对应 skill。');
  }

  // 单条消息模式
  if (options.message) {
    await sendSingleMessage(session, options.message);
    await stopRuntimeCommandSupport();
    Logger.closeLogFile();
    return;
  }

  // 交互式对话模式（默认）
  await interactiveChat(session);
}

/**
 * 创建支持流式输出的 ConversationRunner 回调
 * spinner 在首个文本片段到达时自动停止，文本直接写入 stdout
 */
function createStreamingCallbacks(spinner: ora.Ora): { callbacks: SessionCallbacks; didStream: () => boolean } {
  let streaming = false;
  let streamed = false;

  const callbacks: SessionCallbacks = {
    onText: (text: string) => {
      if (!streaming) {
        spinner.stop();
        process.stdout.write('\n');
        streaming = true;
        streamed = true;
      }
      process.stdout.write(text);
    },
    onToolStart: (name: string, toolUseId: string, input: any) => {
      // 如果上一轮有流式输出，先换行
      if (streaming) {
        process.stdout.write('\n');
        streaming = false;
      }
      spinner.stop();
      Logger.info(`执行工具: ${name}`);
      spinner.start();
      spinner.text = styles.text('执行工具...');
    },
    onToolEnd: () => {
      spinner.text = styles.text('思考中...');
    },
    onToolDisplay: (_name: string, content: string) => {
      spinner.stop();
      console.log(content);
      spinner.start();
    },
    confirmToolExecution: async (request) => confirmCliToolExecution(request, spinner),
  };

  return { callbacks, didStream: () => streamed };
}

async function confirmCliToolExecution(
  request: ToolExecutionConfirmationRequest,
  spinner: ora.Ora,
): Promise<ToolExecutionConfirmationResult> {
  spinner.stop();
  const riskLabel = request.risk === 'high' ? '高风险' : request.risk === 'medium' ? '需要确认' : '低风险';
  console.log('');
  Logger.warning(`${riskLabel}工具操作: ${request.toolName}`);
  Logger.info(request.reason);
  if (request.workingDirectory) {
    Logger.info(`当前目录: ${request.workingDirectory}`);
  }
  const argsPreview = JSON.stringify(request.args ?? {}, null, 2);
  if (argsPreview && argsPreview !== '{}') {
    Logger.info(`参数: ${argsPreview.length > 800 ? `${argsPreview.slice(0, 800)}...` : argsPreview}`);
  }

  if (!process.stdin.isTTY) {
    spinner.start();
    return { approved: false, reason: '当前环境无法显示确认提示，已取消该工具调用。' };
  }

  const { approved } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'approved',
      message: `允许执行 ${request.toolName} 吗？`,
      default: request.risk !== 'high',
    },
  ]);
  spinner.start();
  return approved
    ? { approved: true }
    : { approved: false, reason: `用户取消了 ${request.toolName}。` };
}

async function sendSingleMessage(
  session: AgentSession,
  message: string,
): Promise<void> {
  const spinner = ora(styles.text('思考中...')).start();

  const { callbacks, didStream } = createStreamingCallbacks(spinner);
  const result = await session.handleMessage(message, callbacks);

  spinner.stop();
  if (didStream()) {
    process.stdout.write('\n\n');
  } else {
    // 没有流式输出（如错误信息），直接打印返回值
    console.log('\n' + result.text + '\n');
  }
}

async function interactiveChat(session: AgentSession): Promise<void> {
  // 保存原始的 process.exit 函数
  const originalExit = process.exit.bind(process);
  let isExiting = false;

  /** 统一的退出清理逻辑 */
  const gracefulExit = (code: number) => {
    if (isExiting) {
      originalExit(code);
      return;
    }
    isExiting = true;
    console.log('\n');

    const keepAliveTimer = setInterval(() => {}, 100);
    const cleanup = async () => {
      try {
        await session.cleanup();
        await stopRuntimeCommandSupport();
        Logger.info('已保存对话历史');
        console.log(styles.text('再见！期待下次与你对话。\n'));
      } finally {
        Logger.closeLogFile();
        clearInterval(keepAliveTimer);
        originalExit(code);
      }
    };
    cleanup();
  };

  // 覆盖 process.exit，确保在任何退出情况下都能保存记忆
  (process.exit as any) = (code?: number) => gracefulExit(code ?? 0);

  // 使用 prependListener 确保我们的处理器优先执行
  process.prependListener('SIGINT', () => gracefulExit(0));

  console.log(
    styles.text('开始对话吧！输入消息后按回车发送。\n输入 ') +
    styles.highlight('/exit') + styles.text(' 退出对话，输入 ') +
    styles.highlight('/stop') + styles.text(' 暂停会话，输入 ') +
    styles.highlight('/clear') + styles.text(' 清空历史，输入 ') +
    styles.highlight('/clear --all') + styles.text(' 清空历史并删除文件，输入 ') +
    styles.highlight('/skills') + styles.text(' 查看可用技能。\n输入 ') +
    styles.highlight('/history') + styles.text(' 查看历史信息。\n'),
  );

  // 创建 readline 接口
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: styles.highlight('> '),
  });

  // 处理每一行输入
  rl.on('line', async (message: string) => {
    if (!message.trim()) {
      rl.prompt();
      return;
    }

    // 处理斜杠命令
    if (message.startsWith('/')) {
      const parts = message.slice(1).split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);
      const cmdName = command.toLowerCase();

      // /exit：直接退出，不走 gracefulExit 避免双重告别
      if (cmdName === 'exit') {
        const result = await session.handleCommand(command, args);
        if (result.reply) {
          console.log('\n' + styles.text(result.reply) + '\n');
        }
        isExiting = true;
        rl.close();
        await stopRuntimeCommandSupport();
        Logger.closeLogFile();
        originalExit(0);
        return;
      }

      // 简单内置命令：不需要 spinner
      if (['clear', 'skills', 'history'].includes(cmdName)) {
        const result = await session.handleCommand(command, args);
        if (result.handled && result.reply) {
          console.log('\n' + result.reply);
        }
        rl.prompt();
        return;
      }

      // 可能涉及 AI 的命令（skill 等）
      const spinner = ora({ text: styles.text('思考中...'), color: 'yellow' }).start();
      const { callbacks, didStream } = createStreamingCallbacks(spinner);

      const result = await session.handleCommand(command, args, callbacks);
      spinner.stop();

      if (result.handled) {
        if (didStream()) {
          process.stdout.write('\n\n');
        } else if (result.reply) {
          console.log('\n' + result.reply);
        }
        rl.prompt();
        return;
      }
    }

    // 处理退出命令（向后兼容）
    if (message.toLowerCase() === 'exit' || message.toLowerCase() === 'quit') {
      await session.summarizeAndDestroy();
      await stopRuntimeCommandSupport();
      console.log('\n' + styles.text('再见！期待下次与你对话。') + '\n');
      isExiting = true;
      rl.close();
      Logger.closeLogFile();
      originalExit(0);
      return;
    }

    // 普通消息
    const spinner = ora({ text: styles.text('思考中...'), color: 'yellow' }).start();
    const { callbacks, didStream } = createStreamingCallbacks(spinner);

    const result = await session.handleMessage(message, callbacks);

    spinner.stop();
    if (didStream()) {
      process.stdout.write('\n\n');
    } else {
      console.log('\n' + result.text + '\n');
    }

    rl.prompt();
  });

  // 处理 Ctrl+C
  rl.on('SIGINT', () => {
    rl.pause();
    gracefulExit(0);
  });

  // 处理 readline 关闭
  rl.on('close', () => {
    if (!isExiting) {
      process.exit(0);
    }
  });

  // 显示第一个提示符
  rl.prompt();
}
