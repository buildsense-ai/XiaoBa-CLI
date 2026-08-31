import * as fs from 'fs';
import * as path from 'path';
import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';
import { PathResolver } from '../utils/path-resolver';
import { Tool } from '../types/tool';
import { AgentToolExecutor } from '../agents/agent-tool-executor';
import { ConversationRunner, RunResult, RunnerCallbacks } from './conversation-runner';

export interface BranchSessionOptions {
  id: string;
  type: string;
  aiService: AIService;
  workingDirectory: string;
  signal?: AbortSignal;
  logEnabled?: boolean;
  /** Maximum model turns allowed in one ConversationRunner pass. */
  maxTurnsPerPass?: number;
  /** Maximum number of ConversationRunner passes before the branch stops. */
  maxPasses?: number;
  /** Wall-clock budget for the whole branch. */
  deadlineMs?: number;
  /** Optional prompt-token budget for each runner pass. */
  maxContextTokens?: number;
}

export interface BranchRunOutcome {
  messages: Message[];
  result?: RunResult;
}

export abstract class BranchSession {
  protected readonly messages: Message[] = [];
  protected readonly logger: BranchSessionLogger;
  private readonly abortController = new AbortController();
  private stopped = false;
  private initialized = false;
  private conversationPasses = 0;
  private budgetExhaustedReason: 'max_passes' | 'deadline' | null = null;
  private readonly deadlineAt?: number;
  private readonly budgetTimer?: ReturnType<typeof setTimeout>;

  protected constructor(protected readonly options: BranchSessionOptions) {
    this.logger = new BranchSessionLogger({
      branchId: options.id,
      branchType: options.type,
      workingDirectory: options.workingDirectory,
      enabled: options.logEnabled !== false,
    });
    const deadlineMs = normalizePositiveBudget(options.deadlineMs);
    if (deadlineMs !== undefined) {
      this.deadlineAt = Date.now() + deadlineMs;
      const timer = setTimeout(() => {
        this.exhaustBudget('deadline');
      }, deadlineMs);
      timer.unref?.();
      this.budgetTimer = timer;
    }
    options.signal?.addEventListener('abort', () => this.stop(), { once: true });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearBudgetTimer();
    this.abortController.abort();
  }

  protected shouldContinue(): boolean {
    return !this.stopped
      && !this.abortController.signal.aborted
      && !this.options.signal?.aborted;
  }

  /**
   * Reserve one model pass. Keeping this gate in the branch base class makes
   * the budget apply to every autonomous branch loop, rather than only to a
   * single ConversationRunner invocation.
   */
  protected beginConversationPass(): boolean {
    if (!this.shouldContinue()) return false;
    if (this.deadlineAt !== undefined && Date.now() >= this.deadlineAt) {
      this.exhaustBudget('deadline');
      return false;
    }
    const maxPasses = normalizePositiveBudget(this.options.maxPasses);
    if (maxPasses !== undefined && this.conversationPasses >= maxPasses) {
      this.exhaustBudget('max_passes');
      return false;
    }
    this.conversationPasses++;
    return true;
  }

  protected isBudgetExhausted(): boolean {
    return this.budgetExhaustedReason !== null;
  }

  protected getBudgetExhaustedReason(): string | undefined {
    return this.budgetExhaustedReason || undefined;
  }

  protected getBudgetLogPayload(): Record<string, unknown> {
    return {
      max_turns_per_pass: normalizePositiveBudget(this.options.maxTurnsPerPass),
      max_passes: normalizePositiveBudget(this.options.maxPasses),
      deadline_ms: normalizePositiveBudget(this.options.deadlineMs),
      max_context_tokens: normalizePositiveBudget(this.options.maxContextTokens),
    };
  }

  /** Hooks used by branch-specific provenance trackers. */
  protected onBranchToolStart(_name: string, _toolUseId: string, _input: any): void {}
  protected onBranchToolEnd(_name: string, _toolUseId: string, _result: string): void {}

  /**
   * Called synchronously when the finite branch budget is exhausted. Concrete
   * branches may retain already-observed evidence here, but must not assume
   * that parent context can still be published.
   */
  protected onBudgetExhausted(): void {}

  protected clearBudgetTimer(): void {
    if (this.budgetTimer) clearTimeout(this.budgetTimer);
  }

