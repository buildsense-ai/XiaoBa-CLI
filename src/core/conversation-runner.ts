import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { SkillActivationSignal, SkillToolPolicy } from '../types/skill';
import { ToolCall, ToolDefinition, ToolExecutionContext, ToolExecutor } from '../types/tool';
import { StreamCallbacks } from '../providers/provider';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';
import { ContextCompressor } from './context-compressor';
import { estimateMessagesTokens, estimateToolsTokens } from './token-estimator';
import {
  parseSkillActivationSignal,
  upsertSkillSystemMessage,
} from '../skills/skill-activation-protocol';

const ESSENTIAL_TOOLS = new Set([
  'skill',
]);

const DEFAULT_PROMPT_BUDGET = 120000;
const ANTHROPIC_PROMPT_BUDGET = 180000;
const MIN_MESSAGE_BUDGET = 2000;
const OVERFLOW_REDUCTION_RATIO = 0.6;

/**
 * 对话运行回调
 */
export interface RunnerCallbacks {
  /** 流式文本片段 */
  onText?: (text: string) => void;
  /** 工具开始执行 */
  onToolStart?: (name: string) => void;
  /** 工具执行完成 */
  onToolEnd?: (name: string, result: string) => void;
  /** 需要显示工具输出（如 task_planner） */
  onToolDisplay?: (name: string, content: string) => void;
}

/**
 * 对话运行结果
 */
export interface RunResult {
  /** 最终文本回复 */
  response: string;
  /** 完整的消息列表（包含工具调用中间过程） */
  messages: Message[];
  /** 本次 run() 期间新增的 assistant/tool 消息（不含最终纯文本回复） */
  newMessages: Message[];
}

/** ConversationRunner 构造选项 */
export interface RunnerOptions {
  maxTurns?: number;
  maxContextTokens?: number;
  /** false 时用 aiService.chat() 代替 chatStream()（默认 true） */
  stream?: boolean;
  /** 供 agent 检查 stop 状态，返回 false 时提前退出循环 */
  shouldContinue?: () => boolean;
  /** 是否启用上下文压缩（默认 true，agent 用 false） */
  enableCompression?: boolean;
  /** 透传给 ToolExecutor 的执行上下文（session/run/surface 等） */
  toolExecutionContext?: Partial<ToolExecutionContext>;
  /** 会话已激活 skill 名称（可选） */
  initialSkillName?: string;
  /** 会话初始 skill 工具策略（可选） */
  initialSkillToolPolicy?: SkillToolPolicy;
}

/**
 * ConversationRunner - 核心对话循环
 *
 * 封装 "发送消息 → 检查工具调用 → 执行工具 → 回传结果 → 继续推理" 的循环。
 * 依赖 ToolExecutor 抽象，同时支持 ToolManager（主会话）和 AgentToolExecutor（子 agent）。
 */
export class ConversationRunner {
  private maxTurns: number;
  private compressor: ContextCompressor;
  private stream: boolean;
  private shouldContinue?: () => boolean;
  private enableCompression: boolean;
  private toolExecutionContext?: Partial<ToolExecutionContext>;
  private activeSkillName?: string;
  private activeSkillToolPolicy?: SkillToolPolicy;
  private maxPromptTokens: number;

  constructor(
    private aiService: AIService,
    private toolExecutor: ToolExecutor,
    options?: RunnerOptions,
  ) {
    this.maxTurns = options?.maxTurns ?? 150;
    this.stream = options?.stream ?? true;
    this.shouldContinue = options?.shouldContinue;
    this.enableCompression = options?.enableCompression ?? true;
    this.toolExecutionContext = options?.toolExecutionContext;
    this.activeSkillName = options?.initialSkillName;
    this.activeSkillToolPolicy = options?.initialSkillToolPolicy;
    this.maxPromptTokens = this.resolvePromptBudget(options?.maxContextTokens);
    this.compressor = new ContextCompressor({
      maxContextTokens: options?.maxContextTokens,
    });
  }

