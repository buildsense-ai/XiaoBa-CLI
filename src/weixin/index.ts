import axios from 'axios';
import { WeixinConfig, WeixinMessage } from './types';
import { MessageHandler } from './message-handler';
import { MessageSender } from './message-sender';
import { MessageSessionManager } from '../core/message-session-manager';
import { AgentServices, BUSY_MESSAGE, ERROR_MESSAGE, RuntimeFeedbackInput } from '../core/agent-session';
import { SubAgentManager } from '../core/sub-agent-manager';
import { Logger } from '../utils/logger';
import { ChannelCallbacks } from '../types/tool';
import { AdapterRuntimeBundle, createAdapterRuntime } from '../runtime/adapter-runtime';
import { promises as fs } from 'fs';
import path from 'path';

const CHANNEL_VERSION = 'xiaoba-weixin/1.0';
const DEFAULT_LONGPOLL_MS = 30000;

interface QueuedWeixinMessage {
  userText: string;
  chatId: string;
  runtimeFeedback?: RuntimeFeedbackInput[];
  source?: 'user' | 'subagent_feedback';
}

export function createWeixinRuntime(): AdapterRuntimeBundle {
  return createAdapterRuntime({
    surface: 'weixin',
    promptSnapshotMode: 'fixed',
    skillLoadMode: 'fail-fast',
  });
}

export class WeixinBot {
  private handler: MessageHandler;
  private sender: MessageSender;
  private sessionManager: MessageSessionManager;
  private agentServices: AgentServices;
  private runtime: AdapterRuntimeBundle;
  private contextTokens = new Map<string, string>();
  private messageQueue = new Map<string, QueuedWeixinMessage[]>();
  private isRunning = false;
  private getUpdatesBuf = '';
  private stateDir: string;

  constructor(private config: WeixinConfig) {
    this.handler = new MessageHandler(config.cdnBaseUrl);
    this.sender = new MessageSender(config.token, config.baseUrl, config.cdnBaseUrl);
    this.stateDir = config.stateDir || path.join(process.cwd(), 'data', 'weixin');

    const runtime = createWeixinRuntime();
    this.runtime = runtime;
    this.agentServices = runtime.services;

    this.sessionManager = new MessageSessionManager(
      this.agentServices,
      'weixin',
      runtime.sessionManagerOptions,
    );
    this.loadState();
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
    Logger.openLogFile('weixin');
    Logger.info('正在启动微信机器人...');
    await this.runtime.loadSkills();

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

    const session = this.sessionManager.getOrCreate(sessionKey);
    this.registerSubAgentCallbacks(sessionKey, msg.to_user_id || from);
    const channel = this.buildChannel(msg.to_user_id, sessionKey);
    const expectedMediaCount = (parsed.item_list || []).filter(item =>
      (item.type === 2 && item.image_item?.media)
      || (item.type === 4 && item.file_item?.media)
    ).length;
    const mediaFiles = await this.handler.downloadMedia(parsed);
    const hasMedia = mediaFiles.length > 0;
    const runtimeFeedback: RuntimeFeedbackInput[] = [];
    if (expectedMediaCount > mediaFiles.length) {
      runtimeFeedback.push({
        source: 'weixin.media_download',
        message: `媒体下载不完整: expected=${expectedMediaCount}, downloaded=${mediaFiles.length}`,
        actionHint: '请基于已下载附件继续处理；如果关键附件缺失，请告知用户重新发送。',
      });
    }

    const mediaDesc = hasMedia
      ? ` +${mediaFiles.filter(f => /\.(jpg|jpeg|png|gif)$/i.test(f)).length}图 +${mediaFiles.filter(f => !/\.(jpg|jpeg|png|gif)$/i.test(f)).length}文件`
      : '';

    Logger.info(`[${sessionKey}] 收到消息: ${parsed.text?.slice(0, 50) || '[媒体消息]'}${mediaDesc}...`);

    let userText = parsed.text || '';
    if (hasMedia) {
      const attachmentLines = mediaFiles.map((file, i) => {
        const fileName = file.split(/[/\\]/).pop();
        const isImage = /\.(jpg|jpeg|png|gif)$/i.test(file);
        return `[${isImage ? '图片' : '文件'}${i + 1}] ${fileName}\n[路径] ${file}`;
      });
      const attachmentContext = `[用户已上传${mediaFiles.length}个附件]\n${attachmentLines.join('\n')}`;
      userText = userText ? `${userText}\n${attachmentContext}` : `[用户仅上传了附件，暂未给出明确任务]\n${attachmentContext}`;
    } else if (!userText && expectedMediaCount > 0) {
      userText = '[用户发送了媒体消息，但平台未能下载附件]';
    }

    await session.handleMessage(userText, { channel, runtimeFeedback });
    await this.drainMessageQueue(sessionKey);
  }