  private exhaustBudget(reason: 'max_passes' | 'deadline'): void {
    if (this.budgetExhaustedReason) return;
    this.budgetExhaustedReason = reason;
    this.logger.write('budget_exhausted', {
      reason,
      conversation_passes: this.conversationPasses,
      ...this.getBudgetLogPayload(),
    });
    this.stop();
    try {
      this.onBudgetExhausted();
    } catch (error: any) {
      // Budget cleanup is authoritative; a best-effort branch hook must not
      // turn a bounded shutdown into an unhandled rejection.
      this.logFailure(error);
    }
  }

  protected abstract buildInitialMessages(): Promise<Message[]>;
  protected abstract buildTools(): Tool[];

  /**
   * Hook for branches whose tool surface depends on turn-scoped capability
   * state. It runs immediately before the initial prompt and before every
   * subsequent conversation pass, keeping prompt and tools on one snapshot.
   */
  protected prepareConversationTurn(): void {}

  protected async runConversation(): Promise<BranchRunOutcome> {
    if (!this.beginConversationPass()) {
      return { messages: this.messages };
    }
    this.prepareConversationTurn();
    if (!this.initialized) {
      this.messages.push(...await this.buildInitialMessages());
      this.initialized = true;
      this.logger.write('start', {
        message_count: this.messages.length,
        budget: this.getBudgetLogPayload(),
      });
    }

    const toolExecutor = new AgentToolExecutor(
      this.buildTools(),
      this.options.workingDirectory,
      {
        sessionId: `branch:${this.options.type}:${this.options.id}`,
        surface: 'agent',
        permissionProfile: 'strict',
        abortSignal: this.abortController.signal,
      },
    );
    const runner = new ConversationRunner(this.options.aiService, toolExecutor, {
      stream: false,
      enableCompression: true,
      maxTurns: normalizePositiveBudget(this.options.maxTurnsPerPass),
      maxContextTokens: normalizePositiveBudget(this.options.maxContextTokens),
      shouldContinue: () => this.shouldContinue(),
      toolExecutionContext: {
        sessionId: `branch:${this.options.type}:${this.options.id}`,
        surface: 'agent',
        permissionProfile: 'strict',
        workingDirectory: this.options.workingDirectory,
        workspaceRoot: this.options.workingDirectory,
        abortSignal: this.abortController.signal,
      },
    });

    const callbacks: RunnerCallbacks = {
      onThinking: text => this.logger.write('assistant_text', { text }),
      onToolStart: (name, toolUseId, input) => this.logger.write('tool_start', {
        name,
        tool_use_id: toolUseId,
        input: sanitizeBranchLogValue(input),
      }),
      onToolEnd: (name, toolUseId, result) => this.logger.write('tool_end', {
        name,
        tool_use_id: toolUseId,
        result: sanitizeBranchToolResult(name, result),
      }),
      onRetry: (attempt, maxRetries) => this.logger.write('retry', { attempt, max_retries: maxRetries }),
    };

    // Keep logging and provenance observation independent: a malformed
    // observer must never alter the branch's control flow.
    const originalOnToolStart = callbacks.onToolStart;
    callbacks.onToolStart = (name, toolUseId, input) => {
      try { this.onBranchToolStart(name, toolUseId, input); } catch { /* best effort */ }
      originalOnToolStart?.(name, toolUseId, input);
    };
    const originalOnToolEnd = callbacks.onToolEnd;
    callbacks.onToolEnd = (name, toolUseId, result) => {
      try { this.onBranchToolEnd(name, toolUseId, result); } catch { /* best effort */ }
      originalOnToolEnd?.(name, toolUseId, result);
    };

    try {
      const result = await runner.run(this.messages, callbacks);
      this.logger.write('run_result', {
        response: result.response,
        final_response_visible: result.finalResponseVisible,
        new_message_count: result.newMessages.length,
      });
      return { messages: this.messages, result };
    } finally {
      this.logger.write('transcript', { messages: sanitizeBranchLogValue(this.messages) });
    }
  }

  protected isAbortError(error: any): boolean {
    return error?.name === 'AbortError'
      || /aborted|aborterror|canceled|cancelled/i.test(String(error?.message || ''));
  }