  /**
   * 执行对话循环
   * @param messages 当前消息列表（会被原地修改，追加工具调用中间消息）
   * @param callbacks 可选的 UI 回调
   * @returns 最终文本回复和完整消息列表
   */
  async run(messages: Message[], callbacks?: RunnerCallbacks): Promise<RunResult> {
    const allTools = this.toolExecutor.getToolDefinitions();
    const newMessages: Message[] = [];
    let turns = 0;

    while (turns++ < this.maxTurns) {
      // shouldContinue 回调检查（供 agent 检查 stop 状态）
      if (this.shouldContinue && !this.shouldContinue()) {
        break;
      }

      // ===== 上下文压缩检查（可选） =====
      if (this.enableCompression && this.compressor.needsCompaction(messages)) {
        const usage = this.compressor.getUsageInfo(messages);
        Logger.info(`上下文使用率 ${usage.usagePercent}%，触发压缩...`);
        const compacted = this.compressor.compact(messages);
        // 原地替换 messages 内容（保持外部引用有效）
        messages.length = 0;
        messages.push(...compacted);
      }

      // 根据 stream 选项选择调用方式
      const activeTools = this.applyToolPolicy(allTools, this.activeSkillToolPolicy);
      this.ensurePromptBudget(messages, activeTools);
      const response = await this.requestModelResponse(messages, activeTools, callbacks);

      // 记录 AI 调用 metrics
      if (response.usage) {
        Metrics.recordAICall(this.stream ? 'stream' : 'chat', response.usage);
      }

      // 没有工具调用，返回最终回复
      if (!response.toolCalls || response.toolCalls.length === 0) {
        return {
          response: response.content || '',
          messages,
          newMessages
        };
      }

      // 有工具调用 → 追加 assistant 消息
      const assistantMsg: Message = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls
      };
      messages.push(assistantMsg);
      newMessages.push(assistantMsg);

      // 执行每个工具调用
      for (const toolCall of response.toolCalls) {
        callbacks?.onToolStart?.(toolCall.function.name);
        const activeToolNames = this.applyToolPolicy(allTools, this.activeSkillToolPolicy)
          .map(tool => tool.name);

        const toolStart = Date.now();
        const result = await this.toolExecutor.executeTool(
          toolCall,
          messages,
          {
            ...this.toolExecutionContext,
            activeSkillName: this.activeSkillName,
            allowedToolNames: activeToolNames,
            blockedToolNames: this.activeSkillToolPolicy?.allowedTools
              ? undefined
              : this.activeSkillToolPolicy?.disallowedTools,
          },
        );
        Metrics.recordToolCall(toolCall.function.name, Date.now() - toolStart);

        let toolContent = result.content;

        // skill 工具的结构化激活信号：统一 skill 激活行为
        const activation = this.tryParseSkillActivation(toolCall, result.content);
        if (activation) {
          this.activeSkillName = activation.skillName;
          this.activeSkillToolPolicy = activation.toolPolicy;

          if (activation.maxTurns && activation.maxTurns > 0) {
            this.maxTurns = Math.max(this.maxTurns, turns + activation.maxTurns);
          }

          const systemMsg = upsertSkillSystemMessage(messages, activation);
          newMessages.push(systemMsg);

          toolContent = `Skill "${activation.skillName}" 已激活`;
        }

        this.handleToolDisplay(toolCall, toolContent, callbacks);

        const toolMsg: Message = {
          role: 'tool',
          content: toolContent,
          tool_call_id: result.tool_call_id,
          name: result.name
        };
        messages.push(toolMsg);
        newMessages.push(toolMsg);

        callbacks?.onToolEnd?.(toolCall.function.name, toolContent);
      }
    }

