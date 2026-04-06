import { CatsClient, MessageContext } from './client';
import { CatsCompanyConfig, ParsedCatsMessage, CatsFileInfo } from './types';
import { MessageSender } from './message-sender';
import { extractContentBlocks } from './content-blocks';
import { MessageSessionManager } from '../core/message-session-manager';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { AgentServices, BUSY_MESSAGE } from '../core/agent-session';
import { Logger } from '../utils/logger';
import { SubAgentManager } from '../core/sub-agent-manager';
import { ChannelCallbacks } from '../types/tool';
import { randomUUID } from 'crypto';

interface PendingAttachment {
  fileName: string;
  localPath: string;
  type: 'file' | 'image';
  receivedAt: number;
}

interface PendingAnswer {
  id: string;
  sessionKey: string;
  topic: string;
  expectedSenderId: string;
  resolve: (text: string) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface QueuedMessage {
  userMessage: string | import('../types').ContentBlock[];
  topic: string;
  senderId: string;
}

const PENDING_ANSWER_TIMEOUT_MS = 120_000;

/**
 * CatsCompanyBot 主类
 * 初始化官方 SDK，注册事件，编排消息处理流程
 * 连接、握手、重连与连接层错误处理都归 SDK 负责，runtime 不在这里兜底。
 * 结构与 FeishuBot 对齐
 */
export class CatsCompanyBot {
  private bot: CatsClient;
  private sender: MessageSender;
  private sessionManager: MessageSessionManager;
  private agentServices: AgentServices;
  /** key = pendingAnswerId */
  private pendingAnswers = new Map<string, PendingAnswer>();
  /** key = sessionKey, value = pendingAnswerId */
  private pendingAnswerBySession = new Map<string, string>();
  /** 等待用户后续指令的附件队列，key 为 sessionKey */
  private pendingAttachments = new Map<string, PendingAttachment[]>();
  /** 主会话忙时的消息队列，key = sessionKey */
  private messageQueue = new Map<string, QueuedMessage[]>();
  /** Bot 自身的 uid，用于过滤自己发出的消息 */
  private botUid: string | null = null;

  constructor(config: CatsCompanyConfig) {
    this.bot = new CatsClient({
      serverUrl: config.serverUrl,
      apiKey: config.apiKey,
      httpBaseUrl: config.httpBaseUrl,
    });

    this.sender = new MessageSender(this.bot, config.httpBaseUrl, config.apiKey);

    const aiService = new AIService();
    const toolManager = new ToolManager();

    Logger.info(`已注册 ${toolManager.getToolCount()} 个基础工具 (message mode)`);
    Logger.info(`运行时可用工具数量将根据 skill toolPolicy 动态过滤`);

    const skillManager = new SkillManager();

    this.agentServices = {
      aiService,
      toolManager,
      skillManager,
    };

    this.sessionManager = new MessageSessionManager(
      this.agentServices,
      'catscompany',
      config.sessionTTL,
    );
    this.sessionManager.setWakeupSendFn((channelId, text) => this.sender.reply(channelId, text));
  }

  /**
   * 启动 WebSocket 连接，开始监听消息
   */
  async start(): Promise<void> {
    Logger.openLogFile('catscompany');
    Logger.info('正在启动 CatsCompany 机器人...');

    // 加载 skills
    try {
      await this.agentServices.skillManager.loadSkills();
      const skillCount = this.agentServices.skillManager.getAllSkills().length;
      if (skillCount > 0) {
        Logger.info(`已加载 ${skillCount} 个 skills`);
      }
    } catch (error: any) {
      Logger.warning(`Skills 加载失败: ${error.message}`);
    }

    // 注册事件
    this.bot.on('ready', (info: { uid: string; name: string }) => {
      this.botUid = info.uid;
      const botName = info.name.trim() || '(未设置)';
      process.env.CURRENT_AGENT_DISPLAY_NAME = botName;
      Logger.success(`CatsCompany 机器人已连接，uid=${info.uid}, name=${botName}`);
    });

    this.bot.on('message', async (ctx: MessageContext) => {
      await this.onMessage(ctx);
    });

    this.bot.on('error', (err: Error) => {
      Logger.error(`CatsCompany 连接错误: ${err.message}`);
    });

    this.bot.connect();
    Logger.success('CatsCompany 机器人已启动，等待消息...');
  }

