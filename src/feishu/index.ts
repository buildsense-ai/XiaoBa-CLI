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
import { AskUserQuestionTool } from '../tools/ask-user-question-tool';
import { SubAgentManager } from '../core/sub-agent-manager';
import { BridgeServer, BridgeMessage } from '../bridge/bridge-server';
import { BridgeClient } from '../bridge/bridge-client';
import { SendToBotTool } from '../tools/send-to-bot-tool';
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
  private feishuReplyTool: FeishuReplyTool;
  private feishuSendFileTool: FeishuSendFileTool;
  private feishuMentionTool: FeishuMentionTool;
  private askUserQuestionTool: AskUserQuestionTool | null = null;
  private bridgeServer: BridgeServer | null = null;
  private bridgeClient: BridgeClient | null = null;
  private bridgeConfig: FeishuConfig['bridge'] | undefined;
  /** 已处理的消息 ID，用于去重 */
  private processedMsgIds = new Set<string>();
  /** key = pendingAnswerId */
  private pendingAnswers = new Map<string, PendingAnswer>();
  /** key = sessionKey, value = pendingAnswerId */
  private pendingAnswerBySession = new Map<string, string>();
  /** 等待用户后续指令的附件队列，key 为 sessionKey */
  private pendingAttachments = new Map<string, PendingAttachment[]>();

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
    this.feishuReplyTool = new FeishuReplyTool();
    this.feishuSendFileTool = new FeishuSendFileTool();
    this.feishuMentionTool = new FeishuMentionTool();
    toolManager.registerTool(this.feishuReplyTool);
    toolManager.registerTool(this.feishuSendFileTool);
    toolManager.registerTool(this.feishuMentionTool);
    this.askUserQuestionTool = toolManager.getTool<AskUserQuestionTool>('ask_user_question') ?? null;

    // 初始化 Bot Bridge
    if (config.bridge) {
      this.bridgeConfig = config.bridge;
      this.bridgeClient = new BridgeClient(config.bridge.peers);
      const sendToBotTool = new SendToBotTool(this.bridgeClient, config.bridge.name);
      toolManager.registerTool(sendToBotTool);
      Logger.info(`Bot Bridge 已配置: peers=${this.bridgeClient.getPeerNames().join(', ')}`);
    }

    Logger.info(`已加载 ${toolManager.getToolCount()} 个工具`);

    const skillManager = new SkillManager();

    // 初始化 GauzMemService
    const appConfig = ConfigManager.getConfig();
    let memoryService: GauzMemService | null = null;
    if (appConfig.memory?.enabled) {
      const memConfig: GauzMemConfig = {
        baseUrl: appConfig.memory.baseUrl || 'http://43.139.19.144:1235',
        projectId: appConfig.memory.projectId || 'XiaoBa',
        userId: appConfig.memory.userId || 'guowei',
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

    // 启动 Bridge Server
    if (this.bridgeConfig) {
      this.bridgeServer = new BridgeServer(this.bridgeConfig.port);
      this.bridgeServer.onMessage(async (msg) => {
        await this.onBridgeMessage(msg);
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

    // 群聊需要 @机器人 才响应
    if (msg.chatType === 'group' && !msg.mentionBot) return;

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
    // 文件/图片消息：交给 Agent 自主判断下一步，不在平台层强制回复
    if (msg.file) {
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

    // 并发保护：如果会话正忙，直接回复 BUSY_MESSAGE，不碰工具绑定
    // 避免重复消息的 onMessage 覆盖并解绑正在使用的工具
    if (session.isBusy()) {
      await this.sender.reply(msg.chatId, BUSY_MESSAGE);
      return;
    }

    // 绑定飞书工具到当前会话（按 sessionKey 隔离，避免并发串话）
    this.feishuReplyTool.bindSession(key, msg.chatId, async (chatId, text) => {
      await this.sender.reply(chatId, text);
    });
    this.feishuSendFileTool.bindSession(key, msg.chatId, (chatId, filePath, fileName) => this.sender.sendFile(chatId, filePath, fileName));
    this.feishuMentionTool.bindSession(key, msg.chatId, async (chatId, text) => {
      await this.sender.reply(chatId, text);
    });

    // 绑定 AskUserQuestion 飞书模式
    if (this.askUserQuestionTool) {
      const chatId = msg.chatId;
      this.askUserQuestionTool.bindFeishuSession(
        key,
        // sendFn: 把问题发送给飞书用户
        async (text: string) => {
          await this.sender.reply(chatId, text);
        },
        // waitFn: 等待飞书用户的下一条回复
        () => {
          return new Promise<string>((resolve) => {
            this.registerPendingAnswer(key, chatId, msg.senderId, resolve);
          });
        },
      );
    }

    try {
      // 严格 tool-only：平台层不再自动发送最终文本，所有可见消息必须由 feishu_reply/feishu_send_file 工具发出
      const reply = await session.handleMessage(userText);
      if (reply === BUSY_MESSAGE || reply.startsWith('处理消息时出错:')) {
        await this.sender.reply(msg.chatId, reply);
      }
    } finally {
      this.feishuReplyTool.unbindSession(key);
      this.feishuSendFileTool.unbindSession(key);
      this.feishuMentionTool.unbindSession(key);
      if (this.askUserQuestionTool) {
        this.askUserQuestionTool.unbindFeishuSession(key);
      }
      // 清理可能残留的 pending（如超时或异常中断）
      this.clearPendingAnswerBySession(key);
    }
  }

  /**
   * 处理子智能体反馈注入：绑定飞书工具，触发主 agent 新一轮推理。
   * 等待主会话空闲后再注入，避免覆盖正在使用的工具绑定。
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

      // 等待主会话空闲，避免覆盖正在使用的工具绑定
      if (session.isBusy()) {
        Logger.info(`[${sessionKey}] 主会话忙，等待重试注入子智能体反馈 (${attempt + 1}/${MAX_RETRIES + 1})`);
        continue;
      }

      // 主会话空闲，绑定飞书工具
      this.feishuReplyTool.bindSession(sessionKey, chatId, async (_chatId, replyText) => {
        await this.sender.reply(chatId, replyText);
      });
      this.feishuSendFileTool.bindSession(sessionKey, chatId, (_chatId, filePath, fileName) =>
        this.sender.sendFile(chatId, filePath, fileName)
      );
      this.feishuMentionTool.bindSession(sessionKey, chatId, async (_chatId, replyText) => {
        await this.sender.reply(chatId, replyText);
      });
      if (this.askUserQuestionTool) {
        this.askUserQuestionTool.bindFeishuSession(
          sessionKey,
          async (question: string) => {
            await this.sender.reply(chatId, question);
          },
          () => new Promise<string>((resolve) => {
            this.registerPendingAnswer(sessionKey, chatId, senderId, resolve);
          }),
        );
      }

      try {
        const reply = await session.handleMessage(text);
        if (reply === BUSY_MESSAGE) {
          // isBusy() 与 handleMessage() 之间无 await，此分支理论上不会触发
          Logger.info(`[${sessionKey}] 主会话竞态忙碌，将重试`);
          continue;
        }
        if (reply.startsWith('处理消息时出错:')) {
          await this.sender.reply(chatId, reply);
        }
        return;
      } finally {
        this.feishuReplyTool.unbindSession(sessionKey);
        this.feishuSendFileTool.unbindSession(sessionKey);
        this.feishuMentionTool.unbindSession(sessionKey);
        if (this.askUserQuestionTool) {
          this.askUserQuestionTool.unbindFeishuSession(sessionKey);
        }
        this.clearPendingAnswerBySession(sessionKey);
      }
    }

    Logger.warning(`[${sessionKey}] 子智能体反馈注入失败：主会话持续忙碌`);
  }

  /**
   * 处理来自其他 bot 的 Bridge 消息
   */
  private async onBridgeMessage(msg: BridgeMessage): Promise<void> {
    const sessionKey = `bridge:${msg.chat_id}`;
    const session = this.sessionManager.getOrCreate(sessionKey);

    if (session.isBusy()) {
      Logger.warning(`[Bridge] 会话 ${sessionKey} 忙碌，跳过来自 ${msg.from} 的任务`);
      return;
    }

    this.feishuReplyTool.bindSession(sessionKey, msg.chat_id, async (chatId, text) => {
      await this.sender.reply(chatId, text);
    });
    this.feishuSendFileTool.bindSession(sessionKey, msg.chat_id, (chatId, filePath, fileName) =>
      this.sender.sendFile(chatId, filePath, fileName)
    );
    this.feishuMentionTool.bindSession(sessionKey, msg.chat_id, async (chatId, text) => {
      await this.sender.reply(chatId, text);
    });

    try {
      const userText = `[来自 ${msg.from} 的任务]\n${msg.message}`;
      const reply = await session.handleMessage(userText);
      if (reply.startsWith('处理消息时出错:')) {
        await this.sender.reply(msg.chat_id, reply);
      }
    } finally {
      this.feishuReplyTool.unbindSession(sessionKey);
      this.feishuSendFileTool.unbindSession(sessionKey);
      this.feishuMentionTool.unbindSession(sessionKey);
    }
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
