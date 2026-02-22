import { AIService } from '../utils/ai-service';
import { SkillManager } from '../skills/skill-manager';
import { Logger } from '../utils/logger';
import { SubAgentSession, SubAgentInfo, SubAgentSpawnOptions } from './sub-agent-session';
import { randomUUID } from 'crypto';

// ─── 飞书回调注册 ───────────────────────────────────────

export interface FeishuCallbacks {
  reply: (text: string) => Promise<void>;
  sendFile: (filePath: string, fileName: string) => Promise<void>;
  /** 向主会话投递消息，触发主 agent 新一轮推理 */
  injectMessage?: (text: string) => Promise<void>;
}

export type StopSubAgentResult = 'stopped' | 'not_found' | 'forbidden' | 'not_running';

// ─── SubAgentManager ────────────────────────────────────

/**
 * SubAgentManager - 子智能体管理器（单例）
 *
 * 管理所有后台运行的 SubAgentSession 的生命周期。
 * 按 parentSessionKey 隔离，每个主会话最多同时运行 MAX_CONCURRENT 个子任务。
 */
export class SubAgentManager {
  private static instance: SubAgentManager;

  /** 所有子智能体，key = subagent id */
  private subAgents = new Map<string, SubAgentSession>();
  /** 子智能体 → 父会话 key 的映射 */
  private parentMap = new Map<string, string>();
  /** 持久化的飞书回调，key = 父会话 sessionKey */
  private feishuCallbacks = new Map<string, FeishuCallbacks>();

  private static readonly MAX_CONCURRENT_PER_SESSION = 3;
  /** 完成后保留信息的时间（ms） */
  private static readonly RETENTION_MS = 30 * 60 * 1000;

  private constructor() {}

  static getInstance(): SubAgentManager {
    if (!SubAgentManager.instance) {
      SubAgentManager.instance = new SubAgentManager();
    }
    return SubAgentManager.instance;
  }

  // ─── 飞书回调注册（由 FeishuBot 调用，持久化） ─────────

  /**
   * 注册飞书回调。FeishuBot 在创建/获取 session 时调用一次，
   * 不随 handleMessage 结束而注销，保证子智能体能持续发消息。
   */
  registerFeishuCallbacks(sessionKey: string, callbacks: FeishuCallbacks): void {
    this.feishuCallbacks.set(sessionKey, callbacks);
  }

  // ─── 子智能体生命周期 ─────────────────────────────────

  /**
   * 派遣子智能体执行任务
   */
  spawn(
    parentSessionKey: string,
    skillName: string,
    taskDescription: string,
    userMessage: string,
    workingDirectory: string,
    aiService: AIService,
    skillManager: SkillManager,
  ): SubAgentInfo | { error: string } {
    // 并发限制
    const running = this.listByParent(parentSessionKey).filter(s => s.status === 'running');
    if (running.length >= SubAgentManager.MAX_CONCURRENT_PER_SESSION) {
      return { error: `最多同时运行 ${SubAgentManager.MAX_CONCURRENT_PER_SESSION} 个子任务，当前已有 ${running.length} 个在运行` };
    }

    // 检查 skill 是否存在
    const skill = skillManager.getSkill(skillName);
    if (!skill) {
      return { error: `Skill "${skillName}" 不存在` };
    }

    const id = `sub-${randomUUID()}`;

    // 获取飞书回调
    const feishu = this.feishuCallbacks.get(parentSessionKey);

    const options: SubAgentSpawnOptions = {
      skillName,
      taskDescription,
      userMessage,
      workingDirectory,
      feishuReply: feishu?.reply,
      feishuSendFile: feishu?.sendFile,
      notifyParent: feishu?.injectMessage
        ? async (subAgentId, taskDesc, question) => {
            const msg = `[子智能体 ${subAgentId} 反馈]\n任务：${taskDesc}\n需要你的指示：${question}`;
            await feishu!.injectMessage!(msg);
          }
        : undefined,
    };

    const session = new SubAgentSession(id, aiService, skillManager, options);
    this.subAgents.set(id, session);
    this.parentMap.set(id, parentSessionKey);

    // fire-and-forget
    session.run().finally(() => {
      // 通知主 agent 子智能体已完成（stopped 不通知）
      if (feishu?.injectMessage && session.status !== 'stopped') {
        const info = session.getInfo();
        const statusLabel = info.status === 'completed' ? '已完成' : '失败';
        const msg = `[子智能体 ${id} ${statusLabel}]\n任务：${taskDescription}\n结果：${info.resultSummary || '（无结果）'}`;
        feishu.injectMessage(msg).catch(err => {
          Logger.warning(`[SubAgentManager] 通知主 agent 失败: ${err.message}`);
        });
      }

      // 立即释放不再需要的映射，减少内存尖峰
      this.parentMap.delete(id);

      // subAgents 保留一段时间供查询，然后清理
      setTimeout(() => {
        this.subAgents.delete(id);
      }, SubAgentManager.RETENTION_MS);
    });

    Logger.info(`[SubAgentManager] 派遣 ${id} 执行 "${skillName}" (父会话: ${parentSessionKey})`);
    return session.getInfo();
  }

  /**
   * 停止子智能体
   */
  stop(subAgentId: string): boolean {
    const session = this.subAgents.get(subAgentId);
    if (!session || session.status !== 'running') {
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
    const owner = this.parentMap.get(subAgentId);
    if (!owner) {
      return 'not_found';
    }
    if (owner !== parentSessionKey) {
      return 'forbidden';
    }

    const session = this.subAgents.get(subAgentId);
    if (!session) {
      return 'not_found';
    }
    if (session.status !== 'running') {
      return 'not_running';
    }

    session.stop();
    Logger.info(`[SubAgentManager] 已停止 ${subAgentId} (父会话: ${parentSessionKey})`);
    return 'stopped';
  }

  /**
   * 恢复挂起的子智能体（主 agent 提供答案）
   */
  resumeForParent(parentSessionKey: string, subAgentId: string, answer: string): 'resumed' | 'not_found' | 'forbidden' | 'not_waiting' {
    const owner = this.parentMap.get(subAgentId);
    if (!owner) return 'not_found';
    if (owner !== parentSessionKey) return 'forbidden';

    const session = this.subAgents.get(subAgentId);
    if (!session) return 'not_found';
    if (!session.resume(answer)) return 'not_waiting';

    Logger.info(`[SubAgentManager] 已恢复 ${subAgentId} (父会话: ${parentSessionKey})`);
    return 'resumed';
  }

  /**
   * 查询单个子智能体状态
   */
  getInfo(subAgentId: string): SubAgentInfo | undefined {
    return this.subAgents.get(subAgentId)?.getInfo();
  }

  /**
   * 按父会话查询子智能体（防止跨会话越权）
   */
  getInfoForParent(parentSessionKey: string, subAgentId: string): SubAgentInfo | undefined {
    const owner = this.parentMap.get(subAgentId);
    if (!owner || owner !== parentSessionKey) {
      return undefined;
    }
    return this.subAgents.get(subAgentId)?.getInfo();
  }

  /**
   * 列出某个父会话下的所有子智能体
   */
  listByParent(parentSessionKey: string): SubAgentInfo[] {
    const result: SubAgentInfo[] = [];
    for (const [id, session] of this.subAgents) {
      if (this.parentMap.get(id) === parentSessionKey) {
        result.push(session.getInfo());
      }
    }
    return result;
  }
}