  // ─── 构建 ChannelCallbacks ──────────────────────

  /**
   * 为指定 topic 构建通道回调对象。
   * CatsCompany 复用 ChannelCallbacks 接口，chatId 对应 topic。
   */
  private buildChannel(
    topic: string,
    opts?: {
      sessionKey?: string;
      senderId?: string;
    },
  ): ChannelCallbacks & { hasOutbound: boolean } {
    let _hasOutbound = false;
    const channel: ChannelCallbacks & { hasOutbound: boolean } = {
      chatId: topic,
      get hasOutbound() { return _hasOutbound; },
      reply: async (_targetTopic: string, text: string) => {
        _hasOutbound = true;
        try {
          await this.sender.reply(topic, text);
        } catch (err: any) {
          Logger.warning(`消息发送失败 (reply): ${err.message}`);
        }
      },
      sendFile: async (_targetTopic: string, filePath: string, fileName: string) => {
        _hasOutbound = true;
        try {
          await this.sender.sendFile(topic, filePath, fileName);
        } catch (err: any) {
          Logger.warning(`文件发送失败 (sendFile): ${err.message}`);
        }
      },
    };

    return channel;
  }

  // ─── 消息处理 ─────────────────────────────────────────

  /**
   * 处理收到的消息
   */
  private async onMessage(ctx: MessageContext): Promise<void> {
    const msg = this.parseMessage(ctx);
    if (!msg) return;

    // 过滤 bot 自己发出的消息，防止循环
    if (this.botUid && msg.senderId === this.botUid) return;

    const key = msg.chatType === 'group'
      ? `cc_group:${msg.topic}`
      : `cc_user:${msg.senderId}`;

    // ── 拦截：如果当前 session 正在等待回答，按 sender 精确匹配 ──
    const pendingId = this.pendingAnswerBySession.get(key);
    if (pendingId) {
      const pending = this.pendingAnswers.get(pendingId);
      if (!pending) {
        this.pendingAnswerBySession.delete(key);
      } else if (msg.senderId === pending.expectedSenderId) {
        this.clearPendingAnswerById(pending.id);
        Logger.info(`[${key}] 收到用户对提问的回复: ${msg.text.slice(0, 50)}...`);
        pending.resolve(msg.text);
        return;
      } else {
        Logger.info(`[${key}] 忽略非提问发起人的回复: ${msg.senderId}`);
        return;
      }
    }

    // 获取或创建会话
    const session = this.sessionManager.getOrCreate(key, msg.topic);

    // 注册持久化回调到 SubAgentManager
    const subAgentManager = SubAgentManager.getInstance();
    subAgentManager.registerPlatformCallbacks(key, {
      injectMessage: async (text: string) => {
        await this.handleSubAgentFeedback(key, msg.topic, msg.senderId, text);
      },
    });

    // 处理斜杠命令
    if (typeof msg.text === 'string' && msg.text.startsWith('/')) {
      const parts = msg.text.slice(1).split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);

      const result = await session.handleCommand(command, args);
      if (result.handled && result.reply) {
        try {
          await this.sender.reply(msg.topic, result.reply);
        } catch (err: any) {
          Logger.warning(`命令回复发送失败: ${err.message}`);
        }
      }
      if (result.handled && command.toLowerCase() === 'clear') {
        this.pendingAttachments.delete(key);
      }
      if (result.handled) return;
    }

    Logger.info(`[${key}] 收到消息: ${msg.text.slice(0, 50)}...`);

    let userMessage: string | import('../types').ContentBlock[] = msg.text;

