import { Message, ContentBlock } from '../types';
import { AIService } from '../utils/ai-service';
import { ToolCall, ToolDefinition, ToolExecutionContext, ToolExecutor, ToolResult, ToolTranscriptMode } from '../types/tool';
import { StreamCallbacks } from '../providers/provider';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';
import { ContextCompressor } from './context-compressor';
import { estimateMessagesTokens, estimateToolsTokens } from './token-estimator';
import {
  PLAN_SOFT_NUDGE_MIN_TOOL_CALLS,
  PLAN_SOFT_NUDGE_TOOL_INTERVAL,
  PLAN_TOOL_NAME,
  RECORD_DECISION_TOOL_NAME,
  SUBAGENT_SOFT_NUDGE_MIN_TOOL_CALLS,
  SUBAGENT_SOFT_NUDGE_TOOL_INTERVAL,
  SUBAGENT_TOOL_NAME,
  TRANSIENT_RUNNER_HINT_PREFIX,
  buildDuplicateOutboundHint,
  buildCheckpointDecisionRequiredHint,
  buildExplicitPlanFinalAnswerRetryHint,
  buildExplicitPlanRequestNudgeIfUseful,
  buildInitialDecisionCheckpointIfUseful,
  buildInitialOrchestrationRetryHint,
  buildInitialPlanNudgeIfUseful,
  buildInitialSubagentNudgeIfUseful,
  buildMaxTurnFinalizationHint,
  buildPlanSoftNudge,
  buildRuntimeOrchestrationCheckpointHint,
  buildSubagentSoftNudge,
  buildUnavailableToolCallHint,
  contentToString,
  findCheckpointBlockedExploratoryTools,
  filterOrchestrationCheckpointTools,
  hasCompletedOrchestrationCheckpoint,
  hasOrchestrationCheckpointTools,
  shouldAddInitialOrchestrationRetryHint,
  shouldAddMaxTurnFinalizationHint,
  shouldAddPlanSoftNudge,
  shouldAddRuntimeOrchestrationCheckpoint,
  shouldAddSubagentSoftNudge,
} from './runner-orchestration-policy';
import * as fs from 'fs';
import * as path from 'path';

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
const ANTHROPIC_PROMPT_BUDGET = 200000;
const MIN_MESSAGE_BUDGET = 2000;
const OVERFLOW_REDUCTION_RATIO = 0.6;

/**
 * 对话运行回调
 */
export interface RunnerCallbacks {
  /** 流式文本片段 */
  onText?: (text: string) => void;
  /** AI 思考过程 */
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

export type PendingUserInputProvider = () =>
  | string
  | ContentBlock[]
  | null
  | undefined
  | Promise<string | ContentBlock[] | null | undefined>;

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
  /** Mechanically folds older tool outputs so long-running ReAct loops do not carry every file read forever. */
  compactStaleToolResults?: boolean;
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
  private compactStaleToolResultsEnabled: boolean;
  private static readonly RECENT_TOOL_RESULTS_TO_KEEP = 4;

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
    this.compactStaleToolResultsEnabled = options?.compactStaleToolResults ?? false;
    this.maxTurns = options?.maxTurns;

