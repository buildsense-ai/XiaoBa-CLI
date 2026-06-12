import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { SkillInvocationContext } from '../types/skill';
import { SkillExecutor } from '../skills/skill-executor';
import { ConversationRunner, RunnerCallbacks } from './conversation-runner';
import { PromptManager } from '../utils/prompt-manager';
import { Logger } from '../utils/logger';
import { SubAgentEventType, SubAgentRuntimeEvent } from './sub-agent-events';
import type { ToolExecutionConfirmationRequest, ToolExecutionConfirmationResult } from '../types/tool';
import * as fs from 'fs';
import * as path from 'path';

// ─── 类型定义 ───────────────────────────────────────────

export type SubAgentStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'waiting_for_input';
export type SubAgentType = 'skill' | 'explorer' | 'reviewer' | 'worker' | 'tester';
export type SubAgentToolScope = 'read_only' | 'workspace_write' | 'test_only';
export const SAFE_SUB_AGENT_TOOL_NAMES = [
  'read_file',
  'glob',
  'grep',
  'ask_parent',
  'write_file',
  'edit_file',
  'execute_shell',
] as const;
export type SafeSubAgentToolName = typeof SAFE_SUB_AGENT_TOOL_NAMES[number];

export interface SubAgentInfo {
  id: string;
  displayName?: string;
  agentType: SubAgentType;
  skillName: string;
  toolScope: SubAgentToolScope;
  taskDescription: string;
  status: SubAgentStatus;
  createdAt: number;
  completedAt?: number;
  /** 进度日志 */
  progressLog: string[];
  /** 最终结果摘要 */
  resultSummary?: string;
  /** 子智能体挂起时的待确认问题 */
  pendingQuestion?: string;
  /** 子智能体开始等待主 agent 回复的时间 */
  pendingQuestionSince?: number;
  /** 子智能体执行期间创建的产出文件路径 */
  outputFiles: string[];
  /** 子智能体实际可用工具，由主 agent 显式限制或 runtime 默认解析 */
  allowedTools: string[];
  /** 最近 runtime 事件（由 SubAgentManager 注入） */
  recentEvents?: SubAgentRuntimeEvent[];
  eventCount?: number;
  lastEventAt?: number;
}

export interface SubAgentSpawnOptions {
  displayName?: string;
  skillName?: string;
  agentType?: SubAgentType;
  toolScope?: SubAgentToolScope;
  taskDescription: string;
  userMessage: string;
  /** 主 agent 额外指定的子 agent 行为/角色指令 */
  subAgentPrompt?: string;
  /** 主 agent 显式指定的工具白名单；runtime 仍会过滤危险工具 */
  allowedTools?: readonly string[];
  /** 主 agent 显式指定的子 agent 工具推理轮次预算；不指定则不使用 runner 轮次上限 */
  maxTurns?: number;
  workingDirectory: string;
  /** 子智能体可使用的临时 scratch 目录，完成后会自动清理 */
  temporaryDirectory?: string;
  /** ask_parent 通道：子智能体挂起时向主 agent 投递问题，触发主 agent 推理 */
  notifyParent?: (subAgentId: string, taskDescription: string, question: string) => Promise<void>;
  /** event 通道：向 runtime 事件流写入结构化事件，供 UI/日志/状态 observation 消费 */
  emitEvent?: (type: SubAgentEventType, summary: string, payload?: Record<string, unknown>) => void;
}

// ─── SubAgentSession ────────────────────────────────────

/**
 * SubAgentSession - 独立运行的后台子智能体
 *
 * 拥有自己的 messages[]、ConversationRunner、skill 上下文。
 * 不直接和用户通信：
 * - 运行过程通过 event 通道给 UI/日志/状态 observation；
 * - ask_parent 通过 notifyParent 向主 agent 提问；
 * - 最终 result observation 由 SubAgentManager.finalizeSession() 回流父会话。
 * 主会话不 await 它，fire-and-forget。
 */
export class SubAgentSession {
  readonly id: string;
  readonly displayName?: string;
  readonly skillName: string;
  readonly agentType: SubAgentType;
  readonly toolScope: SubAgentToolScope;
  readonly taskDescription: string;
  readonly temporaryDirectory: string;
  readonly allowedTools: string[];
  status: SubAgentStatus = 'running';
  progressLog: string[] = [];
  resultSummary?: string;
  createdAt = Date.now();
  completedAt?: number;

