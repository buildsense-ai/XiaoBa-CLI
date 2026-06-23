import { AgentSession, AgentServices, SystemPromptProvider } from './agent-session';
import { Logger } from '../utils/logger';
import { composeSessionSystemPromptProvider } from './session-system-prompt';
import { SubAgentManager } from './sub-agent-manager';
import type { SessionRoute } from '../types/session-identity';
import { isSessionRoute } from './session-router';

/** 默认会话过期时间：60 分钟 */
const DEFAULT_SESSION_TTL = 60 * 60 * 1000;

export interface MessageSessionManagerOptions {
  ttl?: number;
  systemPromptProviderFactory?: (sessionKey: string) => SystemPromptProvider;
  skillReloadHandler?: () => Promise<void>;
}

export type SessionKeyInput = string | SessionRoute;

/**
 * MessageSessionManager - 统一的消息会话生命周期管理器
 *
 * 核心特性：
 * - 每个 session key 独立运行，不阻塞
 * - 不同平台（CatsCo/Feishu）共用同一套逻辑
 * - session 之间不污染
 * - 群聊和私聊独立
 */
export class MessageSessionManager {
  private static managers = new Map<string, MessageSessionManager>();
  private sessions = new Map<string, AgentSession>();
  private destroying = new Set<string>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private ttl: number;
  private contextInjector: ((session: AgentSession) => void) | null = null;
  private sessionType: string;
  private systemPromptProviderFactory?: (sessionKey: string) => SystemPromptProvider;
  private skillReloadHandler?: () => Promise<void>;

  constructor(
    private agentServices: AgentServices,
    sessionType: string,
    ttlOrOptions?: number | MessageSessionManagerOptions,
  ) {
    this.sessionType = sessionType;
    const options = typeof ttlOrOptions === 'number'
      ? { ttl: ttlOrOptions }
      : ttlOrOptions;
    this.ttl = options?.ttl ?? DEFAULT_SESSION_TTL;
    this.systemPromptProviderFactory = options?.systemPromptProviderFactory;
    this.skillReloadHandler = options?.skillReloadHandler;
    MessageSessionManager.managers.set(sessionType, this);
    this.startCleanup();
  }

  static getManager(sessionType: string): MessageSessionManager | null {
    return this.managers.get(sessionType) || null;
  }

  /** 获取已存在的会话；不会因为查询而新建会话 */
  get(input: SessionKeyInput): AgentSession | null {
    const { key } = this.normalizeSessionInput(input);
    const session = this.sessions.get(key) || null;
    if (session) {
      session.lastActiveAt = Date.now();
    }
    return session;
  }

  /** 设置上下文注入器，新建 session 时自动调用 */
  setContextInjector(injector: (session: AgentSession) => void): void {
    this.contextInjector = injector;
  }

  /**
   * 获取或创建会话
   * @param key - 会话唯一标识（如 cc_user:usr3, feishu_group:chat123）
   */
  getOrCreate(input: SessionKeyInput): AgentSession {
    const { key, route } = this.normalizeSessionInput(input);
    let session = this.sessions.get(key);
    if (!session) {
      session = new AgentSession(key, this.agentServices, this.sessionType, route);
      if (this.systemPromptProviderFactory) {
        session.setSystemPromptProvider(composeSessionSystemPromptProvider(
          this.systemPromptProviderFactory(key),
          { sessionKey: key, sessionType: this.sessionType },
        ));
      }
      if (this.skillReloadHandler) {
        session.setSkillReloadHandler(this.skillReloadHandler);
      }
      session.restoreFromStore();
      if (this.contextInjector) {
        this.contextInjector(session);
      }
      this.sessions.set(key, session);
      session.runWithLogContext(() => Logger.info(`新建会话: ${key}`));
    }

    session.lastActiveAt = Date.now();
    return session;
  }

  injectContext(key: string, text: string): void {
    const session = this.getOrCreate(key);
    session.injectContext(text);
  }

  private normalizeSessionInput(input: SessionKeyInput): { key: string; route?: SessionRoute } {
    if (isSessionRoute(input)) {
      return { key: input.sessionKey, route: input };
    }
    return { key: input };
  }

  /** 启动定期清理（每分钟检查一次） */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredSessions(Date.now());
    }, 60_000);
  }

  private async cleanupExpiredSessions(now: number): Promise<void> {
    const cleanupPromises: Promise<void>[] = [];
    for (const [key, session] of this.sessions) {
      if (this.destroying.has(key)) continue;
      if (now - session.lastActiveAt <= this.ttl) continue;
      if (SubAgentManager.getInstance().hasActiveForParent(key)) {
        session.lastActiveAt = now;
        session.runWithLogContext(() => Logger.info(`会话仍有后台子任务运行，跳过过期清理: ${key}`));
        continue;
      }

      this.destroying.add(key);
      this.sessions.delete(key);
      session.runWithLogContext(() => Logger.info(`会话已过期清理: ${key}`));
      cleanupPromises.push(
        session.cleanup({
          stopSubAgents: true,
          subAgentStopReason: '父会话过期清理',
        })
          .catch(err => session.runWithLogContext(() => Logger.warning(`会话 ${key} 清理失败: ${err}`)))
          .finally(() => this.destroying.delete(key)),
      );
    }
    await Promise.all(cleanupPromises);
  }

  /** 停止清理定时器并保存所有会话 */
  async destroy(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // 保存所有活跃会话
    const cleanupPromises = Array.from(this.sessions.values()).map(session =>
      session.cleanup({
        stopSubAgents: true,
        subAgentStopReason: '会话管理器销毁',
      }).catch(err =>
        session.runWithLogContext(() => Logger.warning(`会话 ${session.key} 清理失败: ${err}`))
      )
    );
    await Promise.all(cleanupPromises);

    this.sessions.clear();
    MessageSessionManager.managers.delete(this.sessionType);
  }
}