    if (msg.file) {
      const localPath = await this.sender.downloadFile(msg.file.url, msg.file.fileName);
      if (!localPath) {
        try {
          await this.sender.reply(msg.topic, `文件下载失败：${msg.file.fileName}\n请重试上传。`);
        } catch (err: any) {
          Logger.warning(`错误提示发送失败: ${err.message}`);
        }
        return;
      }

      this.enqueuePendingAttachment(key, {
        fileName: msg.file.fileName,
        localPath,
        type: msg.file.type,
        receivedAt: Date.now(),
      });
      const queuedAttachments = this.consumePendingAttachments(key);
      userMessage = await this.buildMultimodalMessage(msg.text, queuedAttachments);
      Logger.info(`[${key}] 附件消息（attachments=${queuedAttachments.length})`);
    } else {
      const queuedAttachments = this.consumePendingAttachments(key);
      if (queuedAttachments.length > 0) {
        userMessage = await this.buildMultimodalMessage(msg.text, queuedAttachments);
        Logger.info(`[${key}] 追加 ${queuedAttachments.length} 个附件`);
      }
    }

    // 并发保护：忙时消息静默入队，空闲后自动处理
    if (session.isBusy()) {
      const queue = this.messageQueue.get(key) ?? [];
      queue.push({ userMessage, topic: msg.topic, senderId: msg.senderId });
      this.messageQueue.set(key, queue);
      Logger.info(`[${key}] 主会话忙，消息已入队 (队列长度: ${queue.length})`);
      return;
    }

    // 构建通道回调，通过 context 传递给工具（替代 bind/unbind）
    const channel = this.buildChannel(msg.topic, {
      sessionKey: key,
      senderId: msg.senderId,
    });

    // 发送 typing 指示，让用户知道 bot 正在处理
    this.sender.sendTyping(msg.topic);

    try {
      const result = await session.handleMessage(userMessage, {
        channel,
        callbacks: {
          onRetry: async (attempt, maxRetries) => {
            try {
              await this.sender.reply(msg.topic, `⚠️ 大模型请求失败，正在重试 (${attempt}/${maxRetries})...`);
            } catch (err: any) {
              Logger.warning(`重试提示发送失败: ${err.message}`);
            }
          },
          onThinking: async (thinking: string) => {
            try {
              await this.sender.sendThinking(msg.topic, thinking);
            } catch (err: any) {
              Logger.warning(`前端通知发送失败 (thinking): ${err.message}`);
            }
          },
          onToolStart: async (toolName: string, toolUseId: string, input: any) => {
            // 跳过输出型工具的 WORKING 消息
            if (toolName === 'send_text' || toolName === 'send_file') {
              return;
            }
            try {
              await this.sender.sendToolUse(msg.topic, toolUseId, toolName, input);
            } catch (err: any) {
              Logger.warning(`前端通知发送失败 (tool_use): ${err.message}`);
            }
          },
          onToolEnd: async (toolName: string, toolUseId: string, result: string) => {
            // 跳过输出型工具的 WORKING 消息
            if (toolName === 'send_text' || toolName === 'send_file') {
              return;
            }
            try {
              let content = result;

              // 清理 execute_shell 的格式化前缀
              if (content.startsWith('命令执行成功:') || content.startsWith('命令执行失败:')) {
                const lines = content.split('\n');
                content = lines.slice(5).join('\n').trim();
              }

              // 清理 read_file 的格式化前缀
              if (content.startsWith('文件:')) {
                const lines = content.split('\n');
                const contentStart = lines.findIndex(line => line.match(/^\s+\d+→/));
                if (contentStart > 0) {
                  content = lines.slice(contentStart).join('\n');
                }
              }

              // 清理 glob 的格式化前缀
              if (content.startsWith('找到') && content.includes('个匹配文件:')) {
                const lines = content.split('\n');
                const listStart = lines.findIndex((line, idx) => idx > 0 && line.match(/^\s+\d+\./));
                if (listStart > 0) {
                  content = lines.slice(listStart).join('\n').trim();
                }
              }

              await this.sender.sendToolResult(msg.topic, toolUseId, content);
            } catch (err: any) {
              Logger.warning(`前端通知发送失败 (tool_result): ${err.message}`);
            }
          },
        },
      });

      // 最终文本回复
      if (result.visibleToUser && result.text) {
        try {
          await this.sender.sendText(msg.topic, result.text);
        } catch (err: any) {
          Logger.warning(`前端通知发送失败 (text): ${err.message}`);
        }
      }
    } finally {
      this.clearPendingAnswerBySession(key);
    }

    // 处理忙时排队的消息
    await this.drainMessageQueue(key);
  }

