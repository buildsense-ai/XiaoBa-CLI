import { AIService } from '../utils/ai-service';
import { SkillManager } from '../skills/skill-manager';
import { Logger } from '../utils/logger';
import {
  SubAgentSession,
  SubAgentInfo,
  SubAgentSpawnOptions,
  SubAgentType,
  SubAgentToolScope,
} from './sub-agent-session';
import {
  formatSubAgentEventLine,
  SubAgentEventStore,
  SubAgentEventType,
  SubAgentRuntimeEvent,
} from './sub-agent-events';
import { randomUUID } from 'crypto';

// ─── 平台回调注册 ───────────────────────────────────────

export interface PlatformCallbacks {
  /**
   * 向主会话投递后台结果 observation，触发主 agent 新一轮推理。
   * 这是 result 通道，不用于 WORKING/UI 进度事件。
   */
  injectMessage: (text: string) => Promise<void>;
  /**
   * 向平台发送子智能体 runtime event，用于 WORKING/UI 可视化。
   * 这是 event 通道，不应被当作最终结果回流给主 agent。
   */
  onSubAgentEvent?: (event: SubAgentRuntimeEvent, info?: SubAgentInfo) => Promise<void> | void;
}

export type StopSubAgentResult = 'stopped' | 'not_found' | 'forbidden' | 'not_running';
export type SubAgentEventLogger = (event: SubAgentRuntimeEvent, info?: SubAgentInfo) => void;

export interface SpawnSubAgentRequest {
  skillName?: string;
  agentType?: SubAgentType;
  toolScope?: SubAgentToolScope;
  subAgentPrompt?: string;
  allowedTools?: readonly string[];
  maxTurns?: number;
  taskDescription: string;
  userMessage: string;
}

export interface StopAllSubAgentsResult {
  stopped: number;
  active: number;
}

// ─── SubAgentManager ────────────────────────────────────

/**
 * SubAgentManager - 子智能体管理器（单例）
 *
 * 管理所有后台运行的 SubAgentSession 的生命周期。
 * 按 parentSessionKey 隔离；是否拆分、派发多少个子任务由主 agent 判断。
 */
export class SubAgentManager {
  private static instance: SubAgentManager;

  /** 所有子智能体，key = subagent id */
  private subAgents = new Map<string, SubAgentSession>();
  /** 已结束子智能体的轻量状态快照，key = subagent id */
  private completedSubAgents = new Map<string, SubAgentInfo>();
  /** 子智能体 → 父会话 key 的映射 */
  private parentMap = new Map<string, string>();
  /** 持久化的平台回调，key = 父会话 sessionKey */
  private platformCallbacks = new Map<string, PlatformCallbacks>();
  /** 会话日志回调，key = 父会话 sessionKey */
  private eventLoggers = new Map<string, SubAgentEventLogger>();
  /** 子智能体展示名，便于日志/UI 使用 子agent1/子agent2 这类稳定标签 */
  private displayNameByAgent = new Map<string, string>();
  private displayCounterByParent = new Map<string, number>();
  /** runtime 事件流，按父会话隔离 */
  private eventStore = new SubAgentEventStore({
    maxEventsPerParent: 120,
    maxEventsPerAgent: 80,
    retentionMs: SubAgentManager.RETENTION_MS,
  });

  /** 完成后保留信息的时间（ms） */
  private static readonly RETENTION_MS = 30 * 60 * 1000;
  private static readonly PARENT_RESULT_MAX_CHARS = 1800;
  private static readonly MIN_ID_PREFIX_LENGTH = 'sub-'.length + 4;

  private constructor() { }

  static getInstance(): SubAgentManager {
    if (!SubAgentManager.instance) {
      SubAgentManager.instance = new SubAgentManager();
    }
    return SubAgentManager.instance;
  }

  // ─── 平台回调注册（由 FeishuBot / CatsCo adapter 调用，持久化） ─

  /**
   * 注册平台回调。FeishuBot / CatsCo adapter 在创建/获取 session 时调用一次，
   * 不随 handleMessage 结束而注销，保证子智能体完成后能通知主 Agent。
   */
  registerPlatformCallbacks(sessionKey: string, callbacks: PlatformCallbacks): void {
    this.platformCallbacks.set(sessionKey, callbacks);
  }

  registerEventLogger(sessionKey: string, logger: SubAgentEventLogger): void {
    this.eventLoggers.set(sessionKey, logger);
  }

