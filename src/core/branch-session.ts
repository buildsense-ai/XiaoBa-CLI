import * as fs from 'fs';
import * as path from 'path';
import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';
import { PathResolver } from '../utils/path-resolver';
import { Tool } from '../types/tool';
import { AgentToolExecutor } from '../agents/agent-tool-executor';
import { ConversationRunner, RunResult, RunnerCallbacks } from './conversation-runner';

export type BranchSessionAbortReason = 'review-timeout' | 'runtime-shutdown' | 'turn_budget_exhausted';
export type BranchTranscriptContract = 'required' | 'best-effort';

export interface SharedReviewTurnBudget {
  remainingTurns: number;
}

export interface BranchSessionOptions {
  id: string;
  type: string;
  aiService: AIService;
  workingDirectory: string;
  /** Runtime-owned root for all branch transcripts. */
  branchLogRoot?: string;
  signal?: AbortSignal;
  logEnabled?: boolean;
  transcriptContract?: BranchTranscriptContract;
  sharedReviewTurnBudget?: SharedReviewTurnBudget;
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

  protected constructor(protected readonly options: BranchSessionOptions) {
    this.logger = new BranchSessionLogger({
      branchId: options.id,
      branchType: options.type,
      workingDirectory: options.workingDirectory,
      branchLogRoot: options.branchLogRoot ?? PathResolver.getLogsPath('branches'),
      enabled: options.logEnabled !== false,
      contract: options.transcriptContract ?? 'best-effort',
    });
    if (options.signal?.aborted) {
      this.stop(this.extractAbortReason(options.signal.reason) ?? 'runtime-shutdown');
      return;
    }
    options.signal?.addEventListener('abort', () => {
      this.stop(this.extractAbortReason(options.signal?.reason) ?? 'runtime-shutdown');
    }, { once: true });
  }

