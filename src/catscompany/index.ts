import { CatsClient, MessageContext } from './client';
import { CatsCompanyConfig, ParsedCatsMessage, CatsFileInfo } from './types';
import { MessageSender } from './message-sender';
import { extractContentBlocks } from './content-blocks';
import { MessageSessionManager } from '../core/message-session-manager';
import { AgentServices, BUSY_MESSAGE, RuntimeFeedbackInput } from '../core/agent-session';
import { Logger } from '../utils/logger';
import { SubAgentManager } from '../core/sub-agent-manager';
import { ChannelCallbacks } from '../types/tool';
import { ContentBlock } from '../types';
import { AdapterRuntimeBundle, createAdapterRuntime } from '../runtime/adapter-runtime';
import { randomUUID } from 'crypto';
import { ConfigManager } from '../utils/config';
import { isPrimaryModelVisionCapable } from '../utils/model-capabilities';

interface PendingAttachment {
  fileName: string;
  localPath: string;
  type: 'file' | 'image';
  receivedAt: number;
}

interface PendingTextMessage {
  msg: ParsedCatsMessage;
  receivedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
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
  userMessage: string | ContentBlock[];
  topic: string;
  senderId: string;
  seq: number;
  receivedAt: number;
  runtimeFeedback?: RuntimeFeedbackInput[];
}

const PENDING_ANSWER_TIMEOUT_MS = 120_000;
const TEXT_ATTACHMENT_COALESCE_MS = Number(process.env.CATSCO_TEXT_ATTACHMENT_COALESCE_MS || 1500);

