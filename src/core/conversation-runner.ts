import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { SkillActivationSignal, SkillToolPolicy } from '../types/skill';
import { ToolCall, ToolDefinition, ToolExecutionContext, ToolExecutor, ToolResult, ToolTranscriptMode } from '../types/tool';
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

const TOOL_NAME_ALIASES: Record<string, string> = {
  Bash: 'execute_shell',
  bash: 'execute_shell',
  Shell: 'execute_shell',
  shell: 'execute_shell',
  execute_bash: 'execute_shell',
};

function normalizeToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name;
}

const DEFAULT_PROMPT_BUDGET = 120000;
const ANTHROPIC_PROMPT_BUDGET = 180000;
const MIN_MESSAGE_BUDGET = 2000;
const OVERFLOW_REDUCTION_RATIO = 0.6;
const TRANSIENT_RUNNER_HINT_PREFIX = '[transient_runner_hint]';
const TRANSIENT_SOFT_CHECK_PREFIX = '[transient_soft_check]';

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
  /** 最终文本是否代表用户可见输出 */
  finalResponseVisible: boolean;
  /** durable session 消息列表（适合长期保存） */
  messages: Message[];
  /** 本次 run() 期间新增的 durable 消息（不含最终纯文本回复） */
  newMessages: Message[];
  /** 当前 run 的 working trace（provider-native） */
  workingMessages?: Message[];
}

interface ToolExecutionRecord {
  toolCall: ToolCall;
  toolName: string;
  toolContent: string;
  result: ToolResult;
}

/** ConversationRunner 构造选项 */
export interface RunnerOptions {
  maxTurns?: number;
  maxContextTokens?: number;
  /** false 时用 aiService.chat() 代替 chatStream()（默认 true） */
  stream?: boolean;
  /** 供 agent 检查 stop 状态，返回 false 时提前退出循环 */
  shouldContinue?: () => boolean;
  /** 预先禁用的工具列表（如已知被策略阻断的工具），避免浪费 turn */
  preDisabledTools?: string[];
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

  /** 工具连续失败计数（用于熔断） */
  private toolFailureCount = new Map<string, number>();
  /** 已被熔断禁用的工具 */
  private disabledTools = new Set<string>();

  private static readonly FAILURE_THRESHOLD = 3;

  /** 截断字符串用于日志输出，避免日志过大 */
  private static truncateForLog(text: string, maxLen = 200): string {
    if (!text) return '(empty)';
    const oneLine = text.replace(/\n/g, '\\n');
    if (oneLine.length <= maxLen) return oneLine;
    return oneLine.slice(0, maxLen) + `...(${text.length}字符)`;
  }

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

    // 设置默认工具策略：只允许 10 个基础 tool，其他工具通过 skill 访问
    this.activeSkillToolPolicy = options?.initialSkillToolPolicy ?? {
      allowedTools: [
        'read', 'write', 'edit', 'glob', 'grep', 'bash',
        'reply', 'send_file', 'pause_turn', 'skill'
      ]
    };