  stop(reason: BranchSessionAbortReason = 'runtime-shutdown'): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController.abort(reason);
  }

  private extractAbortReason(value: unknown): BranchSessionAbortReason | undefined {
    if (value === 'review-timeout') return 'review-timeout';
    if (value === 'runtime-shutdown') return 'runtime-shutdown';
    if (value === 'turn_budget_exhausted') return 'turn_budget_exhausted';
    return undefined;
  }

  private resolveAbortReason(): BranchSessionAbortReason | undefined {
    if (this.options.signal?.aborted) {
      return this.extractAbortReason(this.options.signal.reason) ?? 'runtime-shutdown';
    }
    if (this.abortController.signal.aborted) {
      return this.extractAbortReason(this.abortController.signal.reason) ?? 'runtime-shutdown';
    }
    return undefined;
  }

  protected throwAbortError(message = 'Review branch was aborted.'): never {
    const reason = this.resolveAbortReason() ?? 'runtime-shutdown';
    throw new BranchSessionAbortError(reason, message);
  }

  protected deductTurnBudget(turnsUsed: number): void {
    if (!this.options.sharedReviewTurnBudget) return;
    this.options.sharedReviewTurnBudget.remainingTurns = Math.max(
      0,
      this.options.sharedReviewTurnBudget.remainingTurns - turnsUsed,
    );
  }

  protected shouldContinue(): boolean {
    return !this.stopped
      && !this.abortController.signal.aborted
      && !this.options.signal?.aborted;
  }

  /** Runtime audit path for constrained branches. */
  protected getBranchTranscriptPath(): string | null {
    return this.logger.getFilePath();
  }

  protected abstract buildInitialMessages(): Promise<Message[]>;
  protected abstract buildTools(): Tool[];

  protected async runConversation(): Promise<BranchRunOutcome> {
    if (!this.initialized) {
      this.messages.push(...await this.buildInitialMessages());
      this.initialized = true;
      this.logger.write('start', {
        message_count: this.messages.length,
      });
    }
    if (this.options.sharedReviewTurnBudget && this.options.sharedReviewTurnBudget.remainingTurns <= 0) {
      throw new BranchSessionAbortError(
        'turn_budget_exhausted',
        'The shared review attempt model-turn budget is exhausted.',
      );
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
        input,
      }),
      onToolEnd: (name, toolUseId, result) => this.logger.write('tool_end', {
        name,
        tool_use_id: toolUseId,
        result,
      }),
      onRetry: (attempt, maxRetries) => this.logger.write('retry', { attempt, max_retries: maxRetries }),
    };

    try {
      const maxTurns = this.options.sharedReviewTurnBudget?.remainingTurns;
      const result = await runner.run(this.messages, {
        ...callbacks,
        ...(maxTurns && { maxTurns }),
      });
      this.deductTurnBudget(result.turnsUsed);
      if (result.maxTurnsReached) {
        this.logger.write('run_result', {
          response: result.response,
          final_response_visible: result.finalResponseVisible,
          turns_used: result.turnsUsed,
          max_turns: result.maxTurns,
          max_turns_reached: result.maxTurnsReached,
          remaining_turns: this.options.sharedReviewTurnBudget?.remainingTurns,
        });
        throw new BranchSessionAbortError('turn_budget_exhausted', 'The shared review attempt model-turn budget was exhausted.');
      }
      this.logger.write('run_result', {
        response: result.response,
        final_response_visible: result.finalResponseVisible,
        new_message_count: result.newMessages.length,
      });
      return { messages: this.messages, result };
    } catch (error) {
      if (error instanceof BranchSessionAbortError) throw error;
      if (this.isAbortError(error) || !this.shouldContinue()) {
        this.throwAbortError();
      }
      throw error;
    } finally {
      this.logger.write('transcript', { messages: this.messages });
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

export class BranchSessionAbortError extends Error {
  constructor(public readonly reason: BranchSessionAbortReason, message: string) {
    super(message);
    this.name = 'BranchSessionAbortError';
  }
}

export interface BranchSessionLoggerOptions {
  branchId: string;
  branchType: string;
  workingDirectory: string;
  branchLogRoot: string;
  enabled: boolean;
  contract: BranchTranscriptContract;
}

export class BranchSessionLogger {
  private readonly filePath: string | null;

  constructor(private readonly options: BranchSessionLoggerOptions) {
    if (!options.enabled) {
      this.filePath = null;
      return;
    }
    try {
      const date = new Date();
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const root = path.resolve(options.branchLogRoot);
      const typeDir = path.join(root, sanitizeFilePart(options.branchType));
      const dir = path.join(typeDir, dateStr);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      fs.chmodSync(root, 0o700);
      fs.mkdirSync(typeDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(typeDir, 0o700);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      this.filePath = path.join(dir, `${sanitizeFilePart(options.branchId)}.jsonl`);
    } catch (error: any) {
      this.filePath = null;
      Logger.warning(`[branch:${options.branchType}:${options.branchId}] log setup failed: ${error.message}`);
      if (options.contract === 'required') throw error;
    }
  }

  write(eventType: string, payload: Record<string, unknown> = {}): void {
    if (!this.filePath) return;
    const entry = redactRecord({
      entry_type: 'branch',
      branch_type: this.options.branchType,
      branch_id: this.options.branchId,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      ...payload,
    });
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.chmodSync(this.filePath, 0o600);
    } catch (error: any) {
      Logger.warning(`[branch:${this.options.branchType}:${this.options.branchId}] log write failed: ${error.message}`);
      if (this.options.contract === 'required') throw error;
    }
  }

  getFilePath(): string | null {
    return this.filePath;
  }
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'branch';
}

const CREDENTIAL_FIELD_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|credential)/i;
const CREDENTIAL_ASSIGNMENT_PATTERN = /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|credential)\s*[:=]\s*["']?)[^\s,"'}\]]+/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const TOKEN_PATTERN = /\b(?:sk|rk|xox[baprs])-[-_A-Za-z0-9]{8,}\b/g;

function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return redactValue(record) as Record<string, unknown>;
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && CREDENTIAL_FIELD_PATTERN.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(item => redactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactValue(childValue, childKey),
    ]));
  }
  return value;
}

function redactString(value: string): string {
  let redacted = value;
  for (const credential of knownCredentialValues()) {
    redacted = redacted.split(credential).join('[REDACTED]');
  }
  return redacted
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, '$1[REDACTED]')
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(TOKEN_PATTERN, '[REDACTED]');
}

function knownCredentialValues(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => value && CREDENTIAL_FIELD_PATTERN.test(key) && value.length >= 6)
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
}