    Logger.warning(`达到最大工具调用轮次 (${this.maxTurns})`);
    return {
      response: '[达到最大工具调用轮次，请继续对话]',
      messages,
      newMessages
    };
  }

  /**
   * 处理需要显示输出的工具
   */
  private handleToolDisplay(toolCall: ToolCall, content: string, callbacks?: RunnerCallbacks): void {
    if (toolCall.function.name === 'task_planner' && callbacks?.onToolDisplay) {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        if (args.action === 'create' || args.action === 'update') {
          callbacks.onToolDisplay(toolCall.function.name, content);
        }
      } catch {
        callbacks.onToolDisplay(toolCall.function.name, content);
      }
    }
  }

  private tryParseSkillActivation(
    toolCall: ToolCall,
    content: string,
  ): SkillActivationSignal | null {
    if (toolCall.function.name !== 'skill') {
      return null;
    }

    return parseSkillActivationSignal(content);
  }

  private applyToolPolicy(allTools: ToolDefinition[], policy?: SkillToolPolicy): ToolDefinition[] {
    if (!policy) {
      return allTools;
    }

    if (policy.allowedTools && policy.allowedTools.length > 0) {
      const allowed = new Set(policy.allowedTools.map(name => String(name).trim()).filter(Boolean));
      for (const essential of ESSENTIAL_TOOLS) {
        allowed.add(essential);
      }
      return allTools.filter(tool => allowed.has(tool.name));
    }

    if (policy.disallowedTools && policy.disallowedTools.length > 0) {
      const blocked = new Set(
        policy.disallowedTools
          .map(name => String(name).trim())
          .filter(name => Boolean(name) && !ESSENTIAL_TOOLS.has(name)),
      );
      return allTools.filter(tool => !blocked.has(tool.name));
    }

    return allTools;
  }

  private async requestModelResponse(
    messages: Message[],
    activeTools: ToolDefinition[],
    callbacks?: RunnerCallbacks,
  ) {
    try {
      if (this.stream) {
        const streamCallbacks: StreamCallbacks = {
          onText: (text) => callbacks?.onText?.(text),
        };
        return await this.aiService.chatStream(messages, activeTools, streamCallbacks);
      }
      return await this.aiService.chat(messages, activeTools);
    } catch (error: any) {
      if (!this.isPromptTooLongError(error)) {
        throw error;
      }

      Logger.warning('检测到提示词超长，执行紧急上下文裁剪后重试一次');
      this.forceTrimForOverflow(messages);
      this.ensurePromptBudget(messages, activeTools);

      if (this.stream) {
        const streamCallbacks: StreamCallbacks = {
          onText: (text) => callbacks?.onText?.(text),
        };
        return await this.aiService.chatStream(messages, activeTools, streamCallbacks);
      }
      return await this.aiService.chat(messages, activeTools);
    }
  }

  private ensurePromptBudget(messages: Message[], tools: ToolDefinition[]): void {
    const toolTokens = estimateToolsTokens(tools);
    const messageBudget = Math.max(MIN_MESSAGE_BUDGET, this.maxPromptTokens - toolTokens);
    let messageTokens = estimateMessagesTokens(messages);

    if (messageTokens <= messageBudget) {
      return;
    }

    Logger.warning(
      `[上下文守门] 估算超预算: messages=${messageTokens}, tools=${toolTokens}, budget=${this.maxPromptTokens}`
    );

    for (let pass = 0; pass < 4 && messageTokens > messageBudget; pass++) {
      const compacted = this.compressor.compact(messages);
      this.replaceMessages(messages, compacted);
      messageTokens = estimateMessagesTokens(messages);

      if (messageTokens <= messageBudget) {
        break;
      }

      const trimmed = this.hardTrimMessages(messages, messageBudget);
      this.replaceMessages(messages, trimmed);
      messageTokens = estimateMessagesTokens(messages);
    }

    if (messageTokens > messageBudget) {
      const minimal = this.buildMinimalFallback(messages);
      this.replaceMessages(messages, minimal);
      messageTokens = estimateMessagesTokens(messages);
    }

    Logger.info(
      `[上下文守门] 裁剪后: messages=${messageTokens}, tools=${toolTokens}, budget=${this.maxPromptTokens}`
    );
  }

  private forceTrimForOverflow(messages: Message[]): void {
    const before = estimateMessagesTokens(messages);
    const target = Math.max(MIN_MESSAGE_BUDGET, Math.floor(before * OVERFLOW_REDUCTION_RATIO));
    const trimmed = this.hardTrimMessages(messages, target);
    this.replaceMessages(messages, trimmed);
  }

  private hardTrimMessages(messages: Message[], targetTokens: number): Message[] {
    const system = messages.filter(msg => msg.role === 'system');
    const nonSystem = messages.filter(msg => msg.role !== 'system');

    const recentCount = Math.min(8, nonSystem.length);
    const old = nonSystem.slice(0, -recentCount).map(msg => this.shrinkMessage(msg, true));
    const recent = nonSystem.slice(-recentCount).map(msg => this.shrinkMessage(msg, false));

    let candidate = [...system, ...old, ...recent];

    while (estimateMessagesTokens(candidate) > targetTokens && old.length > 0) {
      old.shift();
      candidate = [...system, ...old, ...recent];
    }

    while (estimateMessagesTokens(candidate) > targetTokens && recent.length > 2) {
      recent.shift();
      candidate = [...system, ...old, ...recent];
    }

    if (estimateMessagesTokens(candidate) > targetTokens && system.length > 1) {
      const trimmedSystem = [
        system[0],
        ...system.slice(1).map(msg => this.shrinkMessage(msg, true)),
      ];
      candidate = [...trimmedSystem, ...old, ...recent];
    }

    return candidate;
  }

  private buildMinimalFallback(messages: Message[]): Message[] {
    const system = messages.find(msg => msg.role === 'system');
    const nonSystem = messages.filter(msg => msg.role !== 'system');
    const tail = nonSystem.slice(-2).map(msg => this.shrinkMessage(msg, true));

    const result: Message[] = [];
    if (system) {
      result.push(this.shrinkMessage(system, true));
    }
    result.push(...tail);

    return result;
  }

  private shrinkMessage(message: Message, aggressive: boolean): Message {
    const maxChars = this.resolveMessageCharLimit(message, aggressive);
    const content = message.content || '';
    let nextContent = content;

    if (content.length > maxChars) {
      nextContent = content.slice(0, maxChars) + `\n...[已截断，原始 ${content.length} 字符]`;
    }

    if (message.role === 'tool') {
      const toolName = message.name || 'unknown';
      nextContent = `[tool:${toolName}] 历史输出已省略`;
    }

    const next: Message = {
      ...message,
      content: nextContent,
    };

    if (aggressive && next.tool_calls) {
      delete next.tool_calls;
    }

    return next;
  }

  private resolveMessageCharLimit(message: Message, aggressive: boolean): number {
    if (message.role === 'system') return aggressive ? 1200 : 2400;
    if (message.role === 'user') return aggressive ? 600 : 1200;
    if (message.role === 'assistant') return aggressive ? 400 : 900;
    return aggressive ? 120 : 240;
  }

  private replaceMessages(target: Message[], next: Message[]): void {
    target.length = 0;
    target.push(...next);
  }

  private resolvePromptBudget(maxContextTokens?: number): number {
    const envBudget = Number(process.env.GAUZ_LLM_MAX_PROMPT_TOKENS);
    if (Number.isFinite(envBudget) && envBudget > 0) {
      return envBudget;
    }

    if (maxContextTokens && maxContextTokens > 0) {
      return maxContextTokens;
    }

    const provider = (process.env.GAUZ_LLM_PROVIDER || '').trim().toLowerCase();
    const model = (process.env.GAUZ_LLM_MODEL || '').trim().toLowerCase();
    const isAnthropic = provider === 'anthropic' || model.includes('claude');

    return isAnthropic ? ANTHROPIC_PROMPT_BUDGET : DEFAULT_PROMPT_BUDGET;
  }

  private isPromptTooLongError(error: any): boolean {
    const text = String(error?.message || error || '').toLowerCase();
    return (
      text.includes('prompt is too long') ||
      text.includes('maximum context length') ||
      text.includes('context_length_exceeded') ||
      text.includes('input is too long')
    );
  }
}
