import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ChatConfig, ChatResponse, Message } from '../types';
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
  manualResumeGuard?: 'budget' | 'review';
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

// 1.6.8 persisted one reason for both HTTP 402 and 409. It is useful only for
// opting into a fresh budget check during explicit /resume, not as a diagnosis.
export const LEGACY_CREDIT_GATE_PAUSE = '额度或模型权限不足，需手动恢复';
export const CREDIT_ACCOUNTING_PAUSE = 'Relay 点数账务未通过，需手动恢复';
export const CREDIT_RESUME_INPUT_NOT_FOUND = '无法在保存的会话中定位原输入';
export const CREDIT_RESUME_CONTEXT_TOO_LARGE = '保留原任务所需的上下文后，本次恢复仍超过可预留点数';

/** A prompt produced by the runtime or reconstructed from cloud chat is not a saved input. */
function isSavedCreditInput(message: Message): boolean {
  return message.role === 'user' && !message.__checkpointSummary && !message.__checkpointBoundary
    && !message.__runtimeObservation && !message.__runtimeFeedback && !message.__syntheticObservation
    && !message.__injected && !message.__remoteContextSource && message.__cacheScope !== 'dynamic';
}

export function findSavedCreditInput(messages: Message[], pendingInput: Message['content'] | undefined): number {
  if (pendingInput == null) return -1;
  const pending = JSON.stringify(pendingInput);
  let lastRoot = -1;
  const matches: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (!isSavedCreditInput(message)) continue;
    if (message.__episodeInputKind === 'root') lastRoot = index;
    if (JSON.stringify(message.content) === pending) matches.push(index);
  }
  if (messages[lastRoot]?.__episodeId && JSON.stringify(messages[lastRoot].content) === pending) return lastRoot;
  if (matches.length !== 1) return -1;
  const match = matches[0];
  // Do not mistake a unique match in an older structured turn for the current root.
  return messages[match].__episodeId || messages[match].__episodeInputKind === 'pending' ? -1 : match;
}
const manualBudgetScope = new AsyncLocalStorage<{
  task: CreditTaskRuntime;
  sessionKey: string;
  reason: string;
  pendingInput: NonNullable<Message['content']>;
  toolHistory: Message[];
  consumed: boolean;
}>();

export function isManualCreditResume(sessionKey: string | undefined): boolean {
  const resume = manualBudgetScope.getStore();
  return Boolean(resume && resume.sessionKey === sessionKey && resume.task === currentCreditTask());
}

export function takeManualCreditResumeBudget(apiUrl: string, sessionKey: string, apiKey: string) {
  const resume = manualBudgetScope.getStore();
  if (!resume || resume.consumed || resume.task !== currentCreditTask()
    || resume.sessionKey !== sessionKey || !resume.task.matches(apiUrl)) return;
  resume.consumed = true;
  return {
    pendingInput: resume.pendingInput,
    toolHistory: resume.toolHistory,
    dispatchBilling: resume.task.dispatchBilling,
    spendableUnits: resume.task.dispatchBilling ? undefined : resume.task.manualResumeSpendableUnits(apiKey),
    keepPaused: (reason = resume.reason) => resume.task.pause(reason),
    beginBoundedAttempt: () => resume.task.requireManualResumeReview(),
    stopAttempt: () => resume.task.pause('恢复请求未安全完成，需手动检查原任务'),
  };
}

// Mark only HTTP-header failures of the matching Responses provider, never SSE
// or settlement errors. Even this Relay envelope does NOT prove reserve failed.
export const creditAccountingHeaderFailures = new WeakSet<object>();
export const budgetedCreditResumeResponses = new WeakSet<ChatResponse>();

export class CreditTaskPausedError extends Error {
  readonly code = 'CATSCO_CREDIT_TASK_PAUSED';
  constructor(message: string) { super(message); this.name = 'CreditTaskPausedError'; }
}

