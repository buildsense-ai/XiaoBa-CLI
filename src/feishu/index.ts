import * as Lark from '@larksuiteoapi/node-sdk';
import { FeishuConfig } from './types';
import { MessageHandler } from './message-handler';
import { MessageSender } from './message-sender';
import { SessionManager } from './session-manager';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { AgentServices, BUSY_MESSAGE } from '../core/agent-session';
import { GauzMemService, GauzMemConfig } from '../utils/gauzmem-service';
import { ConfigManager } from '../utils/config';
import { Logger } from '../utils/logger';
import { FeishuReplyTool } from '../tools/feishu-reply-tool';
import { FeishuSendFileTool } from '../tools/feishu-send-file-tool';
import { FeishuMentionTool } from '../tools/feishu-mention-tool';
import { SubAgentManager } from '../core/sub-agent-manager';
import { BridgeServer, GroupMessage } from '../bridge/bridge-server';
import { BridgeClient } from '../bridge/bridge-client';
import { ChimeInJudge } from '../bridge/chime-in-judge';
import { FeishuChannelCallbacks } from '../types/tool';
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
  chatId: string;
  expectedSenderId: string;
  resolve: (text: string) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface QueuedMessage {
  userText: string;
  chatId: string;
  senderId: string;
}

const PENDING_ANSWER_TIMEOUT_MS = 120_000;

/**
 * FeishuBot 主类
 * 初始化 SDK，注册事件，编排消息处理流程
 */
export class FeishuBot {
  private client: Lark.Client;
  private wsClient: Lark.WSClient;
  private handler: MessageHandler;
  private sender: MessageSender;
  private sessionManager: SessionManager;
  private agentServices: AgentServices;
  private bridgeServer: BridgeServer | null = null;
  private bridgeClient: BridgeClient | null = null;
  private bridgeConfig: FeishuConfig['bridge'] | undefined;
  private chimeInJudge: ChimeInJudge | null = null;
  /** 已处理的消息 ID，用于去重 */
  private processedMsgIds = new Set<string>();
  /** key = pendingAnswerId */
  private pendingAnswers = new Map<string, PendingAnswer>();
  /** key = sessionKey, value = pendingAnswerId */
  private pendingAnswerBySession = new Map<string, string>();
  /** 等待用户后续指令的附件队列，key 为 sessionKey */
  private pendingAttachments = new Map<string, PendingAttachment[]>();
  /** 主会话忙时的消息队列，key = sessionKey */
  private messageQueue = new Map<string, QueuedMessage[]>();

  constructor(config: FeishuConfig) {
    const baseConfig = {
      appId: config.appId,
      appSecret: config.appSecret,
    };

    this.client = new Lark.Client(baseConfig);
    this.wsClient = new Lark.WSClient({
      ...baseConfig,
      loggerLevel: Lark.LoggerLevel.info,
    });

    this.handler = new MessageHandler();
    if (config.botOpenId) {
      this.handler.setBotOpenId(config.botOpenId);
      Logger.info(`飞书 @匹配已启用 open_id 精确模式: ${config.botOpenId}`);
    } else {
      const aliases = (config.botAliases && config.botAliases.length > 0)
        ? config.botAliases
        : ['小八', 'xiaoba'];
      this.handler.setMentionAliases(aliases);
      Logger.warning(`未配置 FEISHU_BOT_OPEN_ID，群聊 @ 将使用别名匹配: ${aliases.join(', ')}`);
    }
    this.sender = new MessageSender(this.client);

    const aiService = new AIService();
    const toolManager = new ToolManager();

    // 注册飞书专用工具（新模式下不再需要持有实例引用做 bind/unbind）
    toolManager.registerTool(new FeishuReplyTool());
    toolManager.registerTool(new FeishuSendFileTool());

    const mentionTool = new FeishuMentionTool();
    toolManager.registerTool(mentionTool);

    // 初始化 Bot Bridge（群聊广播模式）
    if (config.bridge) {
      this.bridgeConfig = config.bridge;
      this.bridgeClient = new BridgeClient(config.bridge.peers);
      this.chimeInJudge = new ChimeInJudge(aiService, {
        botName: config.bridge.name,
        botExpertise: process.env.BOT_EXPERTISE || '论文阅读、代码编写、任务执行',
      });
      Logger.info(`Bot Bridge 已配置: peers=${this.bridgeClient.getPeerNames().join(', ')}`);
    }

    Logger.info(`已加载 ${toolManager.getToolCount()} 个工具`);

    const skillManager = new SkillManager();

    // 初始化 GauzMemService
    const appConfig = ConfigManager.getConfig();
    let memoryService: GauzMemService | null = null;
    if (appConfig.memory?.enabled) {
      const memConfig: GauzMemConfig = {
        baseUrl: appConfig.memory.baseUrl || '',
        projectId: appConfig.memory.projectId || 'XiaoBa',
        userId: appConfig.memory.userId || '',
        agentId: appConfig.memory.agentId || 'XiaoBa',
        enabled: true,
      };
      memoryService = new GauzMemService(memConfig);
      Logger.info('飞书记忆系统已启用');
    }

    // 组装 AgentServices
    this.agentServices = {
      aiService,
      toolManager,
      skillManager,
      memoryService,
    };

    this.sessionManager = new SessionManager(
      this.agentServices,
      config.sessionTTL,
    );
  }

