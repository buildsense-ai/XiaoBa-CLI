import axios from 'axios';
import { WeixinConfig, WeixinMessage } from './types';
import { MessageHandler } from './message-handler';
import { MessageSender } from './message-sender';
import { MessageSessionManager } from '../core/message-session-manager';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { AgentServices } from '../core/agent-session';
import { Logger } from '../utils/logger';
import { ChannelCallbacks } from '../types/tool';
import { promises as fs } from 'fs';
import path from 'path';

const CHANNEL_VERSION = 'xiaoba-weixin/1.0';
const DEFAULT_LONGPOLL_MS = 30000;

export class WeixinBot {
  private handler: MessageHandler;
  private sender: MessageSender;
  private sessionManager: MessageSessionManager;
  private agentServices: AgentServices;
  private contextTokens = new Map<string, string>();
  private isRunning = false;
  private getUpdatesBuf = '';
  private stateDir: string;

  constructor(private config: WeixinConfig) {
    this.handler = new MessageHandler(config.cdnBaseUrl);
    this.sender = new MessageSender(config.token, config.baseUrl, config.cdnBaseUrl);
    this.stateDir = config.stateDir || path.join(process.cwd(), 'data', 'weixin');

    const aiService = new AIService();
    const toolManager = new ToolManager();
    const skillManager = new SkillManager();

    this.agentServices = {
      aiService,
      toolManager,
      skillManager,
    };

    this.sessionManager = new MessageSessionManager(this.agentServices);
    this.setupChannelCallbacks();
    this.loadState();
  }

  private setupChannelCallbacks(): void {
    this.sessionManager.setWakeupSendFn((chatId, text) => {
      const userId = chatId.replace('user:', '');
      const contextToken = this.contextTokens.get(chatId);
      return this.sender.sendText(userId, text, contextToken);
    });
  }

  private async loadState(): Promise<void> {
    try {
      await fs.mkdir(this.stateDir, { recursive: true });
      const bufPath = path.join(this.stateDir, 'get_updates.buf');
      const tokensPath = path.join(this.stateDir, 'context_tokens.json');

      try {
        this.getUpdatesBuf = await fs.readFile(bufPath, 'utf-8');
      } catch {}

      try {
        const data = await fs.readFile(tokensPath, 'utf-8');
        const tokens = JSON.parse(data);
        this.contextTokens = new Map(Object.entries(tokens));
      } catch {}
    } catch (err) {
      Logger.error(`[微信] 加载状态失败: ${err}`);
    }
  }

  private async saveState(): Promise<void> {
    try {
      const bufPath = path.join(this.stateDir, 'get_updates.buf');
      const tokensPath = path.join(this.stateDir, 'context_tokens.json');

      await fs.writeFile(bufPath, this.getUpdatesBuf);
      await fs.writeFile(tokensPath, JSON.stringify(Object.fromEntries(this.contextTokens)));
    } catch (err) {
      Logger.error(`[微信] 保存状态失败: ${err}`);
    }
  }

  private buildChannel(chatId: string, sessionKey: string): ChannelCallbacks {
    return {
      chatId,
      reply: async (cid: string, text: string) => {
        const userId = sessionKey.replace('user:', '');
        const contextToken = this.contextTokens.get(sessionKey);
        await this.sender.sendText(userId, text, contextToken);
      },
      sendFile: async (cid: string, filePath: string, fileName: string) => {
        const userId = sessionKey.replace('user:', '');
        const contextToken = this.contextTokens.get(sessionKey);
        await this.sender.sendFile(userId, filePath, fileName, contextToken);
      },
    };
  }

  async start(): Promise<void> {
    Logger.info('正在启动微信机器人...');
    await this.agentServices.skillManager.loadSkills();
    Logger.info(`已加载 ${this.agentServices.skillManager.getAllSkills().length} 个 skills`);

    this.isRunning = true;
    Logger.success('微信机器人已启动，开始长轮询...');

    this.poll();
  }

  private async poll(): Promise<void> {
    let backoff = 1000;
    const maxBackoff = 30000;

    while (this.isRunning) {
      try {
        const response = await axios.post(
          `${this.config.baseUrl}/ilink/bot/getupdates`,
          {
            get_updates_buf: this.getUpdatesBuf,
            base_info: { channel_version: CHANNEL_VERSION },
          },
          {
            headers: {
              'Authorization': `Bearer ${this.config.token}`,
              'AuthorizationType': 'ilink_bot_token',
              'Content-Type': 'application/json',
            },
            timeout: DEFAULT_LONGPOLL_MS + 5000,
          }
        );

        const { ret, errcode, errmsg, msgs = [], get_updates_buf } = response.data;

        if (errcode === -14) {
          Logger.error('[微信] 会话已过期，请重新登录');
          await new Promise(resolve => setTimeout(resolve, 3600000));
          continue;
        }

        if (get_updates_buf) {
          this.getUpdatesBuf = get_updates_buf;
          await this.saveState();
        }

        if (msgs.length > 0) {
          Logger.info(`[微信] 收到 ${msgs.length} 条消息`);
          for (const msg of msgs) {
            await this.handleMessage(msg);
          }
        }

        backoff = 1000;
      } catch (error: any) {
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') continue;
        Logger.error(`[微信] 轮询错误: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, maxBackoff);
      }
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    if (msg.message_type === 2) return;
    if (msg.message_type !== 0 && msg.message_type !== 1) return;

    const from = msg.from_user_id?.trim();
    if (!from) return;

    const sessionKey = `user:${from}`;
    if (msg.context_token) {
      this.contextTokens.set(sessionKey, msg.context_token);
      await this.saveState();
    }

    const parsed = this.handler.parseMessage(msg);
    if (!parsed || this.handler.shouldIgnoreMessage(parsed)) return;

    const mediaFiles = await this.handler.downloadMedia(parsed);
    const hasMedia = mediaFiles.length > 0;

    Logger.info(`[${sessionKey}] 收到消息: ${parsed.text?.slice(0, 50) || '[媒体消息]'}${hasMedia ? ` +${mediaFiles.length}图` : ''}...`);

    const session = this.sessionManager.getOrCreate(sessionKey, msg.to_user_id);
    const channel = this.buildChannel(msg.to_user_id, sessionKey);

    let userText = parsed.text || '';
    if (hasMedia) {
      const attachmentLines = mediaFiles.map((file, i) =>
        `[图片${i + 1}] ${file.split(/[/\\]/).pop()}\n[图片路径] ${file}`
      );
      const attachmentContext = `[用户已上传图片]\n${attachmentLines.join('\n')}`;
      userText = userText ? `${userText}\n${attachmentContext}` : `[用户仅上传了图片，暂未给出明确任务]\n${attachmentContext}`;
    }

    await session.handleMessage(userText, { channel });
  }

  destroy(): void {
    this.isRunning = false;
    Logger.info('[微信] 机器人已停止');
  }
}