export function createCatsCompanyRuntime(sessionTTL?: number): AdapterRuntimeBundle {
  return createAdapterRuntime({
    surface: 'catscompany',
    sessionTTL,
    promptSnapshotMode: 'mutable-identity',
  });
}

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
  /** Text can arrive just before the image/file event; hold it briefly so one user turn stays together. */
  private pendingTextMessages = new Map<string, PendingTextMessage>();
  /** 主会话忙时的消息队列，key = sessionKey */
  private messageQueue = new Map<string, QueuedMessage[]>();
  /** Bot 自身的 uid，用于过滤自己发出的消息 */
  private botUid: string | null = null;
  private runtime: AdapterRuntimeBundle;
  private runtimeProfile: AdapterRuntimeBundle['profile'];

  constructor(config: CatsCompanyConfig) {
    this.bot = new CatsClient({
      serverUrl: config.serverUrl,
      apiKey: config.apiKey,
      httpBaseUrl: config.httpBaseUrl,
    });

    this.sender = new MessageSender(this.bot, config.httpBaseUrl, config.apiKey);

    const runtime = createCatsCompanyRuntime(config.sessionTTL);
    this.runtime = runtime;
    this.runtimeProfile = runtime.profile;
    this.agentServices = runtime.services;
    const { toolManager } = this.agentServices;

    Logger.info(`已注册 ${toolManager.getToolCount()} 个基础工具 (message mode)`);
    Logger.info(`运行时可用工具数量将根据 skill toolPolicy 动态过滤`);

    this.sessionManager = new MessageSessionManager(
      this.agentServices,
      'catscompany',
      runtime.sessionManagerOptions,
    );
  }

  /**
   * 启动 WebSocket 连接，开始监听消息
   */
  async start(): Promise<void> {
    Logger.openLogFile('catscompany');
    Logger.info('正在启动 CatsCompany connector...');

    // 加载 skills
    await this.runtime.loadSkills();

    // 注册事件
    this.bot.on('ready', (info: { uid: string; name: string }) => {
      this.botUid = info.uid;
      const botName = info.name.trim() || '(未设置)';
      this.runtimeProfile.displayName = botName;
      this.runtimeProfile.prompt.displayName = botName;
      process.env.CURRENT_AGENT_DISPLAY_NAME = botName;
      Logger.success(`CatsCo agent 已连接，uid=${info.uid}, name=${botName}`);
    });

    this.bot.on('message', async (ctx: MessageContext) => {
      await this.onMessage(ctx);
    });

    this.bot.on('error', (err: Error) => {
      Logger.error(`CatsCo 连接错误: ${err.message}`);
    });

    this.bot.connect();
    Logger.success('CatsCo agent 已启动，等待消息...');
  }

  // ─── 构建 ChannelCallbacks ──────────────────────

  /**
   * 为指定 topic 构建通道回调对象。
   * CatsCo webapp 复用 ChannelCallbacks 接口，chatId 对应 topic。
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
        try {
          await this.sender.sendFile(topic, filePath, fileName);
          _hasOutbound = true;
        } catch (err: any) {
          Logger.warning(`文件发送失败 (sendFile): ${err.message}`);
          throw err;
        }
      },
      sendRuntimePlan: async (_targetTopic, snapshot) => {
        try {
          await this.sender.sendRuntimePlan(topic, snapshot);
        } catch (err: any) {
          Logger.warning(`计划卡片发送失败 (sendRuntimePlan): ${err.message}`);
          throw err;
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
    const coalescedMsg = this.coalesceIncomingMessage(key, msg);
    if (!coalescedMsg) return;

    await this.processParsedMessage(coalescedMsg, key);
  }

  private async processParsedMessage(msg: ParsedCatsMessage, key: string): Promise<void> {
    const session = this.sessionManager.getOrCreate(key);

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
    const runtimeFeedback: RuntimeFeedbackInput[] = [];

    const messageFiles = msg.files && msg.files.length > 0 ? msg.files : (msg.file ? [msg.file] : []);
    if (messageFiles.length > 0) {
      const attachments: PendingAttachment[] = [];
      for (const file of messageFiles) {
        const localPath = await this.sender.downloadFile(file.url, file.fileName);
        if (!localPath) {
          runtimeFeedback.push({
            source: 'catscompany.file_download',
            message: `文件下载失败: ${file.fileName}`,
            actionHint: '请告知用户该附件没有成功读取，并让用户重试上传或改用文字说明。',
          });
          continue;
        }
        attachments.push({
          fileName: file.fileName,
          localPath,
          type: file.type,
          receivedAt: Date.now(),
        });
      }

      if (attachments.length > 0) {
        userMessage = await this.buildMultimodalMessage(msg.text, attachments);
        Logger.info(`[${key}] 原子附件消息（attachments=${attachments.length})`);
      } else {
        userMessage = `[用户上传了 ${messageFiles.length} 个附件，但平台未能下载这些附件]`;
      }
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
      queue.push({
        userMessage,
        topic: msg.topic,
        senderId: msg.senderId,
        seq: msg.seq,
        receivedAt: Date.now(),
        runtimeFeedback,
      });
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
        runtimeFeedback,
        pendingUserInputProvider: () => this.consumeQueuedUserInput(key),
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

  private coalesceIncomingMessage(sessionKey: string, msg: ParsedCatsMessage): ParsedCatsMessage | null {
    const messageFiles = msg.files && msg.files.length > 0 ? msg.files : (msg.file ? [msg.file] : []);
    if (messageFiles.length > 0) {
      const pendingText = this.pendingTextMessages.get(sessionKey);
      if (
        pendingText
        && pendingText.msg.senderId === msg.senderId
        && pendingText.msg.topic === msg.topic
      ) {
        clearTimeout(pendingText.timeoutHandle);
        this.pendingTextMessages.delete(sessionKey);

        const mergedText = pendingText.msg.text.trim() || msg.text;
        Logger.info(
          `[${sessionKey}] 合并延迟文本与随后到达的附件: ${messageFiles.map(file => file.fileName).join(', ')} ` +
          `(wait=${Date.now() - pendingText.receivedAt}ms)`
        );
        return { ...msg, text: mergedText };
      }

      return msg;
    }

    if (!this.shouldDelayTextForAttachment(sessionKey, msg)) {
      return msg;
    }

    this.deferTextForPossibleAttachment(sessionKey, msg);
    return null;
  }

  private shouldDelayTextForAttachment(sessionKey: string, msg: ParsedCatsMessage): boolean {
    if (TEXT_ATTACHMENT_COALESCE_MS <= 0) return false;
    if (!msg.text.trim()) return false;
    if (msg.text.trim().startsWith('/')) return false;
    if ((this.pendingAttachments.get(sessionKey)?.length ?? 0) > 0) return false;
    return true;
  }

  private deferTextForPossibleAttachment(sessionKey: string, msg: ParsedCatsMessage): void {
    const existing = this.pendingTextMessages.get(sessionKey);
    if (existing) {
      clearTimeout(existing.timeoutHandle);
      this.pendingTextMessages.delete(sessionKey);
      void this.processParsedMessage(existing.msg, sessionKey).catch((error: any) => {
        Logger.error(`[${sessionKey}] 处理被新文本顶出的延迟消息失败: ${error.message}`);
      });
    }

    const timeoutHandle = setTimeout(() => {
      const pending = this.pendingTextMessages.get(sessionKey);
      if (!pending || pending.msg !== msg) return;

      this.pendingTextMessages.delete(sessionKey);
      void this.processParsedMessage(msg, sessionKey).catch((error: any) => {
        Logger.error(`[${sessionKey}] 处理延迟文本消息失败: ${error.message}`);
      });
    }, TEXT_ATTACHMENT_COALESCE_MS);

    this.pendingTextMessages.set(sessionKey, {
      msg,
      receivedAt: Date.now(),
      timeoutHandle,
    });

    Logger.info(`[${sessionKey}] 文本消息暂存 ${TEXT_ATTACHMENT_COALESCE_MS}ms，等待可能随后到达的附件`);
  }

  /**
   * 从 MessageContext 解析为 ParsedCatsMessage
   */
  private parseMessage(ctx: MessageContext): ParsedCatsMessage | null {
    const text = typeof ctx.text === 'string' ? ctx.text : '';
    const chatType = ctx.isGroup ? 'group' : 'p2p';

    // 检测 rich content 中的文件/图片
    let file: CatsFileInfo | undefined;
    const files: CatsFileInfo[] = [];
    const blockTextParts: string[] = [];
    let content = ctx.content;
    const seenFileUrls = new Set<string>();
    const appendFile = (candidate: CatsFileInfo) => {
      if (typeof candidate.url !== 'string') return;
      const url = candidate.url.trim();
      if (!url || seenFileUrls.has(url)) return;
      seenFileUrls.add(url);
      const normalized = { ...candidate, url };
      files.push(normalized);
      if (!file) file = normalized;
    };

    if (Array.isArray(ctx.content_blocks)) {
      for (const block of ctx.content_blocks) {
        if (!block || typeof block !== 'object') continue;
        const typedBlock = block as any;
        if (typedBlock.type === 'text' && typeof typedBlock.text === 'string' && typedBlock.text.trim()) {
          blockTextParts.push(typedBlock.text);
          continue;
        }
        if ((typedBlock.type === 'file' || typedBlock.type === 'image') && typedBlock.payload) {
          const payload = typedBlock.payload;
          const url = typeof payload.url === 'string' ? payload.url : '';
          if (!url) continue;
          appendFile({
            url,
            fileName: payload.name || payload.file_name || (typedBlock.type === 'image' ? 'image.png' : 'unknown'),
            type: typedBlock.type === 'image' ? 'image' : 'file',
          });
        }
      }
    }

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
        appendFile({
          url: rich.payload.url,
          fileName: rich.payload.name || 'unknown',
          type: 'file',
        });
      } else if (rich.type === 'image' && rich.payload) {
        appendFile({
          url: rich.payload.url,
          fileName: rich.payload.name || 'image.png',
          type: 'image',
        });
      }
    }

    // content_blocks 里的 text block 是新协议的 canonical 用户文本；
    // 顶层 content 可能只是附件摘要，因此只作为没有 text block 时的 fallback。
    const blockText = blockTextParts.join('\n\n');
    const mergedText = blockText || text;
    if (!mergedText && files.length === 0) return null;

    return {
      topic: ctx.topic,
      chatType,
      senderId: ctx.senderId,
      seq: ctx.seq ?? 0,
      text: mergedText || (files.length > 0 ? files.map(item => `[${item.type === 'image' ? '图片' : '文件'}] ${item.fileName}`).join('\n') : ''),
      rawContent: ctx.content,
      file: files[0],
      files,
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
      const result = await session.handleMessage(msg.userMessage, {
        channel,
        runtimeFeedback: msg.runtimeFeedback,
        pendingUserInputProvider: () => this.consumeQueuedUserInput(sessionKey),
      });
      if (result.text !== BUSY_MESSAGE && result.visibleToUser && result.text) {
        try {
          await this.sender.sendText(msg.topic, result.text);
        } catch (err: any) {
          Logger.warning(`队列消息回复发送失败: ${err.message}`);
        }
      }
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

  private consumeQueuedUserInput(sessionKey: string): string | ContentBlock[] | null {
    const queue = this.messageQueue.get(sessionKey);
    if (!queue || queue.length === 0) return null;

    this.messageQueue.delete(sessionKey);
    const messages = [...queue].sort((a, b) => {
      if (a.seq > 0 && b.seq > 0 && a.seq !== b.seq) return a.seq - b.seq;
      return a.receivedAt - b.receivedAt;
    });

    Logger.info(`[${sessionKey}] 合并 ${messages.length} 条处理期间新到的用户消息`);
    return this.mergeQueuedMessages(messages);
  }

  private mergeQueuedMessages(messages: QueuedMessage[]): string | ContentBlock[] {
    if (messages.length === 1) {
      return messages[0].userMessage;
    }

    const header = [
      `用户在你处理上一轮时又补充了 ${messages.length} 条消息。`,
      '请把这些补充消息作为当前最新需求一起处理；如果前后要求冲突，以最后一条为准。',
    ].join('\n');

    const hasRichContent = messages.some(item => Array.isArray(item.userMessage));
    if (!hasRichContent) {
      const body = messages
        .map((item, index) => `${index + 1}. ${item.senderId}: ${item.userMessage as string}`)
        .join('\n');
      return `${header}\n\n${body}`;
    }

    const blocks: ContentBlock[] = [{ type: 'text', text: `${header}\n` }];
    for (const [index, item] of messages.entries()) {
      blocks.push({
        type: 'text',
        text: `\n[补充消息 ${index + 1} / ${messages.length}，来自 ${item.senderId}]\n`,
      });
      if (Array.isArray(item.userMessage)) {
        blocks.push(...item.userMessage);
      } else {
        blocks.push({ type: 'text', text: item.userMessage });
      }
    }

    return blocks;
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
    for (const pending of this.pendingTextMessages.values()) {
      clearTimeout(pending.timeoutHandle);
    }
    this.pendingTextMessages.clear();
    this.pendingAttachments.clear();
    this.messageQueue.clear();
    Logger.info('CatsCo agent 已停止');
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
    const config = ConfigManager.getConfigReadonly();
    const primaryModelCanSeeImages = isPrimaryModelVisionCapable(config);
    const currentImagePaths: string[] = [];
    const currentFilePaths: string[] = [];

    if (text) {
      blocks.push({ type: 'text', text });
    }

    for (const att of attachments) {
      if (att.type === 'image') {
        if (!primaryModelCanSeeImages) {
          currentImagePaths.push(`[Current image] ${att.fileName}\n[Current image path] ${att.localPath}`);
          continue;
        }

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
    if (currentImagePaths.length > 0) {
      blocks.push({
        type: 'text',
        text: [
          '[Current user turn contains image attachments]',
          'The primary model cannot directly inspect image pixels in this runtime.',
          'If the user request depends on image content, call read_file on the current image path below.',
          'Use only the current image path(s) listed here. Do not use old tmp/downloads paths, old image URLs, old filenames, or prior image descriptions.',
          currentImagePaths.join('\n\n'),
        ].join('\n'),
      });
      Logger.info(`[CatsCo] Primary model is text-only; exposed ${currentImagePaths.length} current image path(s) for read_file`);
    }

    if (currentFilePaths.length > 0) {
      blocks.push({
        type: 'text',
        text: [
          '[Current user turn contains file attachments]',
          'If file content is needed, use only the current file path(s) below. Do not reuse historical attachment paths.',
          currentFilePaths.join('\n\n'),
        ].join('\n'),
      });
    }

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
      '[当前会话是 CatsCo 聊天：给用户可见的文本会自动发送；如需发送文件，使用当前可用的发送文件工具]',
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