  private messages: Message[] = [];
  private stopped = false;
  /** 子智能体执行期间创建的文件路径（用于自动发送产出） */
  private outputFiles: string[] = [];
  /** 挂起等待主 agent 回答的问题 */
  private pendingQuestion: string | null = null;
  private pendingQuestionSince: number | null = null;
  private pendingResolve: ((answer: string) => void) | null = null;
  private pendingWaitPromise: Promise<string> | null = null;
  private pendingReminderTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private abortController: AbortController | null = null;
  private terminalEventEmitted = false;

  // ─── 会话级重试配置 ──────────────────────────────────
  private static readonly SESSION_MAX_RETRIES = 2;
  private static readonly SESSION_RETRY_BASE_DELAY_MS = 5000;
  private static readonly PARENT_INPUT_REMINDER_MS = 60_000;

  private static isRetryableError(err: any): boolean {
    const msg = String(err?.message || '').toLowerCase();
    return /429|rate.?limit|too many requests|overloaded|频率|并发/.test(msg)
      || /\b50[023]\b|529/.test(msg)
      || /econnreset|etimedout|econnaborted/.test(msg);
  }

  constructor(
    id: string,
    private aiService: AIService,
    private skillManager: SkillManager,
    private options: SubAgentSpawnOptions,
  ) {
    this.id = id;
    this.displayName = normalizeOptionalString(options.displayName);
    this.agentType = resolveAgentType(options);
    this.skillName = options.skillName || this.agentType;
    this.toolScope = resolveToolScope(this.agentType, options.toolScope);
    this.taskDescription = options.taskDescription;
    this.temporaryDirectory = resolveTemporaryDirectory(options.workingDirectory, id, options.temporaryDirectory);
    this.allowedTools = resolveAllowedTools(this.toolScope, options.allowedTools);
  }

  /**
   * 后台执行（带会话级重试）。调用方不 await，fire-and-forget。
   */
  async run(): Promise<void> {
    let lastError: any;

    for (let attempt = 0; attempt <= SubAgentSession.SESSION_MAX_RETRIES; attempt++) {
      if (this.stopped) {
        this.status = 'stopped';
        this.completedAt = Date.now();
        this.emitTerminalEvent('agent_stopped', `任务已停止：${this.taskDescription}`);
        return;
      }

      // 重试前：等待 + 重置状态
      if (attempt > 0) {
        const delay = SubAgentSession.SESSION_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        Logger.warning(`[SubAgent ${this.id}] 第 ${attempt} 次重试，${delay}ms 后开始`);
        this.reportProgress(`第 ${attempt} 次重试（${lastError?.message}）`);
        await new Promise(resolve => setTimeout(resolve, delay));
        if (this.stopped) {
          this.status = 'stopped';
          this.completedAt = Date.now();
          this.emitTerminalEvent('agent_stopped', `任务已停止：${this.taskDescription}`);
          return;
        }
        this.messages = [];
        this.outputFiles = [];
      }

      try {
        await this._executeOnce();
        return; // 成功，直接返回
      } catch (err: any) {
        lastError = err;
        if (this.stopped) break;
        if (!SubAgentSession.isRetryableError(err) || attempt === SubAgentSession.SESSION_MAX_RETRIES) {
          break; // 不可重试 或 重试次数用尽
        }
        Logger.warning(`[SubAgent ${this.id}] 可重试错误: ${err.message}`);
      }
    }

    if (this.stopped) {
      this.status = 'stopped';
      this.completedAt = Date.now();
      this.resultSummary = '任务已停止';
      this.emitTerminalEvent('agent_stopped', `任务已停止：${this.taskDescription}`);
      Logger.info(`[SubAgent ${this.id}] 已停止: ${this.taskDescription}`);
      return;
    }

    // 最终失败
    this.status = this.stopped ? 'stopped' : 'failed';
    this.completedAt = Date.now();
    this.resultSummary = `执行失败: ${lastError?.message}`;
    this.emitTerminalEvent(this.stopped ? 'agent_stopped' : 'agent_failed', this.resultSummary);
    Logger.error(`[SubAgent ${this.id}] ${this.stopped ? '已停止' : '失败'}: ${lastError?.message}`);
  }