  protected logFailure(error: any): void {
    this.logger.write('failed', {
      message: String(error?.message || error || 'unknown error'),
      name: error?.name,
    });
    if (!this.isAbortError(error)) {
      Logger.warning(`[branch:${this.options.type}:${this.options.id}] failed: ${error?.message || error}`);
    }
  }
}

function normalizePositiveBudget(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.floor(number);
}

export interface BranchSessionLoggerOptions {
  branchId: string;
  branchType: string;
  workingDirectory: string;
  enabled: boolean;
}

export class BranchSessionLogger {
  private readonly filePath: string | null;

  constructor(private readonly options: BranchSessionLoggerOptions) {
    if (!options.enabled) {
      this.filePath = null;
      return;
    }
    const date = new Date();
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const dir = PathResolver.getLogsPath('branches', options.branchType, dateStr);
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, `${sanitizeFilePart(options.branchId)}.jsonl`);
  }

  write(eventType: string, payload: Record<string, unknown> = {}): void {
    if (!this.filePath) return;
    const safePayload = sanitizeBranchLogValue(payload) as Record<string, unknown>;
    const entry = {
      entry_type: 'branch',
      branch_type: this.options.branchType,
      branch_id: this.options.branchId,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      ...safePayload,
    };
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
    } catch (error: any) {
      Logger.warning(`[branch:${this.options.branchType}:${this.options.branchId}] log write failed: ${error.message}`);
    }
  }
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'branch';
}

const MAX_BRANCH_LOG_TEXT = 24_000;
const MAX_BRANCH_LOG_ITEMS = 128;
const MAX_BRANCH_LOG_DEPTH = 8;

/**
 * Branch logs are local audit artifacts, not a credential store. Keep enough
 * shape for debugging while redacting capability selectors and receipts even
 * if a future CatsLog adapter accidentally returns an unprojected field.
 */
function sanitizeBranchLogValue(value: unknown, key?: string, depth = 0): unknown {
  if (key && isSensitiveLogKey(key)) return '[redacted]';
  if (depth >= MAX_BRANCH_LOG_DEPTH) return '[truncated]';
  if (typeof value === 'string') {
    // Tool arguments/results are often JSON-in-a-string. Parse those strings
    // opportunistically so nested receipt/token keys receive the same guard.
    if (key === 'arguments' || key === 'content' || key === 'result') {
      try {
        return JSON.stringify(sanitizeBranchLogValue(JSON.parse(value), undefined, depth + 1));
      } catch {
        // Preserve ordinary prose, but cap untrusted tool text.
      }
    }
    const scrubbed = scrubInlineSensitiveText(value);
    return scrubbed.length > MAX_BRANCH_LOG_TEXT
      ? `${scrubbed.slice(0, MAX_BRANCH_LOG_TEXT)}…[truncated]`
      : scrubbed;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_BRANCH_LOG_ITEMS).map(item => sanitizeBranchLogValue(item, undefined, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeBranchLogValue(entryValue, entryKey, depth + 1),
    ]));
  }
  return value;
}

function isSensitiveLogKey(key: string): boolean {
  // Normalize camelCase and punctuation before matching so both
  // `retrieval_receipt` and `retrievalReceipt` are covered without treating a
  // benign key such as `guid` as a UID selector.
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
  return /(?:^|_)(authorization|bearer|password|secret|token|receipt|api_key|uid|uids|scope|tenant|principal|credential|private_key)(?:_|$)/.test(normalized);
}

function scrubInlineSensitiveText(value: string): string {
  let scrubbed = value;
  // Catch labelled secrets in plain assistant text that cannot be handled by
  // object-key redaction (for example a model repeating a raw tool result).
  scrubbed = scrubbed.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]');
  scrubbed = scrubbed.replace(/((?:retrieval[_-]?receipt|skill[_-]?token|memory[_-]?write[_-]?token|access[_-]?token|api[_-]?key|password|secret)\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]');
  return scrubbed;
}

function sanitizeBranchToolResult(name: string, result: string): unknown {
  if (!name.startsWith('catslog_')) return result;
  // CatsLog tool projections are normally JSON. If an alternate adapter
  // returns plain text, keep only a bounded diagnostic rather than persisting
  // an opaque string that might contain a bearer or retrieval receipt.
  try {
    return JSON.stringify(sanitizeBranchLogValue(JSON.parse(result)));
  } catch {
    return `[catslog result redacted; length=${result.length}]`;
  }
}