  /**
   * 从 MessageContext 解析为 ParsedCatsMessage
   */
  private parseMessage(ctx: MessageContext): ParsedCatsMessage | null {
    const text = typeof ctx.text === 'string' ? ctx.text : '';
    const chatType = ctx.isGroup ? 'group' : 'p2p';

    // 检测 rich content 中的文件/图片
    let file: CatsFileInfo | undefined;
    let content = ctx.content;

    // 如果 content 是 JSON 字符串，先解析
    if (typeof content === 'string') {
      try {
        content = JSON.parse(content);
      } catch {
        // 解析失败，保持原样
      }
    }

    if (typeof content === 'object' && content !== null) {
      const rich = content as any;
      if (rich.type === 'file' && rich.payload) {
        file = {
          url: rich.payload.url,
          fileName: rich.payload.name || 'unknown',
          type: 'file',
        };
      } else if (rich.type === 'image' && rich.payload) {
        file = {
          url: rich.payload.url,
          fileName: rich.payload.name || 'image.png',
          type: 'image',
        };
      }
    }

    // 纯文本和文件都为空则忽略
    if (!text && !file) return null;

    return {
      topic: ctx.topic,
      chatType,
      senderId: ctx.senderId,
      seq: 0,  // 简化：不需要seq
      text: text || (file ? `[${file.type === 'image' ? '图片' : '文件'}] ${file.fileName}` : ''),
      rawContent: ctx.content,
      file,
    };
  }

  /**
   * 处理子智能体反馈注入
   */
  private async handleSubAgentFeedback(
    sessionKey: string,
    topic: string,
    senderId: string,
    text: string,
  ): Promise<void> {
    const MAX_RETRIES = 10;
    const RETRY_DELAY_MS = 5000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      }

      const session = this.sessionManager.getOrCreate(sessionKey);

      if (session.isBusy()) {
        Logger.info(`[${sessionKey}] 主会话忙，等待重试注入子智能体反馈 (${attempt + 1}/${MAX_RETRIES + 1})`);
        continue;
      }

      const channel = this.buildChannel(topic, {
        sessionKey,
        senderId,
      });