  /**
   * 单次执行核心逻辑（不含重试）
   */
  private async _executeOnce(): Promise<void> {
    this.abortController = new AbortController();

    // 1. 构建独立的 system prompt
    const systemPrompt = await PromptManager.buildSystemPrompt();
    this.messages.push({
      role: 'system',
      content: [
        systemPrompt,
        buildSubAgentSystemPrompt(this.agentType, this.toolScope, this.temporaryDirectory, this.allowedTools, this.options.subAgentPrompt, this.options.maxTurns),
      ].filter(Boolean).join('\n\n'),
    });
    await fs.promises.mkdir(this.temporaryDirectory, { recursive: true });

    // 2. 以 tool_result 形式注入 skill 内容（兼容旧 spawn_subagent(skill_name) 形式）
    const skill = this.options.skillName
      ? this.skillManager.getSkill(this.options.skillName)
      : null;
    if (this.options.skillName && !skill) {
      throw new Error(`Skill "${this.options.skillName}" 未找到`);
    }

    if (skill) {
      const invocationContext: SkillInvocationContext = {
        skillName: this.options.skillName!,
        arguments: [],
        rawArguments: '',
        userMessage: this.options.userMessage,
      };
      const skillToolCallId = `subagent-skill-${this.id}`;
      this.messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: skillToolCallId,
          type: 'function',
          function: {
            name: 'skill',
            arguments: JSON.stringify({ skill: this.options.skillName, args: '' }),
          },
        }],
      });
      this.messages.push({
        role: 'tool',
        content: SkillExecutor.execute(skill, invocationContext),
        tool_call_id: skillToolCallId,
        name: 'skill',
      });
    }

    // 3. 注入用户消息
    this.messages.push({ role: 'user', content: this.options.userMessage });

    // 4. 创建独立的 ToolManager
    const toolManager = new ToolManager(this.options.workingDirectory, {
      sessionId: `subagent:${this.id}`,
      surface: 'agent',
      permissionProfile: 'strict',
    }, {
      enabledToolNames: this.allowedTools,
    });

    // 创建独立的 ConversationRunner（不注入 channel，子智能体不直接和用户通信）
    const runner = new ConversationRunner(this.aiService, toolManager, {
      maxTurns: this.options.maxTurns,
      enableCompression: true,
      shouldContinue: () => !this.stopped,
      toolExecutionContext: {
        sessionId: `subagent:${this.id}`,
        surface: 'agent',
        permissionProfile: 'strict',
        abortSignal: this.abortController.signal,
        requestParentInput: (question: string) => this.waitForParentInput(question),
        confirmToolExecution: (request) => this.confirmSubAgentToolExecution(request),
      },
    });

    // 7. 用 callbacks 捕获进度。这里产生的是 runtime event，不是主 agent 最终结果。
    const callbacks: RunnerCallbacks = {
      onThinking: (thinking) => {
        this.emitEvent('agent_progress', thinking);
      },
      onToolStart: (name) => {
        this.emitEvent('agent_tool_start', `开始执行工具 ${name}`, { toolName: name });
      },
      onToolEnd: (name, _toolUseId, result) => {
        this.emitEvent('agent_tool_end', `工具 ${name} 完成：${truncateForEvent(result, 180)}`, {
          toolName: name,
        });
        this.detectAndReportProgress(name, result);
      },
    };

    this.reportProgress(`开始执行：${this.taskDescription}`);
    const runResult = await runner.run(this.messages, callbacks);
    if (this.stopped) {
      this.status = 'stopped';
      this.completedAt = Date.now();
      this.resultSummary = '任务已停止';
      this.emitTerminalEvent('agent_stopped', `任务已停止：${this.taskDescription}`);
      return;
    }

    // 8. 完成（不直接发用户消息/文件；只记录 resultSummary，由 Manager 压缩后回流主 agent）
    this.status = 'completed';
    this.completedAt = Date.now();
    this.resultSummary = compactResultSummary(buildResultSummary(runResult.response, this.messages, this.progressLog));
    this.emitTerminalEvent('agent_completed', truncateForEvent(this.resultSummary || '任务已完成', 600), {
      outputFiles: [...this.outputFiles],
    });

    Logger.success(`[SubAgent ${this.id}] 完成: ${this.taskDescription}`);
  }

  stop(): void {
    this.stopped = true;
    this.status = 'stopped';
    this.completedAt = Date.now();
    this.abortController?.abort();
    this.emitTerminalEvent('agent_stopped', `任务已停止：${this.taskDescription}`);
    // 如果正在挂起等待，解除阻塞
    if (this.pendingResolve) {
      this.pendingResolve('（任务已被停止）');
      this.pendingResolve = null;
      this.pendingQuestion = null;
      this.pendingQuestionSince = null;
      this.pendingWaitPromise = null;
    }
    this.clearParentInputReminder();
  }

  /**
   * 恢复挂起的子智能体（由主 agent 通过 resume_subagent 调用）
   * @returns 是否成功恢复
   */
  resume(answer: string): boolean {
    if (!this.pendingResolve || this.status !== 'waiting_for_input') {
      return false;
    }
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.pendingQuestion = null;
    this.pendingQuestionSince = null;
    this.clearParentInputReminder();
    this.status = 'running';
    this.reportProgress(`收到回复，继续执行`);
    resolve(answer);
    return true;
  }

  getInfo(): SubAgentInfo {
    return {
      id: this.id,
      displayName: this.displayName,
      skillName: this.skillName,
      taskDescription: this.taskDescription,
      status: this.status,
      createdAt: this.createdAt,
      completedAt: this.completedAt,
      agentType: this.agentType,
      toolScope: this.toolScope,
      progressLog: [...this.progressLog],
      resultSummary: this.resultSummary,
      pendingQuestion: this.pendingQuestion ?? undefined,
      pendingQuestionSince: this.pendingQuestionSince ?? undefined,
      outputFiles: [...this.outputFiles],
      allowedTools: [...this.allowedTools],
    };
  }

  private async waitForParentInput(question: string): Promise<string> {
    const normalizedQuestion = String(question || '').trim();
    if (!normalizedQuestion) {
      throw new Error('ask_parent question 不能为空');
    }
    if (!this.options.notifyParent) {
      throw new Error('当前平台未注册主 agent 通知回调，无法等待补充信息');
    }
    if (this.pendingWaitPromise) {
      throw new Error('已有一个等待中的 ask_parent 问题');
    }

    this.pendingQuestion = normalizedQuestion;
    this.pendingQuestionSince = Date.now();
    this.status = 'waiting_for_input';
    this.emitEvent('agent_waiting', `等待主 agent 回复：${truncateForEvent(normalizedQuestion, 180)}`, {
      question: normalizedQuestion,
    });
    this.startParentInputReminder(normalizedQuestion);

    this.pendingWaitPromise = new Promise<string>((resolve) => {
      this.pendingResolve = resolve;
    });

    try {
      await this.options.notifyParent(this.id, this.taskDescription, normalizedQuestion);
      const answer = await this.pendingWaitPromise;
      if (this.stopped) {
        throw new Error('任务已停止');
      }
      this.status = 'running';
      this.pendingQuestionSince = null;
      this.clearParentInputReminder();
      return answer;
    } catch (error) {
      if (!this.stopped) {
        this.status = 'running';
      }
      this.pendingResolve = null;
      this.pendingQuestion = null;
      this.pendingQuestionSince = null;
      this.pendingWaitPromise = null;
      this.clearParentInputReminder();
      throw error;
    }
  }

  private async confirmSubAgentToolExecution(
    request: ToolExecutionConfirmationRequest,
  ): Promise<ToolExecutionConfirmationResult> {
    if (!this.options.notifyParent) {
      return { approved: false, reason: '当前子智能体没有主会话确认通道，已取消该工具调用。' };
    }
    const argsPreview = JSON.stringify(request.args ?? {});
    const question = [
      `子智能体「${this.displayName || this.id}」想执行 ${request.toolName}。`,
      `风险等级: ${request.risk}`,
      request.reason,
      argsPreview && argsPreview !== '{}' ? `参数: ${argsPreview.slice(0, 500)}${argsPreview.length > 500 ? '...' : ''}` : '',
      '请回复“确认/允许/yes”批准，或回复其他内容取消。',
    ].filter(Boolean).join('\n');
    const answer = await this.waitForParentInput(question);
    const normalized = String(answer || '').trim().toLowerCase();
    const approved = normalized === 'y'
      || normalized === 'yes'
      || normalized === 'ok'
      || normalized === 'approve'
      || normalized.includes('确认')
      || normalized.includes('允许')
      || normalized.includes('同意')
      || normalized.includes('批准');
    return approved
      ? { approved: true }
      : { approved: false, reason: `主会话未确认 ${request.toolName}，已取消。` };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    await this.cleanupTemporaryDirectory();
    this.messages = [];
    this.pendingResolve = null;
    this.pendingQuestion = null;
    this.pendingQuestionSince = null;
    this.pendingWaitPromise = null;
    this.clearParentInputReminder();
    this.abortController = null;
  }

  // ─── 私有方法 ──────────────────────────────────────

  private reportProgress(message: string): void {
    this.progressLog.push(message);
    this.emitEvent('agent_progress', message);
    // 仅记录到 progressLog，不推飞书
    // 主 agent 通过 check_subagent 查看进度后自行决定是否告知用户
  }

  private startParentInputReminder(question: string): void {
    this.clearParentInputReminder();
    this.pendingReminderTimer = setInterval(() => {
      if (this.closed || this.stopped || this.status !== 'waiting_for_input') {
        this.clearParentInputReminder();
        return;
      }
      const waitingMs = this.pendingQuestionSince ? Date.now() - this.pendingQuestionSince : 0;
      this.emitEvent('agent_waiting', `仍在等待主 agent 回复：${truncateForEvent(question, 180)}`, {
        question,
        waitingMs,
        reminder: true,
      });
    }, SubAgentSession.PARENT_INPUT_REMINDER_MS);
    this.pendingReminderTimer.unref?.();
  }

  private clearParentInputReminder(): void {
    if (this.pendingReminderTimer) {
      clearInterval(this.pendingReminderTimer);
      this.pendingReminderTimer = null;
    }
  }

  private detectAndReportProgress(toolName: string, result: string): void {
    // 从工具结果中提取文件路径，用于自动发送产出
    if (toolName === 'write_file' || toolName === 'pptx_generator') {
      const filePath = this.extractFilePath(toolName, result);
      if (filePath) {
        this.outputFiles.push(filePath);
        this.emitEvent('artifact_update', `产出文件：${filePath}`, {
          filePath,
          toolName,
        });
      }
    }

    // 记录有意义的进度（基于章节分析文件，而非所有 write_file）
    if (toolName === 'write_file' && result.includes('chapters/')) {
      const match = result.match(/chapters\/\d+_([^/]+)\//);
      const chapterSlug = match ? match[1] : null;
      this.reportProgress(chapterSlug ? `已完成章节: ${chapterSlug}` : `已完成 ${this.progressLog.length} 个阶段`);
    } else if (toolName === 'pptx_generator') {
      this.reportProgress('PPT 生成完成');
    } else if (toolName === 'write_file' && result.includes('summary.md')) {
      this.reportProgress('全文总结完成');
    }
  }

  /** 从工具结果中提取文件路径 */
  private extractFilePath(toolName: string, result: string): string | null {
    if (toolName === 'pptx_generator') {
      // pptx_generator 返回 JSON，包含 output_path
      try {
        const parsed = JSON.parse(result);
        return parsed.output_path || null;
      } catch {
        return null;
      }
    }
    // write_file 返回格式: "成功创建文件: <path>\n..."
    const match = result.match(/成功(?:创建|覆盖)文件:\s*(.+?)(?:\n|$)/);
    return match ? match[1].trim() : null;
  }

  private emitEvent(type: SubAgentEventType, summary: string, payload?: Record<string, unknown>): void {
    this.options.emitEvent?.(type, truncateForEvent(summary, 800), payload);
  }

  private emitTerminalEvent(type: SubAgentEventType, summary: string, payload?: Record<string, unknown>): void {
    if (this.terminalEventEmitted) return;
    this.terminalEventEmitted = true;
    this.emitEvent(type, summary, payload);
  }

  private async cleanupTemporaryDirectory(): Promise<void> {
    const tempDir = path.resolve(this.temporaryDirectory);
    if (!isSafeSubAgentTempDirectory(this.options.workingDirectory, tempDir, this.id)) {
      Logger.warning(`[SubAgent ${this.id}] 跳过临时目录清理，路径不在安全范围内: ${tempDir}`);
      return;
    }

    try {
      await fs.promises.access(tempDir);
    } catch {
      return;
    }

    const preservedOutputs = this.outputFiles
      .map(filePath => path.resolve(this.options.workingDirectory, filePath))
      .filter(filePath => isSameOrInside(tempDir, filePath));

    try {
      if (preservedOutputs.length === 0) {
        await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
        this.emitEvent('agent_progress', '临时目录已清理', { temporaryDirectory: tempDir });
        return;
      }

      const stats = await removeTemporaryEntriesExceptOutputs(tempDir, preservedOutputs);
      this.emitEvent('agent_progress', `临时目录已清理，保留 ${stats.preservedFiles} 个产出文件`, {
        temporaryDirectory: tempDir,
        deletedFiles: stats.deletedFiles,
        deletedDirectories: stats.deletedDirectories,
        preservedFiles: stats.preservedFiles,
      });
    } catch (error: any) {
      Logger.warning(`[SubAgent ${this.id}] 临时目录清理失败: ${error.message}`);
      this.emitEvent('agent_progress', `临时目录清理失败：${error.message}`, {
        temporaryDirectory: tempDir,
      });
    }
  }
}

