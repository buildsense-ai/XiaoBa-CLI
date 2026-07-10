import axios from 'axios';
import { WeixinConfig, WeixinMessage } from './types';
import { MessageHandler } from './message-handler';
import { MessageSender } from './message-sender';
import { MessageSessionManager } from '../core/message-session-manager';
import { AgentServices, BUSY_MESSAGE, ERROR_MESSAGE, RuntimeFeedbackInput } from '../core/agent-session';
import { SubAgentManager } from '../core/sub-agent-manager';
import { shouldSuppressSubAgentObservationReply } from '../core/sub-agent-observation';
import { Logger } from '../utils/logger';
import { ChannelCallbacks } from '../types/tool';
import { AdapterRuntimeBundle, createAdapterRuntime } from '../runtime/adapter-runtime';
import { promises as fs } from 'fs';
import path from 'path';
import {
  createExecutionScopeFromRoute,
  createSessionRoute,
  createWeixinSessionRoute,
  parseSessionKeyV2,
} from '../core/session-router';
import type { SessionRoute } from '../types/session-identity';

const CHANNEL_VERSION = 'xiaoba-weixin/1.0';
const DEFAULT_LONGPOLL_MS = 30000;

interface QueuedMessage {
  userText: string;
  chatId: string;
  userId: string;
  sessionRoute: SessionRoute;
  source?: 'user' | 'subagent_feedback';
  runtimeFeedback?: RuntimeFeedbackInput[];
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
  private messageQueue = new Map<string, QueuedMessage[]>();
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
      const { bufPath, tokensPath } = this.getStatePaths();

