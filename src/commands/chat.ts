import * as readline from 'readline';
import ora from 'ora';
import { Logger } from '../utils/logger';
import { AIService } from '../utils/ai-service';
import { CommandOptions } from '../types';
import { styles } from '../theme/colors';
import { SkillManager } from '../skills/skill-manager';
import { GauzMemService, GauzMemConfig } from '../utils/gauzmem-service';
import { ConfigManager } from '../utils/config';
import { ToolManager } from '../tools/tool-manager';
import { AgentSession, AgentServices, SessionCallbacks } from '../core/agent-session';

export async function chatCommand(options: CommandOptions): Promise<void> {
  const aiService = new AIService();
  Logger.openLogFile('cli');

  // 初始化 ToolManager
  const toolManager = new ToolManager();
  Logger.info(`已加载 ${toolManager.getToolCount()} 个工具`);

  // 初始化 SkillManager
  const skillManager = new SkillManager();
  try {
    await skillManager.loadSkills();
    const skillCount = skillManager.getAllSkills().length;
    if (skillCount > 0) {
      Logger.info(`已加载 ${skillCount} 个 skills`);
    }
  } catch (error: any) {
    Logger.warning(`Skills 加载失败: ${error.message}`);
  }

  // 初始化 GauzMemService
  const config = ConfigManager.getConfig();
  let memoryService: GauzMemService | null = null;

  if (config.memory?.enabled) {
    const memConfig: GauzMemConfig = {
      baseUrl: config.memory.baseUrl || '',
      projectId: config.memory.projectId || 'XiaoBa',
      userId: config.memory.userId || '',
      agentId: config.memory.agentId || 'XiaoBa',
      enabled: true,
    };
    memoryService = new GauzMemService(memConfig);
    Logger.info('记忆系统已启用');
  }

  // 组装 AgentServices + 创建 AgentSession
  const services: AgentServices = {
    aiService,
    toolManager,
    skillManager,
    memoryService,
  };
  const session = new AgentSession('cli', services);

  // 启动时激活指定 skill
  if (options.skill) {
    const activated = await session.activateSkill(options.skill);
    if (!activated) {
      Logger.error(`Skill "${options.skill}" 未找到，请通过 xiaoba skill list 查看可用 skills`);
      Logger.closeLogFile();
      return;
    }
    Logger.info(`已绑定 skill: ${options.skill}`);
  }

  // 单条消息模式
  if (options.message) {
    await sendSingleMessage(session, options.message);
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
    onToolStart: (name: string) => {
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
    }
  };

  return { callbacks, didStream: () => streamed };
}

async function sendSingleMessage(
  session: AgentSession,
  message: string,
): Promise<void> {
  const spinner = ora(styles.text('思考中...')).start();

  const { callbacks, didStream } = createStreamingCallbacks(spinner);
  const reply = await session.handleMessage(message, callbacks);

  spinner.stop();
  if (didStream()) {
    process.stdout.write('\n\n');
  } else {
    // 没有流式输出（如错误信息），直接打印返回值
    console.log('\n' + reply + '\n');
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
        const success = await session.summarizeAndDestroy();
        if (success) {
          Logger.info('已保存对话历史到记忆系统');
        }
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
    styles.highlight('/skills') + styles.text(' 查看可用技能。\n输入 ') +
    styles.highlight('/clear') + styles.text(' 清空历史，输入 ') +
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

    const reply = await session.handleMessage(message, callbacks);

    spinner.stop();
    if (didStream()) {
      process.stdout.write('\n\n');
    } else {
      console.log('\n' + reply + '\n');
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