    this.maxPromptTokens = this.resolvePromptBudget(options?.maxContextTokens);
    this.sessionLabel = this.toolExecutionContext?.sessionId
      ? `${this.toolExecutionContext.sessionId} `
      : '';
    this.compressor = new ContextCompressor(this.aiService, {
      maxContextTokens: this.maxPromptTokens,
      compactionThreshold: 0.5,
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
    const toolDefinitions = new Map(allTools.map(tool => [tool.name, tool]));
    const newMessages: Message[] = [];
    let nextTurnTransientHints: Message[] = [];
    let hasDeliveredMessageOutThisRun = false;
    let lastOutboundContent: string | null = null;
    let observationSinceLastOutbound = false;
    let executedToolCallsThisRun = 0;
    let hasSpawnedSubagentThisRun = false;
    let hasUpdatedPlanThisRun = false;
    let hasRecordedDecisionThisRun = false;
    let subagentSoftNudgeCount = 0;
    let planSoftNudgeCount = 0;
    let forceInitialOrchestrationCheckpointNextTurn = false;
    let forceRuntimeOrchestrationCheckpointNextTurn = false;
    let forceStrictOrchestrationCheckpointNextTurn = false;
    let nextSubagentSoftNudgeAtToolCount = SUBAGENT_SOFT_NUDGE_MIN_TOOL_CALLS;
    let nextPlanSoftNudgeAtToolCount = PLAN_SOFT_NUDGE_MIN_TOOL_CALLS;
    let hasShownMaxTurnFinalizationHint = false;
    let hasShownInitialOrchestrationRetryHint = false;
    let hasShownRuntimeOrchestrationCheckpoint = false;
    let hasShownExplicitPlanFinalAnswerRetryHint = false;
    let checkpointExplorationBlockCount = 0;
    let turns = 0;
    const explicitPlanNudge = buildExplicitPlanRequestNudgeIfUseful(messages, allTools);
    if (explicitPlanNudge) {
      nextTurnTransientHints.push(explicitPlanNudge);
      Logger.info(`[${this.sessionLabel}Turn 1] 已注入明确 plan 请求提醒`);
    }
    const initialDecisionCheckpoint = buildInitialDecisionCheckpointIfUseful(messages, allTools);
    if (initialDecisionCheckpoint) {
      nextTurnTransientHints.push(initialDecisionCheckpoint);
      Logger.info(`[${this.sessionLabel}Turn 1] 已注入复杂任务编排 checkpoint`);
    }
    const initialPlanNudge = buildInitialPlanNudgeIfUseful(messages, allTools);
    if (initialPlanNudge) {
      nextTurnTransientHints.push(initialPlanNudge);
      Logger.info(`[${this.sessionLabel}Turn 1] 已注入复杂任务 plan 提醒`);
    }
    const initialSubagentNudge = buildInitialSubagentNudgeIfUseful(messages, allTools);
    if (initialSubagentNudge) {
      nextTurnTransientHints.push(initialSubagentNudge);
      Logger.info(`[${this.sessionLabel}Turn 1] 已注入复杂任务子 agent 拆分提醒`);
    }
    if (explicitPlanNudge || initialPlanNudge || initialSubagentNudge) {
      forceInitialOrchestrationCheckpointNextTurn = true;
    }
    const hadExplicitPlanRequest = Boolean(explicitPlanNudge);
    const hadInitialOrchestrationNudge = Boolean(initialDecisionCheckpoint || explicitPlanNudge || initialPlanNudge || initialSubagentNudge);

    while (this.maxTurns === undefined || turns < this.maxTurns) {
      turns++;
      if (this.shouldContinue && !this.shouldContinue()) {
        break;
      }

      if (shouldAddMaxTurnFinalizationHint(this.maxTurns, turns, hasShownMaxTurnFinalizationHint)) {
        nextTurnTransientHints.push(buildMaxTurnFinalizationHint(this.maxTurns, turns));
        hasShownMaxTurnFinalizationHint = true;
        Logger.info(`[${this.sessionLabel}Turn ${turns}] 已注入工具预算收束提醒`);
      }

      if (this.compactStaleToolResultsEnabled) {
        this.compactStaleToolResults(messages);
      }

      if (this.enableCompression) {
        const toolTokens = estimateToolsTokens(allTools);
        const messageTokens = estimateMessagesTokens(messages);
        const totalTokens = messageTokens + toolTokens;
        const usagePercent = Math.round((totalTokens / this.maxPromptTokens) * 100);
        Logger.info(`[${this.sessionLabel}Turn ${turns}] 上下文: ${messageTokens} + ${toolTokens} = ${totalTokens} tokens (${usagePercent}%)`);
        
        // 检查压缩：考虑工具tokens，留足安全边际
        const threshold = this.maxPromptTokens * 0.5;
        if (totalTokens > threshold) {
          Logger.info(`上下文使用率 ${usagePercent}%，触发压缩...`);
          const compacted = await this.compressor.compact(messages);
          messages.length = 0;
          messages.push(...compacted);
        }
      }

      const pendingCheckpointKind = forceRuntimeOrchestrationCheckpointNextTurn
        ? 'runtime'
        : forceInitialOrchestrationCheckpointNextTurn
          ? 'initial'
          : null;
      const hasPendingOrchestrationCheckpoint =
        pendingCheckpointKind !== null
        && !hasCompletedOrchestrationCheckpoint({
          hasUpdatedPlan: hasUpdatedPlanThisRun,
          hasSpawnedSubagent: hasSpawnedSubagentThisRun,
          hasRecordedDecision: hasRecordedDecisionThisRun,
        })
        && hasOrchestrationCheckpointTools(allTools);
      const activeTools = hasPendingOrchestrationCheckpoint && forceStrictOrchestrationCheckpointNextTurn
        ? filterOrchestrationCheckpointTools(allTools)
        : allTools;
      const isStrictOrchestrationCheckpoint = activeTools.length !== allTools.length;
      forceInitialOrchestrationCheckpointNextTurn = false;
      forceRuntimeOrchestrationCheckpointNextTurn = false;
      forceStrictOrchestrationCheckpointNextTurn = false;
      if (hasPendingOrchestrationCheckpoint) {
        const mode = isStrictOrchestrationCheckpoint
          ? `只开放编排工具 (${activeTools.length}/${allTools.length}个)`
          : `工具列表保持完整 (${activeTools.length}个)`;
        Logger.info(`[${this.sessionLabel}Turn ${turns}] 编排 checkpoint ${mode}`);
      }
      const requestMessages = this.buildProviderInputMessages(messages, nextTurnTransientHints);
      nextTurnTransientHints = [];
      this.ensurePromptBudget(requestMessages, activeTools);
      this.logProviderMessagesForDebug(requestMessages, activeTools, turns);
      const aiStartTime = Date.now();
      Logger.info(`[${this.sessionLabel}Turn ${turns}] 调用AI推理 (可用工具: ${activeTools.length}个)`);

      let response;
      try {
        response = await this.requestModelResponse(requestMessages, activeTools, callbacks);
        const aiDuration = Date.now() - aiStartTime;
        Logger.info(`[${this.sessionLabel}Turn ${turns}] AI推理完成，耗时: ${aiDuration}ms`);
      } catch (error: any) {
        if (hasDeliveredMessageOutThisRun && this.isMessageSurface()) {
          Logger.warning(`[${this.sessionLabel}Turn ${turns}] 已有外发消息送达，后续推理失败后直接收束: ${error.message}`);
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
        Logger.info(`[${this.sessionLabel}Turn ${turns}] AI最终回复: ${ConversationRunner.truncateForLog(response.content || '', 300)}`);

        if (
          hadExplicitPlanRequest
          && !hasUpdatedPlanThisRun
          && !hasShownExplicitPlanFinalAnswerRetryHint
          && allTools.some(tool => tool.name === PLAN_TOOL_NAME)
        ) {
          nextTurnTransientHints.push(buildExplicitPlanFinalAnswerRetryHint());
          forceInitialOrchestrationCheckpointNextTurn = true;
          forceStrictOrchestrationCheckpointNextTurn = true;
          hasShownExplicitPlanFinalAnswerRetryHint = true;
          Logger.info(`[${this.sessionLabel}Turn ${turns}] 明确 plan 请求未调用 update_plan，已重试提醒`);
          continue;
        }

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
        // 发送 thinking 回调
        if (callbacks?.onThinking) {
          await callbacks.onThinking(response.content);
        }
      }
      const toolNames = response.toolCalls.map(tc => tc.function.name).join(', ');
      Logger.info(`[${this.sessionLabel}Turn ${turns}] AI选择工具: [${toolNames}]`);

      const unavailableToolNames = this.findUnavailableToolCalls(response.toolCalls, activeTools);
      if (unavailableToolNames.length > 0) {
        const availableToolNames = activeTools.map(tool => tool.name);
        nextTurnTransientHints.push(buildUnavailableToolCallHint(
          unavailableToolNames,
          availableToolNames,
          hasPendingOrchestrationCheckpoint,
        ));
        if (hasPendingOrchestrationCheckpoint) {
          if (pendingCheckpointKind === 'runtime') {
            forceRuntimeOrchestrationCheckpointNextTurn = true;
          } else {
            forceInitialOrchestrationCheckpointNextTurn = true;
          }
          forceStrictOrchestrationCheckpointNextTurn = true;
        }
        Logger.warning(
          `[${this.sessionLabel}Turn ${turns}] AI请求了当前未开放的工具: `
          + `${unavailableToolNames.join(', ')}；本轮工具调用已拒绝`
        );
        continue;
      }

      if (hasPendingOrchestrationCheckpoint) {
        const requestedToolNames = response.toolCalls.map(toolCall => normalizeToolName(toolCall.function.name));
        const blockedToolNames = findCheckpointBlockedExploratoryTools(
          requestedToolNames,
          {
            hasUpdatedPlan: hasUpdatedPlanThisRun,
            hasSpawnedSubagent: hasSpawnedSubagentThisRun,
            hasRecordedDecision: hasRecordedDecisionThisRun,
          },
        );
        if (blockedToolNames.length > 0) {
          nextTurnTransientHints.push(buildCheckpointDecisionRequiredHint(
            blockedToolNames,
            allTools,
            {
              hasUpdatedPlan: hasUpdatedPlanThisRun,
              hasSpawnedSubagent: hasSpawnedSubagentThisRun,
              hasRecordedDecision: hasRecordedDecisionThisRun,
            },
          ));
          if (pendingCheckpointKind === 'runtime') {
            forceRuntimeOrchestrationCheckpointNextTurn = true;
          } else {
            forceInitialOrchestrationCheckpointNextTurn = true;
          }
          forceStrictOrchestrationCheckpointNextTurn = true;
          checkpointExplorationBlockCount++;
          Logger.warning(
            `[${this.sessionLabel}Turn ${turns}] 编排 checkpoint 未完成，已拦截探索工具: `
            + blockedToolNames.join(', ')
          );
          continue;
        }
      }

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
        const toolDuration = Date.now() - toolStart;
        Metrics.recordToolCall(toolName, toolDuration);
        Logger.info(`[${this.sessionLabel}Turn ${turns}] 工具完成: ${toolName} | 耗时: ${toolDuration}ms | 结果: ${ConversationRunner.truncateForLog(result.content, 300)}`);
        callbacks?.onToolEnd?.(toolName, toolUseId, contentToString(result.content));

        executedToolCallsThisRun++;
        if (toolName === SUBAGENT_TOOL_NAME && result.ok !== false && !result.errorCode) {
          hasSpawnedSubagentThisRun = true;
        }
        if (toolName === PLAN_TOOL_NAME && result.ok !== false && !result.errorCode) {
          hasUpdatedPlanThisRun = true;
        }
        if (toolName === RECORD_DECISION_TOOL_NAME && result.ok !== false && !result.errorCode) {
          hasRecordedDecisionThisRun = true;
        }

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
              nextTurnTransientHints = [buildDuplicateOutboundHint(content)];
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

      if (
        shouldAddInitialOrchestrationRetryHint(
          allTools,
          hadInitialOrchestrationNudge,
          hasShownInitialOrchestrationRetryHint,
          turns,
          executionRecords,
          {
            hasUpdatedPlan: hasUpdatedPlanThisRun,
            hasSpawnedSubagent: hasSpawnedSubagentThisRun,
            hasRecordedDecision: hasRecordedDecisionThisRun,
          },
        )
      ) {
        nextTurnTransientHints.push(buildInitialOrchestrationRetryHint(
          allTools,
          {
            hasUpdatedPlan: hasUpdatedPlanThisRun,
            hasSpawnedSubagent: hasSpawnedSubagentThisRun,
            hasRecordedDecision: hasRecordedDecisionThisRun,
          },
        ));
        forceInitialOrchestrationCheckpointNextTurn = true;
        forceStrictOrchestrationCheckpointNextTurn = true;
        hasShownInitialOrchestrationRetryHint = true;
        Logger.info(`[${this.sessionLabel}Turn ${turns}] 已注入复杂任务编排二次提醒`);
      }

      let hasQueuedOrchestrationCheckpoint = forceInitialOrchestrationCheckpointNextTurn;
      if (
        !hasQueuedOrchestrationCheckpoint
        &&
        shouldAddRuntimeOrchestrationCheckpoint(
          allTools,
          turns,
          executedToolCallsThisRun,
          hasShownRuntimeOrchestrationCheckpoint,
          {
            hasUpdatedPlan: hasUpdatedPlanThisRun,
            hasSpawnedSubagent: hasSpawnedSubagentThisRun,
            hasRecordedDecision: hasRecordedDecisionThisRun,
          },
        )
      ) {
        nextTurnTransientHints.push(buildRuntimeOrchestrationCheckpointHint(
          turns,
          executedToolCallsThisRun,
          allTools,
          {
            hasUpdatedPlan: hasUpdatedPlanThisRun,
            hasSpawnedSubagent: hasSpawnedSubagentThisRun,
            hasRecordedDecision: hasRecordedDecisionThisRun,
          },
        ));
        forceRuntimeOrchestrationCheckpointNextTurn = true;
        forceStrictOrchestrationCheckpointNextTurn = true;
        hasShownRuntimeOrchestrationCheckpoint = true;
        hasQueuedOrchestrationCheckpoint = true;
        Logger.info(
          `[${this.sessionLabel}Turn ${turns}] 已注入运行中编排 checkpoint `
          + `(turns=${turns}, tools=${executedToolCallsThisRun})`
        );
      }

      if (shouldAddSubagentSoftNudge(
        allTools,
        turns,
        executedToolCallsThisRun,
        hasSpawnedSubagentThisRun || hasRecordedDecisionThisRun,
        nextSubagentSoftNudgeAtToolCount,
      ) && !hasQueuedOrchestrationCheckpoint) {
        nextTurnTransientHints.push(buildSubagentSoftNudge(turns, executedToolCallsThisRun, subagentSoftNudgeCount));
        subagentSoftNudgeCount++;
        nextSubagentSoftNudgeAtToolCount += SUBAGENT_SOFT_NUDGE_TOOL_INTERVAL + (subagentSoftNudgeCount * 4);
        Logger.info(
          `[${this.sessionLabel}Turn ${turns}] 已注入子 agent 柔性提醒 `
          + `(turns=${turns}, tools=${executedToolCallsThisRun}, count=${subagentSoftNudgeCount})`
        );
      }

      if (shouldAddPlanSoftNudge(
        allTools,
        turns,
        executedToolCallsThisRun,
        hasUpdatedPlanThisRun || hasRecordedDecisionThisRun,
        nextPlanSoftNudgeAtToolCount,
      ) && !hasQueuedOrchestrationCheckpoint) {
        nextTurnTransientHints.push(buildPlanSoftNudge(turns, executedToolCallsThisRun, planSoftNudgeCount));
        planSoftNudgeCount++;
        nextPlanSoftNudgeAtToolCount += PLAN_SOFT_NUDGE_TOOL_INTERVAL + (planSoftNudgeCount * 3);
        Logger.info(
          `[${this.sessionLabel}Turn ${turns}] 已注入 plan 柔性提醒 `
          + `(turns=${turns}, tools=${executedToolCallsThisRun}, count=${planSoftNudgeCount})`
        );
      }

      await this.appendPendingUserInput(messages, newMessages, turns);
    }

    if (this.shouldContinue && !this.shouldContinue()) {
      const label = this.sessionLabel.trim();
      Logger.info(label ? `[${label}] 当前回合已中止` : '当前回合已中止');
      return {
        response: '',
        finalResponseVisible: false,
        messages,
        newMessages,
      };
    }

    if (this.maxTurns !== undefined) {
      Logger.warning(`达到最大工具调用轮次 (${this.maxTurns})`);
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

    const userMessage: Message = { role: 'user', content: pending };
    messages.push(userMessage);
    newMessages.push(userMessage);

    const preview = typeof pending === 'string'
      ? pending
      : pending.map(block => block.type === 'text' ? block.text : '[image]').join('');
    Logger.info(
      `[${this.sessionLabel}Turn ${turns}] 已合并处理期间新到的用户消息: ` +
      ConversationRunner.truncateForLog(preview, 240)
    );

    return true;
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

    for (const record of executionRecords) {
      const transcriptMode = this.getToolTranscriptMode(record.toolName, toolDefinitions);
      if (this.shouldNormalizeOutboundRecord(record, transcriptMode)) {
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
    const assistant: Message = {
      role: 'assistant',
      content: this.shouldKeepAssistantDraft(assistantMsg, outboundMessages)
        ? assistantMsg.content
        : null,
      ...(transcriptToolCalls?.length
        ? { tool_calls: transcriptToolCalls }
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
      if (message.role !== 'system' || typeof message.content !== 'string') {
        return true;
      }
      return !message.content.startsWith(TRANSIENT_RUNNER_HINT_PREFIX);
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

  private findUnavailableToolCalls(
    toolCalls: ToolCall[],
    activeTools: ToolDefinition[],
  ): string[] {
    const availableToolNames = new Set(activeTools.map(tool => tool.name));
    const unavailable: string[] = [];
    for (const toolCall of toolCalls) {
      const requested = toolCall.function.name;
      const normalized = normalizeToolName(requested);
      if (!availableToolNames.has(requested) && !availableToolNames.has(normalized)) {
        unavailable.push(requested);
      }
    }
    return Array.from(new Set(unavailable));
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
    try {
      if (this.stream) {
        const streamCallbacks: StreamCallbacks = {
          onText: (text) => callbacks?.onText?.(text),
          onRetry: (attempt, maxRetries) => callbacks?.onRetry?.(attempt, maxRetries),
        };
        return await this.aiService.chatStream(messages, activeTools, streamCallbacks, {
          signal: this.toolExecutionContext?.abortSignal,
        });
      }
      return await this.aiService.chat(messages, activeTools, {
        signal: this.toolExecutionContext?.abortSignal,
      });
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
        return await this.aiService.chatStream(messages, activeTools, streamCallbacks, {
          signal: this.toolExecutionContext?.abortSignal,
        });
      }
      return await this.aiService.chat(messages, activeTools, {
        signal: this.toolExecutionContext?.abortSignal,
      });
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

  private compactStaleToolResults(messages: Message[]): void {
    const toolIndexes = messages
      .map((message, index) => ({ message, index }))
      .filter(item => item.message.role === 'tool')
      .map(item => item.index);

    if (toolIndexes.length <= ConversationRunner.RECENT_TOOL_RESULTS_TO_KEEP) return;

    const preserved = new Set(toolIndexes.slice(-ConversationRunner.RECENT_TOOL_RESULTS_TO_KEEP));
    for (const index of toolIndexes) {
      if (preserved.has(index)) continue;
      const message = messages[index];
      if (message.role !== 'tool') continue;
      const content = message.content;
      const alreadyCompacted = typeof content === 'string' && content.startsWith('[tool:') && content.includes('历史工具输出已省略');
      if (alreadyCompacted) continue;

      const toolName = message.name || 'unknown';
      const originalLength = typeof content === 'string'
        ? content.length
        : Array.isArray(content)
          ? content.length
          : 0;
      message.content = `[tool:${toolName}] 历史工具输出已省略；如仍需要细节，请重新调用工具读取更小范围。${originalLength > 0 ? ` 原始长度约 ${originalLength}。` : ''}`;
    }
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
    if (context.abortSignal?.aborted) {
      return buildAbortedToolResult(toolCall);
    }

    let lastResult = await this.toolExecutor.executeTool(toolCall, messages, context);

    for (let attempt = 1; attempt <= ConversationRunner.MAX_RETRIES; attempt++) {
      if (context.abortSignal?.aborted) {
        return buildAbortedToolResult(toolCall);
      }
      if (!ConversationRunner.isRateLimitError(lastResult)) {
        return lastResult;
      }
      const delay = ConversationRunner.RETRY_BASE_DELAY_MS * attempt;
      Logger.warning(`[${this.sessionLabel}Turn ${turn}] ${toolCall.function.name} 触发限流 (429)，${delay}ms 后重试 (${attempt}/${ConversationRunner.MAX_RETRIES})`);
      await waitForRetryDelay(delay, context.abortSignal);
      if (context.abortSignal?.aborted) {
        return buildAbortedToolResult(toolCall);
      }
      lastResult = await this.toolExecutor.executeTool(toolCall, messages, context);
    }

    return lastResult;
  }
}

function buildAbortedToolResult(toolCall: ToolCall): ToolResult {
  return {
    tool_call_id: toolCall.id,
    role: 'tool',
    name: toolCall.function.name,
    content: '工具执行已取消',
    ok: false,
    errorCode: 'EXECUTION_TIMEOUT',
    retryable: false,
  };
}

function waitForRetryDelay(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  if (abortSignal.aborted) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      abortSignal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => cleanup();
    timer = setTimeout(cleanup, ms);
    abortSignal.addEventListener('abort', onAbort, { once: true });
  });
}
