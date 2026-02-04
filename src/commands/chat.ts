import * as readline from 'readline';
import ora from 'ora';
import deasync from 'deasync';
import { Logger } from '../utils/logger';
import { AIService } from '../utils/ai-service';
import { Message, CommandOptions } from '../types';
import { styles } from '../theme/colors';
import { SkillManager } from '../skills/skill-manager';
import { SkillExecutor } from '../skills/skill-executor';
import { SkillInvocationContext } from '../types/skill';
import { GauzMemService, GauzMemConfig } from '../utils/gauzmem-service';
import { ConfigManager } from '../utils/config';
import { PromptManager } from '../utils/prompt-manager';
import { ToolManager } from '../tools/tool-manager';
import { ToolCall } from '../types/tool';

// 历史管理配置
const HISTORY_MAX_LENGTH = 20;  // 触发压缩的阈值
const HISTORY_KEEP_RECENT = 5;  // 压缩后保留的最近消息数
const HISTORY_COMPRESS_COUNT = 15; // 每次压缩的消息数量

export async function chatCommand(options: CommandOptions): Promise<void> {
  const aiService = new AIService();
  const conversationHistory: Message[] = [];

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

  // 构建 System Prompt（包含动态加载的skills）
  Logger.info('正在构建 system prompt...');
  const systemPrompt = await PromptManager.buildSystemPrompt();

  // 将 system prompt 作为第一条消息添加到对话历史
  conversationHistory.push({
    role: 'system',
    content: systemPrompt
  });

  // 初始化 GauzMemService
  const config = ConfigManager.getConfig();
  let memoryService: GauzMemService | null = null;

  if (config.memory?.enabled) {
    const memConfig: GauzMemConfig = {
      baseUrl: config.memory.baseUrl || 'http://43.139.19.144:1235',
      projectId: config.memory.projectId || 'XiaoBa',
      userId: config.memory.userId || 'guowei',
      agentId: config.memory.agentId || 'XiaoBa',
      enabled: true,
    };
    memoryService = new GauzMemService(memConfig);
    Logger.info('记忆系统已启用');
  }

  // 单条消息模式
  if (options.message) {
    await sendSingleMessage(aiService, options.message, memoryService, systemPrompt, toolManager);
    return;
  }

  // 交互式对话模式
  if (options.interactive) {
    await interactiveChat(aiService, conversationHistory, skillManager, memoryService, toolManager);
    return;
  }

  // 默认进入交互模式
  await interactiveChat(aiService, conversationHistory, skillManager, memoryService, toolManager);
}

async function sendSingleMessage(
  aiService: AIService,
  message: string,
  memoryService: GauzMemService | null,
  systemPrompt: string,
  toolManager: ToolManager
): Promise<void> {
  const messages: Message[] = [];

  // 添加 system prompt
  messages.push({ role: 'system', content: systemPrompt });

  // 搜索相关记忆
  if (memoryService) {
    const memories = await memoryService.searchMemory(message);
    if (memories.length > 0) {
      const memoryContext = memoryService.formatMemoriesAsContext(memories);
      messages.push({ role: 'system', content: memoryContext });
    }
  }

  messages.push({ role: 'user', content: message });

  const spinner = ora(styles.text('思考中...')).start();

  try {
    // 获取工具定义
    const tools = toolManager.getToolDefinitions();
    let finalResponse = '';

    // 工具调用循环
    while (true) {
      const response = await aiService.chat(messages, tools);

      // 如果有工具调用
      if (response.toolCalls && response.toolCalls.length > 0) {
        spinner.text = styles.text('执行工具...');

        // 添加助手消息（包含工具调用）
        messages.push({
          role: 'assistant',
          content: response.content,
          tool_calls: response.toolCalls
        });

        // 执行每个工具调用
        for (const toolCall of response.toolCalls) {
          const result = await toolManager.executeTool(toolCall);

          // 添加工具结果消息
          messages.push({
            role: 'tool',
            content: result.content,
            tool_call_id: result.tool_call_id,
            name: result.name
          });
        }

        spinner.text = styles.text('思考中...');
        continue;
      }

      // 没有工具调用，结束循环
      finalResponse = response.content || '';
      break;
    }

    spinner.stop();
    Logger.text('\n' + finalResponse + '\n');

    // 保存到记忆系统
    if (memoryService) {
      await memoryService.writeMemory(message, 'user');
      await memoryService.writeMemory(finalResponse, 'agent');
    }
  } catch (error: any) {
    spinner.stop();
    Logger.error(error.message);
  }
}