function resolveAgentType(options: SubAgentSpawnOptions): SubAgentType {
  if (options.agentType) return options.agentType;
  return options.skillName ? 'skill' : 'worker';
}

function normalizeOptionalString(value: unknown): string | undefined {
  const text = String(value || '').trim();
  return text || undefined;
}

function resolveToolScope(agentType: SubAgentType, explicit?: SubAgentToolScope): SubAgentToolScope {
  if (explicit) return explicit;
  if (agentType === 'worker' || agentType === 'skill') return 'workspace_write';
  if (agentType === 'tester') return 'test_only';
  return 'read_only';
}

function defaultToolsForScope(scope: SubAgentToolScope): string[] {
  const readOnly = ['read_file', 'glob', 'grep', 'ask_parent'];
  if (scope === 'read_only') return readOnly;
  if (scope === 'test_only') return [...readOnly, 'execute_shell'];
  return [...readOnly, 'write_file', 'edit_file', 'execute_shell'];
}

function resolveAllowedTools(scope: SubAgentToolScope, requestedTools?: readonly string[]): string[] {
  const tools = requestedTools ?? defaultToolsForScope(scope);
  const safeTools = new Set<string>(SAFE_SUB_AGENT_TOOL_NAMES);
  const scopedTools = new Set(defaultToolsForScope(scope));
  return Array.from(new Set(
    tools
      .map(tool => String(tool).trim())
      .filter(tool => safeTools.has(tool) && scopedTools.has(tool))
  ));
}