  destroy(): void {
    this.isRunning = false;
    this.messageQueue.clear();
    Logger.info('[微信] 机器人已停止');
  }

  private registerSubAgentCallbacks(sessionKey: string, chatId: string): void {
    SubAgentManager.getInstance().registerPlatformCallbacks(sessionKey, {
      injectMessage: async (text: string) => {
        await this.handleSubAgentFeedback(sessionKey, chatId, text);
      },
    });
  }

  private async handleSubAgentFeedback(
    sessionKey: string,
    chatId: string,
    text: string,
  ): Promise<void> {
    const session = this.sessionManager.getOrCreate(sessionKey);
    if (session.isBusy()) {
      this.enqueueMessage(sessionKey, {
        userText: text,
        chatId,
        source: 'subagent_feedback',
      });
      Logger.info(`[${sessionKey}] 主会话忙，子智能体反馈已入队 (队列长度: ${this.messageQueue.get(sessionKey)?.length || 0})`);
      return;
    }

    const channel = this.buildChannel(chatId, sessionKey);
    const result = await session.handleRuntimeObservation(text, { channel, source: 'subagent_result' });
    if (result.text === BUSY_MESSAGE) {
      this.enqueueMessage(sessionKey, {
        userText: text,
        chatId,
        source: 'subagent_feedback',
      });
      Logger.info(`[${sessionKey}] 主会话竞态忙碌，子智能体反馈已入队`);
      return;
    }
    if (result.text === ERROR_MESSAGE) {
      await channel.reply(chatId, result.text);
    }
    await this.drainMessageQueue(sessionKey);
  }

  private enqueueMessage(sessionKey: string, message: QueuedWeixinMessage): void {
    const queue = this.messageQueue.get(sessionKey) ?? [];
    queue.push(message);
    this.messageQueue.set(sessionKey, queue);
  }

  private async drainMessageQueue(sessionKey: string): Promise<void> {
    const queue = this.messageQueue.get(sessionKey);
    if (!queue || queue.length === 0) return;

    const session = this.sessionManager.getOrCreate(sessionKey);
    if (session.isBusy()) {
      Logger.info(`[${sessionKey}] 主会话仍忙，暂缓排空微信队列 (队列长度: ${queue.length})`);
      return;
    }

    const messages = queue.splice(0);
    this.messageQueue.delete(sessionKey);

    const mergedText = messages.length === 1
      ? messages[0].userText
      : messages.map((m, i) => `[${m.source === 'subagent_feedback' ? '后台子agent通知' : '队列消息'} ${i + 1}] ${m.userText}`).join('\n');
    const runtimeFeedback = messages.flatMap(message => message.runtimeFeedback || []);
    const last = messages[messages.length - 1];
    const channel = this.buildChannel(last.chatId, sessionKey);

    const singleSubAgentFeedback = messages.length === 1 && messages[0].source === 'subagent_feedback';
    const result = singleSubAgentFeedback
      ? await session.handleRuntimeObservation(mergedText, {
        channel,
        runtimeFeedback,
        source: 'subagent_result',
      })
      : await session.handleMessage(mergedText, { channel, runtimeFeedback });
    if (result.text === ERROR_MESSAGE) {
      await channel.reply(last.chatId, result.text);
    }

    await this.drainMessageQueue(sessionKey);
  }
}
