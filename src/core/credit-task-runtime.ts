import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ChatConfig, Message } from '../types';
import { isCatsRelayApiBase } from '../utils/catsco-domains';

export interface CreditTaskSnapshot {
  taskId: string;
  state: 'running' | 'paused' | 'completed';
  enabled?: boolean;
  startSent?: boolean;
  reason?: string;
  retainedTaskId?: string;
  pendingInput?: Message['content'];
  pendingCommand?: 'compact' | 'resume';
  finishPending?: boolean;
  subagentProgress?: Record<string, { taskDescription: string; messages: Message[]; outputFiles: string[] }>;
}

export interface CreditTaskDecision {
  enabled: boolean;
  allowed: boolean;
  task_id: string;
  state: CreditTaskSnapshot['state'];
  retained_task_id?: string;
  reason?: string;
  spendable_units: number;
  debt_units: number;
}

const scope = new AsyncLocalStorage<CreditTaskRuntime>();
export const currentCreditTask = (): CreditTaskRuntime | undefined => scope.getStore();
export const isCatsCoCreditProvider = (config: Partial<ChatConfig>): boolean =>
  config.catsCoRelay === true || isCatsRelayApiBase(config.apiUrl);

export class CreditTaskPausedError extends Error {
  readonly code = 'CATSCO_CREDIT_TASK_PAUSED';
  constructor(message: string) { super(message); this.name = 'CreditTaskPausedError'; }
}

export function creditTaskHeaders(apiUrl: string): Record<string, string> {
  const task = currentCreditTask();
  return task?.matches(apiUrl) ? { 'X-CatsCo-Root-Task-ID': task.snapshot.taskId } : {};
}

/** One original goal, including all necessary in-process descendants. No credentials are persisted. */
export class CreditTaskRuntime {
  readonly snapshot: CreditTaskSnapshot;
  private startPromise?: Promise<void>;
  private finishPromise?: Promise<void>;
  private children = 0;
  private parentCompleted = false;
  private revision = 0;

  constructor(
    private readonly config: Partial<ChatConfig>,
    snapshot?: CreditTaskSnapshot,
    private readonly save: (snapshot: CreditTaskSnapshot) => void = () => {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.snapshot = snapshot ? { ...snapshot } : { taskId: randomUUID(), state: 'running' };
  }

  run<T>(fn: () => T): T {
    // A child cannot replace the root of an existing async task.
    return scope.getStore() ? fn() : scope.run(this, fn);
  }

  matches(apiUrl: string): boolean {
    try { return new URL(apiUrl).origin === new URL(this.config.apiUrl!).origin; }
    catch { return false; }
  }

  get pauseMessage(): string {
    if (this.snapshot.finishPending) return '原任务已完成，结束状态尚未同步，请手动执行 /resume 重试。';
    const retained = this.snapshot.retainedTaskId ? ` 当前保留任务：${this.snapshot.retainedTaskId}。` : '';
    return `任务已暂停，进度已保存（${this.snapshot.reason || '额度或权限检查未通过'}）。${retained}请在无欠款、有可用额度且具备模型权限后手动执行 /resume。`;
  }

  persist(): void { this.save({ ...this.snapshot }); }

  pause(reason: string): CreditTaskPausedError {
    this.revision++;
    this.snapshot.state = 'paused';
    this.snapshot.reason = reason;
    this.persist();
    return new CreditTaskPausedError(this.pauseMessage);
  }

  saveSubagentProgress(id: string, progress: NonNullable<CreditTaskSnapshot['subagentProgress']>[string]): void {
    this.snapshot.subagentProgress = { ...this.snapshot.subagentProgress, [id]: structuredClone(progress) };
    this.persist();
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.snapshot.startSent) return this.status();
    this.snapshot.startSent = true;
    this.persist();
    this.startPromise = this.request('start').then(() => {});
    return this.startPromise;
  }

  async status(): Promise<void> {
    if (this.snapshot.state === 'paused') throw new CreditTaskPausedError(this.pauseMessage);
    if (this.snapshot.state === 'completed') throw new CreditTaskPausedError('原任务已结束，不能附着新步骤继续调用。');
    if (!this.snapshot.startSent) return this.start();
    if (this.snapshot.enabled === false) return;
    await this.request('status');
  }

  async resume(): Promise<void> {
    // Only the explicit user resume path calls this; status never auto-resumes.
    this.parentCompleted = false;
    this.revision++;
    await this.request('resume');
    this.finishPromise = undefined;
    this.startPromise = Promise.resolve();
  }