function buildSubAgentSystemPrompt(
  agentType: SubAgentType,
  toolScope: SubAgentToolScope,
  temporaryDirectory: string,
  allowedTools: readonly string[],
  subAgentPrompt?: string,
  maxTurns?: number,
): string {
  const roleLine = agentRoleLine(agentType);
  return [
    '[subagent_runtime]',
    roleLine,
    '你只会看到主 agent 传入的任务和上下文，不会自动继承主会话完整历史；不要假设有未提供的信息。',
    '你是后台子智能体，不直接面向用户输出消息，也不调用 send_text/send_file。',
    '把高噪音探索、工具输出和中间推理保留在你自己的上下文里；最终只输出简明结果、关键证据、风险和产物路径。',
    `临时 scratch 目录: ${temporaryDirectory}。中间文件放这里；需要长期保留或交付给用户的产物不要只放在 scratch 目录中。`,
    allowedTools.includes('ask_parent')
      ? '如果信息不足，先基于可用工具自行调查；只有真正需要主 agent 或用户决策时才用 ask_parent 明确提出问题并等待恢复。'
      : '如果信息不足，先基于可用工具自行调查；本次未授权 ask_parent，请在最终结果里说明缺口和需要主 agent 判断的事项。',
    `工具权限范围: ${toolScope}。实际可用工具: ${allowedTools.length > 0 ? allowedTools.join(', ') : '无'}。不要尝试派生新的子智能体。`,
    maxTurns
      ? `本次主 agent 设置的工具推理轮次预算: ${maxTurns}。接近预算时请优先总结已知结论和缺口。`
      : '本次没有固定的类型轮次上限；由你自己在信息足够时及时总结结束。',
    subAgentPrompt ? `主 agent 额外指令:\n${subAgentPrompt.trim()}` : '',
  ].join('\n');
}

