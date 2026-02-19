import { AgentSession, AgentServices } from '../core/agent-session';
import { Logger } from '../utils/logger';
import { ParsedFeishuMessage } from './types';

/** 默认会话过期时间：30 分钟 */
const DEFAULT_SESSION_TTL = 30 * 60 * 1000;

/**
 * 会话生命周期管理器
 * - p2p 消息按 user:{senderId} 隔离
 * - 群聊消息按 group:{chatId} 隔离
 * - 定时清理过期会话
 */
export class SessionManager {
  private sessions = new Map<string, AgentSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private ttl: number;
  private teammateContext: string | null = null;

  constructor(
    private agentServices: AgentServices,
    ttl?: number,
  ) {
    this.ttl = ttl ?? DEFAULT_SESSION_TTL;
    this.startCleanup();
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
  getOrCreate(key: string): AgentSession {
    let session = this.sessions.get(key);
    if (!session) {
      session = new AgentSession(key, this.agentServices);
      if (this.teammateContext) {
        session.injectContext(this.teammateContext);
      }
      this.sessions.set(key, session);
      Logger.info(`新建飞书会话: ${key}`);
    }
    session.lastActiveAt = Date.now();
    return session;
  }

  /**
   * 启动定期清理（每分钟检查一次）
   */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, session] of this.sessions) {
        if (now - session.lastActiveAt > this.ttl) {
          // 过期前尝试保存摘要到记忆系统
          session.summarizeAndDestroy().catch(err => {
            Logger.warning(`会话 ${key} 摘要保存失败: ${err}`);
          });
          this.sessions.delete(key);
          Logger.info(`飞书会话已过期清理: ${key}`);
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
