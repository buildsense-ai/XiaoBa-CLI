import * as Lark from '@larksuiteoapi/node-sdk';
import { FeishuConfig } from './types';
import { MessageHandler } from './message-handler';
import { MessageSender } from './message-sender';
import { SessionManager } from './session-manager';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { AgentServices } from '../core/agent-session';
import { GauzMemService, GauzMemConfig } from '../utils/gauzmem-service';
import { ConfigManager } from '../utils/config';
import { Logger } from '../utils/logger';
import { FeishuReplyTool } from '../tools/feishu-reply-tool';
import { FeishuSendFileTool } from '../tools/feishu-send-file-tool';
import { AskUserQuestionTool } from '../tools/ask-user-question-tool';

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
  private askUserQuestionTool: AskUserQuestionTool | null = null;
  /** 已处理的消息 ID，用于去重 */
  private processedMsgIds = new Set<string>();
  /** 等待用户回答的 pending Promise，key 为 chatId */
  private pendingAnswers = new Map<string, { resolve: (text: string) => void }>();

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
    this.sender = new MessageSender(this.client);

    const aiService = new AIService();
    const toolManager = new ToolManager();
    this.feishuReplyTool = new FeishuReplyTool();
    this.feishuSendFileTool = new FeishuSendFileTool();
    toolManager.registerTool(this.feishuReplyTool);
    toolManager.registerTool(this.feishuSendFileTool);
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

    // 群聊需要 @机器人 才响应
    if (msg.chatType === 'group' && !msg.mentionBot) return;

    // ── 拦截：如果当前 chatId 有等待回答的问题，直接 resolve 并返回 ──
    const pending = this.pendingAnswers.get(msg.chatId);
    if (pending) {
      this.pendingAnswers.delete(msg.chatId);
      Logger.info(`[${msg.chatId}] 收到用户对提问的回复: ${msg.text.slice(0, 50)}...`);
      pending.resolve(msg.text);
      return;
    }

    // 获取或创建会话
    const key = this.sessionManager.getSessionKey(msg);
    const session = this.sessionManager.getOrCreate(key);

    // 处理斜杠命令
    if (msg.text.startsWith('/')) {
      const parts = msg.text.slice(1).split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);

      const result = await session.handleCommand(command, args);
      if (result.handled && result.reply) {
        await this.sender.reply(msg.chatId, result.reply);
      }
      if (result.handled) return;
    }

    Logger.info(`[${key}] 收到消息: ${msg.text.slice(0, 50)}...`);

    // 如果是文件/图片消息，先下载到本地
    let userText = msg.text;
    if (msg.file) {
      const localPath = await this.sender.downloadFile(
        msg.messageId,
        msg.file.fileKey,
        msg.file.fileName,
      );
      if (localPath) {
        userText = `${msg.text}\n[文件已下载到: ${localPath}]`;
      } else {
        userText = `${msg.text}\n[文件下载失败]`;
      }
    }

    // 绑定飞书工具到当前会话
    this.feishuReplyTool.bind(msg.chatId, (chatId, text) => this.sender.reply(chatId, text));
    this.feishuSendFileTool.bind(msg.chatId, (chatId, filePath, fileName) => this.sender.sendFile(chatId, filePath, fileName));

    // 绑定 AskUserQuestion 飞书模式
    if (this.askUserQuestionTool) {
      const chatId = msg.chatId;
      this.askUserQuestionTool.bindFeishu(
        // sendFn: 把问题发送给飞书用户
        async (text: string) => {
          await this.sender.reply(chatId, text);
        },
        // waitFn: 等待飞书用户的下一条回复
        () => {
          return new Promise<string>((resolve) => {
            this.pendingAnswers.set(chatId, { resolve });
          });
        },
      );
    }

    try {
      // AI 处理（静默，不传进度回调）
      const reply = await session.handleMessage(userText);

      // 发送最终文本回复
      await this.sender.reply(msg.chatId, reply);
    } finally {
      this.feishuReplyTool.unbind();
      this.feishuSendFileTool.unbind();
      if (this.askUserQuestionTool) {
        this.askUserQuestionTool.unbindFeishu();
      }
      // 清理可能残留的 pending（如超时或异常中断）
      this.pendingAnswers.delete(msg.chatId);
    }
  }

  /**
   * 停止机器人
   */
  destroy(): void {
    this.sessionManager.destroy();
    Logger.info('飞书机器人已停止');
  }
}