function agentRoleLine(agentType: SubAgentType): string {
  switch (agentType) {
    case 'explorer':
      return '角色: explorer。只读探索代码和事实，输出路径、证据和结论，不修改文件。';
    case 'reviewer':
      return '角色: reviewer。审查风险、缺陷、测试缺口和可维护性问题，不修改文件。';
    case 'tester':
      return '角色: tester。运行必要测试或检查命令，聚焦失败原因和可复现输出，不修改源码。';
    case 'worker':
      return '角色: worker。可以在授权范围内做小而清晰的实现改动，并说明改了哪些文件。';
    case 'skill':
      return '角色: skill worker。按照已激活 skill 的流程完成任务，并给出压缩结果。';
    default:
      return '角色: background worker。完成独立子任务并返回压缩结果。';
  }
}

function truncateForEvent(text: string, maxLength: number): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}... [truncated]`;
}

function compactResultSummary(text: string, maxLength = 4000): string {
  const normalized = String(text || '').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}\n...[已压缩，原始 ${normalized.length} 字符；需要细节请让主 agent 用 check_subagent 或重新读取相关文件]`;
}

function buildResultSummary(response: string, messages: Message[], progressLog: string[]): string {
  const direct = String(response || '').trim();
  if (direct) return direct;

  const lastAssistantMessage = [...messages].reverse().find(message => (
    message.role === 'assistant'
    && typeof message.content === 'string'
    && message.content.trim()
    && (!message.tool_calls || message.tool_calls.length === 0)
  ));
  const lastAssistantText = typeof lastAssistantMessage?.content === 'string'
    ? lastAssistantMessage.content.trim()
    : '';
  if (lastAssistantText) {
    return lastAssistantText;
  }

  const recentProgress = progressLog.slice(-5).map(item => item.trim()).filter(Boolean);
  if (recentProgress.length > 0) {
    return [
      '未形成最终摘要，可能是在停止、错误或仍在探索时结束。',
      '最近进度：',
      ...recentProgress.map(item => `- ${item}`),
      '建议主 agent 用 check_subagent 查看最近事件，或派发更小范围的子任务。',
    ].join('\n');
  }

  return '未形成最终摘要，可能是在停止、错误或仍在探索时结束。建议主 agent 用 check_subagent 查看最近事件，或重新派发更小范围的子任务。';
}