  /**
   * 启动 WebSocket 长连接，开始监听消息
   */
  async start(): Promise<void> {
    Logger.openLogFile('feishu');
    Logger.info('正在启动飞书机器人...');

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

    // 启动 Bridge Server（群聊广播模式）
    if (this.bridgeConfig) {
      this.bridgeServer = new BridgeServer(this.bridgeConfig.port);
      this.bridgeServer.onGroupMessage(async (msg) => {
        await this.onGroupBroadcast(msg);
      });
      await this.bridgeServer.start();
    }

    this.wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: any) => {
          await this.onMessage(data);
        },
      }),
    });

    Logger.success('飞书机器人已启动，等待消息...');
  }

  // ─── 构建 FeishuChannelCallbacks ──────────────────────

  /**
   * 为指定 chatId 构建飞书通道回调对象。
   * 传入 handleMessage 的 options.feishuChannel，工具从 context 中读取。
   */
  private buildFeishuChannel(
    chatId: string,
    opts?: {
      /** 提供 senderId 以启用 ask_user_question 的等待回复能力 */
      sessionKey?: string;
      senderId?: string;
      /** 可选的 reply 拦截器（如 bridge 场景需要收集回复文本） */
      replyInterceptor?: (text: string) => void;
    },
  ): FeishuChannelCallbacks {
    const channel: FeishuChannelCallbacks = {
      chatId,
      reply: async (targetChatId: string, text: string) => {
        opts?.replyInterceptor?.(text);
        await this.sender.reply(targetChatId, text);
        // 广播给所有 bridge peer
        if (this.bridgeClient && this.bridgeConfig) {
          this.bridgeClient.broadcast({
            from: this.bridgeConfig.name,
            chat_id: targetChatId,
            content: text,
          });
        }
      },
      sendFile: async (targetChatId: string, filePath: string, fileName: string) => {
        await this.sender.sendFile(targetChatId, filePath, fileName);
      },
    };

    // 如果提供了 sessionKey + senderId，启用 ask_user_question
    if (opts?.sessionKey && opts?.senderId) {
      channel.askUser = {
        send: async (text: string) => {
          await this.sender.reply(chatId, text);
        },
        wait: () => {
          return new Promise<string>((resolve) => {
            this.registerPendingAnswer(opts.sessionKey!, chatId, opts.senderId!, resolve);
          });
        },
      };
    }

    return channel;
  }

  // ─── 消息处理 ─────────────────────────────────────────

  /**
   * 处理收到的消息事件
   */
  private async onMessage(data: any): Promise<void> {
    const msg = this.handler.parse(data);
    if (!msg) return;

    // 消息去重：跳过已处理的 messageId
    if (this.processedMsgIds.has(msg.messageId)) return;
    this.processedMsgIds.add(msg.messageId);

    // 防止 Set 无限增长，超过 1000 条时清理旧记录
    if (this.processedMsgIds.size > 1000) {
      const ids = Array.from(this.processedMsgIds);
      this.processedMsgIds = new Set(ids.slice(-500));
    }

    const key = this.sessionManager.getSessionKey(msg);

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
    const session = this.sessionManager.getOrCreate(key);

    // 注册持久化飞书回调到 SubAgentManager（不随 handleMessage 结束而注销）
    // 这样后台子智能体可以在主会话空闲时继续给用户发消息
    const subAgentManager = SubAgentManager.getInstance();
    subAgentManager.registerFeishuCallbacks(key, {
      reply: async (text: string) => {
        await this.sender.reply(msg.chatId, text);
      },
      sendFile: async (filePath: string, fileName: string) => {
        await this.sender.sendFile(msg.chatId, filePath, fileName);
      },
      injectMessage: async (text: string) => {
        await this.handleSubAgentFeedback(key, msg.chatId, msg.senderId, text);
      },
    });

    // 处理斜杠命令
    if (msg.text.startsWith('/')) {
      const parts = msg.text.slice(1).split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);

      const result = await session.handleCommand(command, args);
      if (result.handled && result.reply) {
        await this.sender.reply(msg.chatId, result.reply);
        Logger.info(`[feishu_command_reply] 已发送: ${result.reply.slice(0, 80)}...`);
      }
      if (result.handled && command.toLowerCase() === 'clear') {
        this.pendingAttachments.delete(key);
      }
      if (result.handled) return;
    }

    Logger.info(`[${key}] 收到消息: ${msg.text.slice(0, 50)}...`);

    let userText = msg.text;
    // 合并转发消息：拉取子消息内容拼接为文本
    if (msg.mergeForwardIds && msg.mergeForwardIds.length > 0) {
      Logger.info(`[${key}] 合并转发消息，拉取 ${msg.mergeForwardIds.length} 条子消息...`);
      const mergedText = await this.sender.fetchMergeForwardTexts(msg.mergeForwardIds);
      userText = `[以下是用户转发的合并消息，共${msg.mergeForwardIds.length}条]\n${mergedText}`;
      Logger.info(`[${key}] 合并转发内容已拼接（${mergedText.length}字符）`);
    } else if (msg.file) {
    // 文件/图片消息：交给 Agent 自主判断下一步，不在平台层强制回复
      const localPath = await this.sender.downloadFile(
        msg.messageId,
        msg.file.fileKey,
        msg.file.fileName,
      );
      if (!localPath) {
        await this.sender.reply(msg.chatId, `文件下载失败：${msg.file.fileName}\n请重试上传。`);
        return;
      }

      this.enqueuePendingAttachment(key, {
        fileName: msg.file.fileName,
        localPath,
        type: msg.file.type,
        receivedAt: Date.now(),
      });
      const queuedAttachments = this.consumePendingAttachments(key);
      userText = this.buildAttachmentOnlyPrompt(queuedAttachments);
      Logger.info(`[${key}] 附件消息已交给 Agent 自主判断（attachments=${queuedAttachments.length})`);
    } else {
      // 普通文本消息：若有待处理附件，拼接上下文后一并交给 Agent
      const queuedAttachments = this.consumePendingAttachments(key);
      if (queuedAttachments.length > 0) {
        userText = `${msg.text}\n${this.formatAttachmentContext(queuedAttachments)}`;
        Logger.info(`[${key}] 追加 ${queuedAttachments.length} 个待处理附件到用户指令`);
      }
    }

    // 并发保护：忙时消息静默入队，空闲后自动处理
    if (session.isBusy()) {
      const queue = this.messageQueue.get(key) ?? [];
      queue.push({ userText, chatId: msg.chatId, senderId: msg.senderId });
      this.messageQueue.set(key, queue);
      Logger.info(`[${key}] 主会话忙，消息已入队 (队列长度: ${queue.length})`);
      return;
    }

    // 构建飞书通道回调，通过 context 传递给工具（替代 bind/unbind）
    const feishuChannel = this.buildFeishuChannel(msg.chatId, {
      sessionKey: key,
      senderId: msg.senderId,
    });

    try {
      const reply = await session.handleMessage(userText, { feishuChannel });
      if (reply === BUSY_MESSAGE || reply.startsWith('处理消息时出错:')) {
        await this.sender.reply(msg.chatId, reply);
      }
    } finally {
      this.clearPendingAnswerBySession(key);
    }

    // 处理忙时排队的消息
    await this.drainMessageQueue(key);
  }

  /**
   * 处理子智能体反馈注入：触发主 agent 新一轮推理。
   * 等待主会话空闲后再注入，避免并发冲突。
   */
  private async handleSubAgentFeedback(
    sessionKey: string,
    chatId: string,
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

      // 等待主会话空闲
      if (session.isBusy()) {
        Logger.info(`[${sessionKey}] 主会话忙，等待重试注入子智能体反馈 (${attempt + 1}/${MAX_RETRIES + 1})`);
        continue;
      }

      const feishuChannel = this.buildFeishuChannel(chatId, {
        sessionKey,
        senderId,
      });

      try {
        const reply = await session.handleMessage(text, { feishuChannel });
        if (reply === BUSY_MESSAGE) {
          Logger.info(`[${sessionKey}] 主会话竞态忙碌，将重试`);
          continue;
        }
        if (reply.startsWith('处理消息时出错:')) {
          await this.sender.reply(chatId, reply);
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
   * 排空消息队列：依次处理忙时积压的用户消息
   */
  private async drainMessageQueue(sessionKey: string): Promise<void> {
    while (true) {
      const queue = this.messageQueue.get(sessionKey);
      if (!queue || queue.length === 0) return;

      const next = queue.shift()!;
      if (queue.length === 0) this.messageQueue.delete(sessionKey);

      const session = this.sessionManager.getOrCreate(sessionKey);
      const feishuChannel = this.buildFeishuChannel(next.chatId, {
        sessionKey,
        senderId: next.senderId,
      });

      try {
        const reply = await session.handleMessage(next.userText, { feishuChannel });
        if (reply.startsWith('处理消息时出错:')) {
          await this.sender.reply(next.chatId, reply);
        }
      } finally {
        this.clearPendingAnswerBySession(sessionKey);
      }
    }
  }

  /**
   * 处理来自其他 bot 的群聊广播消息
   * P0 优化：被@直接触发推理；未被@时用轻量 LLM 判断"该不该插嘴"
   */
  private async onGroupBroadcast(msg: GroupMessage): Promise<void> {
    if (this.bridgeConfig && msg.from === this.bridgeConfig.name) return;

    const sessionKey = `group:${msg.chat_id}`;
    const session = this.sessionManager.getOrCreate(sessionKey);
    const text = `${msg.from}: ${msg.content}`;

    // 记录到 chime-in judge 的上下文（无论是否触发推理）
    this.chimeInJudge?.recordMessage(text);

    // 被@了 → 直接触发推理
    const mentionsMe = this.bridgeConfig && msg.content.includes(this.bridgeConfig.name);

    // 没被@ → 用轻量 LLM 判断该不该主动插嘴
    if (!mentionsMe) {
      session.injectContext(text);

      if (this.chimeInJudge) {
        const shouldChimeIn = await this.chimeInJudge.shouldChimeIn(text);
        if (!shouldChimeIn) {
          Logger.info(`[Bridge] 广播上下文已注入(不插嘴): session=${sessionKey}, from=${msg.from}`);
          return;
        }
        // 判断为"该插嘴"：加随机延迟（1-3秒），降低两个 bot 同时说话的概率
        const beforeDelay = Date.now();
        const delay = 1000 + Math.random() * 2000;
        Logger.info(`[Bridge] 判断应插嘴，延迟 ${Math.round(delay)}ms: session=${sessionKey}`);
        await new Promise(resolve => setTimeout(resolve, delay));
        // 延迟后检查：如果期间有新广播消息（别的 bot 已经回复了），放弃插嘴
        if (this.chimeInJudge.hasNewMessageSince(beforeDelay)) {
          Logger.info(`[Bridge] 延迟期间已有其他 bot 回复，放弃插嘴: session=${sessionKey}`);
          return;
        }
      } else {
        Logger.info(`[Bridge] 广播上下文已注入: session=${sessionKey}, from=${msg.from}`);
        return;
      }
    } else {
      Logger.info(`[Bridge] 广播中被@，触发推理: session=${sessionKey}, from=${msg.from}`);
    }

    if (session.isBusy()) {
      const queue = this.messageQueue.get(sessionKey) ?? [];
      queue.push({ userText: text, chatId: msg.chat_id, senderId: '' });
      this.messageQueue.set(sessionKey, queue);
      return;
    }
    const feishuChannel = this.buildFeishuChannel(msg.chat_id);
    try {
      await session.handleMessage(text, { feishuChannel });
    } finally {
      this.clearPendingAnswerBySession(sessionKey);
    }
    await this.drainMessageQueue(sessionKey);
  }

  /**
   * 停止机器人
   */
  destroy(): void {
    if (this.bridgeServer) {
      this.bridgeServer.stop();
    }
    this.sessionManager.destroy();
    for (const pendingId of Array.from(this.pendingAnswers.keys())) {
      this.clearPendingAnswerById(pendingId);
    }
    this.pendingAnswerBySession.clear();
    this.pendingAttachments.clear();
    this.messageQueue.clear();
    Logger.info('飞书机器人已停止');
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

  private formatAttachmentContext(attachments: PendingAttachment[]): string {
    const lines = attachments.map((attachment, index) => {
      return `[附件${index + 1}] ${attachment.fileName} (${attachment.type})\n[附件路径] ${attachment.localPath}`;
    });

    return `[用户已上传附件]\n${lines.join('\n')}`;
  }

  private buildAttachmentOnlyPrompt(attachments: PendingAttachment[]): string {
    return [
      '[用户仅上传了附件，暂未给出明确任务]',
      '[当前会话是飞书聊天：给老师可见的文本请通过 feishu_reply 工具发送；发送文件请用 feishu_send_file 工具]',
      '请你先判断最合理的下一步，不要默认进入任何特定 skill（例如 paper-analysis）。',
      '如果任务不明确，先提出一个最小澄清问题；如果任务足够明确，再自行执行。',
      this.formatAttachmentContext(attachments),
    ].join('\n');
  }

  private registerPendingAnswer(
    sessionKey: string,
    chatId: string,
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
      chatId,
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
