import { CatsBot, MessageContext } from '@catscompany/bot-sdk';
import { CatsCompanyConfig, ParsedCatsMessage, CatsFileInfo } from './types';
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
import { AskUserQuestionTool } from '../tools/ask-user-question-tool';
import { SubAgentManager } from '../core/sub-agent-manager';
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

const PENDING_ANSWER_TIMEOUT_MS = 120_000;

/**
 * CatsCompanyBot 主类
 * 初始化 SDK，注册事件，编排消息处理流程
 * 结构与 FeishuBot 对齐
 */
export class CatsCompanyBot {
  private bot: CatsBot;
  private sender: MessageSender;
  private sessionManager: SessionManager;
  private agentServices: AgentServices;
  private replyTool: FeishuReplyTool;
  private sendFileTool: FeishuSendFileTool;
  private askUserQuestionTool: AskUserQuestionTool | null = null;
  /** key = pendingAnswerId */
  private pendingAnswers = new Map<string, PendingAnswer>();
  /** key = sessionKey, value = pendingAnswerId */
  private pendingAnswerBySession = new Map<string, string>();
  /** 等待用户后续指令的附件队列，key 为 sessionKey */
  private pendingAttachments = new Map<string, PendingAttachment[]>();

  constructor(config: CatsCompanyConfig) {
    this.bot = new CatsBot({
      serverUrl: config.serverUrl,
      apiKey: config.apiKey,
      httpBaseUrl: config.httpBaseUrl,
    });

    this.sender = new MessageSender(this.bot);

    const aiService = new AIService();
    const toolManager = new ToolManager();
    this.replyTool = new FeishuReplyTool();
    this.sendFileTool = new FeishuSendFileTool();
    toolManager.registerTool(this.replyTool);
    toolManager.registerTool(this.sendFileTool);
    this.askUserQuestionTool = toolManager.getTool<AskUserQuestionTool>('ask_user_question') ?? null;
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
      Logger.info('CatsCompany 记忆系统已启用');
    }

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
    this.bot.on('ready', (uid) => {
      Logger.success(`CatsCompany 机器人已连接，uid=${uid}`);
    });

    this.bot.on('message', async (ctx: MessageContext) => {
      await this.onMessage(ctx);
    });

    this.bot.on('reconnecting', (attempt) => {
      Logger.warning(`CatsCompany 正在重连 (第 ${attempt} 次)...`);
    });

    this.bot.on('error', (err) => {
      Logger.error(`CatsCompany 连接错误: ${err.message}`);
    });

