import { AgentSession, AgentServices } from '../core/agent-session';
import { Logger } from '../utils/logger';
import { ParsedFeishuMessage } from './types';
import { MessageSender } from './message-sender';

/** 默认会话过期时间：30 分钟 */
const DEFAULT_SESSION_TTL = 30 * 60 * 1000;

/**
 * 会话生命周期管理器
 * - p2p 消息按 user:{senderId} 隔离
 * - 群聊消息按 group:{chatId} 隔离
 * - 定时清理过期会话
 * - 过期时支持主动唤醒用户
 */
export class SessionManager {
  private sessions = new Map<string, AgentSession>();
  private destroying = new Set<string>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private ttl: number;
  private teammateContext: string | null = null;
  /** 记录每个 session 最近一次消息的 chatId（用于过期时主动唤醒） */
  private lastChatIdMap = new Map<string, string>();
  private sender: MessageSender | null = null;

  constructor(
    private agentServices: AgentServices,
    ttl?: number,
  ) {
    this.ttl = ttl ?? DEFAULT_SESSION_TTL;
    this.startCleanup();
  }

  /** 注入 MessageSender 引用（用于过期时主动唤醒） */
  setSender(sender: MessageSender): void {
    this.sender = sender;
  }

  /** 设置同事档案上下文，新建 session 时自动注入 */
  setTeammateContext(context: string): void {
    this.teammateContext = context;
  }

  /**
   * 根据消息生成会话 key
   */
  getSessionKey(msg: ParsedFeishuMessage): string {
    return msg.chatType === 'group'
      ? `group:${msg.chatId}`
      : `user:${msg.senderId}`;
  }

  /**
   * 获取或创建会话
   */
  getOrCreate(key: string, chatId?: string): AgentSession {
    let session = this.sessions.get(key);
    if (!session) {
      session = new AgentSession(key, this.agentServices);
      session.restoreFromStore();
      if (this.teammateContext) {
        session.injectContext(this.teammateContext);
      }
      this.sessions.set(key, session);
      Logger.info(`新建飞书会话: ${key}`);
    }

    // 更新最近的 chatId（用于过期时唤醒）
    if (chatId) {
      this.lastChatIdMap.set(key, chatId);
      this.injectWakeupReply(session, key);
    }

    session.lastActiveAt = Date.now();
    return session;
  }

  /** 为 session 注入主动唤醒回调 */
  private injectWakeupReply(session: AgentSession, key: string): void {
    if (!this.sender) return;
    const sender = this.sender;
    session.setWakeupReply(async (text: string) => {
      const chatId = this.lastChatIdMap.get(key);
      if (!chatId) {
        Logger.warning(`[${key}] 主动唤醒失败: 无 chatId`);
        return;
      }
      await sender.reply(chatId, text);
    });
  }

  /**
   * 启动定期清理（每分钟检查一次）
   */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, session] of this.sessions) {
        if (this.destroying.has(key)) continue;
        if (now - session.lastActiveAt > this.ttl) {
          this.destroying.add(key);
          this.sessions.delete(key);
          Logger.info(`飞书会话已过期清理: ${key}`);
          session.summarizeAndDestroy()
            .catch(err => Logger.warning(`会话 ${key} 摘要保存失败: ${err}`))
            .finally(() => this.destroying.delete(key));
        }
      }
    }, 60_000);
  }

  /**
   * 停止清理定时器
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }
}