/**
 * 压缩对话历史并生成摘要
 * @returns 返回是否成功写入记忆系统
 */
async function compressHistory(
  messages: Message[],
  aiService: AIService,
  memoryService: GauzMemService | null
): Promise<boolean> {
  // 检查是否有实际的用户对话（不只是系统消息）
  const hasUserMessages = messages.some(m => m.role === 'user');
  if (messages.length === 0 || !memoryService || !hasUserMessages) {
    return false;
  }

  try {
    // 构建摘要提示
    const conversationText = messages
      .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
      .join('\n');

    const summaryPrompt = `请对以下对话进行简洁的摘要，保留关键信息、重要事实和上下文。摘要应该简洁但完整，以便未来回忆时能理解对话的主要内容。

对话内容：
${conversationText}

请生成摘要：`;

    // 调用 AI 生成摘要
    const spinner = ora(styles.text('正在压缩对话历史...')).start();
    const summary = await aiService.chat([
      { role: 'user', content: summaryPrompt }
    ]);
    spinner.stop();

    // 将摘要写入 GauzMem，使用特殊标记
    const summaryText = `[对话摘要 - ${new Date().toISOString()}]\n${summary}`;
    const writeSuccess = await memoryService.writeMemory(summaryText, 'agent');

    if (writeSuccess) {
      Logger.info(`已压缩 ${messages.length} 条消息并写入记忆系统`);
      return true;
    } else {
      Logger.warning(`已生成摘要但写入记忆系统失败`);
      return false;
    }
  } catch (error) {
    Logger.error('压缩历史失败: ' + String(error));
    return false;
  }
}