      try {
        const result = await session.handleMessage(text, { channel });
        if (result.text === BUSY_MESSAGE) {
          Logger.info(`[${sessionKey}] 主会话竞态忙碌，将重试`);
          continue;
        }
        if (result.text.startsWith('处理消息时出错:')) {
          try {
            await this.sender.reply(topic, result.text);
          } catch (err: any) {
            Logger.warning(`错误消息发送失败: ${err.message}`);
          }
        }
        await this.drainMessageQueue(sessionKey);
        return;
      } finally {
        this.clearPendingAnswerBySession(sessionKey);
      }
    }

    Logger.warning(`[${sessionKey}] 子智能体反馈注入失败：主会话持续忙碌`);
  }

  /**
   * 排空消息队列：将忙时积压的消息合并为一条，一次性处理
   */
  private async drainMessageQueue(sessionKey: string): Promise<void> {
    const queue = this.messageQueue.get(sessionKey);
    if (!queue || queue.length === 0) return;

    const msg = queue.shift()!;
    if (queue.length === 0) {
      this.messageQueue.delete(sessionKey);
    }

    const session = this.sessionManager.getOrCreate(sessionKey);
    const channel = this.buildChannel(msg.topic, {
      sessionKey,
      senderId: msg.senderId,
    });

    try {
      const result = await session.handleMessage(msg.userMessage, { channel });
      if (result.text.startsWith('处理消息时出错:')) {
        try {
          await this.sender.reply(msg.topic, result.text);
        } catch (err: any) {
          Logger.warning(`错误消息发送失败: ${err.message}`);
        }
      }
    } finally {
      this.clearPendingAnswerBySession(sessionKey);
    }

    await this.drainMessageQueue(sessionKey);
  }

  /**
   * 停止机器人
   */
  async destroy(): Promise<void> {
    this.bot.disconnect();
    await this.sessionManager.destroy();
    for (const pendingId of Array.from(this.pendingAnswers.keys())) {
      this.clearPendingAnswerById(pendingId);
    }
    this.pendingAnswerBySession.clear();
    this.pendingAttachments.clear();
    this.messageQueue.clear();
    Logger.info('CatsCompany 机器人已停止');
  }

  private enqueuePendingAttachment(sessionKey: string, attachment: PendingAttachment): number {
    const queue = this.pendingAttachments.get(sessionKey) ?? [];
    queue.push(attachment);
    const trimmed = queue.slice(-5);
    this.pendingAttachments.set(sessionKey, trimmed);
    return trimmed.length;
  }

  private consumePendingAttachments(sessionKey: string): PendingAttachment[] {
    const queue = this.pendingAttachments.get(sessionKey) ?? [];
    this.pendingAttachments.delete(sessionKey);
    return queue;
  }

  private async buildMultimodalMessage(text: string, attachments: PendingAttachment[]): Promise<import('../types').ContentBlock[]> {
    const { createImageBlock } = require('../utils/image-utils');
    const blocks: import('../types').ContentBlock[] = [];

    if (text) {
      blocks.push({ type: 'text', text });
    }

    for (const att of attachments) {
      if (att.type === 'image') {
        const imgBlock = await createImageBlock(att.localPath);
        if (imgBlock) {
          blocks.push(imgBlock);
          Logger.info(`[多模态] 已添加图片块: ${att.fileName}, base64长度: ${(imgBlock.source as any)?.data?.length || 0}`);
        } else {
          Logger.warning(`[多模态] 图片块创建失败: ${att.fileName} at ${att.localPath}`);
        }
      } else {
        blocks.push({ type: 'text', text: `[文件] ${att.fileName}\n[路径] ${att.localPath}` });
      }
    }

    Logger.info(`[多模态] 构建完成，共 ${blocks.length} 个块: ${blocks.map(b => b.type).join(', ')}`);
    return blocks;
  }

  private formatAttachmentContext(attachments: PendingAttachment[]): string {
    const lines = attachments.map((attachment, index) => {
      return `[附件${index + 1}] ${attachment.fileName} (${attachment.type})\n[附件路径] ${attachment.localPath}`;
    });
    return `[用户已上传附件]\n${lines.join('\n')}`;
  }

  private buildAttachmentOnlyPrompt(attachments: PendingAttachment[]): string {
    return [
      '[用户仅上传了附件，暂未给出明确任务]',
      '[当前会话是 CatsCompany 聊天：给用户可见的文本请通过 reply 工具发送；发送文件请用 send_file 工具]',
      '请你先判断最合理的下一步，不要默认进入任何特定 skill（例如 paper-analysis）。',
      '如果任务不明确，先提出一个最小澄清问题；如果任务足够明确，再自行执行。',
      this.formatAttachmentContext(attachments),
    ].join('\n');
  }

  private registerPendingAnswer(
    sessionKey: string,
    topic: string,
    expectedSenderId: string,
    resolve: (text: string) => void,
  ): void {
    const existingId = this.pendingAnswerBySession.get(sessionKey);
    if (existingId) {
      const existing = this.pendingAnswers.get(existingId);
      this.clearPendingAnswerById(existingId);
      existing?.resolve('（提问已更新，请回答最新问题）');
    }

    const id = randomUUID();
    const timeoutHandle = setTimeout(() => {
      const pending = this.pendingAnswers.get(id);
      if (!pending) return;
      this.clearPendingAnswerById(id);
      pending.resolve('（用户未在120秒内回复）');
    }, PENDING_ANSWER_TIMEOUT_MS);

    this.pendingAnswers.set(id, {
      id,
      sessionKey,
      topic,
      expectedSenderId,
      resolve,
      timeoutHandle,
    });
    this.pendingAnswerBySession.set(sessionKey, id);
  }

  private clearPendingAnswerBySession(sessionKey: string): void {
    const pendingId = this.pendingAnswerBySession.get(sessionKey);
    if (!pendingId) return;
    this.clearPendingAnswerById(pendingId);
  }

  private clearPendingAnswerById(pendingId: string): void {
    const pending = this.pendingAnswers.get(pendingId);
    if (!pending) return;

    clearTimeout(pending.timeoutHandle);
    this.pendingAnswers.delete(pendingId);

    const mappedId = this.pendingAnswerBySession.get(pending.sessionKey);
    if (mappedId === pendingId) {
      this.pendingAnswerBySession.delete(pending.sessionKey);
    }
  }
}
