import { Message, ContentBlock, ChatConfig, ChatResponse } from '../types';
import type { ScopedDeviceGrant, ScopedDeviceSelection, ScopedLocalFileGrant } from '../types/session-identity';
import { AIService } from '../utils/ai-service';
import { ToolCall, ToolDefinition, ToolExecutionContext, ToolExecutor, ToolResult, ToolTranscriptMode } from '../types/tool';
import { StreamCallbacks } from '../providers/provider';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';
import { ContextCompressor } from './context-compressor';
import { estimateMessagesTokens, estimateToolsTokens } from './token-estimator';
import { foldHistoricalReadFileMessages, resolveReadFileMessageFoldingOptions } from './read-file-message-folder';
import {
  buildExplicitPlanRequestHintIfUseful,
  buildInitialDecisionHintIfUseful,
  buildPlanSoftNudge,
  buildSubagentSoftNudge,
  nextPlanNudgeToolCount,
  nextSubagentNudgeToolCount,
  PLAN_TOOL_NAME,
  RECORD_DECISION_TOOL_NAME,
  shouldAddPlanSoftNudge,
  shouldAddSubagentSoftNudge,
  SUBAGENT_TOOL_NAME,
  TRANSIENT_RUNNER_HINT_PREFIX,
} from './runner-orchestration-policy';
import {
  TRANSIENT_RUNTIME_CONTEXT_PREFIX,
  buildRuntimeContextMessage,
} from './runtime-context-builder';
import { calculateSummaryBudgetTokens, resolveModelPromptBudgetTokens } from '../utils/model-context-window';
import { MODEL_IMAGE_SAFETY_MESSAGE, isModelImageSafetyError } from '../utils/model-error-classifier';
import { formatProviderErrorForLog } from '../utils/provider-error-log-sanitizer';
import { renderRequiredDefaultPromptFile } from '../utils/prompt-template';
import {
  buildSyntheticObservationLifecycleEvent,
  buildSyntheticObservationMessages,
  describeSyntheticObservationForLog,
  SyntheticObservation,
} from './synthetic-observation';
import * as fs from 'fs';
import * as path from 'path';