  unregisterEventLogger(sessionKey: string): void {
    this.eventLoggers.delete(sessionKey);
  }

  unregisterPlatformCallbacks(sessionKey: string): void {
    this.platformCallbacks.delete(sessionKey);
  }

  // ─── 子智能体生命周期 ─────────────────────────────────

  /**
   * 派遣子智能体执行任务
   */
  async spawn(
    parentSessionKey: string,
    request: SpawnSubAgentRequest,
    workingDirectory: string,
    aiService: AIService,
    skillManager: SkillManager,
  ): Promise<SubAgentInfo | { error: string }> {
    const skillName = request.skillName?.trim();
    const agentType = request.agentType || (skillName ? 'skill' : 'worker');
    const toolScope = request.toolScope;
    const subAgentPrompt = request.subAgentPrompt?.trim();
    const allowedTools = request.allowedTools;
    const maxTurns = request.maxTurns;
    const taskDescription = request.taskDescription.trim();
    const userMessage = request.userMessage.trim();

    // 检查 skill 是否存在
    const skill = skillName ? (await skillManager.resolveSkill(skillName))?.skill : null;
    if (skillName && !skill) {
      return { error: `Skill "${skillName}" 不存在` };
    }

    const id = `sub-${randomUUID()}`;
    const displayName = this.nextDisplayName(parentSessionKey);
    this.displayNameByAgent.set(id, displayName);

    // 获取平台回调（子智能体需要 injectMessage 向主 Agent 报告）
    const platform = this.platformCallbacks.get(parentSessionKey);
    if (!platform) {
      return { error: '平台回调未注册，无法派遣子智能体' };
    }

    const options: SubAgentSpawnOptions = {
      displayName,
      agentType,
      toolScope,
      skillName,
      subAgentPrompt,
      allowedTools,
      maxTurns,
      taskDescription,
      userMessage,
      workingDirectory,
      emitEvent: (type, summary, payload) => {
        this.recordEvent(parentSessionKey, id, type, summary, payload);
      },
      // ask_parent 通道：子 agent 需要主 agent/用户补信息时才注入父会话。
      notifyParent: async (subAgentId, taskDesc, question) => {
        const msg = `[${displayName} 反馈]\nID：${subAgentId}\n任务：${taskDesc}\n需要你的指示：${question}`;
        await platform.injectMessage(msg);
      },
    };

    const session = new SubAgentSession(id, aiService, skillManager, options);
    this.subAgents.set(id, session);
    this.parentMap.set(id, parentSessionKey);
    const spawnedEvent = this.recordEvent(parentSessionKey, id, 'agent_spawned', `派遣 ${displayName} (${agentType}) 执行：${taskDescription}`, {
      agentType,
      skillName,
      toolScope: session.toolScope,
      allowedTools: session.allowedTools,
    }, { notifyPlatform: false });
    await this.notifyPlatformEvent(parentSessionKey, id, spawnedEvent);

    // fire-and-forget：manager.spawn() 只负责创建并启动后台 session。
    // 这里不 return/await session.run()，所以 spawn_subagent 工具不会等子 agent 跑完。
    // 子 agent 完成后会在 finalizeSession() 里通过 result observation 回流父会话。
    void session.run()
      .catch(err => {
        session.status = 'failed';
        session.completedAt = Date.now();
        session.resultSummary = `执行失败: ${err?.message || err}`;
        Logger.error(`[SubAgentManager] ${id} 未捕获失败: ${err?.message || err}`);
      })
      .finally(() => {
        void this.finalizeSession(parentSessionKey, id, session, platform, taskDescription);
      });

    Logger.info(`[SubAgentManager] 派遣 ${id} 执行 "${skillName || agentType}" (父会话: ${parentSessionKey})`);
    return this.decorateInfo(parentSessionKey, session.getInfo());
  }

  /**
   * 停止子智能体
   */
  stop(subAgentId: string): boolean {
    const session = this.subAgents.get(subAgentId);
    if (!session || !isActiveSubAgentStatus(session.status)) {
      return false;
    }
    session.stop();
    Logger.info(`[SubAgentManager] 已停止 ${subAgentId}`);
    return true;
  }