  async complete(): Promise<void> {
    this.parentCompleted = true;
    if (this.children === 0) await this.finish();
  }

  async child<T>(fn: () => Promise<T>): Promise<T> {
    this.children++;
    try { return await this.run(fn); }
    finally {
      this.children--;
      if (this.parentCompleted && this.children === 0) await this.finish();
    }
  }

  finish(): Promise<void> {
    if (this.snapshot.state === 'paused' || (this.snapshot.state === 'completed' && !this.snapshot.finishPending)) {
      return Promise.resolve();
    }
    if (this.finishPromise) return this.finishPromise;
    this.finishPromise = (async () => {
      // Work has ended. Persist the acknowledgement gap so recovery never reruns models/tools.
      this.revision++;
      this.snapshot.state = 'completed';
      this.snapshot.finishPending = this.snapshot.enabled !== false;
      this.persist();
      if (this.snapshot.enabled !== false) await this.request('finish');
      this.snapshot.finishPending = false;
      this.snapshot.pendingInput = undefined;
      this.snapshot.subagentProgress = undefined;
      this.snapshot.pendingCommand = undefined;
      this.persist();
    })().catch(error => { this.finishPromise = undefined; throw error; });
    return this.finishPromise;
  }

  private async request(action: 'start' | 'status' | 'resume' | 'finish'): Promise<CreditTaskDecision> {
    const revision = this.revision;
    try {
      const endpoint = new URL('/v1/credit-tasks', this.config.apiUrl);
      if (!this.config.apiKey || endpoint.username || endpoint.password) throw new Error('Relay 凭据或地址未配置');
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({ action, task_id: this.snapshot.taskId }),
        // Never follow redirects carrying the model credential to another origin.
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Relay 任务门禁不可用 (${response.status})`);
      const decision = await response.json() as CreditTaskDecision;
      if (typeof decision.enabled !== 'boolean' || typeof decision.allowed !== 'boolean'
        || decision.task_id !== this.snapshot.taskId
        || !['running', 'paused', 'completed'].includes(decision.state)
        || !Number.isSafeInteger(decision.spendable_units) || decision.spendable_units < 0
        || !Number.isSafeInteger(decision.debt_units) || decision.debt_units < 0
        || (!decision.enabled && !decision.allowed)) {
        throw new Error('Relay 任务门禁响应无效');
      }
      // A stale in-flight status must never undo a concurrent pause (including a 402).
      if (revision !== this.revision) throw new CreditTaskPausedError(this.pauseMessage);
      if (this.snapshot.enabled === true && decision.enabled === false) throw new Error('Relay 任务门禁状态发生变化');
      this.snapshot.enabled = decision.enabled;
      this.snapshot.retainedTaskId = decision.retained_task_id;
      if (decision.enabled && action !== 'finish' && (!decision.allowed || decision.state !== 'running'
        || (action === 'resume' && (decision.debt_units > 0 || decision.spendable_units <= 0)))) {
        throw this.pause(decision.reason || '额度或模型权限不足');
      }
      if (action === 'finish' && decision.enabled && decision.state !== 'completed') {
        throw new Error('Relay 尚未确认原任务结束');
      }
      if (action === 'finish') this.revision++;
      this.snapshot.state = action === 'finish' ? 'completed' : 'running';
      this.snapshot.reason = undefined;
      this.persist();
      return decision;
    } catch (error) {
      if (error instanceof CreditTaskPausedError) throw error;
      if (action === 'finish') {
        this.snapshot.reason = error instanceof Error ? error.message : 'Relay 任务结束同步失败';
        this.persist();
        throw new CreditTaskPausedError('原任务已完成，结束状态尚未同步，请手动执行 /resume 重试。');
      }
      throw this.pause(error instanceof Error ? error.message : 'Relay 任务门禁检查失败');
    }
  }
}

/** Called before every actual model attempt, including retries and checkpoint summaries. */
export async function checkCreditTask(config: Partial<ChatConfig>): Promise<void> {
  if (!isCatsCoCreditProvider(config)) return;
  const task = currentCreditTask();
  if (!task || !task.matches(config.apiUrl || '')) {
    throw new CreditTaskPausedError('缺少原任务身份，已停止 CatsCo 模型调用，请从原会话手动恢复。');
  }
  await task.status();
}
