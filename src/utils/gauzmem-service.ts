/**
 * GauzMem Service — 长期记忆读写客户端
 *
 * 职责：
 * - writeMessage(): 写入对话消息（fire-and-forget）
 * - recall(): 被动记忆召回（返回自然语言字符串）
 *
 * 设计：
 * - Circuit breaker: 连续 3 次失败 → 60s 冷却期
 * - 所有方法在 GauzMem 未配置或不可用时静默降级，不影响主流程
 */

import axios, { AxiosInstance } from 'axios';
import { Logger } from './logger';

// ─── 配置 ──────────────────────────────────────────────

interface GauzMemConfig {
  enabled: boolean;
  baseUrl: string;
  projectId: string;
  userId: string;
  apiKey?: string;
}

function loadConfig(): GauzMemConfig {
  return {
    enabled: process.env.GAUZ_MEM_ENABLED === 'true',
    baseUrl: (process.env.GAUZ_MEM_BASE_URL || '').replace(/\/+$/, ''),
    projectId: process.env.GAUZ_MEM_PROJECT_ID || 'XiaoBa',
    userId: process.env.GAUZ_MEM_USER_ID || '',
    apiKey: process.env.GAUZ_MEM_API_KEY,
  };
}

// ─── Circuit Breaker ───────────────────────────────────

const CB_THRESHOLD = 3;
const CB_COOLDOWN_MS = 60_000;

class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  isOpen(): boolean {
    if (this.failures < CB_THRESHOLD) return false;
    if (Date.now() >= this.openUntil) {
      // 冷却期结束，半开状态：允许一次尝试
      this.failures = CB_THRESHOLD - 1;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= CB_THRESHOLD) {
      this.openUntil = Date.now() + CB_COOLDOWN_MS;
      Logger.warning(`[GauzMem] circuit breaker open，${CB_COOLDOWN_MS / 1000}s 后重试`);
    }
  }
}

// ─── Service ───────────────────────────────────────────

export class GauzMemService {
  private static instance: GauzMemService | null = null;

  private config: GauzMemConfig;
  private client: AxiosInstance | null = null;
  private cb = new CircuitBreaker();

  private constructor() {
    this.config = loadConfig();
    if (this.config.enabled && this.config.baseUrl) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.config.apiKey) {
        headers['X-API-Key'] = this.config.apiKey;
      }
      this.client = axios.create({
        baseURL: this.config.baseUrl,
        timeout: 10_000,
        headers,
      });
      Logger.info(`[GauzMem] 已启用 → ${this.config.baseUrl} (project=${this.config.projectId})`);
    }
  }

  static getInstance(): GauzMemService {
    if (!this.instance) {
      this.instance = new GauzMemService();
    }
    return this.instance;
  }

  /** GauzMem 是否可用（已配置 + circuit breaker 未打开） */
  isAvailable(): boolean {
    return !!(this.client && !this.cb.isOpen());
  }

  // ─── 写入消息 ─────────────────────────────────────

  /**
   * 写入一条对话消息到 GauzMem。
   * Fire-and-forget：调用方不需要 await，失败静默。
   */
  async writeMessage(
    text: string,
    speaker: 'user' | 'agent',
    platformId: string,
    runId?: string,
    userId?: string,
  ): Promise<void> {
    if (!this.isAvailable()) return;

    try {
      await this.client!.post('/api/v1/memories/messages', {
        project_id: this.config.projectId,
        message: {
          text,
          user_id: userId || this.config.userId,
          platform_id: platformId,
          speaker,
          run_id: runId,
        },
      });
      this.cb.recordSuccess();
    } catch (err: any) {
      this.cb.recordFailure();
      Logger.warning(`[GauzMem] writeMessage 失败: ${err.message}`);
    }
  }

  // ─── 被动记忆召回 ─────────────────────────────────

  /**
   * 被动记忆召回：返回自然语言格式的回忆片段，直接注入 prompt。
   * 失败时返回空字符串。
   */
  async recall(query: string): Promise<string> {
    if (!this.isAvailable() || !query.trim()) return '';

    try {
      const resp = await this.client!.post('/api/v1/memories/recall', {
        project_id: this.config.projectId,
        query,
      });
      this.cb.recordSuccess();

      const data = resp.data;
      const recallText = data?.recall || '';
      const factsCount = data?.facts_count || 0;

      if (factsCount > 0) {
        Logger.info(`[GauzMem] recall: ${factsCount} facts, ${data?.subgraph_count || 0} subgraphs`);
      }

      return recallText;
    } catch (err: any) {
      this.cb.recordFailure();
      Logger.warning(`[GauzMem] recall 失败: ${err.message}`);
      return '';
    }
  }

  // ─── Getters ──────────────────────────────────────

  getProjectId(): string {
    return this.config.projectId;
  }
}