  /**
   * 按父会话停止子智能体（防止跨会话越权）
   */
  stopForParent(parentSessionKey: string, subAgentId: string): StopSubAgentResult {
    const targetId = this.resolveSubAgentIdForParent(parentSessionKey, subAgentId);
    if (!targetId) {
      return 'not_found';
    }
    const owner = targetId ? this.parentMap.get(targetId) : undefined;
    if (!owner) {
      return 'not_found';
    }
    if (owner !== parentSessionKey) {
      return 'forbidden';
    }

    const session = this.subAgents.get(targetId);
    if (!session) {
      return this.completedSubAgents.has(targetId) ? 'not_running' : 'not_found';
    }
    if (!isActiveSubAgentStatus(session.status)) {
      return 'not_running';
    }

    session.stop();
    Logger.info(`[SubAgentManager] 已停止 ${targetId} (父会话: ${parentSessionKey})`);
    return 'stopped';
  }

  stopAllForParent(parentSessionKey: string, reason = '父会话生命周期结束'): StopAllSubAgentsResult {
    let stopped = 0;
    let active = 0;

    for (const [id, session] of this.subAgents) {
      if (this.parentMap.get(id) !== parentSessionKey) continue;
      if (isActiveSubAgentStatus(session.status)) {
        active += 1;
        session.stop();
        stopped += 1;
      }
    }

    if (stopped > 0) {
      Logger.info(`[SubAgentManager] 已停止父会话 ${parentSessionKey} 下 ${stopped} 个子智能体`);
    }
    return { stopped, active };
  }

  hasActiveForParent(parentSessionKey: string): boolean {
    for (const [id, session] of this.subAgents) {
      if (this.parentMap.get(id) !== parentSessionKey) continue;
      if (isActiveSubAgentStatus(session.status)) {
        return true;
      }
    }
    return false;
  }

  shutdown(reason = 'runtime shutdown'): StopAllSubAgentsResult {
    let stopped = 0;
    let active = 0;
    const parents = new Set(this.parentMap.values());

    for (const parentSessionKey of parents) {
      const result = this.stopAllForParent(parentSessionKey, reason);
      stopped += result.stopped;
      active += result.active;
    }

    return { stopped, active };
  }

  /**
   * 恢复挂起的子智能体（主 agent 提供答案）
   */
  resumeForParent(parentSessionKey: string, subAgentId: string, answer: string): 'resumed' | 'not_found' | 'forbidden' | 'not_waiting' {
    const targetId = this.resolveSubAgentIdForParent(parentSessionKey, subAgentId);
    if (!targetId) return 'not_found';
    const owner = targetId ? this.parentMap.get(targetId) : undefined;
    if (!owner) return 'not_found';
    if (owner !== parentSessionKey) return 'forbidden';

    const session = this.subAgents.get(targetId);
    if (!session) return this.completedSubAgents.has(targetId) ? 'not_waiting' : 'not_found';
    if (!session.resume(answer)) return 'not_waiting';

    Logger.info(`[SubAgentManager] 已恢复 ${targetId} (父会话: ${parentSessionKey})`);
    return 'resumed';
  }

  /**
   * 查询单个子智能体状态
   */
  getInfo(subAgentId: string): SubAgentInfo | undefined {
    const session = this.subAgents.get(subAgentId);
    const parentSessionKey = this.parentMap.get(subAgentId);
    if (!parentSessionKey) return undefined;
    const info = session?.getInfo() ?? this.completedSubAgents.get(subAgentId);
    return info ? this.decorateInfo(parentSessionKey, info) : undefined;
  }

  /**
   * 按父会话查询子智能体（防止跨会话越权）
   */
  getInfoForParent(parentSessionKey: string, subAgentId: string): SubAgentInfo | undefined {
    const targetId = this.resolveSubAgentIdForParent(parentSessionKey, subAgentId);
    if (!targetId) return undefined;

    const owner = this.parentMap.get(targetId);
    if (!owner || owner !== parentSessionKey) {
      return undefined;
    }
    const session = this.subAgents.get(targetId);
    const info = session?.getInfo() ?? this.completedSubAgents.get(targetId);
    return info ? this.decorateInfo(parentSessionKey, info) : undefined;
  }

  /**
   * 列出某个父会话下的所有子智能体
   */
  listByParent(parentSessionKey: string): SubAgentInfo[] {
    const result: SubAgentInfo[] = [];
    for (const [id, session] of this.subAgents) {
      if (this.parentMap.get(id) === parentSessionKey) {
        result.push(this.decorateInfo(parentSessionKey, session.getInfo()));
      }
    }
    for (const [id, info] of this.completedSubAgents) {
      if (this.parentMap.get(id) === parentSessionKey && !this.subAgents.has(id)) {
        result.push(this.decorateInfo(parentSessionKey, info));
      }
    }
    return result;
  }