function contentToString(content: string | ContentBlock[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '[图片]';
  return content.map(block => block.type === 'text' ? block.text : '[图片]').join('');
}

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

const MIN_MESSAGE_BUDGET = 2000;
const OVERFLOW_REDUCTION_RATIO = 0.6;
const TRANSIENT_CURRENT_DIRECTORY_PREFIX = '[transient_current_directory]';
const MAX_EMPTY_MAX_TOKEN_RECOVERIES = 1;
const EMPTY_MAX_TOKENS_MESSAGE = '模型这轮输出达到了 max_tokens 上限，但没有生成可见回复或工具调用。已保留当前上下文；请回复“继续”，我会从刚才的位置继续推进。';
export const PROMPT_BUDGET_TRIM_MESSAGE = '当前上下文超过模型窗口，已裁剪较早的历史内容以继续处理。';
export const PROMPT_TOOLS_DISABLED_MESSAGE = '当前模型上下文不足以加载全部工具，本轮已先按纯文本继续处理。';

/**
 * 对话运行回调
 */
export interface RunnerCallbacks {
  /** 流式文本片段 */
  onText?: (text: string) => void;
  /** 模型在工具调用前给出的用户可见中途文本 */
  onAssistantText?: (text: string) => void | Promise<void>;
  /** 运行状态提示，例如压缩、裁剪、工具不可用 */
  onThinking?: (thinking: string) => void;
  /** 工具开始执行 */
  onToolStart?: (name: string, toolUseId: string, input: any) => void;
  /** 工具执行完成 */
  onToolEnd?: (name: string, toolUseId: string, result: string) => void;
  /** 需要显示工具输出（如 task_planner） */
  onToolDisplay?: (name: string, content: string) => void;
  /** 重试通知 */
  onRetry?: (attempt: number, maxRetries: number) => void;
}

/**
 * 对话运行结果
 */
export interface RunResult {
  /** 最终文本回复 */
  response: string;
  /** 最终文本是否代表用户可见输出 */
  finalResponseVisible: boolean;
  /** session 消息列表 */
  messages: Message[];
  /** 本次 run() 期间新增的消息（不含最终纯文本回复） */
  newMessages: Message[];
}

export interface PendingUserInput {
  content: string | ContentBlock[];
  deviceGrants?: ScopedDeviceGrant[];
  deviceSelection?: ScopedDeviceSelection;
  localFileGrants?: ScopedLocalFileGrant[];
}

export type PendingUserInputProvider = () =>
  | string
  | ContentBlock[]
  | PendingUserInput
  | null
  | undefined
  | Promise<string | ContentBlock[] | PendingUserInput | null | undefined>;

function isPendingUserInput(value: string | ContentBlock[] | PendingUserInput): value is PendingUserInput {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'content' in value;
}

export type SyntheticObservationProvider = () => SyntheticObservation[];

interface ToolExecutionRecord {
  toolCall: ToolCall;
  toolName: string;
  toolContent: string | ContentBlock[];
  result: ToolResult;
  newMessages?: Message[];
}

/** ConversationRunner 构造选项 */
export interface RunnerOptions {
  /** Optional safety cap for autonomous tool loops. Undefined means no runner-level cap. */
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
  /** Pulls user messages that arrived while the current run was busy. */
  pendingUserInputProvider?: PendingUserInputProvider;
  /** Non-blocking runtime observations produced by sidecar branches. */
  syntheticObservationProvider?: SyntheticObservationProvider;
}

/**
 * ConversationRunner - 核心对话循环
 *
 * 封装 "发送消息 → 检查工具调用 → 执行工具 → 回传结果 → 继续推理" 的循环。
 * 依赖 ToolExecutor 抽象，同时支持 ToolManager（主会话）和 AgentToolExecutor（子 agent）。
 */
export class ConversationRunner {
  private compressor: ContextCompressor;
  private stream: boolean;
  private shouldContinue?: () => boolean;
  private enableCompression: boolean;
  private toolExecutionContext?: Partial<ToolExecutionContext>;
  private maxPromptTokens: number;
  private maxTurns?: number;
  private sessionLabel: string;
  private pendingUserInputProvider?: PendingUserInputProvider;
  private syntheticObservationProvider?: SyntheticObservationProvider;

  /** 截断字符串用于日志输出，避免日志过大 */
  private static truncateForLog(text: any, maxLen = 200): string {
    if (!text) return '(empty)';
    if (typeof text !== 'string') {
      text = JSON.stringify(text);
    }
    const oneLine = text.replace(/\n/g, '\\n');
    if (oneLine.length <= maxLen) return oneLine;
    return oneLine.slice(0, maxLen) + `...(${text.length}字符)`;
  }

  constructor(
    private aiService: AIService,
    private toolExecutor: ToolExecutor,
    options?: RunnerOptions,
  ) {
    this.stream = options?.stream ?? true;
    this.shouldContinue = options?.shouldContinue;
    this.enableCompression = options?.enableCompression ?? true;
    this.toolExecutionContext = options?.toolExecutionContext;
    this.pendingUserInputProvider = options?.pendingUserInputProvider;
    this.syntheticObservationProvider = options?.syntheticObservationProvider;
    this.maxTurns = options?.maxTurns;

    this.maxPromptTokens = this.resolvePromptBudget(options?.maxContextTokens);
    this.sessionLabel = this.toolExecutionContext?.sessionId
      ? `${this.toolExecutionContext.sessionId} `
      : '';
    this.compressor = new ContextCompressor(this.aiService, {
      maxContextTokens: this.maxPromptTokens,
      compactionThreshold: 0.5,
      summaryContentBudget: calculateSummaryBudgetTokens(this.maxPromptTokens),
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
    const supportsToolCalling = (this.aiService as any).isToolCallingSupported?.() !== false;
    const activeTools = supportsToolCalling ? allTools : [];
    if (activeTools.length === 0 && allTools.length > 0) {
      Logger.warning(`[${this.sessionLabel}] 当前模型/中转暂不启用工具调用，已按纯文本模型运行`);
    }
    const toolDefinitions = new Map(allTools.map(tool => [tool.name, tool]));
    const newMessages: Message[] = [];
    let nextTurnTransientHints: Message[] = [];
    let hasDeliveredMessageOutThisRun = false;
    let lastOutboundContent: string | null = null;
    let observationSinceLastOutbound = false;
    let turns = 0;
    let executedToolCalls = 0;
    let hasUpdatedPlan = false;
    let hasSpawnedSubagent = false;
    let hasRecordedDecision = false;
    let planSoftNudgeCount = 0;
    let subagentSoftNudgeCount = 0;
    let nextPlanNudgeAt = nextPlanNudgeToolCount(0);
    let nextSubagentNudgeAt = nextSubagentNudgeToolCount(0);
    let emptyMaxTokenRecoveries = 0;
    let notifiedToolBudgetDisabled = false;

    while (true) {
      turns++;
      if (this.shouldContinue && !this.shouldContinue()) {
        break;
      }
      if (this.maxTurns && turns > this.maxTurns) {
        Logger.warning(`[${this.sessionLabel}] 已达到最大推理轮次 ${this.maxTurns}，正在收束`);
        return {
          response: `已达到本次后台任务的轮次预算（${this.maxTurns} 轮），我先基于已完成的信息收束。`,
          finalResponseVisible: true,
          messages,
          newMessages,
        };
      }
      this.injectSyntheticObservations(messages, turns);
      const requestTools = this.fitToolsToPromptBudget(activeTools);
      if (requestTools.length < activeTools.length && !notifiedToolBudgetDisabled) {
        notifiedToolBudgetDisabled = true;
        if (callbacks?.onThinking) {
          await callbacks.onThinking(PROMPT_TOOLS_DISABLED_MESSAGE);
        }
      }

      if (this.enableCompression) {
        const toolTokens = estimateToolsTokens(requestTools);
        const messageTokens = estimateMessagesTokens(messages);
        const totalTokens = messageTokens + toolTokens;
        const usagePercent = Math.round((totalTokens / this.maxPromptTokens) * 100);
        Logger.info(`[${this.sessionLabel}Turn ${turns}] 上下文: ${messageTokens} + ${toolTokens} = ${totalTokens} tokens (${usagePercent}%)`);
        
        // 检查压缩：考虑工具tokens，留足安全边际
        const threshold = this.maxPromptTokens * 0.5;
        if (totalTokens > threshold) {
          Logger.info(`上下文使用率 ${usagePercent}%，触发压缩...`);
          if (callbacks?.onThinking) {
            await callbacks.onThinking('上下文较长，正在压缩后继续处理。');
          }
          const compacted = await this.compressor.compact(messages, {
            signal: this.toolExecutionContext?.abortSignal,
          });
          messages.length = 0;
          messages.push(...compacted);
          if (callbacks?.onThinking) {
            await callbacks.onThinking('上下文压缩完成，继续处理。');
          }
        }
      }

      const orchestrationHints: Message[] = [];
      const explicitPlanHint = buildExplicitPlanRequestHintIfUseful(messages, requestTools);
      const decisionHint = buildInitialDecisionHintIfUseful(messages, requestTools);
      if (explicitPlanHint) orchestrationHints.push(explicitPlanHint);
      if (decisionHint) orchestrationHints.push(decisionHint);
      if (shouldAddPlanSoftNudge(requestTools, turns, executedToolCalls, hasUpdatedPlan || hasRecordedDecision, nextPlanNudgeAt)) {
        orchestrationHints.push(buildPlanSoftNudge(turns, executedToolCalls, planSoftNudgeCount));
        planSoftNudgeCount++;
        nextPlanNudgeAt = nextPlanNudgeToolCount(executedToolCalls);
      }
      if (shouldAddSubagentSoftNudge(requestTools, turns, executedToolCalls, hasSpawnedSubagent || hasRecordedDecision, nextSubagentNudgeAt)) {
        orchestrationHints.push(buildSubagentSoftNudge(turns, executedToolCalls, subagentSoftNudgeCount));
        subagentSoftNudgeCount++;
        nextSubagentNudgeAt = nextSubagentNudgeToolCount(executedToolCalls);
      }

      let requestMessages = this.buildProviderInputMessages(messages, [
        ...nextTurnTransientHints,
        ...orchestrationHints,
      ]);
      nextTurnTransientHints = [];
      const readFileFolding = foldHistoricalReadFileMessages(
        requestMessages,
        resolveReadFileMessageFoldingOptions(),
      );
      requestMessages = readFileFolding.messages;
      if (readFileFolding.stats.folded_count > 0) {
        Logger.info(
          `[${this.sessionLabel}Turn ${turns}] read_file 历史折叠: `
          + `folded=${readFileFolding.stats.folded_count}, `
          + `saved≈${readFileFolding.stats.saved_tokens_est} tokens`,
        );
      }
      const promptTrimmed = this.ensurePromptBudget(requestMessages, requestTools);
      if (promptTrimmed && callbacks?.onThinking) {
        await callbacks.onThinking(PROMPT_BUDGET_TRIM_MESSAGE);
      }
      this.logProviderMessagesForDebug(requestMessages, requestTools, turns);
      const aiStartTime = Date.now();
      Logger.info(`[${this.sessionLabel}Turn ${turns}] 调用AI推理 (可用工具: ${requestTools.length}个)`);

      let response;
      try {
        response = await this.requestModelResponse(requestMessages, requestTools, callbacks);
        const aiDuration = Date.now() - aiStartTime;
        Logger.info(`[${this.sessionLabel}Turn ${turns}] AI推理完成，耗时: ${aiDuration}ms`);
      } catch (error: any) {
        if (this.isMessageSurface() && isModelImageSafetyError(error)) {
          if (this.toolExecutionContext?.channel && this.toolExecutionContext?.surface !== 'catscompany') {
            try {
              await this.toolExecutionContext.channel.reply(
                this.toolExecutionContext.channel.chatId,
                MODEL_IMAGE_SAFETY_MESSAGE,
              );
            } catch (err: any) {
              Logger.error(`[${this.sessionLabel}Turn ${turns}] 图片安全提示发送失败: ${err.message}`);
            }
          }
          const assistantMessage: Message = {
            role: 'assistant',
            content: MODEL_IMAGE_SAFETY_MESSAGE,
          };
          messages.push(assistantMessage);
          newMessages.push(assistantMessage);
          Logger.warning(`[${this.sessionLabel}Turn ${turns}] 图片被模型安全策略拒绝，已发送可见收束提示: ${formatProviderErrorForLog(error)}`);
          return {
            response: MODEL_IMAGE_SAFETY_MESSAGE,
            finalResponseVisible: true,
            messages,
            newMessages,
          };
        }
        if (hasDeliveredMessageOutThisRun && this.isMessageSurface()) {
          Logger.warning(`[${this.sessionLabel}Turn ${turns}] 已有外发消息送达，后续推理失败后直接收束: ${formatProviderErrorForLog(error)}`);
          return {
            response: '',
            finalResponseVisible: false,
            messages,
            newMessages,
          };
        }
        throw error;
      }

      if (response.usage) {
        Metrics.recordAICall(this.stream ? 'stream' : 'chat', response.usage);
        Logger.info(`[${this.sessionLabel}Turn ${turns}] AI返回 tokens: ${response.usage.promptTokens}+${response.usage.completionTokens}=${response.usage.totalTokens}`);
      }

      if (!response.toolCalls || response.toolCalls.length === 0) {
        if (this.isEmptyMaxTokensResponse(response)) {
          Logger.warning(`[${this.sessionLabel}Turn ${turns}] 模型输出达到 max_tokens 且没有可见内容或工具调用`);
          if (emptyMaxTokenRecoveries < MAX_EMPTY_MAX_TOKEN_RECOVERIES) {
            emptyMaxTokenRecoveries++;
            nextTurnTransientHints = [this.buildEmptyMaxTokensRecoveryHint()];
            continue;
          }

          response = { ...response, content: EMPTY_MAX_TOKENS_MESSAGE, toolCalls: [] };
        }

        Logger.info(`[${this.sessionLabel}Turn ${turns}] AI最终回复: ${ConversationRunner.truncateForLog(response.content || '', 300)}`);

        if (response.content) {
          const finalAssistantMessage: Message = { role: 'assistant', content: response.content };
          messages.push(finalAssistantMessage);
          newMessages.push(finalAssistantMessage);
        }

        if (await this.appendPendingUserInput(messages, newMessages, turns)) {
          continue;
        }

        if (this.isMessageSurface()) {
          let finalText = response.content || '';
          finalText = finalText.replace(/^\[已发送信息\]\s*/, '');
          finalText = finalText.replace(/^\[已发送文件\]\s*/, '');

          // CatsCo 使用 Code Mode API，不自动转发，由上层统一处理
          const surface = this.toolExecutionContext?.surface;
          if (finalText && this.toolExecutionContext?.channel && surface !== 'catscompany') {
            try {
              await this.toolExecutionContext.channel.reply(
                this.toolExecutionContext.channel.chatId,
                finalText
              );
              const preview = finalText.length > 100 ? finalText.slice(0, 100) + '...' : finalText;
              Logger.info(`[${this.sessionLabel}Turn ${turns}] Message模式：已自动转发 "${preview}"`);
            } catch (err: any) {
              Logger.error(`[${this.sessionLabel}Turn ${turns}] Message模式发送失败: ${err.message}`);
            }
          }

          return {
            response: finalText,
            finalResponseVisible: true,
            messages,
            newMessages,
          };
        }

        let cleanedResponse = response.content || '';
        cleanedResponse = cleanedResponse.replace(/^\[已发送信息\]\s*/, '');
        cleanedResponse = cleanedResponse.replace(/^\[已发送文件\]\s*/, '');

        return {
          response: cleanedResponse,
          finalResponseVisible: true,
          messages,
          newMessages,
        };
      }

      if (response.content) {
        Logger.info(`[${this.sessionLabel}Turn ${turns}] AI文本: ${ConversationRunner.truncateForLog(response.content, 300)}`);
        if (callbacks?.onAssistantText) {
          await callbacks.onAssistantText(response.content);
        } else if (callbacks?.onThinking) {
          await callbacks.onThinking(response.content);
        }
      }
      const toolNames = response.toolCalls.map(tc => tc.function.name).join(', ');
      Logger.info(`[${this.sessionLabel}Turn ${turns}] AI选择工具: [${toolNames}]`);

      const assistantMsg: Message = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
        providerContent: response.providerContent,
      };
      const executionRecords: ToolExecutionRecord[] = [];
      let shouldPauseTurn = false;

      for (const toolCall of response.toolCalls) {
        if (this.shouldContinue && !this.shouldContinue()) {
          break;
        }

        const toolName = toolCall.function.name;
        const toolUseId = toolCall.id;
        const toolInput = JSON.parse(toolCall.function.arguments);
        const transcriptMode = this.getToolTranscriptMode(toolName, toolDefinitions);
        callbacks?.onToolStart?.(toolName, toolUseId, toolInput);
        Logger.info(`[${this.sessionLabel}Turn ${turns}] 执行工具: ${toolName} | 参数: ${ConversationRunner.truncateForLog(toolCall.function.arguments, 500)}`);
        const activeToolNames = allTools.map(tool => tool.name);
        const toolStart = Date.now();
        const result = await this.executeToolWithRetry(
          toolCall,
          messages,
          this.toolExecutionContext || {},
          turns,
        );
        executedToolCalls++;
        if (toolName === PLAN_TOOL_NAME) {
          hasUpdatedPlan = true;
        } else if (toolName === SUBAGENT_TOOL_NAME) {
          hasSpawnedSubagent = true;
        } else if (toolName === RECORD_DECISION_TOOL_NAME) {
          hasRecordedDecision = true;
        }
        const toolDuration = Date.now() - toolStart;
        Metrics.recordToolCall(toolName, toolDuration);
        Logger.info(`[${this.sessionLabel}Turn ${turns}] 工具完成: ${toolName} | 耗时: ${toolDuration}ms | 结果: ${ConversationRunner.truncateForLog(result.content, 300)}`);
        callbacks?.onToolEnd?.(toolName, toolUseId, contentToString(result.content));

        if (
          (transcriptMode === 'outbound_message' || transcriptMode === 'outbound_file')
          && result.ok
          && !result.errorCode
        ) {
          hasDeliveredMessageOutThisRun = true;
        }

        const toolContent = result.content;

        this.handleToolDisplay(toolCall, contentToString(toolContent), callbacks);
        executionRecords.push({
          toolCall,
          toolName,
          toolContent,
          result,
          newMessages: (result as any).newMessages, // 保存图片等额外消息
        });

        if (result.controlSignal === 'pause_turn' && !result.errorCode) {
          shouldPauseTurn = true;
          break;
        }
      }

      const turnMessages = this.buildTurnMessages(
        assistantMsg,
        executionRecords,
        toolDefinitions,
      );
      messages.push(...turnMessages);
      newMessages.push(...turnMessages);

      for (const record of executionRecords) {
        const transcriptMode = this.getToolTranscriptMode(record.toolName, toolDefinitions);
        if (this.shouldNormalizeOutboundRecord(record, transcriptMode)) {
          const outbound = this.buildOutboundAssistantMessage(record, toolDefinitions);
          const content = typeof outbound?.content === 'string' ? outbound.content : '';
          if (content) {
            if (lastOutboundContent === content && !observationSinceLastOutbound) {
              nextTurnTransientHints = [this.buildDuplicateOutboundHint(content)];
            }
            lastOutboundContent = content;
            observationSinceLastOutbound = false;
          }
          continue;
        }

        if (transcriptMode !== 'suppress' || record.result.errorCode || record.result.ok === false) {
          observationSinceLastOutbound = true;
        }
      }

      if (shouldPauseTurn) {
        Logger.info(`[${this.sessionLabel}Turn ${turns}] pause_turn 已触发，本轮收束`);
        return {
          response: '',
          finalResponseVisible: false,
          messages,
          newMessages,
        };
      }

      await this.appendPendingUserInput(messages, newMessages, turns);
    }

    return {
      response: '',
      finalResponseVisible: false,
      messages,
      newMessages,
    };
  }

  private async appendPendingUserInput(
    messages: Message[],
    newMessages: Message[],
    turns: number,
  ): Promise<boolean> {
    if (!this.pendingUserInputProvider) return false;

    const pending = await this.pendingUserInputProvider();
    if (!pending) return false;

    const content = isPendingUserInput(pending) ? pending.content : pending;
    let shouldRefreshRuntimeContext = false;
    if (isPendingUserInput(pending) && pending.deviceGrants?.length) {
      this.toolExecutionContext = {
        ...(this.toolExecutionContext || {}),
        deviceGrants: [
          ...(this.toolExecutionContext?.deviceGrants || []),
          ...pending.deviceGrants,
        ],
      };
      shouldRefreshRuntimeContext = true;
    }
    if (isPendingUserInput(pending) && pending.deviceSelection) {
      this.toolExecutionContext = {
        ...(this.toolExecutionContext || {}),
        deviceSelection: pending.deviceSelection,
      };
      shouldRefreshRuntimeContext = true;
    }
    if (isPendingUserInput(pending) && pending.localFileGrants?.length) {
      this.toolExecutionContext = {
        ...(this.toolExecutionContext || {}),
        localFileGrants: [
          ...(this.toolExecutionContext?.localFileGrants || []),
          ...pending.localFileGrants,
        ],
      };
      shouldRefreshRuntimeContext = true;
    }
    if (shouldRefreshRuntimeContext) {
      this.refreshRuntimeContextForPendingInput(messages);
    }

    const userMessage: Message = { role: 'user', content };
    messages.push(userMessage);
    newMessages.push(userMessage);

    const preview = typeof content === 'string'
      ? content
      : content.map(block => block.type === 'text' ? block.text : '[image]').join('');
    Logger.info(
      `[${this.sessionLabel}Turn ${turns}] 已合并处理期间新到的用户消息: ` +
      ConversationRunner.truncateForLog(preview, 240)
    );

    return true;
  }

  private refreshRuntimeContextForPendingInput(messages: Message[]): void {
    const sessionKey = this.toolExecutionContext?.sessionId
      || this.toolExecutionContext?.executionScope?.sessionKey;
    if (!sessionKey) return;

    const runtimeContext = buildRuntimeContextMessage({
      sessionKey,
      sessionType: this.toolExecutionContext?.surface,
      executionScope: this.toolExecutionContext?.executionScope,
      localDeviceGrant: this.toolExecutionContext?.localDeviceGrant,
      deviceGrants: this.toolExecutionContext?.deviceGrants,
      deviceSelection: this.toolExecutionContext?.deviceSelection,
      localFileGrants: this.toolExecutionContext?.localFileGrants,
    });
    if (!runtimeContext) return;

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (
        message.role === 'system'
        && typeof message.content === 'string'
        && message.content.startsWith(TRANSIENT_RUNTIME_CONTEXT_PREFIX)
      ) {
        messages.splice(i, 1);
      }
    }
    messages.push(runtimeContext);
  }

  private injectSyntheticObservations(messages: Message[], turn: number): void {
    if (!this.syntheticObservationProvider) return;
    let observations: SyntheticObservation[] = [];
    try {
      observations = this.syntheticObservationProvider();
    } catch (error: any) {
      Logger.warning(`[${this.sessionLabel}Turn ${turn}] synthetic observation drain failed: ${error.message}`);
      return;
    }
    if (observations.length === 0) return;

    const syntheticMessages = buildSyntheticObservationMessages(observations);
    messages.push(...syntheticMessages);
    Logger.info(
      `[${this.sessionLabel}Turn ${turn}] injected ${observations.length} synthetic runtime observation(s): `
      + observations.map(describeSyntheticObservationForLog).join(' | ')
    );
    for (const observation of observations) {
      Logger.runtimeEvent(
        'INFO',
        `[${this.sessionLabel}Turn ${turn}] synthetic_observation_lifecycle injected id=${observation.id || '(unassigned)'}`,
        buildSyntheticObservationLifecycleEvent(observation, {
          outcome: 'injected',
          reason: 'provider_call_drain',
        }),
      );
    }
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

  private buildTurnMessages(
    assistantMsg: Message,
    executionRecords: ToolExecutionRecord[],
    toolDefinitions: Map<string, ToolDefinition>,
  ): Message[] {
    const messages: Message[] = [];
    const transcriptRecords: ToolExecutionRecord[] = [];
    const outboundMessages: Message[] = [];
    const hasTranscriptRecord = executionRecords.some(record => {
      const transcriptMode = this.getToolTranscriptMode(record.toolName, toolDefinitions);
      if (this.shouldNormalizeOutboundRecord(record, transcriptMode)) {
        return false;
      }
      return transcriptMode !== 'suppress' || record.result.errorCode || record.result.ok === false;
    });

    for (const record of executionRecords) {
      const transcriptMode = this.getToolTranscriptMode(record.toolName, toolDefinitions);
      if (!hasTranscriptRecord && this.shouldNormalizeOutboundRecord(record, transcriptMode)) {
        const outbound = this.buildOutboundAssistantMessage(record, toolDefinitions);
        if (outbound) {
          outboundMessages.push(outbound);
        }
        continue;
      }
      if (transcriptMode === 'suppress' && !record.result.errorCode && record.result.ok !== false) {
        continue;
      }
      transcriptRecords.push(record);
    }

    const transcriptToolCalls = this.filterToolCallsForTranscript(assistantMsg, transcriptRecords);
    const providerContent = this.filterProviderContentForTranscript(assistantMsg, transcriptToolCalls);
    const assistant: Message = {
      role: 'assistant',
      content: this.shouldKeepAssistantDraft(assistantMsg, outboundMessages)
        ? assistantMsg.content
        : null,
      ...(transcriptToolCalls?.length
        ? { tool_calls: transcriptToolCalls }
        : {}),
      ...(providerContent?.length
        ? { providerContent }
        : {}),
    };

    if (assistant.content || assistant.tool_calls?.length) {
      messages.push(assistant);
    }

    messages.push(...outboundMessages);

    for (const record of transcriptRecords) {
      const transcriptMode = this.getToolTranscriptMode(record.toolName, toolDefinitions);
      if (transcriptMode === 'suppress' && !record.result.errorCode) {
        continue;
      }

      // 检测图片读取结果的特殊标记
      if (typeof record.toolContent === 'object' && record.toolContent && '_imageForNewMessage' in record.toolContent) {
        const imageData = record.toolContent as any;
        // tool result 包含文本 + 图片（避免产生连续的 user 消息）
        messages.push({
          role: 'tool',
          content: [
            {
              type: 'text',
              text: [
                `Image file read: ${imageData.filePath}`,
                'Use only the image attached in this same tool result.',
                'Do not describe old images, file names, or prior conversation context.',
                'If visual details are unclear, say you are not sure.',
              ].join('\n'),
            },
            imageData.imageBlock,
          ],
          tool_call_id: record.result.tool_call_id,
          name: record.result.name,
        });
      } else {
        // 正常的 tool result
        messages.push({
          role: 'tool',
          content: record.toolContent,
          tool_call_id: record.result.tool_call_id,
          name: record.result.name,
        });

        // 插入额外消息（如图片）
        if (record.newMessages) {
          messages.push(...record.newMessages);
        }
      }
    }

    return messages;
  }

  private filterToolCallsForTranscript(
    assistantMsg: Message,
    transcriptRecords: ToolExecutionRecord[],
  ): Message['tool_calls'] {
    if (!assistantMsg.tool_calls?.length) return undefined;
    const transcriptToolCallIds = new Set(transcriptRecords.map(record => record.toolCall.id));
    return assistantMsg.tool_calls.filter(toolCall => transcriptToolCallIds.has(toolCall.id));
  }

  private filterProviderContentForTranscript(
    assistantMsg: Message,
    transcriptToolCalls: Message['tool_calls'],
  ): Message['providerContent'] {
    if (!Array.isArray(assistantMsg.providerContent) || !transcriptToolCalls?.length) {
      return undefined;
    }

    const transcriptToolCallIds = new Set(transcriptToolCalls.map(toolCall => toolCall.id));
    const blocks: NonNullable<Message['providerContent']> = [];
    let hasToolUse = false;

    for (const block of assistantMsg.providerContent) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use') {
        const id = typeof block.id === 'string' ? block.id : '';
        if (!transcriptToolCallIds.has(id)) continue;
        hasToolUse = true;
      }
      blocks.push(block);
    }

    return hasToolUse ? blocks : undefined;
  }

  private shouldKeepAssistantDraft(
    assistantMsg: Message,
    outboundMessages: Message[],
  ): boolean {
    if (!assistantMsg.content || typeof assistantMsg.content !== 'string') {
      return Array.isArray(assistantMsg.content);
    }
    return !outboundMessages.some(message => message.content === assistantMsg.content);
  }

  private buildProviderInputMessages(messages: Message[], transientHints: Message[]): Message[] {
    const sanitizedBase = messages.filter(message => {
      if (typeof message.content !== 'string') {
        return true;
      }
      if (message.content.startsWith(TRANSIENT_CURRENT_DIRECTORY_PREFIX)) {
        return false;
      }
      if (message.role !== 'system') {
        return true;
      }
      return !message.content.startsWith(TRANSIENT_RUNNER_HINT_PREFIX)
        && !message.content.startsWith(TRANSIENT_CURRENT_DIRECTORY_PREFIX);
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

    const currentDirectoryHint = this.buildCurrentDirectoryHint();
    return this.insertCurrentDirectoryHint(
      [
        ...collapsed,
        ...transientHints,
      ],
      currentDirectoryHint,
    );
  }

  private insertCurrentDirectoryHint(messages: Message[], hint: Message | null): Message[] {
    if (!hint) return messages;

    const insertIndex = this.findCurrentDirectoryHintInsertIndex(messages);
    return [
      ...messages.slice(0, insertIndex),
      hint,
      ...messages.slice(insertIndex),
    ];
  }

  private findCurrentDirectoryHintInsertIndex(messages: Message[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== 'assistant' || !message.tool_calls?.length) {
        continue;
      }

      const suffix = messages.slice(i + 1);
      const suffixBelongsToToolExchange = suffix.length > 0 && suffix.every(item => {
        if (item.role === 'tool') return true;
        return this.isTransientRunnerHint(item);
      });

      if (suffixBelongsToToolExchange) {
        return i;
      }
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && !this.isCurrentDirectoryHint(messages[i])) {
        return i;
      }
    }

    return messages.length;
  }

  private isTransientRunnerHint(message: Message): boolean {
    return message.role === 'system'
      && typeof message.content === 'string'
      && message.content.startsWith(TRANSIENT_RUNNER_HINT_PREFIX);
  }

  private isCurrentDirectoryHint(message: Message): boolean {
    return typeof message.content === 'string'
      && message.content.startsWith(TRANSIENT_CURRENT_DIRECTORY_PREFIX);
  }

  private buildCurrentDirectoryHint(): Message | null {
    const currentDirectory = this.toolExecutionContext?.getCurrentDirectory?.()
      || this.toolExecutionContext?.workingDirectory;
    if (!currentDirectory) return null;

    return {
      role: 'user',
      content: [
        TRANSIENT_CURRENT_DIRECTORY_PREFIX,
        renderRequiredDefaultPromptFile('transient/current-directory.md', { currentDirectory }),
      ].join('\n'),
      __injected: true,
    };
  }

  private isMessageSurface(): boolean {
    const surface = this.toolExecutionContext?.surface;
    return surface === 'catscompany' || surface === 'feishu' || surface === 'weixin';
  }

  private getToolTranscriptMode(
    toolName: string,
    toolDefinitions: Map<string, ToolDefinition>,
  ): ToolTranscriptMode {
    const exact = toolDefinitions.get(toolName);
    if (exact) return exact.transcriptMode ?? 'default';
    return toolDefinitions.get(normalizeToolName(toolName))?.transcriptMode ?? 'default';
  }

  private shouldNormalizeOutboundRecord(
    record: ToolExecutionRecord,
    transcriptMode: ToolTranscriptMode,
  ): boolean {
    if (record.result.errorCode || record.result.ok === false) {
      return false;
    }

    return transcriptMode === 'outbound_message';
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

    return null;
  }

  private extractOutboundMessage(
    toolName: string,
    args: Record<string, unknown>,
  ): string | null {
    if (normalizeToolName(toolName) === 'send_text') {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
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

  private buildDuplicateOutboundHint(content: string): Message {
    return {
      role: 'system',
      content: `${TRANSIENT_RUNNER_HINT_PREFIX}\n${renderRequiredDefaultPromptFile('transient/runner-duplicate-outbound.md', { content })}`,
    };
  }

  private isEmptyMaxTokensResponse(response: ChatResponse): boolean {
    const stopReason = String(response.stopReason || '').toLowerCase();
    const content = typeof response.content === 'string' ? response.content.trim() : '';
    return !content
      && (!response.toolCalls || response.toolCalls.length === 0)
      && (stopReason === 'max_tokens' || stopReason === 'length');
  }

  private buildEmptyMaxTokensRecoveryHint(): Message {
    return {
      role: 'system',
      content: [
        TRANSIENT_RUNNER_HINT_PREFIX,
        renderRequiredDefaultPromptFile('transient/runner-empty-max-tokens.md', {}),
      ].join('\n'),
    };
  }

  private logProviderMessagesForDebug(
    messages: Message[],
    activeTools: ToolDefinition[],
    turn: number,
  ): void {
    if (!/^(1|true|yes)$/i.test(process.env.XIAOBA_DEBUG_PROVIDER_MESSAGES || '')) {
      return;
    }

    const entries = messages.map((message, index) => {
      const content = contentToString(message.content);
      const toolCalls = message.tool_calls
        ?.map(call => `${call.function.name}(${ConversationRunner.truncateForLog(call.function.arguments, 180)})`)
        .join(', ');
      const markers = [
        message.role === 'system' && content.includes('[skill:') ? 'contains_skill_system_marker' : '',
        message.role === 'system' && content.includes('SKILL.md') ? 'system_mentions_skill_md' : '',
        message.role === 'tool' && message.name === 'skill' ? 'skill_tool_result' : '',
      ].filter(Boolean).join(',');

      return {
        index,
        role: message.role,
        name: message.name,
        tool_call_id: message.tool_call_id,
        tool_calls: toolCalls,
        length: content.length,
        markers: markers ? markers.split(',') : [],
        content,
      };
    });

    Logger.info(`[${this.sessionLabel}Turn ${turn}] Provider input debug: messages=${messages.length}, tools=${activeTools.length}`);
    for (const entry of entries) {
      Logger.info(
        `[${this.sessionLabel}Turn ${turn}] provider[${entry.index}] role=${entry.role}`
        + `${entry.name ? ` name=${entry.name}` : ''}`
        + `${entry.tool_call_id ? ` tool_call_id=${entry.tool_call_id}` : ''}`
        + `${entry.tool_calls ? ` tool_calls=${entry.tool_calls}` : ''}`
        + ` len=${entry.length}`
        + `${entry.markers.length ? ` markers=${entry.markers.join(',')}` : ''}`
        + ` content=${ConversationRunner.truncateForLog(entry.content, 800)}`
      );
    }

    this.writeProviderMessagesDebugFile(turn, activeTools, entries);
  }

  private writeProviderMessagesDebugFile(
    turn: number,
    activeTools: ToolDefinition[],
    entries: Array<{
      index: number;
      role: Message['role'];
      name?: string;
      tool_call_id?: string;
      tool_calls?: string;
      length: number;
      markers: string[];
      content: string;
    }>,
  ): void {
    try {
      const date = new Date();
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const dir = path.resolve('logs', 'provider-messages', dateStr);
      fs.mkdirSync(dir, { recursive: true });
      const safeSession = (this.toolExecutionContext?.sessionId || 'unknown').replace(/[:<>"|?*]/g, '_');
      const filePath = path.join(dir, `${safeSession}.jsonl`);
      fs.appendFileSync(filePath, JSON.stringify({
        entry_type: 'provider_messages',
        timestamp: date.toISOString(),
        session_id: this.toolExecutionContext?.sessionId,
        surface: this.toolExecutionContext?.surface,
        turn,
        tool_count: activeTools.length,
        messages: entries,
      }) + '\n', 'utf-8');
    } catch (error: any) {
      Logger.warning(`[${this.sessionLabel}Turn ${turn}] provider debug file write failed: ${error.message}`);
    }
  }

  private async requestModelResponse(
    messages: Message[],
    activeTools: ToolDefinition[],
    callbacks?: RunnerCallbacks,
  ) {
    const requestOptions = {
      signal: this.toolExecutionContext?.abortSignal,
    };
    try {
      if (this.stream) {
        const streamCallbacks: StreamCallbacks = {
          onText: (text) => callbacks?.onText?.(text),
          onRetry: (attempt, maxRetries) => callbacks?.onRetry?.(attempt, maxRetries),
        };
        return await this.aiService.chatStream(messages, activeTools, streamCallbacks, requestOptions);
      }
      return await this.aiService.chat(messages, activeTools, requestOptions);
    } catch (error: any) {
      if (!this.isPromptTooLongError(error)) {
        throw error;
      }

      Logger.warning('检测到提示词超长，执行紧急上下文裁剪后重试一次');
      this.forceTrimForOverflow(messages);
      const promptTrimmed = this.ensurePromptBudget(messages, activeTools);
      if (promptTrimmed && callbacks?.onThinking) {
        await callbacks.onThinking(PROMPT_BUDGET_TRIM_MESSAGE);
      }

      if (this.stream) {
        const streamCallbacks: StreamCallbacks = {
          onText: (text) => callbacks?.onText?.(text),
        };
        return await this.aiService.chatStream(messages, activeTools, streamCallbacks, requestOptions);
      }
      return await this.aiService.chat(messages, activeTools, requestOptions);
    }
  }

  private ensurePromptBudget(messages: Message[], tools: ToolDefinition[]): boolean {
    const toolTokens = estimateToolsTokens(tools);
    const messageBudget = Math.max(1, this.maxPromptTokens - toolTokens);
    let messageTokens = estimateMessagesTokens(messages);

    if (messageTokens <= messageBudget) {
      return false;
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
      const minimal = this.buildMinimalFallback(messages, messageBudget);
      this.replaceMessages(messages, minimal);
      messageTokens = estimateMessagesTokens(messages);
    }

    Logger.info(
      `[上下文守门] 裁剪后: messages=${messageTokens}, tools=${toolTokens}, budget=${this.maxPromptTokens}`
    );
    return true;
  }

  private fitToolsToPromptBudget(tools: ToolDefinition[]): ToolDefinition[] {
    if (tools.length === 0) {
      return tools;
    }

    const toolTokens = estimateToolsTokens(tools);
    const toolBudget = Math.max(1, this.maxPromptTokens - MIN_MESSAGE_BUDGET);
    if (toolTokens <= toolBudget) {
      return tools;
    }

    Logger.warning(
      `[上下文守门] 工具定义超预算: tools=${toolTokens}, toolBudget=${toolBudget}, promptBudget=${this.maxPromptTokens}; 本轮禁用工具定义`
    );
    return [];
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

    return this.repairToolExchangeMessages(candidate);
  }

  private buildMinimalFallback(messages: Message[], targetTokens: number): Message[] {
    const system = messages.find(msg => msg.role === 'system');
    const nonSystem = messages.filter(msg => msg.role !== 'system');
    const tail = nonSystem.slice(-2).map(msg => this.shrinkMessage(msg, true));

    const result: Message[] = [];
    if (system) {
      result.push(this.shrinkMessage(system, true));
    }
    result.push(...tail);

    return this.fitMessagesToBudget(result, targetTokens);
  }

  private fitMessagesToBudget(messages: Message[], targetTokens: number): Message[] {
    let candidate = this.repairToolExchangeMessages(messages);
    const caps = [600, 320, 160, 80];

    for (const cap of caps) {
      if (estimateMessagesTokens(candidate) <= targetTokens) {
        return candidate;
      }
      candidate = candidate.map((message, index) => (
        this.truncateMessageContent(message, index === 0 ? cap * 2 : cap)
      ));
      candidate = this.repairToolExchangeMessages(candidate);
    }

    while (estimateMessagesTokens(candidate) > targetTokens && candidate.length > 1) {
      candidate.splice(1, 1);
    }

    if (estimateMessagesTokens(candidate) > targetTokens && candidate.length > 0) {
      candidate = [this.truncateMessageContent(candidate[0], 80)];
    }

    return this.repairToolExchangeMessages(candidate);
  }

  private repairToolExchangeMessages(messages: Message[]): Message[] {
    const toolResultIds = new Set(
      messages
        .filter(message => message.role === 'tool' && message.tool_call_id)
        .map(message => message.tool_call_id as string),
    );
    const retainedToolCallIds = new Set<string>();
    const repaired: Message[] = [];

    for (const message of messages) {
      if (message.role !== 'assistant' || !message.tool_calls?.length) {
        repaired.push(message);
        continue;
      }

      const toolCalls = message.tool_calls.filter(toolCall => toolResultIds.has(toolCall.id));
      for (const toolCall of toolCalls) {
        retainedToolCallIds.add(toolCall.id);
      }

      if (toolCalls.length > 0) {
        const providerContent = this.filterProviderContentForTranscript(message, toolCalls);
        repaired.push({
          ...message,
          tool_calls: toolCalls,
          providerContent,
        });
        continue;
      }

      const content = contentToString(message.content).trim();
      if (content) {
        repaired.push({ ...message, tool_calls: undefined, providerContent: undefined });
      }
    }

    return repaired.filter(message => {
      if (message.role !== 'tool') return true;
      return Boolean(message.tool_call_id && retainedToolCallIds.has(message.tool_call_id));
    });
  }

  private truncateMessageContent(message: Message, maxChars: number): Message {
    const content = contentToString(message.content);
    if (content.length <= maxChars) {
      return message;
    }
    return {
      ...message,
      content: `${content.slice(0, maxChars)}\n...[已截断以适配模型上下文预算，原始 ${content.length} 字符]`,
      tool_calls: undefined,
      providerContent: undefined,
    };
  }

  private shrinkMessage(message: Message, aggressive: boolean): Message {
    const maxChars = this.resolveMessageCharLimit(message, aggressive);
    const content = contentToString(message.content);
    let nextContent = message.content;

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

    if (content.length > maxChars || aggressive) {
      delete next.providerContent;
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

    return resolveModelPromptBudgetTokens(this.resolveModelConfig(), process.env);
  }

  private resolveModelConfig(): Pick<ChatConfig, 'apiUrl' | 'model' | 'provider' | 'maxTokens' | 'contextWindowTokens'> {
    const serviceConfig = typeof (this.aiService as any).getConfig === 'function'
      ? (this.aiService as any).getConfig()
      : undefined;
    if (serviceConfig && typeof serviceConfig === 'object') {
      return serviceConfig;
    }

    return {
      provider: process.env.GAUZ_LLM_PROVIDER === 'anthropic' || process.env.GAUZ_LLM_PROVIDER === 'openai'
        ? process.env.GAUZ_LLM_PROVIDER
        : undefined,
      apiUrl: process.env.GAUZ_LLM_API_BASE,
      model: process.env.GAUZ_LLM_MODEL,
      maxTokens: Number(process.env.GAUZ_LLM_MAX_OUTPUT_TOKENS || process.env.GAUZ_LLM_MAX_TOKENS) || undefined,
      contextWindowTokens: Number(process.env.GAUZ_LLM_CONTEXT_WINDOW_TOKENS || process.env.GAUZ_LLM_CONTEXT_TOKENS) || undefined,
    };
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
  private static readonly RATE_LIMIT_ERROR_CODES = new Set([
    'RATE_LIMIT',
    'HTTP_429',
    'TOO_MANY_REQUESTS',
  ]);

  private static hasRateLimitMarkers(text: string): boolean {
    if (!text) {
      return false;
    }

    const lower = text.toLowerCase();
    if (
      lower.includes('rate limit')
      || lower.includes('too many requests')
      || lower.includes('频率受限')
      || lower.includes('限流')
    ) {
      return true;
    }

    return /(status(?:\s*code)?|http(?:\s*status)?|错误码|code)\s*[:=]?\s*429\b/i.test(text)
      || /\b429\b.{0,24}(too many requests|rate limit|频率受限|限流)/i.test(text)
      || /(too many requests|rate limit|频率受限|限流).{0,24}\b429\b/i.test(text);
  }

  /** 检测工具结果是否为 429 限流错误（避免把正文里的数字 429 误判为限流） */
  private static isRateLimitError(result: ToolResult): boolean {
    const content = String(result.content || '');
    if (result.errorCode && ConversationRunner.RATE_LIMIT_ERROR_CODES.has(result.errorCode)) {
      return true;
    }

    const isFailure = result.ok === false
      || Boolean(result.errorCode)
      || result.retryable === true;

    if (!isFailure) {
      return false;
    }

    return ConversationRunner.hasRateLimitMarkers(content);
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
      Logger.warning(`[${this.sessionLabel}Turn ${turn}] ${toolCall.function.name} 触发限流 (429)，${delay}ms 后重试 (${attempt}/${ConversationRunner.MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      lastResult = await this.toolExecutor.executeTool(toolCall, messages, context);
    }

    return lastResult;
  }
}
