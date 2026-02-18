import * as Lark from '@larksuiteoapi/node-sdk';
import { FeishuConfig } from './types';
import { MessageHandler } from './message-handler';
import { MessageSender } from './message-sender';
import { SessionManager } from './session-manager';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { AgentServices, BUSY_MESSAGE } from '../core/agent-session';
import { Logger } from '../utils/logger';
import { SendMessageTool } from '../tools/send-message-tool';
import { SendFileTool } from '../tools/send-file-tool';
import { SubAgentManager } from '../core/sub-agent-manager';
import { BridgeServer, BridgeMessage } from '../bridge/bridge-server';
import { BridgeClient } from '../bridge/bridge-client';

interface PendingAttachment {
  fileName: string;
  localPath: string;
  type: 'file' | 'image';
  receivedAt: number;
}


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
  private sendMessageTool: SendMessageTool;
  private sendFileTool: SendFileTool;
  private bridgeServer: BridgeServer | null = null;
  private bridgeClient: BridgeClient | null = null;
  private bridgeConfig: FeishuConfig['bridge'] | undefined;
  /** 已处理的消息 ID，用于去重 */
  private processedMsgIds = new Set<string>();
  /** 等待用户后续指令的附件队列，key 为 sessionKey */
  private pendingAttachments = new Map<string, PendingAttachment[]>();
  /** 消息合并队列：session 忙时暂存后续消息，处理完后合并为一条 */
  private pendingMessages = new Map<string, { texts: string[]; chatId: string }>();
  private static readonly MAX_PENDING_MESSAGES = 5;

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
    this.sendMessageTool = toolManager.getTool<SendMessageTool>('send_message')!;
    this.sendFileTool = toolManager.getTool<SendFileTool>('send_file')!;

    // 初始化 Bot Bridge
    if (config.bridge) {
      this.bridgeConfig = config.bridge;
      this.bridgeClient = new BridgeClient(config.bridge.peers);
      Logger.info(`Bot Bridge 已配置: peers=${this.bridgeClient.getPeerNames().join(', ')}`);
    }

    Logger.info(`已加载 ${toolManager.getToolCount()} 个工具`);

    const skillManager = new SkillManager();

    // 组装 AgentServices
    this.agentServices = {
      aiService,
      toolManager,
      skillManager,
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

    // 群聊需要 @机器人 才响应
    if (msg.chatType === 'group' && !msg.mentionBot) return;

    // 获取或创建会话
    const session = this.sessionManager.getOrCreate(key);

    // 注册持久化飞书回调到 SubAgentManager（不随 handleMessage 结束而注销）
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
    // 文件/图片消息：交给 Agent 自主判断下一步
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

    // 并发保护：忙时入队，处理完后合并
    if (session.isBusy()) {
      const pending = this.pendingMessages.get(key);
      if (pending && pending.texts.length >= FeishuBot.MAX_PENDING_MESSAGES) {
        await this.sender.reply(msg.chatId, BUSY_MESSAGE);
      } else {
        if (!pending) {
          this.pendingMessages.set(key, { texts: [userText], chatId: msg.chatId });
        } else {
          pending.texts.push(userText);
        }
        await this.sender.reply(msg.chatId, '收到，处理完当前任务后一起回复你。');
        Logger.info(`[${key}] 消息入队 (队列长度: ${this.pendingMessages.get(key)!.texts.length})`);
      }
      return;
    }

    await this.processMessage(key, msg.chatId, userText, session);
  }

  /**
   * 实际处理消息：绑定工具 → 调用 session → 处理队列中的后续消息
   */
  private async processMessage(
    key: string,
    chatId: string,
    userText: string,
    session: ReturnType<SessionManager['getOrCreate']>,
  ): Promise<void> {
    this.sendMessageTool.bindSession(key, chatId, async (_chatId, text) => {
      await this.sender.reply(chatId, text);
    });
    this.sendFileTool.bindSession(key, chatId, (_chatId, filePath, fileName) => this.sender.sendFile(chatId, filePath, fileName));

    try {
      const reply = await session.handleMessage(userText);
      if (reply === BUSY_MESSAGE || reply.startsWith('处理消息时出错:') || reply.startsWith('API 暂时限流')) {
        await this.sender.reply(chatId, reply);
      }
    } finally {
      this.sendMessageTool.unbindSession(key);
      this.sendFileTool.unbindSession(key);
    }

    // 处理合并队列中的后续消息
    const pending = this.pendingMessages.get(key);
    if (pending && pending.texts.length > 0) {
      this.pendingMessages.delete(key);
      const merged = pending.texts.join('\n');
      Logger.info(`[${key}] 合并 ${pending.texts.length} 条等待消息，开始处理`);
      await this.processMessage(key, pending.chatId, merged, session);
    }
  }

  /**
   * 处理子智能体反馈注入
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

      if (session.isBusy()) {
        Logger.info(`[${sessionKey}] 主会话忙，等待重试注入子智能体反馈 (${attempt + 1}/${MAX_RETRIES + 1})`);
        continue;
      }

      this.sendMessageTool.bindSession(sessionKey, chatId, async (_chatId, replyText) => {
        await this.sender.reply(chatId, replyText);
      });
      this.sendFileTool.bindSession(sessionKey, chatId, (_chatId, filePath, fileName) =>
        this.sender.sendFile(chatId, filePath, fileName)
      );

      try {
        const reply = await session.handleMessage(text);
        if (reply === BUSY_MESSAGE) {
          Logger.info(`[${sessionKey}] 主会话竞态忙碌，将重试`);
          continue;
        }
        if (reply.startsWith('处理消息时出错:')) {
          await this.sender.reply(chatId, reply);
        }
        return;
      } finally {
        this.sendMessageTool.unbindSession(sessionKey);
        this.sendFileTool.unbindSession(sessionKey);
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

    this.sendMessageTool.bindSession(sessionKey, msg.chat_id, async (chatId, text) => {
      await this.sender.reply(chatId, text);
    });
    this.sendFileTool.bindSession(sessionKey, msg.chat_id, (chatId, filePath, fileName) =>
      this.sender.sendFile(chatId, filePath, fileName)
    );

    try {
      const userText = `[来自 ${msg.from} 的任务]\n${msg.message}`;
      const reply = await session.handleMessage(userText);
      if (reply.startsWith('处理消息时出错:')) {
        await this.sender.reply(msg.chat_id, reply);
      }
    } finally {
      this.sendMessageTool.unbindSession(sessionKey);
      this.sendFileTool.unbindSession(sessionKey);
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
    this.pendingAttachments.clear();
    this.pendingMessages.clear();
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
      '[当前会话是飞书聊天：给老师可见的文本请通过 send_message 工具发送；发送文件请用 send_file 工具]',
      '请你先判断最合理的下一步，不要默认进入任何特定 skill（例如 paper-analysis）。',
      '如果任务不明确，先提出一个最小澄清问题；如果任务足够明确，再自行执行。',
      this.formatAttachmentContext(attachments),
    ].join('\n');
  }

}