  formatRefsForParent(parentSessionKey: string, limit = 6): string {
    const all = this.listByParent(parentSessionKey);
    const refs = all.slice(0, limit).map(info => {
      const label = info.displayName ? `${info.displayName} (${info.id})` : info.id;
      return `- ${label}: ${info.status}`;
    });
    if (refs.length === 0) return '';
    const suffix = all.length > limit
      ? `\n- ...还有 ${all.length - limit} 个`
      : '';
    return [
      '当前会话可用子任务：',
      refs.join('\n') + suffix,
      '可使用完整 ID、唯一短前缀或展示名（如 子agent1）。',
    ].join('\n');
  }

  recordEvent(
    parentSessionKey: string,
    subAgentId: string,
    type: SubAgentEventType,
    summary: string,
    payload?: Record<string, unknown>,
    options: { notifyPlatform?: boolean } = {},
  ): SubAgentRuntimeEvent {
    // Event 通道：写内存事件流、日志和平台 UI。不要在这里唤醒主 agent。
    // 主 agent 唤醒只走 finalizeSession()/notifyParent 的 result observation 通道。
    const event = this.eventStore.append({
      parentSessionKey,
      subAgentId,
      subAgentName: this.displayNameByAgent.get(subAgentId),
      type,
      summary,
      payload,
    });
    const eventAgentLabel = event.subAgentName ? `${event.subAgentName}(${subAgentId})` : subAgentId;
    Logger.info(`[SubAgentEvent] ${parentSessionKey}/${eventAgentLabel} ${type}: ${summary}`);
    this.logSubAgentEvent(parentSessionKey, subAgentId, event);
    if (options.notifyPlatform !== false) {
      void this.notifyPlatformEvent(parentSessionKey, subAgentId, event);
    }
    return event;
  }

  listEventsByParent(parentSessionKey: string, limit = 20): SubAgentRuntimeEvent[] {
    return this.eventStore.listByParent(parentSessionKey, limit);
  }

  buildObservationForParent(parentSessionKey: string, limit = 12): string {
    const events = this.listEventsByParent(parentSessionKey, limit);
    if (events.length === 0) return '';
    return events.map(formatSubAgentEventLine).join('\n');
  }

  private decorateInfo(parentSessionKey: string, info: SubAgentInfo): SubAgentInfo {
    const recentEvents = this.eventStore.listByAgent(parentSessionKey, info.id, 8);
    return {
      ...info,
      displayName: info.displayName || this.displayNameByAgent.get(info.id),
      recentEvents,
      eventCount: this.eventStore.listByAgent(parentSessionKey, info.id).length,
      lastEventAt: recentEvents[recentEvents.length - 1]?.timestamp,
    };
  }

  private async finalizeSession(
    parentSessionKey: string,
    id: string,
    session: SubAgentSession,
    platform: PlatformCallbacks,
    taskDescription: string,
  ): Promise<void> {
    let info = session.getInfo();
    this.subAgents.delete(id);
    this.completedSubAgents.set(id, info);

    try {
      await session.close();
      info = session.getInfo();
      this.completedSubAgents.set(id, info);
    } catch (error: any) {
      Logger.warning(`[SubAgentManager] 关闭 ${id} 失败: ${error.message}`);
    }

    // 通知主 agent 子智能体已完成（stopped 不通知）
    if (info.status !== 'stopped') {
      const statusLabel = info.status === 'completed' ? '已完成' : '失败';
      const displayName = info.displayName || this.displayNameByAgent.get(id) || id;
      const fileList = info.outputFiles.length > 0
        ? `\n产出文件：\n${info.outputFiles.map(f => `- ${f}`).join('\n')}`
        : '';
      const resultSummary = compactForParentNotification(
        info.resultSummary || '（无结果）',
        SubAgentManager.PARENT_RESULT_MAX_CHARS,
      );
      const resultObservation = [
        `[${displayName} ${statusLabel}]`,
        `ID：${id}`,
        `任务：${taskDescription}`,
        `结果摘要：${resultSummary}`,
        '说明：这是压缩后的子 agent 结果。需要更多细节时先用 check_subagent 查看，再按需重新读取具体文件或更小范围。',
        fileList.trim() ? fileList.trim() : '',
      ].filter(Boolean).join('\n');
      await this.injectResultObservationWithRetry(parentSessionKey, id, platform, resultObservation);
    }

    // 完成后只保留轻量快照和事件一段时间，便于用户追问和 check_subagent。
    const retentionTimer = setTimeout(() => {
      this.completedSubAgents.delete(id);
      this.eventStore.removeAgent(parentSessionKey, id);
      this.parentMap.delete(id);
      this.displayNameByAgent.delete(id);
      this.cleanupParentCachesIfIdle(parentSessionKey);
    }, SubAgentManager.RETENTION_MS);
    retentionTimer.unref?.();
  }

