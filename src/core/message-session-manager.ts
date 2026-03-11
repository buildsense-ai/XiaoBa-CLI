import { AgentSession, AgentServices } from './agent-session';
import { Logger } from '../utils/logger';

/** 默认会话过期时间：30 分钟 */
const DEFAULT_SESSION_TTL = 30 * 60 * 1000;

/**
 * 统一唤醒回复函数签名
 * 平台层注入具体的发送实现
 */
export type WakeupSendFn = (channelId: string, text: string) => Promise<void>;

/**
 * MessageSessionManager - 统一的消息会话生命周期管理器
 *
 * 核心特性：
 * - 每个 session key 独立运行，不阻塞
 * - 不同平台（CatsCompany/Feishu）共用同一套逻辑
 * - session 之间不污染
 * - 群聊和私聊独立
 */
export class MessageSessionManager {
  private sessions = new Map<string, AgentSession>();
  private destroying = new Set<string>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private ttl: number;
  /** 记录每个 session 最近一次消息的通道 ID（topic/chatId，用于过期时主动唤醒） */
  private lastChannelIdMap = new Map<string, string>();
  private wakeupSendFn: WakeupSendFn | null = null;
  private contextInjector: ((session: AgentSession) => void) | null = null;

  constructor(
    private agentServices: AgentServices,
    ttl?: number,
  ) {
    this.ttl = ttl ?? DEFAULT_SESSION_TTL;
    this.startCleanup();
  }

  /** 注入唤醒发送函数（用于过期时主动唤醒） */
  setWakeupSendFn(fn: WakeupSendFn): void {
    this.wakeupSendFn = fn;
  }

  /** 设置上下文注入器，新建 session 时自动调用 */
  setContextInjector(injector: (session: AgentSession) => void): void {
    this.contextInjector = injector;
  }

  /**
   * 获取或创建会话
   * @param key - 会话唯一标识（如 cc_user:usr3, feishu_group:chat123）
   * @param channelId - 通道 ID（topic 或 chatId，用于唤醒回复）
   */
  getOrCreate(key: string, channelId?: string): AgentSession {
    let session = this.sessions.get(key);
    if (!session) {
      session = new AgentSession(key, this.agentServices);
      session.restoreFromStore();
      if (this.contextInjector) {
        this.contextInjector(session);
      }
      this.sessions.set(key, session);
      Logger.info(`新建会话: ${key}`);
    }

    if (channelId) {
      this.lastChannelIdMap.set(key, channelId);
      this.injectWakeupReply(session, key);
    }

    session.lastActiveAt = Date.now();
    return session;
  }

  /** 为 session 注入主动唤醒回调 */
  private injectWakeupReply(session: AgentSession, key: string): void {
    if (!this.wakeupSendFn) return;
    const sendFn = this.wakeupSendFn;
    session.setWakeupReply(async (text: string) => {
      const channelId = this.lastChannelIdMap.get(key);
      if (!channelId) {
        Logger.warning(`[${key}] 主动唤醒失败: 无 channelId`);
        return;
      }
      await sendFn(channelId, text);
    });
  }

  /** 启动定期清理（每分钟检查一次） */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, session] of this.sessions) {
        if (this.destroying.has(key)) continue;
        if (now - session.lastActiveAt > this.ttl) {
          this.destroying.add(key);
          this.sessions.delete(key);
          Logger.info(`会话已过期清理: ${key}`);
          session.summarizeAndDestroy()
            .catch(err => Logger.warning(`会话 ${key} 摘要保存失败: ${err}`))
            .finally(() => this.destroying.delete(key));
        }
      }
    }, 60_000);
  }

  /** 停止清理定时器 */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }
}