function resolveTemporaryDirectory(workingDirectory: string, subAgentId: string, explicit?: string): string {
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.resolve(workingDirectory, 'tmp', 'subagents', subAgentId);
}

function isSafeSubAgentTempDirectory(workingDirectory: string, tempDir: string, subAgentId: string): boolean {
  const expectedRoot = path.resolve(workingDirectory, 'tmp', 'subagents');
  return path.basename(tempDir) === subAgentId && isSameOrInside(expectedRoot, tempDir);
}

function isSameOrInside(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const relative = path.relative(resolvedParent, resolvedChild);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

interface TempCleanupStats {
  deletedFiles: number;
  deletedDirectories: number;
  preservedFiles: number;
}

async function removeTemporaryEntriesExceptOutputs(
  targetPath: string,
  preservedOutputs: string[],
): Promise<TempCleanupStats> {
  const stats: TempCleanupStats = {
    deletedFiles: 0,
    deletedDirectories: 0,
    preservedFiles: 0,
  };
  await removeTemporaryPath(targetPath, preservedOutputs.map(filePath => path.resolve(filePath)), stats);
  return stats;
}

async function removeTemporaryPath(
  targetPath: string,
  preservedOutputs: string[],
  stats: TempCleanupStats,
): Promise<void> {
  const resolvedTarget = path.resolve(targetPath);
  const isPreservedFile = preservedOutputs.some(filePath => path.resolve(filePath) === resolvedTarget);
  const containsPreservedOutput = preservedOutputs.some(filePath => isSameOrInside(resolvedTarget, filePath));

  let entryStats: fs.Stats;
  try {
    entryStats = await fs.promises.lstat(resolvedTarget);
  } catch {
    return;
  }

  if (isPreservedFile) {
    stats.preservedFiles += 1;
    return;
  }

  if (!entryStats.isDirectory() || entryStats.isSymbolicLink()) {
    await fs.promises.rm(resolvedTarget, { force: true });
    stats.deletedFiles += 1;
    return;
  }

  if (!containsPreservedOutput) {
    await fs.promises.rm(resolvedTarget, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    stats.deletedDirectories += 1;
    return;
  }

  const entries = await fs.promises.readdir(resolvedTarget);
  for (const entry of entries) {
    await removeTemporaryPath(path.join(resolvedTarget, entry), preservedOutputs, stats);
  }

  try {
    await fs.promises.rmdir(resolvedTarget);
    stats.deletedDirectories += 1;
  } catch (error: any) {
    if (error?.code !== 'ENOTEMPTY') {
      throw error;
    }
  }
}