  private cleanupParentCachesIfIdle(parentSessionKey: string): void {
    for (const owner of this.parentMap.values()) {
      if (owner === parentSessionKey) return;
    }
    this.displayCounterByParent.delete(parentSessionKey);
    this.eventStore.clearParent(parentSessionKey);
  }

  private nextDisplayName(parentSessionKey: string): string {
    const next = (this.displayCounterByParent.get(parentSessionKey) ?? 0) + 1;
    this.displayCounterByParent.set(parentSessionKey, next);
    return `子agent${next}`;
  }

  private async injectResultObservationWithRetry(
    parentSessionKey: string,
    subAgentId: string,
    platform: PlatformCallbacks,
    observation: string,
  ): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await platform.injectMessage(observation);
        return;
      } catch (error: any) {
        const suffix = attempt < maxAttempts ? '，准备重试' : '，已放弃';
        Logger.warning(`[SubAgentManager] 通知主 agent 失败 (${attempt}/${maxAttempts})${suffix}: ${error.message}`);
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    this.recordEvent(parentSessionKey, subAgentId, 'agent_progress', '完成通知投递失败，请用 check_subagent 查看结果', undefined, {
      notifyPlatform: false,
    });
  }

  private resolveSubAgentIdForParent(parentSessionKey: string, rawRef: string): string | undefined {
    const ref = String(rawRef || '').trim();
    if (!ref) return undefined;

    const owner = this.parentMap.get(ref);
    if (owner) return ref;

    let prefixMatch: string | undefined;
    for (const [id, ownerKey] of this.parentMap) {
      if (ownerKey !== parentSessionKey) continue;
      if (this.displayNameByAgent.get(id) === ref) return id;
      if (ref.length >= SubAgentManager.MIN_ID_PREFIX_LENGTH && id.startsWith(ref)) {
        if (prefixMatch && prefixMatch !== id) {
          return undefined;
        }
        prefixMatch = id;
      }
    }
    return prefixMatch;
  }

  private logSubAgentEvent(
    parentSessionKey: string,
    subAgentId: string,
    event: SubAgentRuntimeEvent,
  ): void {
    const logger = this.eventLoggers.get(parentSessionKey);
    if (!logger) return;

    const session = this.subAgents.get(subAgentId);
    const info = session?.getInfo() ?? this.completedSubAgents.get(subAgentId);
    try {
      logger(event, info ? this.decorateInfo(parentSessionKey, info) : undefined);
    } catch (error: any) {
      Logger.warning(`[SubAgentManager] 写入子智能体事件日志失败: ${error.message}`);
    }
  }

  private async notifyPlatformEvent(
    parentSessionKey: string,
    subAgentId: string,
    event: SubAgentRuntimeEvent,
  ): Promise<void> {
    const platform = this.platformCallbacks.get(parentSessionKey);
    if (!platform?.onSubAgentEvent) return;

    const session = this.subAgents.get(subAgentId);
    const info = session?.getInfo() ?? this.completedSubAgents.get(subAgentId);
    try {
      await platform.onSubAgentEvent(
        event,
        info ? this.decorateInfo(parentSessionKey, info) : undefined,
      );
    } catch (error: any) {
      Logger.warning(`[SubAgentManager] 平台子智能体事件通知失败: ${error.message}`);
    }
  }
}

function isActiveSubAgentStatus(status: SubAgentInfo['status']): boolean {
  return status === 'running' || status === 'waiting_for_input';
}

function compactForParentNotification(text: string, maxChars: number): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}... [已压缩，原始 ${normalized.length} 字符]`;
}