export function creditTaskHeaders(apiUrl: string): Record<string, string> {
  const task = currentCreditTask();
  if (!task?.matches(apiUrl)) return {};
  const root = { 'X-CatsCo-Root-Task-ID': task.snapshot.taskId };
  if (task.dispatchBilling) return { ...root, 'X-CatsCo-Billing-Dispatch': '1' };
  return task.snapshot.enabled === false ? {} : root;
}

/** One original goal, including all necessary in-process descendants. No credentials are persisted. */
export class CreditTaskRuntime {
  readonly snapshot: CreditTaskSnapshot;
  readonly dispatchBilling: boolean;
  private startPromise?: Promise<void>;
  private finishPromise?: Promise<void>;
  private children = 0;
  private parentCompleted = false;
  private revision = 0;
  private latestDecision?: CreditTaskDecision;

  constructor(
    private readonly config: Partial<ChatConfig>,
    snapshot?: CreditTaskSnapshot,
    private readonly save: (snapshot: CreditTaskSnapshot) => void = () => {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.dispatchBilling = process.env.CATSCO_RELAY_BILLING_DISPATCH === '1' && isCatsCoCreditProvider(config);
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

  manualResumeSpendableUnits(apiKey: string): number | undefined {
    const d = this.latestDecision;
    if (apiKey && apiKey === this.config.apiKey && this.snapshot.state === 'running' && this.snapshot.enabled === true
      && d?.enabled && d.allowed && d.state === 'running' && d.debt_units === 0) return d.spendable_units;
  }

  runManualResume<T>(sessionKey: string, history: Message[], fn: () => T): T {
    const { state, enabled, startSent, reason, pendingInput, pendingCommand, finishPending, subagentProgress, manualResumeGuard } = this.snapshot;
    const accountingPause = reason === LEGACY_CREDIT_GATE_PAUSE || reason === CREDIT_ACCOUNTING_PAUSE
      || (this.dispatchBilling && reason === '余额不足');
    if (currentCreditTask() !== this || state !== 'paused' || enabled !== true || startSent !== true
      || pendingInput == null || pendingCommand || finishPending || Object.keys(subagentProgress ?? {}).length
      || manualResumeGuard === 'review' || (!accountingPause && manualResumeGuard !== 'budget')) return fn();
    const toolHistory = structuredClone(history.filter(message => message.role === 'tool' || message.tool_calls?.length));
    this.snapshot.manualResumeGuard = 'budget';
    return manualBudgetScope.run({ task: this, sessionKey, reason: reason || CREDIT_ACCOUNTING_PAUSE, pendingInput, toolHistory, consumed: false }, fn);
  }

  requireManualResumeReview(): void {
    // Persist before sending: interruption must not replay an uncertain inference on restart.
    this.snapshot.manualResumeGuard = 'review';
    this.persist();
  }

  get pauseMessage(): string {
    if (this.snapshot.finishPending) return '原任务已完成，结束状态尚未同步，请手动执行 /resume 重试。';
    if (this.snapshot.manualResumeGuard === 'review') return '原任务的恢复结果尚未确认，需检查已保存的进度，系统不会重发。';
    switch (this.snapshot.reason) {
      case 'quota_exhausted':
      case 'debt_outstanding':
      case '余额不足':
        return '余额不足';
      case 'entitlement_expired':
        return '当前套餐没有可用的模型调用权益。';
      case 'plan_tier_unavailable':
        return '暂时无法确认套餐计费档位，请稍后再试。';
      case 'retained_task_other':
        return '账户当前只允许已获准继续的任务使用剩余额度。';
      case 'task_completed':
        return 'Relay 已结束原任务，不能继续执行其剩余步骤。';
      case 'manual_resume_required':
        return 'Relay 尚未批准原任务继续执行。';
      case CREDIT_ACCOUNTING_PAUSE:
      case LEGACY_CREDIT_GATE_PAUSE:
      case '模型请求的额度或权限门禁未通过，需手动恢复':
        return '本次模型调用的点数账务未通过，请稍后再试。';
      case CREDIT_RESUME_INPUT_NOT_FOUND:
        return '无法在保存的会话中定位原输入，原任务的检查点已保留。';
      default:
        return this.snapshot.reason || '本次任务状态无法确认，原进度已保留。';
    }
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
    if (this.dispatchBilling) {
      if (this.snapshot.startSent) return this.status();
      this.snapshot.startSent = true;
      this.snapshot.enabled = true;
      this.persist();
      return this.startPromise = Promise.resolve();
    }
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
    if (this.dispatchBilling || this.snapshot.enabled === false) return;
    await this.request('status');
  }

  async resume(): Promise<void> {
    // Resuming the saved input is explicit. Relay checks funding when inference starts.
    if (this.snapshot.manualResumeGuard === 'review') throw new CreditTaskPausedError(this.pauseMessage);
    if (this.snapshot.state === 'completed') throw new CreditTaskPausedError('原任务已结束，不能继续调用。');
    this.parentCompleted = false;
    this.revision++;
    if (this.dispatchBilling) {
      this.snapshot.state = 'running';
      this.snapshot.enabled = true;
      this.snapshot.startSent = true;
      this.snapshot.reason = undefined;
      this.snapshot.manualResumeGuard = undefined;
      this.persist();
    } else {
      await this.request('resume');
    }
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

  finish(abandon = false): Promise<void> {
    if (abandon && this.children > 0) return Promise.reject(new Error('子步骤尚未结束'));
    if ((!abandon && this.snapshot.state === 'paused') || (this.snapshot.state === 'completed' && !this.snapshot.finishPending)) {
      return Promise.resolve();
    }
    if (this.finishPromise) return this.finishPromise;
    this.finishPromise = (async () => {
      // Work has ended. Persist the acknowledgement gap so recovery never reruns models/tools.
      this.revision++;
      this.snapshot.state = 'completed';
      this.snapshot.finishPending = this.dispatchBilling || this.snapshot.enabled !== false;
      this.persist();
      if (this.snapshot.finishPending) await this.request('finish');
      this.snapshot.finishPending = false;
      this.snapshot.pendingInput = undefined;
      this.snapshot.manualResumeGuard = undefined;
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
      const model = action === 'start' ? this.config.model?.trim() : undefined;
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}`,
          ...(this.dispatchBilling && action === 'finish' ? { 'X-CatsCo-Billing-Dispatch': '1' } : {}),
        },
        body: JSON.stringify({ action, task_id: this.snapshot.taskId, ...(model && { model }) }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      }).catch(() => { throw new Error('暂时无法连接 Relay，请稍后再试。'); });
      if ([401, 403].includes(response.status)) throw new Error('Relay 访问授权未通过，请检查模型服务配置。');
      if (!response.ok) throw new Error(`Relay 任务检查失败（HTTP ${response.status}），请稍后再试。`);
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
      const dispatchFinish = this.dispatchBilling && action === 'finish';
      if (this.snapshot.enabled === true && decision.enabled === false && !dispatchFinish) {
        throw new Error('Relay 任务门禁状态发生变化');
      }
      this.snapshot.enabled = decision.enabled;
      this.snapshot.retainedTaskId = decision.retained_task_id;
      if (decision.enabled && action !== 'finish' && (!decision.allowed || decision.state !== 'running'
        || (action === 'resume' && (decision.debt_units > 0 || decision.spendable_units <= 0)))) {
        const reason = decision.reason;
        throw this.pause(reason && ['quota_exhausted', 'debt_outstanding', 'entitlement_expired', 'retained_task_other',
          'task_completed', 'manual_resume_required', 'plan_tier_unavailable', '余额不足'].includes(reason)
          ? reason : 'Relay 未确认本次任务可执行，请稍后再试。');
      }
      if (action === 'finish' && (decision.enabled || dispatchFinish) && decision.state !== 'completed') {
        throw new Error('Relay 尚未确认原任务结束');
      }
      if (action === 'finish') this.revision++;
      this.latestDecision = decision;
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
