import * as fs from 'fs';
import * as path from 'path';
import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';
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
      enabled: options.logEnabled !== false,
    });
    options.signal?.addEventListener('abort', () => this.stop(), { once: true });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController.abort();
  }

  protected shouldContinue(): boolean {
    return !this.stopped
      && !this.abortController.signal.aborted
      && !this.options.signal?.aborted;
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
      const result = await runner.run(this.messages, callbacks);
      this.logger.write('run_result', {
        response: result.response,
        final_response_visible: result.finalResponseVisible,
        new_message_count: result.newMessages.length,
      });
      return { messages: this.messages, result };
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
    const dir = path.resolve(options.workingDirectory, 'logs', 'branches', options.branchType, dateStr);
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, `${sanitizeFilePart(options.branchId)}.jsonl`);
  }

  write(eventType: string, payload: Record<string, unknown> = {}): void {
    if (!this.filePath) return;
    const entry = {
      entry_type: 'branch',
      branch_type: this.options.branchType,
      branch_id: this.options.branchId,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      ...payload,
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