    this.maxPromptTokens = this.resolvePromptBudget(options?.maxContextTokens);
    this.compressor = new ContextCompressor(this.aiService, {
      maxContextTokens: options?.maxContextTokens,
    });
    // 预先禁用已知被阻断的工具
    if (options?.preDisabledTools) {
      for (const name of options.preDisabledTools) {
        this.disabledTools.add(name);
      }
      if (this.disabledTools.size > 0) {
        Logger.info(`[Runner] 预禁用工具: [${[...this.disabledTools].join(', ')}]`);
      }
    }
  }

  /**
   * 执行对话循环
   * @param messages 当前消息列表（会被原地修改，追加工具调用中间消息）
   * @param callbacks 可选的 UI 回调
   * @returns 最终文本回复和完整消息列表
   */
  async run(messages: Message[], callbacks?: RunnerCallbacks): Promise<RunResult> {
    const allTools = this.toolExecutor.getToolDefinitions();
    const toolDefinitions = new Map(allTools.map(tool => [tool.name, tool]));
    const durableMessages = messages;
    const workingMessages = [...messages];
    const newMessages: Message[] = [];
    let nextTurnTransientHints: Message[] = [];
    let hasDeliveredMessageOutThisRun = false;
    let softCheckedNoMessageOut = false;
    const latestUserQuery = this.extractLatestUserQuery(workingMessages);
    let turns = 0;

    while (turns++ < this.maxTurns) {
      if (this.shouldContinue && !this.shouldContinue()) {
        break;
      }

      if (this.enableCompression && this.compressor.needsCompaction(workingMessages)) {
        const usage = this.compressor.getUsageInfo(workingMessages);
        Logger.info(`上下文使用率 ${usage.usagePercent}%，触发压缩...`);
        const compactedWorking = await this.compressor.compact(workingMessages);
        workingMessages.length = 0;
        workingMessages.push(...compactedWorking);

        const compactedDurable = await this.compressor.compact(durableMessages);
        durableMessages.length = 0;
        durableMessages.push(...compactedDurable);
      }

      const activeTools = this.applyToolPolicy(allTools, this.activeSkillToolPolicy)
        .filter(tool => !this.disabledTools.has(tool.name));
      const requestMessages = this.buildProviderInputMessages(workingMessages, nextTurnTransientHints);
      nextTurnTransientHints = [];
      this.ensurePromptBudget(requestMessages, activeTools);
      Logger.info(`[Turn ${turns}] 调用AI推理 (可用工具: ${activeTools.length}个)`);

      let response;
      try {
        response = await this.requestModelResponse(requestMessages, activeTools, callbacks);
      } catch (error: any) {
        if (hasDeliveredMessageOutThisRun && this.isMessageSurface()) {
          Logger.warning(`[Turn ${turns}] 已有外发消息送达，后续推理失败后直接收束: ${error.message}`);
          return {
            response: '',
            finalResponseVisible: false,
            messages: durableMessages,
            newMessages,
            workingMessages,
          };
        }
        throw error;
      }

      if (response.usage) {
        Metrics.recordAICall(this.stream ? 'stream' : 'chat', response.usage);
        Logger.info(`[Turn ${turns}] AI返回 tokens: ${response.usage.promptTokens}+${response.usage.completionTokens}=${response.usage.totalTokens}`);
      }

      if (!response.toolCalls || response.toolCalls.length === 0) {
        Logger.info(`[Turn ${turns}] AI最终回复: ${ConversationRunner.truncateForLog(response.content || '', 300)}`);
        if (this.isMessageSurface()) {
          let finalText = response.content || '';
          // 过滤AI回复中的系统标记前缀
          finalText = finalText.replace(/^\[已发送信息\]\s*/, '');
          finalText = finalText.replace(/^\[已发送文件\]\s*/, '');

          if (!hasDeliveredMessageOutThisRun && finalText && !softCheckedNoMessageOut) {
            workingMessages.push({ role: 'assistant', content: finalText });
            nextTurnTransientHints = [this.buildNoMessageOutSoftCheckHint(latestUserQuery)];
            softCheckedNoMessageOut = true;
            Logger.warning(`[Turn ${turns}] 本轮尚未产生用户可见消息，注入一次 soft check 后继续`);
            continue;
          }

          return {
            response: '',
            finalResponseVisible: false,
            messages: durableMessages,
            newMessages,
            workingMessages,
          };
        }

        // 过滤AI回复中的系统标记前缀
        let cleanedResponse = response.content || '';
        cleanedResponse = cleanedResponse.replace(/^\[已发送信息\]\s*/, '');
        cleanedResponse = cleanedResponse.replace(/^\[已发送文件\]\s*/, '');

        return {
          response: cleanedResponse,
          finalResponseVisible: true,
          messages: durableMessages,
          newMessages,
          workingMessages,
        };
      }

      if (response.content) {
        Logger.info(`[Turn ${turns}] AI文本: ${ConversationRunner.truncateForLog(response.content, 300)}`);
      }
      const toolNames = response.toolCalls.map(tc => tc.function.name).join(', ');
      Logger.info(`[Turn ${turns}] AI选择工具: [${toolNames}]`);

      const assistantMsg: Message = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
      };
      const executionRecords: ToolExecutionRecord[] = [];
      let shouldPauseTurn = false;

      for (const toolCall of response.toolCalls) {
        if (this.shouldContinue && !this.shouldContinue()) {
          break;
        }

        const toolName = toolCall.function.name;
        callbacks?.onToolStart?.(toolName);
        Logger.info(`[Turn ${turns}] 执行工具: ${toolName} | 参数: ${ConversationRunner.truncateForLog(toolCall.function.arguments, 500)}`);
        const activeToolNames = this.applyToolPolicy(allTools, this.activeSkillToolPolicy)
          .filter(tool => !this.disabledTools.has(tool.name))
          .map(tool => tool.name);
        const toolStart = Date.now();
        const result = await this.executeToolWithRetry(
          toolCall,
          workingMessages,
          {
            ...this.toolExecutionContext,
            activeSkillName: this.activeSkillName,
            allowedToolNames: activeToolNames,
            blockedToolNames: this.activeSkillToolPolicy?.allowedTools
              ? undefined
              : this.activeSkillToolPolicy?.disallowedTools,
          },
          turns,
        );
        const toolDuration = Date.now() - toolStart;
        Metrics.recordToolCall(toolName, toolDuration);
        Logger.info(`[Turn ${turns}] 工具完成: ${toolName} | 耗时: ${toolDuration}ms | 结果: ${ConversationRunner.truncateForLog(result.content, 300)}`);

        const transcriptMode = this.getToolTranscriptMode(toolName, toolDefinitions);
        if (
          (transcriptMode === 'outbound_message' || transcriptMode === 'outbound_file')
          && result.ok
          && !result.errorCode
        ) {
          hasDeliveredMessageOutThisRun = true;
          softCheckedNoMessageOut = false;
        }

        let toolContent = result.content;
        const isBlocked = result.errorCode === 'TOOL_NOT_ALLOWED_BY_SKILL_POLICY'
          || result.errorCode === 'TOOL_BLOCKED_BY_SKILL_POLICY'
          || result.errorCode === 'TOOL_NOT_REGISTERED';
        const isFailed = toolContent.startsWith('Python 工具执行失败') || toolContent.startsWith('错误:');

        if (isBlocked) {
          this.disabledTools.add(toolName);
          this.toolFailureCount.delete(toolName);
          toolContent += `\n\n[系统] 工具 "${toolName}" 已被自动禁用（策略阻断），请换用其他工具完成任务。`;
          Logger.warning(`[Turn ${turns}] 熔断: ${toolName} 被策略阻断，已从可用列表移除`);
        } else if (isFailed) {
          const count = (this.toolFailureCount.get(toolName) || 0) + 1;
          this.toolFailureCount.set(toolName, count);
          if (count >= ConversationRunner.FAILURE_THRESHOLD) {
            this.disabledTools.add(toolName);
            this.toolFailureCount.delete(toolName);
            toolContent += `\n\n[系统] 工具 "${toolName}" 连续失败 ${count} 次，已被自动禁用，请换用其他工具完成任务。`;
            Logger.warning(`[Turn ${turns}] 熔断: ${toolName} 连续失败 ${count} 次，已从可用列表移除`);
          }
        } else {
          this.toolFailureCount.delete(toolName);
        }

        const activation = this.tryParseSkillActivation(toolCall, result.content);
        if (activation) {
          this.activeSkillName = activation.skillName;
          this.activeSkillToolPolicy = this.mergeAdditionalTools(activation.toolPolicy, activation.additionalTools);

          if (activation.maxTurns && activation.maxTurns > 0) {
            this.maxTurns = Math.max(this.maxTurns, turns + activation.maxTurns);
          }

          upsertSkillSystemMessage(workingMessages, activation);
          const durableSystemMsg = upsertSkillSystemMessage(durableMessages, activation);
          if (durableSystemMsg) {
            newMessages.push(durableSystemMsg);
          }

          toolContent = `Skill "${activation.skillName}" 已激活`;
        }

        this.handleToolDisplay(toolCall, toolContent, callbacks);
        executionRecords.push({
          toolCall,
          toolName,
          toolContent,
          result,
        });

        if (result.controlSignal === 'pause_turn' && !result.errorCode) {
          shouldPauseTurn = true;
          break;
        }
        callbacks?.onToolEnd?.(toolCall.function.name, toolContent);
      }

      const durableTurnMessages = this.buildTurnTranscriptMessages(
        assistantMsg,
        executionRecords,
        toolDefinitions,
      );
      const workingTurnMessages = this.buildTurnWorkingMessages(
        assistantMsg,
        executionRecords,
        toolDefinitions,
      );
      durableMessages.push(...durableTurnMessages);
      workingMessages.push(...workingTurnMessages);
      newMessages.push(...durableTurnMessages);

      if (shouldPauseTurn) {
        Logger.info(`[Turn ${turns}] pause_turn 已触发，本轮收束`);
        return {
          response: '',
          finalResponseVisible: false,
          messages: durableMessages,
          newMessages,
          workingMessages,
        };
      }
    }

    Logger.warning(`达到最大工具调用轮次 (${this.maxTurns})`);
    return {
      response: this.isMessageSurface() ? '' : '[达到最大工具调用轮次，请继续对话]',
      finalResponseVisible: !this.isMessageSurface(),
      messages: durableMessages,
      newMessages,
      workingMessages,
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

  private buildTurnTranscriptMessages(
    assistantMsg: Message,
    executionRecords: ToolExecutionRecord[],
    toolDefinitions: Map<string, ToolDefinition>,
  ): Message[] {
    const retainedToolCalls: ToolCall[] = [];
    const retainedToolMessages: Message[] = [];
    const normalizedMessages: Message[] = [];

    for (const record of executionRecords) {
      const transcriptMode = this.getToolTranscriptMode(record.toolName, toolDefinitions);
      const normalized = this.shouldNormalizeOutboundRecord(record, transcriptMode)
        ? this.buildOutboundAssistantMessage(record, toolDefinitions)
        : null;

      if (normalized) {
        normalizedMessages.push(normalized);
        continue;
      }

      if (transcriptMode === 'suppress' && !record.result.errorCode) {
        continue;
      }

      retainedToolCalls.push(record.toolCall);
      retainedToolMessages.push({
        role: 'tool',
        content: record.toolContent,
        tool_call_id: record.result.tool_call_id,
        name: record.result.name,
      });
    }

    const transcriptMessages: Message[] = [];
    const hasNormalizedOutbound = normalizedMessages.length > 0;
    const assistantContent =
      hasNormalizedOutbound && assistantMsg.content
        ? null
        : assistantMsg.content;

    if (assistantContent || retainedToolCalls.length > 0) {
      transcriptMessages.push({
        role: 'assistant',
        content: assistantContent,
        ...(retainedToolCalls.length > 0 ? { tool_calls: retainedToolCalls } : {}),
      });
    }

    transcriptMessages.push(...retainedToolMessages);
    transcriptMessages.push(...normalizedMessages);
    return transcriptMessages;
  }

  private buildTurnWorkingMessages(
    assistantMsg: Message,
    executionRecords: ToolExecutionRecord[],
    toolDefinitions: Map<string, ToolDefinition>,
  ): Message[] {
    const workingMessages: Message[] = [];

    const workingAssistant: Message = {
      role: 'assistant',
      content: assistantMsg.content,
      ...(assistantMsg.tool_calls?.length ? { tool_calls: assistantMsg.tool_calls } : {}),
    };

    if (workingAssistant.content || workingAssistant.tool_calls?.length) {
      workingMessages.push(workingAssistant);
    }

    for (const record of executionRecords) {
      const transcriptMode = this.getToolTranscriptMode(record.toolName, toolDefinitions);
      if (transcriptMode === 'suppress' && !record.result.errorCode) {
        continue;
      }

      workingMessages.push({
        role: 'tool',
        content: record.toolContent,
        tool_call_id: record.result.tool_call_id,
        name: record.result.name,
      });
    }

    return workingMessages;
  }

  private buildProviderInputMessages(messages: Message[], transientHints: Message[]): Message[] {
    const sanitizedBase = messages.filter(message => {
      if (message.role !== 'system' || typeof message.content !== 'string') {
        return true;
      }
      return !message.content.startsWith(TRANSIENT_RUNNER_HINT_PREFIX)
        && !message.content.startsWith(TRANSIENT_SOFT_CHECK_PREFIX);
    });

    const collapsed: Message[] = [];
    for (const message of sanitizedBase) {
      const previous = collapsed[collapsed.length - 1];
      if (
        previous
        && previous.role === 'assistant'
        && message.role === 'assistant'
        && !previous.tool_calls?.length
        && !message.tool_calls?.length
        && typeof previous.content === 'string'
        && typeof message.content === 'string'
        && previous.content.trim()
        && previous.content === message.content
      ) {
        continue;
      }
      collapsed.push(message);
    }

    if (transientHints.length === 0) {
      return collapsed;
    }

    return [...collapsed, ...transientHints];
  }

  private isMessageSurface(): boolean {
    const surface = this.toolExecutionContext?.surface;
    return surface === 'catscompany' || surface === 'feishu';
  }

  private extractLatestUserQuery(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === 'user' && message.content?.trim()) {
        return message.content.trim();
      }
    }
    return '';
  }

  private buildNoMessageOutSoftCheckHint(latestUserQuery: string): Message {
    const lines = [
      TRANSIENT_SOFT_CHECK_PREFIX,
      `当前用户 query 是：${latestUserQuery || '(空)'}`,
      '本轮你还没有发送任何用户可见消息。',
      '注意：你输出的文本用户看不到，必须使用 reply 工具发送消息。',
      '如果用户的问题需要回复，请立即调用 reply 工具。',
      '只有在用户的问题确实不需要回复时，才可以调用 pause_turn。',
    ];
    return {
      role: 'system',
      content: lines.join('\n'),
    };
  }

  private getToolTranscriptMode(
    toolName: string,
    toolDefinitions: Map<string, ToolDefinition>,
  ): ToolTranscriptMode {
    return toolDefinitions.get(toolName)?.transcriptMode ?? 'default';
  }

  private shouldNormalizeOutboundRecord(
    record: ToolExecutionRecord,
    transcriptMode: ToolTranscriptMode,
  ): boolean {
    if (record.result.errorCode || record.result.ok === false) {
      return false;
    }

    return transcriptMode === 'outbound_message' || transcriptMode === 'outbound_file';
  }

  private buildOutboundAssistantMessage(
    record: ToolExecutionRecord,
    toolDefinitions: Map<string, ToolDefinition>,
  ): Message | null {
    const transcriptMode = this.getToolTranscriptMode(record.toolName, toolDefinitions);
    let args: Record<string, unknown> = {};

    try {
      args = JSON.parse(record.toolCall.function.arguments || '{}');
    } catch {
      return null;
    }

    if (transcriptMode === 'outbound_message') {
      const text = this.extractOutboundMessage(record.toolName, args);
      if (!text) {
        return null;
      }
      return {
        role: 'assistant',
        content: text,
      };
    }

    if (transcriptMode === 'outbound_file') {
      const fileName = typeof args.file_name === 'string' ? args.file_name.trim() : '';
      if (!fileName) {
        return null;
      }
      return {
        role: 'assistant',
        content: fileName,
      };
    }

    return null;
  }

  private extractOutboundMessage(
    toolName: string,
    args: Record<string, unknown>,
  ): string | null {
    if (toolName === 'reply') {
      const text = typeof args.message === 'string' ? args.message.trim() : '';
      return text || null;
    }

    if (toolName === 'feishu_mention') {
      const message = typeof args.message === 'string' ? args.message.trim() : '';
      const mentions = Array.isArray(args.mentions)
        ? args.mentions
          .map(item => typeof item === 'object' && item && typeof (item as { name?: unknown }).name === 'string'
            ? `@${String((item as { name: string }).name).trim()}`
            : '')
          .filter(Boolean)
        : [];
      const prefix = mentions.join(' ').trim();
      const combined = [prefix, message].filter(Boolean).join(' ').trim();
      return combined || null;
    }

    return null;
  }

  private applyToolPolicy(allTools: ToolDefinition[], policy?: SkillToolPolicy): ToolDefinition[] {
    if (!policy) {
      return allTools;
    }

    if (policy.allowedTools && policy.allowedTools.length > 0) {
      const allowed = new Set(
        policy.allowedTools
          .map(name => normalizeToolName(String(name).trim()))
          .filter(Boolean),
      );
      for (const essential of ESSENTIAL_TOOLS) {
        allowed.add(essential);
      }
      return allTools.filter(tool => allowed.has(tool.name));
    }

    if (policy.disallowedTools && policy.disallowedTools.length > 0) {
      const blocked = new Set(
        policy.disallowedTools
          .map(name => normalizeToolName(String(name).trim()))
          .filter(name => Boolean(name) && !ESSENTIAL_TOOLS.has(name)),
      );
      return allTools.filter(tool => !blocked.has(tool.name));
    }

    return allTools;
  }

  private mergeAdditionalTools(policy?: SkillToolPolicy, additionalTools?: string[]): SkillToolPolicy | undefined {
    if (!additionalTools || additionalTools.length === 0) {
      return policy;
    }

    const normalized = additionalTools.map(t => normalizeToolName(t.trim())).filter(Boolean);
    if (normalized.length === 0) {
      return policy;
    }

    if (!policy) {
      return { allowedTools: normalized };
    }

    const merged: SkillToolPolicy = { ...policy };
    if (merged.allowedTools) {
      merged.allowedTools = [...new Set([...merged.allowedTools, ...normalized])];
    } else {
      merged.allowedTools = normalized;
    }

    return merged;
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

    // 纯机械裁剪（同步，不调用 AI）
    for (let pass = 0; pass < 3 && messageTokens > messageBudget; pass++) {
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
      text.includes('input is too long') ||
      text.includes('premature close')
    );
  }

  // ─── 429 重试逻辑 ──────────────────────────────────

  private static readonly MAX_RETRIES = 2;
  private static readonly RETRY_BASE_DELAY_MS = 5000;

  /** 检测工具结果是否为 429 限流错误（避免把正文里的数字 429 误判为限流） */
  private static isRateLimitError(result: ToolResult): boolean {
    const content = String(result.content || '');
    const trimmed = content.trim();
    const lower = trimmed.toLowerCase();

    // 先判断这条工具结果是否“看起来是失败”
    const looksFailed = result.ok === false
      || Boolean(result.errorCode)
      || /^(错误[:：]|读取文件失败[:：]|发送失败[:：]|文件发送失败[:：]|命令执行失败[:：]|工具执行错误[:：]|Python 工具执行失败)/.test(trimmed);

    if (!looksFailed) {
      return false;
    }

    // 必须出现“限流上下文”，不能仅仅因为正文里出现了数字 429
    const hasRateLimitKeyword = lower.includes('rate limit')
      || lower.includes('too many requests')
      || lower.includes('频率受限')
      || lower.includes('限流');

    const has429WithErrorContext = /(status\s*code|http|错误码|code)\s*[:=]?\s*429/i.test(trimmed)
      || /(失败|error|exception|retry|重试).{0,24}\b429\b/i.test(trimmed)
      || /\b429\b.{0,24}(失败|error|exception|retry|重试)/i.test(trimmed);

    return hasRateLimitKeyword || has429WithErrorContext;
  }

  /** 带 429 重试的工具执行 */
  private async executeToolWithRetry(
    toolCall: ToolCall,
    messages: Message[],
    context: Partial<ToolExecutionContext>,
    turn: number,
  ): Promise<ToolResult> {
    let lastResult = await this.toolExecutor.executeTool(toolCall, messages, context);

    for (let attempt = 1; attempt <= ConversationRunner.MAX_RETRIES; attempt++) {
      if (!ConversationRunner.isRateLimitError(lastResult)) {
        return lastResult;
      }
      const delay = ConversationRunner.RETRY_BASE_DELAY_MS * attempt;
      Logger.warning(`[Turn ${turn}] ${toolCall.function.name} 触发限流 (429)，${delay}ms 后重试 (${attempt}/${ConversationRunner.MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      lastResult = await this.toolExecutor.executeTool(toolCall, messages, context);
    }

    return lastResult;
  }
}