async function interactiveChat(
  aiService: AIService,
  conversationHistory: Message[],
  skillManager: SkillManager,
  memoryService: GauzMemService | null,
  toolManager: ToolManager
): Promise<void> {
  // 保存原始的 process.exit 函数
  const originalExit = process.exit.bind(process);
  let isExiting = false;

  // 覆盖 process.exit，确保在任何退出情况下都能保存记忆
  (process.exit as any) = (code?: number) => {
    if (isExiting) {
      originalExit(code);
      return;
    }
    isExiting = true;

    console.log('\n');

    // 使用定时器保持进程运行，直到清理完成
    const keepAliveTimer = setInterval(() => {}, 100);

    // 执行异步清理逻辑
    const cleanup = async () => {
      try {
        if (conversationHistory.length > 0 && memoryService) {
          const success = await compressHistory(conversationHistory, aiService, memoryService);
          if (success) {
            Logger.info('已保存对话历史到记忆系统');
          }
        }
        console.log(styles.text('再见！期待下次与你对话。\n'));
      } finally {
        // 清理完成，清除定时器并退出
        clearInterval(keepAliveTimer);
        originalExit(code);
      }
    };

    // 启动清理逻辑
    cleanup();
  };

  // 设置 Ctrl+C 信号处理器 - 使用异步方式
  const sigintHandler = () => {
    if (isExiting) {
      originalExit(0);
      return;
    }
    isExiting = true;

    console.log('\n');

    // 使用定时器保持进程运行，直到清理完成
    const keepAliveTimer = setInterval(() => {}, 100);

    // 执行异步清理逻辑
    const cleanup = async () => {
      try {
        if (conversationHistory.length > 0 && memoryService) {
          const success = await compressHistory(conversationHistory, aiService, memoryService);
          if (success) {
            Logger.info('已保存对话历史到记忆系统');
          }
        }
        console.log(styles.text('再见！期待下次与你对话。\n'));
      } finally {
        // 清理完成，清除定时器并退出
        clearInterval(keepAliveTimer);
        originalExit(0);
      }
    };

    // 启动清理逻辑
    cleanup();
  };

  // 使用 prependListener 确保我们的处理器优先执行
  process.prependListener('SIGINT', sigintHandler);

  console.log(styles.text('开始对话吧！输入消息后按回车发送。\n输入 ') + styles.highlight('/exit') + styles.text(' 退出对话，输入 ') + styles.highlight('/skills') + styles.text(' 查看可用技能。\n输入 ') + styles.highlight('/clear') + styles.text(' 清空历史，输入 ') + styles.highlight('/history') + styles.text(' 查看历史信息。\n'));

  // 创建 readline 接口
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: styles.highlight('> ')
  });

  // 处理每一行输入
  rl.on('line', async (message: string) => {
    if (!message.trim()) {
      rl.prompt();
      return;
    }

    // 处理 slash commands
    if (message.startsWith('/')) {
      const handled = await handleSlashCommand(
        message,
        skillManager,
        conversationHistory,
        aiService,
        memoryService,
        toolManager
      );
      if (handled) {
        rl.prompt();
        return;
      }
    }

    // 处理退出命令（向后兼容）
    if (message.toLowerCase() === 'exit' || message.toLowerCase() === 'quit') {
      // 退出前压缩剩余的对话历史
      if (conversationHistory.length > 0 && memoryService) {
        const success = await compressHistory(conversationHistory, aiService, memoryService);
        if (success) {
          Logger.info('已保存对话历史到记忆系统');
        }
      }
      console.log('\n' + styles.text('再见！期待下次与你对话。') + '\n');
      rl.close();
      return;
    }

    conversationHistory.push({ role: 'user', content: message });

    // 搜索相关记忆（作为临时上下文，不添加到历史）
    let contextMessages: Message[] = [...conversationHistory];
    if (memoryService) {
      const memories = await memoryService.searchMemory(message);
      if (memories.length > 0) {
        const memoryContext = memoryService.formatMemoriesAsContext(memories);
        // 将记忆插入到用户消息之前作为上下文
        contextMessages = [
          ...conversationHistory.slice(0, -1),
          { role: 'system', content: memoryContext },
          conversationHistory[conversationHistory.length - 1]
        ];
      }
    }

    const spinner = ora({
      text: styles.text('思考中...'),
      color: 'yellow',
    }).start();

    try {
      // 获取工具定义
      const tools = toolManager.getToolDefinitions();
      let finalResponse = '';

      // 工具调用循环
      while (true) {
        const response = await aiService.chat(contextMessages, tools);

        // 如果有工具调用
        if (response.toolCalls && response.toolCalls.length > 0) {
          spinner.text = styles.text('执行工具...');

          // 添加助手消息（包含工具调用）
          contextMessages.push({
            role: 'assistant',
            content: response.content,
            tool_calls: response.toolCalls
          });

          // 执行每个工具调用
          for (const toolCall of response.toolCalls) {
            const result = await toolManager.executeTool(toolCall);

            // 添加工具结果消息
            contextMessages.push({
              role: 'tool',
              content: result.content,
              tool_call_id: result.tool_call_id,
              name: result.name
            });
          }

          spinner.text = styles.text('思考中...');
          continue;
        }

        // 没有工具调用，结束循环
        finalResponse = response.content || '';
        break;
      }

      spinner.stop();

      conversationHistory.push({ role: 'assistant', content: finalResponse });

      // 显示响应，使用黑金配色
      console.log('\n' + styles.text(finalResponse) + '\n');

      // 检查是否需要压缩历史
      if (conversationHistory.length > HISTORY_MAX_LENGTH) {
        const toCompress = conversationHistory.slice(0, HISTORY_COMPRESS_COUNT);
        const success = await compressHistory(toCompress, aiService, memoryService);
        if (success) {
          conversationHistory.splice(0, HISTORY_COMPRESS_COUNT);
          Logger.info(`已保留最近 ${conversationHistory.length} 条消息`);
        } else {
          Logger.warning('压缩失败，保留所有历史消息');
        }
      }
    } catch (error: any) {
      spinner.stop();
      console.log('\n' + styles.error(error.message) + '\n');
    }

    // 显示下一个提示符
    rl.prompt();
  });

  // 处理 Ctrl+C
  rl.on('SIGINT', () => {
    // 暂停 readline，防止立即退出
    rl.pause();

    // 执行清理逻辑
    sigintHandler();
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

/**
 * 处理 slash command
 */
async function handleSlashCommand(
  message: string,
  skillManager: SkillManager,
  conversationHistory: Message[],
  aiService: AIService,
  memoryService: GauzMemService | null,
  toolManager: ToolManager
): Promise<boolean> {
  // 解析命令
  const parts = message.slice(1).split(/\s+/);
  const commandName = parts[0].toLowerCase();
  const args = parts.slice(1);

  // 处理内置命令
  if (commandName === 'exit') {
    // 退出前压缩剩余的对话历史
    if (conversationHistory.length > 0 && memoryService) {
      const success = await compressHistory(conversationHistory, aiService, memoryService);
      if (success) {
        Logger.info('已保存对话历史到记忆系统');
      }
    }
    console.log('\n' + styles.text('再见！期待下次与你对话。') + '\n');
    process.exit(0);
  }

  if (commandName === 'skills') {
    listSkills(skillManager);
    return true;
  }

  if (commandName === 'clear') {
    conversationHistory.length = 0;
    Logger.success('对话历史已清空');
    return true;
  }

  if (commandName === 'history') {
    console.log('\n' + styles.title('对话历史信息:') + '\n');
    console.log(styles.text(`当前历史长度: ${conversationHistory.length} 条消息`));
    console.log(styles.text(`压缩阈值: ${HISTORY_MAX_LENGTH} 条`));
    console.log(styles.text(`压缩后保留: ${HISTORY_KEEP_RECENT} 条\n`));
    return true;
  }

  // 查找 skill
  const skill = skillManager.getSkill(commandName);
  if (!skill) {
    Logger.warning(`未找到 skill: ${commandName}`);
    return false;
  }

  if (!skill.metadata.userInvocable) {
    Logger.warning(`Skill "${commandName}" 不允许用户调用`);
    return false;
  }

  // 执行 skill
  const context: SkillInvocationContext = {
    skillName: commandName,
    arguments: args,
    rawArguments: args.join(' '),
    userMessage: message
  };

  const prompt = SkillExecutor.execute(skill, context);

  // 注入到对话历史
  conversationHistory.push({
    role: 'system',
    content: prompt
  });

  Logger.info(`已激活 skill: ${skill.metadata.name}`);

  // 如果有参数，自动发送用户消息
  if (args.length > 0) {
    const userMessage = args.join(' ');
    conversationHistory.push({
      role: 'user',
      content: userMessage
    });

    // 搜索相关记忆（作为临时上下文，不添加到历史）
    let contextMessages: Message[] = [...conversationHistory];
    if (memoryService) {
      const memories = await memoryService.searchMemory(userMessage);
      if (memories.length > 0) {
        const memoryContext = memoryService.formatMemoriesAsContext(memories);
        contextMessages = [
          ...conversationHistory.slice(0, -1),
          { role: 'system', content: memoryContext },
          conversationHistory[conversationHistory.length - 1]
        ];
      }
    }

    // 调用 AI
    const spinner = ora(styles.text('思考中...')).start();
    try {
      // 获取工具定义
      const tools = toolManager.getToolDefinitions();
      let finalResponse = '';

      // 工具调用循环
      while (true) {
        const response = await aiService.chat(contextMessages, tools);

        // 如果有工具调用
        if (response.toolCalls && response.toolCalls.length > 0) {
          spinner.text = styles.text('执行工具...');

          // 添加助手消息（包含工具调用）
          contextMessages.push({
            role: 'assistant',
            content: response.content,
            tool_calls: response.toolCalls
          });

          // 执行每个工具调用
          for (const toolCall of response.toolCalls) {
            const result = await toolManager.executeTool(toolCall);

            // 添加工具结果消息
            contextMessages.push({
              role: 'tool',
              content: result.content,
              tool_call_id: result.tool_call_id,
              name: result.name
            });
          }

          spinner.text = styles.text('思考中...');
          continue;
        }

        // 没有工具调用，结束循环
        finalResponse = response.content || '';
        break;
      }

      spinner.stop();
      conversationHistory.push({ role: 'assistant', content: finalResponse });
      console.log('\n' + styles.text(finalResponse) + '\n');

      // 检查是否需要压缩历史
      if (conversationHistory.length > HISTORY_MAX_LENGTH) {
        const toCompress = conversationHistory.slice(0, HISTORY_COMPRESS_COUNT);
        const success = await compressHistory(toCompress, aiService, memoryService);
        if (success) {
          conversationHistory.splice(0, HISTORY_COMPRESS_COUNT);
          Logger.info(`已保留最近 ${conversationHistory.length} 条消息`);
        } else {
          Logger.warning('压缩失败，保留所有历史消息');
        }
      }
    } catch (error: any) {
      spinner.stop();
      Logger.error(error.message);
    }
  }

  return true;
}

/**
 * 列出所有可用的 skills
 */
function listSkills(skillManager: SkillManager): void {
  const skills = skillManager.getUserInvocableSkills();

  if (skills.length === 0) {
    console.log('\n' + styles.text('暂无可用的 skills。') + '\n');
    return;
  }

  console.log('\n' + styles.title('可用的 Skills:') + '\n');
  skills.forEach(skill => {
    const hint = skill.metadata.argumentHint ? ` ${skill.metadata.argumentHint}` : '';
    console.log(styles.highlight(`  /${skill.metadata.name}`) + styles.text(hint));
    console.log(styles.text(`    ${skill.metadata.description}\n`));
  });
}