      await fs.writeFile(bufPath, this.getUpdatesBuf);
      await fs.writeFile(tokensPath, JSON.stringify(Object.fromEntries(this.contextTokens)));
    } catch (err) {
      Logger.error(`[微信] 保存状态失败: ${err}`);
    }
  }

  private getStatePaths(): { bufPath: string; tokensPath: string } {
    return {
      bufPath: path.join(this.stateDir, 'get_updates.buf'),
      tokensPath: path.join(this.stateDir, 'context_tokens.json'),
    };
  }

  private async clearState(): Promise<void> {
    this.getUpdatesBuf = '';
    this.contextTokens.clear();
    try {
      const { bufPath, tokensPath } = this.getStatePaths();
      await fs.rm(bufPath, { force: true });
      await fs.rm(tokensPath, { force: true });
    } catch (err) {
      Logger.error(`[微信] 清理过期状态失败: ${err}`);
    }
  }

  private async handleSessionExpired(): Promise<void> {
    Logger.error('[微信] 会话已过期，请重新登录：打开 Dashboard 的微信配置，点击“获取 Token”扫码授权，保存后重新启动微信机器人。');
    await this.clearState();
    this.isRunning = false;
    try {
      await this.config.onSessionExpired?.();
    } catch (err) {
      Logger.error(`[微信] 会话过期收束失败: ${err}`);
    }
  }

  private buildChannel(chatId: string, sessionKey: string, userId: string, botUserId?: string): ChannelCallbacks {
    return {
      chatId,
      reply: async (cid: string, text: string) => {
        const contextToken = this.contextTokens.get(sessionKey) || this.contextTokens.get(`user:${userId}`);
        await this.sender.sendText(userId, text, contextToken, botUserId);
      },
      sendFile: async (cid: string, filePath: string, fileName: string) => {
        const contextToken = this.contextTokens.get(sessionKey) || this.contextTokens.get(`user:${userId}`);
        await this.sender.sendFile(userId, filePath, fileName, contextToken, botUserId);
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
          await this.handleSessionExpired();
          return;
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

    const parsed = this.handler.parseMessage(msg);
    if (!parsed || this.handler.shouldIgnoreMessage(parsed)) return;

    const route = createWeixinSessionRoute(parsed);
    const sessionKey = route.sessionKey;
    const userId = route.actorUserId;
    if (msg.context_token) {
      this.contextTokens.set(sessionKey, msg.context_token);
      this.contextTokens.set(route.legacySessionKey || `user:${userId}`, msg.context_token);
      await this.saveState();
    }

    const session = this.sessionManager.getOrCreate(route);
    const channel = this.buildChannel(route.topicId, sessionKey, userId, parsed.chat?.id);
    SubAgentManager.getInstance().registerPlatformCallbacks(sessionKey, {
      injectMessage: async (text: string) => {
        await this.handleSubAgentFeedback(sessionKey, route.topicId, userId, text, route);
      },
    });
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

    if (session.isBusy()) {
      const queue = this.messageQueue.get(sessionKey) ?? [];
      queue.push({
        userText,
        chatId: route.topicId,
        userId,
        sessionRoute: route,
        source: 'user',
        runtimeFeedback,
      });
      this.messageQueue.set(sessionKey, queue);
      Logger.info(`[${sessionKey}] 主会话忙，微信消息已入队 (队列长度: ${queue.length})`);
      return;
    }

    const result = await session.handleMessage(userText, {
      channel,
      sessionRoute: route,
      executionScope: createExecutionScopeFromRoute(route),
      runtimeFeedback,
    });
    if (result.text === BUSY_MESSAGE || result.text === ERROR_MESSAGE) {
      await channel.reply(route.topicId, result.text);
    }
    await this.drainMessageQueue(sessionKey);
  }

  private async handleSubAgentFeedback(
    sessionKey: string,
    chatId: string,
    userId: string,
    text: string,
    sessionRoute?: SessionRoute,
  ): Promise<void> {
    const session = this.sessionManager.getOrCreate(sessionKey);
    const route = sessionRoute ?? this.createRouteFromSessionKey(sessionKey, userId);

    if (session.isBusy()) {
      this.enqueueSubAgentFeedback(sessionKey, chatId, userId, text, route);
      Logger.info(`[${sessionKey}] 主会话忙，微信子智能体反馈已入队`);
      return;
    }

    const channel = this.buildChannel(chatId, sessionKey, userId);
    const result = await session.handleRuntimeObservation(text, {
      channel,
      sessionRoute: route,
      executionScope: createExecutionScopeFromRoute(route),
      source: 'subagent_result',
      suppressFinalResponse: shouldSuppressSubAgentObservationReply(text),
    });
    if (result.text === BUSY_MESSAGE) {
      this.enqueueSubAgentFeedback(sessionKey, chatId, userId, text, route);
      return;
    }
    if (result.text === ERROR_MESSAGE) {
      await channel.reply(chatId, result.text);
    }
    await this.drainMessageQueue(sessionKey);
  }

  private enqueueSubAgentFeedback(
    sessionKey: string,
    chatId: string,
    userId: string,
    text: string,
    sessionRoute?: SessionRoute,
  ): void {
    const route = sessionRoute ?? this.createRouteFromSessionKey(sessionKey, userId);
    const queue = this.messageQueue.get(sessionKey) ?? [];
    queue.push({
      userText: text,
      chatId,
      userId,
      sessionRoute: route,
      source: 'subagent_feedback',
    });
    this.messageQueue.set(sessionKey, queue);
  }

  private async drainMessageQueue(sessionKey: string): Promise<void> {
    const queue = this.messageQueue.get(sessionKey);
    if (!queue || queue.length === 0) return;

    const msg = queue.shift()!;
    if (queue.length === 0) {
      this.messageQueue.delete(sessionKey);
    }

    const session = this.sessionManager.getOrCreate(sessionKey);
    if (session.isBusy()) {
      queue.unshift(msg);
      this.messageQueue.set(sessionKey, queue);
      return;
    }

    const channel = this.buildChannel(msg.chatId, sessionKey, msg.userId);
    const executionScope = createExecutionScopeFromRoute(msg.sessionRoute);
    const result = msg.source === 'subagent_feedback'
      ? await session.handleRuntimeObservation(msg.userText, {
        channel,
        sessionRoute: msg.sessionRoute,
        executionScope,
        source: 'subagent_result',
        suppressFinalResponse: shouldSuppressSubAgentObservationReply(msg.userText),
      })
      : await session.handleMessage(msg.userText, {
        channel,
        sessionRoute: msg.sessionRoute,
        executionScope,
        runtimeFeedback: msg.runtimeFeedback,
      });

    if (result.text === ERROR_MESSAGE) {
      await channel.reply(msg.chatId, result.text);
    }
    await this.drainMessageQueue(sessionKey);
  }

  private createRouteFromSessionKey(sessionKey: string, userId: string): SessionRoute {
    const parsed = parseSessionKeyV2(sessionKey);
    const legacyUserId = sessionKey.startsWith('user:') ? sessionKey.slice('user:'.length) : '';
    return createSessionRoute({
      source: parsed?.source || 'weixin',
      topicId: parsed?.topicId || legacyUserId || userId || 'unknown_user',
      topicType: parsed?.topicType || 'p2p',
      actorUserId: userId || legacyUserId || 'unknown_user',
      agentId: parsed?.agentId,
      identityTrust: 'legacy_context',
      identitySource: 'weixin.runtime',
      legacySessionKey: parsed ? (userId ? `user:${userId}` : undefined) : sessionKey,
    });
  }

  destroy(): void {
    this.isRunning = false;
    this.messageQueue.clear();
    void this.sessionManager.destroy().catch(err => {
      Logger.warning(`[微信] 清理会话管理器失败: ${err}`);
    });
    Logger.info('[微信] 机器人已停止');
  }
}