    await this.bot.connect();
    Logger.success('CatsCompany 机器人已启动，等待消息...');
  }

  /**
   * 处理收到的消息
   */
  private async onMessage(ctx: MessageContext): Promise<void> {
    const msg = this.parseMessage(ctx);
    if (!msg) return;

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

    // 注册持久化回调到 SubAgentManager
    const subAgentManager = SubAgentManager.getInstance();
    subAgentManager.registerFeishuCallbacks(key, {
      reply: async (text: string) => {
        await this.sender.reply(msg.topic, text);
      },
      sendFile: async (filePath: string, fileName: string) => {
        await this.sender.sendFile(msg.topic, filePath, fileName);
      },
      injectMessage: async (text: string) => {
        await this.handleSubAgentFeedback(key, msg.topic, msg.senderId, text);
      },
    });

    // 处理斜杠命令
    if (msg.text.startsWith('/')) {
      const parts = msg.text.slice(1).split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);

      const result = await session.handleCommand(command, args);
      if (result.handled && result.reply) {
        await this.sender.reply(msg.topic, result.reply);
      }
      if (result.handled && command.toLowerCase() === 'clear') {
        this.pendingAttachments.delete(key);
      }
      if (result.handled) return;
    }

    Logger.info(`[${key}] 收到消息: ${msg.text.slice(0, 50)}...`);

    let userText = msg.text;

    if (msg.file) {
      // 文件/图片消息：下载后交给 Agent 自主判断
      const localPath = await this.sender.downloadFile(msg.file.url, msg.file.fileName);
      if (!localPath) {
        await this.sender.reply(msg.topic, `文件下载失败：${msg.file.fileName}\n请重试上传。`);
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

    // 并发保护
    if (session.isBusy()) {
      await this.sender.reply(msg.topic, BUSY_MESSAGE);
      return;
    }

    // 绑定工具到当前会话
    this.replyTool.bindSession(key, msg.topic, async (_topic, text) => {
      await this.sender.reply(msg.topic, text);
    });
    this.sendFileTool.bindSession(key, msg.topic, (_topic, filePath, fileName) =>
      this.sender.sendFile(msg.topic, filePath, fileName)
    );

    // 绑定 AskUserQuestion
    if (this.askUserQuestionTool) {
      const topic = msg.topic;
      this.askUserQuestionTool.bindFeishuSession(
        key,
        async (text: string) => {
          await this.sender.reply(topic, text);
        },
        () => {
          return new Promise<string>((resolve) => {
            this.registerPendingAnswer(key, topic, msg.senderId, resolve);
          });
        },
      );
    }

    try {
      const reply = await session.handleMessage(userText);
      if (reply === BUSY_MESSAGE || reply.startsWith('处理消息时出错:')) {
        await this.sender.reply(msg.topic, reply);
      }
    } finally {
      this.replyTool.unbindSession(key);
      this.sendFileTool.unbindSession(key);
      if (this.askUserQuestionTool) {
        this.askUserQuestionTool.unbindFeishuSession(key);
      }
      this.clearPendingAnswerBySession(key);
    }
  }

  /**
   * 从 MessageContext 解析为 ParsedCatsMessage
   */
  private parseMessage(ctx: MessageContext): ParsedCatsMessage | null {
    const text = ctx.text;
    const chatType = ctx.isGroup ? 'group' : 'p2p';

    // 检测 rich content 中的文件/图片
    let file: CatsFileInfo | undefined;
    if (typeof ctx.content === 'object' && ctx.content !== null) {
      const rich = ctx.content as any;
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
      senderId: ctx.from,
      seq: ctx.seq,
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

      this.replyTool.bindSession(sessionKey, topic, async (_topic, replyText) => {
        await this.sender.reply(topic, replyText);
      });
      this.sendFileTool.bindSession(sessionKey, topic, (_topic, filePath, fileName) =>
        this.sender.sendFile(topic, filePath, fileName)
      );
      if (this.askUserQuestionTool) {
        this.askUserQuestionTool.bindFeishuSession(
          sessionKey,
          async (question: string) => {
            await this.sender.reply(topic, question);
          },
          () => new Promise<string>((resolve) => {
            this.registerPendingAnswer(sessionKey, topic, senderId, resolve);
          }),
        );
      }

      try {
        const reply = await session.handleMessage(text);
        if (reply === BUSY_MESSAGE) {
          Logger.info(`[${sessionKey}] 主会话竞态忙碌，将重试`);
          continue;
        }
        if (reply.startsWith('处理消息时出错:')) {
          await this.sender.reply(topic, reply);
        }
        return;
      } finally {
        this.replyTool.unbindSession(sessionKey);
        this.sendFileTool.unbindSession(sessionKey);
        if (this.askUserQuestionTool) {
          this.askUserQuestionTool.unbindFeishuSession(sessionKey);
        }
        this.clearPendingAnswerBySession(sessionKey);
      }
    }

    Logger.warning(`[${sessionKey}] 子智能体反馈注入失败：主会话持续忙碌`);
  }

  /**
   * 停止机器人
   */
  destroy(): void {
    this.bot.disconnect();
    this.sessionManager.destroy();
    for (const pendingId of Array.from(this.pendingAnswers.keys())) {
      this.clearPendingAnswerById(pendingId);
    }
    this.pendingAnswerBySession.clear();
    this.pendingAttachments.clear();
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

  private formatAttachmentContext(attachments: PendingAttachment[]): string {
    const lines = attachments.map((attachment, index) => {
      return `[附件${index + 1}] ${attachment.fileName} (${attachment.type})\n[附件路径] ${attachment.localPath}`;
    });
    return `[用户已上传附件]\n${lines.join('\n')}`;
  }

  private buildAttachmentOnlyPrompt(attachments: PendingAttachment[]): string {
    return [
      '[用户仅上传了附件，暂未给出明确任务]',
      '[当前会话是 CatsCompany 聊天：给用户可见的文本请通过 feishu_reply 工具发送；发送文件请用 feishu_send_file 工具]',
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
