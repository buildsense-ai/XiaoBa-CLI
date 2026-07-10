import { Message } from '../types';
import type {
  ExecutionScope,
  ScopedDeviceGrant,
  ScopedDeviceSelection,
  ScopedLocalDeviceGrant,
  ScopedLocalFileGrant,
  SessionRoute,
} from '../types/session-identity';
import * as fs from 'fs';
import * as path from 'path';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import {
  ChannelCallbacks,
  DeviceRpcTransport,
  TargetRoutes,
  ThinToolRpcTransport,
  ToolExecutionConfirmationRequest,
  ToolExecutionConfirmationResult,
} from '../types/tool';
import {
  SessionSkillRuntime,
  SkillReloadHandler,
} from '../skills/session-skill-runtime';
import { PromptManager } from '../utils/prompt-manager';
import { Logger } from '../utils/logger';
import { SessionTurnLogger } from '../utils/session-turn-logger';
import { Metrics } from '../utils/metrics';
import { ContextWindowManager, type ContextCompactionStatusEvent } from './context-window-manager';
import {
  RuntimeFeedbackInbox,
  RuntimeFeedbackInput,
  RuntimeFeedbackOptions,
} from './runtime-feedback-inbox';
import { TurnLogRecorder } from './turn-log-recorder';
import { TurnContextBuilder } from './turn-context-builder';
import { AgentTurnController, AgentTurnRunError } from './agent-turn-controller';
import { SessionLifecycleManager } from './session-lifecycle-manager';
import { PlanRuntime } from './plan-runtime';
import { SubAgentManager } from './sub-agent-manager';
import type { PendingUserInputProvider } from './conversation-runner';
import { resolveModelContextWindow } from '../utils/model-context-window';
import { parseSessionKeyV2 } from './session-router';
import { MODEL_IMAGE_SAFETY_MESSAGE, isModelImageSafetyError } from '../utils/model-error-classifier';
import { stripAssistantArtifactsFromMessages } from '../utils/transcript-artifacts';
import type { PromptTraceSnapshot } from '../utils/prompt-observability';
import { toPromptTurnMetadata } from '../utils/prompt-observability';
import type { StreamRetryInfo } from '../providers/provider';

export type { RuntimeFeedbackInput, RuntimeFeedbackOptions } from './runtime-feedback-inbox';

export const BUSY_MESSAGE = '正在处理上一条消息，请稍候...';
export const ERROR_MESSAGE = '不好意思，刚才处理出了点问题，你再试一次？';
export const MODEL_TIMEOUT_MESSAGE = '模型中转请求超时了，我已经保留本轮已完成的工具结果和上下文。你可以直接说“继续”，我会从这里接上。';
export const MODEL_TRANSIENT_ERROR_MESSAGE = '当前模型服务临时异常，刚才这次请求没有完成。我已经保留上下文；你可以稍后重试，或临时切换到其他模型继续。';
export const CONTEXT_COMPACTION_START_MESSAGE = '正在压缩上下文，整理较早的对话内容。';
export const CONTEXT_COMPACTION_COMPLETE_MESSAGE = '上下文压缩完成，继续处理当前请求。';
export const CONTEXT_COMPACTION_ERROR_MESSAGE = '上下文压缩失败，已保留原上下文继续处理。';

// ─── 接口定义 ───────────────────────────────────────────

/** 共享服务集合 */
export interface AgentServices {
  aiService: AIService;
  toolManager: ToolManager;
  skillManager: SkillManager;

}

export type SystemPromptProvider = () => Promise<string> | string;

/** 会话回调（由适配层提供） */
export interface SessionCallbacks {
  onText?: (text: string) => void;
  onAssistantText?: (text: string) => void | Promise<void>;
  onThinking?: (thinking: string) => void | Promise<void>;
  onToolStart?: (name: string, toolUseId: string, input: any) => void;
  onToolEnd?: (name: string, toolUseId: string, result: string) => void;
  onToolDisplay?: (name: string, content: string) => void;
  onRetry?: (attempt: number, maxRetries: number, info?: StreamRetryInfo) => void | Promise<void>;
  confirmToolExecution?: (request: ToolExecutionConfirmationRequest) => Promise<ToolExecutionConfirmationResult>;
}

export interface InitSessionOptions {
  callbacks?: SessionCallbacks;
  signal?: AbortSignal;
}

/** 消息处理选项（由平台适配层传入） */
export interface HandleMessageOptions {
  callbacks?: SessionCallbacks;
  /** 平台通道回调，注入到 ToolExecutionContext 供工具使用 */
  channel?: ChannelCallbacks;
  /** 当前 turn 的会话路由快照，用于模型可见的结构化运行上下文 */
  sessionRoute?: SessionRoute;
  /** 当前 turn 的可信执行身份 */
  executionScope?: ExecutionScope;
  /** 当前本机运行体授权，例如 CatsCo body/device 绑定。 */
  localDeviceGrant?: ScopedLocalDeviceGrant;
  /** 当前 turn 已授权的用户设备资源。 */
  deviceGrants?: ScopedDeviceGrant[];
  /** 服务端为当前 turn 选定的用户设备。 */
  deviceSelection?: ScopedDeviceSelection;
  /** 当前 turn 可用的远程设备 RPC 通道。 */
  deviceRpc?: DeviceRpcTransport;
  thinToolRpc?: ThinToolRpcTransport;
  targetRoutes?: TargetRoutes;
  /** 当前 turn 已授权的本地文件资源。 */
  localFileGrants?: ScopedLocalFileGrant[];
  /** 当前 turn 专属、给 agent 可见的运行时反馈 */
  runtimeFeedback?: RuntimeFeedbackInput[];
  /** Pulls user messages that arrived while this session was busy. */
  pendingUserInputProvider?: PendingUserInputProvider;
}

export interface HandleRuntimeObservationOptions extends HandleMessageOptions {
  /** 内部 observation 来源，例如 subagent_result */
  source?: string;
  /** 为 true 时，observation 仍进入主会话处理和历史，但本轮最终文本不外发给用户。 */
  suppressFinalResponse?: boolean;
}

/** 命令处理结果 */
export interface CommandResult {
  handled: boolean;
  reply?: string;
}

export interface HandleMessageResult {
  text: string;
  visibleToUser: boolean;
  /** code mode 过程数据（thinking / tool_use / tool_result） */
  newMessages?: import('../types').Message[];
}

export interface SessionCleanupOptions {
  stopSubAgents?: boolean;
  subAgentStopReason?: string;
}

// ─── AgentSession 核心类 ────────────────────────────────

/**
 * AgentSession - 统一的会话核心
 *
 * 持有独立的 messages[]，封装：
 * - 系统提示词构建（幂等）
 * - 记忆搜索 & 注入
 * - 完整消息处理管线（ConversationRunner）
 * - 内置命令 + skill 命令
 * - 并发保护（busy）
 * - session cleanup / reset / clear 调度
 */
export class AgentSession {
  private messages: Message[] = [];
  private initialized = false;
  private busy = false;
  private systemPromptOverride?: SystemPromptProvider;
  private promptTrace?: PromptTraceSnapshot;
  /** 外部请求中断当前 run（例如用户在 busy 时发送"停止"） */
  private interruptRequested = false;
  private activeAbortController: AbortController | null = null;
  lastActiveAt: number = Date.now();
  private sessionTurnLogger: SessionTurnLogger;
  private turnLogRecorder: TurnLogRecorder;
  private turnContextBuilder = new TurnContextBuilder();
  private turnController: AgentTurnController;
  private contextWindowManager: ContextWindowManager;
  private skillRuntime: SessionSkillRuntime;
  private runtimeFeedbackInbox = new RuntimeFeedbackInbox();
  private planRuntime = new PlanRuntime();
  private lifecycleManager: SessionLifecycleManager;
  private readonly defaultDirectory: string;
  private currentDirectory: string;

  constructor(
    public readonly key: string,
    private services: AgentServices,
    private sessionType?: string,
    private readonly sessionRoute?: SessionRoute,
  ) {
    const type = sessionType || this.extractSessionType(key);
    this.sessionTurnLogger = new SessionTurnLogger(type, key);
    this.turnLogRecorder = new TurnLogRecorder(this.sessionTurnLogger);
    const modelConfig = typeof (services.aiService as any).getConfig === 'function'
      ? (services.aiService as any).getConfig()
      : {};
    const contextWindow = resolveModelContextWindow(modelConfig);
    Logger.info(
      `[${key}] 模型上下文: ${contextWindow.label} window=${contextWindow.contextWindowTokens}, promptBudget=${contextWindow.promptBudgetTokens}, reserve=${contextWindow.safetyReserveTokens}`,
    );
    this.contextWindowManager = new ContextWindowManager(services.aiService, {
      maxContextTokens: contextWindow.promptBudgetTokens,
      summaryContentBudget: contextWindow.summaryBudgetTokens,
    });
    this.skillRuntime = new SessionSkillRuntime(services.skillManager, key);
    this.lifecycleManager = new SessionLifecycleManager({
      sessionKey: key,
      legacySessionKey: sessionRoute?.legacySessionKey,
      legacyRestoreKey: sessionRoute?.legacyRestoreKey,
      legacyCleanupKey: sessionRoute?.legacyCleanupKey,
      allowLegacySessionFallback: this.shouldAllowLegacySessionFallback(sessionRoute),
      runtimeFeedbackInbox: this.runtimeFeedbackInbox,
    });
    this.defaultDirectory = this.resolveDefaultDirectory();
    this.currentDirectory = this.loadInitialCurrentDirectory();
    this.turnController = new AgentTurnController({
      sessionKey: key,
      sessionType,
      sessionRoute,
      services,
      skillRuntime: this.skillRuntime,
      planRuntime: this.planRuntime,
      turnContextBuilder: this.turnContextBuilder,
      turnLogRecorder: this.turnLogRecorder,
      workspaceRoot: this.defaultDirectory,
      getCurrentDirectory: () => this.currentDirectory,
      updateCurrentDirectory: directory => this.updateCurrentDirectory(directory),
    });

    const runtimeFeedbackInbox = this.runtimeFeedbackInbox;
    const subAgentManager = SubAgentManager.getInstance();
    subAgentManager.registerPlatformCallbacks(key, {
      injectMessage: async (text: string) => {
        runtimeFeedbackInbox.enqueue('subagent_feedback', text, {
          maxLength: 2400,
        });
      },
    });
    if (typeof (subAgentManager as any).registerEventLogger === 'function') {
      subAgentManager.registerEventLogger(key, (event, info) => {
        this.sessionTurnLogger.logSubAgentEvent(event, info);
      });
    }
  }

  private resolveDefaultDirectory(): string {
    const toolManager = this.services.toolManager as any;
    const root = typeof toolManager.getWorkspaceRoot === 'function'
      ? toolManager.getWorkspaceRoot()
      : process.cwd();
    return path.resolve(root);
  }

  private loadInitialCurrentDirectory(): string {
    const stored = this.lifecycleManager.loadCurrentDirectory();
    if (stored) {
      const resolved = path.resolve(stored);
      if (this.isExistingDirectory(resolved)) {
        return resolved;
      }
    }
    this.lifecycleManager.saveCurrentDirectory(this.defaultDirectory);
    return this.defaultDirectory;
  }

  private shouldAllowLegacySessionFallback(route?: SessionRoute): boolean {
    // CatsCo legacy keys do not include enough topic/agent identity, so V2 sessions
    // must not restore them as if they were the same conversation.
    return route?.source !== 'catscompany';
  }

  private isExistingDirectory(directory: string): boolean {
    try {
      return fs.existsSync(directory) && fs.statSync(directory).isDirectory();
    } catch {
      return false;
    }
  }

  private updateCurrentDirectory(directory: string): void {
    const resolved = path.resolve(directory);
    if (!this.isExistingDirectory(resolved)) return;
    if (resolved === this.currentDirectory) return;
    this.currentDirectory = resolved;
    this.lifecycleManager.saveCurrentDirectory(resolved);
  }

  private resetCurrentDirectory(): void {
    this.currentDirectory = this.defaultDirectory;
    this.lifecycleManager.saveCurrentDirectory(this.defaultDirectory);
  }

  private extractSessionType(key: string): string {
    const parsedV2 = parseSessionKeyV2(key);
    if (parsedV2) {
      if (parsedV2.source === 'catscompany') return 'catscompany';
      if (parsedV2.source === 'feishu') return 'feishu';
      if (parsedV2.source === 'weixin') return 'weixin';
    }
    if (key.startsWith('catscompany:')) return 'catscompany';
    if (key.startsWith('feishu:')) return 'feishu';
    if (key.startsWith('user:')) return 'weixin';
    return 'chat';
  }

  runWithLogContext<T>(fn: () => T): T {
    return Logger.withSessionContext(this.key, this.sessionTurnLogger, fn);
  }

  private withLogContext<T>(fn: () => T): T {
    return this.runWithLogContext(fn);
  }

  setSystemPromptProvider(provider: SystemPromptProvider): void {
    if (this.initialized) {
      throw new Error('Cannot set system prompt provider after session initialization');
    }
    this.systemPromptOverride = provider;
  }

  setSkillReloadHandler(handler: SkillReloadHandler): void {
    this.skillRuntime.setReloadHandler(handler);
  }

  // ─── 初始化 ─────────────────────────────────────────

  /** 构建系统提示词（幂等初始化；已初始化会话在下一轮开始前可热加载） */
  async init(options: InitSessionOptions = {}): Promise<void> {
    if (this.initialized) return;
    const { systemPrompt, promptTrace } = await this.buildCurrentSystemPrompt();
    this.applyPromptTrace(promptTrace, 'init');
    this.initialized = true;
    const initialSystemMessages: Message[] = [];
    if (systemPrompt.trim()) {
      initialSystemMessages.push({ role: 'system', content: systemPrompt });
    }
    if (initialSystemMessages.length > 0) {
      this.messages.unshift(...initialSystemMessages);
    }
    const injectedContext = this.messages.filter(message => message.__injected);
    if (injectedContext.length > 0) {
      this.messages = this.messages.filter(message => !message.__injected);
    }

    // 加载上次会话摘要（本地文件兜底）
    // 已移除摘要机制

    // 从 DB 恢复未归档的消息
    const restoredMessages = this.lifecycleManager.consumePendingRestore();
    if (restoredMessages.length > 0) {
      this.messages.push(...restoredMessages);
      Logger.info(`[会话 ${this.key}] 已恢复 ${restoredMessages.length} 条消息`);

      const usage = this.contextWindowManager.getUsageInfo(this.messages);
      Logger.info(`[${this.key}] 恢复后上下文: ${usage.usedTokens}/${usage.maxTokens} tokens (${usage.usagePercent}%)`);

      this.messages = stripAssistantArtifactsFromMessages(this.messages);
      this.messages = await this.contextWindowManager.compactIfNeeded(this.messages, {
        sessionKey: this.key,
        reason: '恢复后',
        signal: options.signal ?? this.activeAbortController?.signal,
        onStatus: this.createContextCompactionNotifier(options.callbacks),
      });
    }

    if (injectedContext.length > 0) {
      this.messages.push(...injectedContext);
    }
  }

  // ─── 消息处理 ───────────────────────────────────────

  private static readonly MAX_INJECTED_CONTEXT = 30;

  /** 静默注入上下文消息，不触发 AI 推理。超过上限自动丢弃最早的注入消息。 */
  injectContext(text: string): void {
    this.messages.push({ role: 'user', content: text, __injected: true });
    this.lastActiveAt = Date.now();
    this.enforceInjectedContextLimit();
  }

  /**
   * 注入给 agent 可见的运行时反馈。
   * 反馈会暂存在 turn-scoped buffer，下一次真正执行 handleMessage 时才进入本轮上下文。
   */
  injectRuntimeFeedback(
    source: string,
    message: string,
    options: RuntimeFeedbackOptions = {},
  ): boolean {
    const enqueued = this.runtimeFeedbackInbox.enqueue(source, message, options);
    if (enqueued) {
      this.lastActiveAt = Date.now();
    }
    return enqueued;
  }

  /**
   * 完整消息处理管线：记忆搜索 → AI 推理 → 工具循环 → 同步历史
   *
   * @param text 用户消息文本
   * @param callbacksOrOptions 旧签名兼容 SessionCallbacks，新签名用 HandleMessageOptions
   */
  async handleMessage(
    text: string | import('../types').ContentBlock[],
    callbacksOrOptions?: SessionCallbacks | HandleMessageOptions,
  ): Promise<HandleMessageResult> {
    return this.handleInput(text, callbacksOrOptions);
  }

  /**
   * 处理 runtime observation（例如子 agent 完成结果）。
   *
   * 对外部模型 API 来说它仍是 role=user 的一轮输入；CatsCo 内部保留
   * __runtimeObservation/runtimeObservationSource 标记，避免和真实用户追加消息混淆。
   */
  async handleRuntimeObservation(
    text: string,
    options: HandleRuntimeObservationOptions = {},
  ): Promise<HandleMessageResult> {
    const { source = 'runtime_observation', ...handleOptions } = options;
    return this.handleInput(text, handleOptions, source, options.suppressFinalResponse === true);
  }

  private async handleInput(
    text: string | import('../types').ContentBlock[],
    callbacksOrOptions?: SessionCallbacks | HandleMessageOptions,
    runtimeObservationSource?: string,
    suppressFinalResponse = false,
  ): Promise<HandleMessageResult> {
    return this.withLogContext(async () => {
      // 兼容旧签名：如果传入的对象有 onText/onToolStart 等字段，视为 SessionCallbacks
      let callbacks: SessionCallbacks | undefined;
      let channel: ChannelCallbacks | undefined;
      let sessionRoute: SessionRoute | undefined;
      let executionScope: ExecutionScope | undefined;
      let localDeviceGrant: ScopedLocalDeviceGrant | undefined;
      let deviceGrants: ScopedDeviceGrant[] | undefined;
      let deviceSelection: ScopedDeviceSelection | undefined;
      let deviceRpc: DeviceRpcTransport | undefined;
      let thinToolRpc: ThinToolRpcTransport | undefined;
      let targetRoutes: TargetRoutes | undefined;
      let localFileGrants: ScopedLocalFileGrant[] | undefined;
      let runtimeFeedbackInputs: RuntimeFeedbackInput[] = [];
      let pendingUserInputProvider: PendingUserInputProvider | undefined;

      if (callbacksOrOptions) {
        if (
          'channel' in callbacksOrOptions
          || 'sessionRoute' in callbacksOrOptions
          || 'executionScope' in callbacksOrOptions
          || 'localDeviceGrant' in callbacksOrOptions
          || 'deviceGrants' in callbacksOrOptions
          || 'deviceSelection' in callbacksOrOptions
          || 'deviceRpc' in callbacksOrOptions
          || 'thinToolRpc' in callbacksOrOptions
          || 'targetRoutes' in callbacksOrOptions
          || 'localFileGrants' in callbacksOrOptions
          || 'callbacks' in callbacksOrOptions
          || 'runtimeFeedback' in callbacksOrOptions
          || 'pendingUserInputProvider' in callbacksOrOptions
        ) {
          // 新签名 HandleMessageOptions
          const opts = callbacksOrOptions as HandleMessageOptions;
          callbacks = opts.callbacks;
          channel = opts.channel;
          sessionRoute = opts.sessionRoute;
          executionScope = opts.executionScope;
          localDeviceGrant = opts.localDeviceGrant;
          deviceGrants = opts.deviceGrants;
          deviceSelection = opts.deviceSelection;
          deviceRpc = opts.deviceRpc;
          thinToolRpc = opts.thinToolRpc;
          targetRoutes = opts.targetRoutes;
          localFileGrants = opts.localFileGrants;
          runtimeFeedbackInputs = opts.runtimeFeedback || [];
          pendingUserInputProvider = opts.pendingUserInputProvider;
        } else {
          // 旧签名 SessionCallbacks
          callbacks = callbacksOrOptions as SessionCallbacks;
        }
      }

      if (this.busy) {
        return { text: BUSY_MESSAGE, visibleToUser: true };
      }

      const runtimeFeedback = this.consumeRuntimeFeedback(runtimeFeedbackInputs);

      // 按"单次消息"统计 metrics，避免跨轮次累积导致定位困难
      Metrics.reset();

      this.busy = true;
      this.interruptRequested = false;
      this.activeAbortController = new AbortController();
      this.lastActiveAt = Date.now();

      try {
        await this.refreshSystemPromptIfNeeded();
      } catch (error: any) {
        Logger.warning(`[会话 ${this.key}] Prompt 热加载失败，继续使用上一版: ${error?.message || error}`);
      }

      this.messages = stripAssistantArtifactsFromMessages(this.messages);
      this.messages = await this.contextWindowManager.compactIfNeeded(this.messages, {
        sessionKey: this.key,
        reason: '处理前',
        signal: this.activeAbortController.signal,
        onStatus: this.createContextCompactionNotifier(callbacks),
      });

      try {
        await this.init({
          callbacks,
          signal: this.activeAbortController.signal,
        });
        const result = await this.turnController.run({
          input: text,
          messages: this.messages,
          runtimeFeedback,
          runtimeObservationSource,
          suppressFinalResponse,
          callbacks,
          channel,
          sessionRoute,
          executionScope,
          localDeviceGrant,
          deviceGrants,
          deviceSelection,
          deviceRpc,
          thinToolRpc,
          targetRoutes,
          localFileGrants,
          pendingUserInputProvider,
          abortSignal: this.activeAbortController.signal,
          shouldContinue: () => !this.interruptRequested,
        });
        this.messages = result.messages;
        this.lifecycleManager.saveContext(this.messages);
        return result;
      } catch (err: any) {
        if (this.isAbortError(err) || this.interruptRequested || this.activeAbortController.signal.aborted) {
          Logger.info(`[会话 ${this.key}] 当前请求已取消`);
          this.messages = this.turnContextBuilder.removeTransientMessages(this.messages);
          this.lifecycleManager.saveContext(this.messages);
          return { text: '已停止当前请求。', visibleToUser: true };
        }

        const recoveredMessages = this.getPartialMessagesFromError(err);
        if (recoveredMessages) {
          this.messages = recoveredMessages;
        }

        // 不删除用户消息，而是添加一个错误回复，保持上下文连贯
        // 这样用户说"继续"时可以接上
        Logger.error(`[会话 ${this.key}] 处理失败: ${err.message}`);

        // 识别多模态相关错误
        const errorMsg = err.message || String(err);
        const isImageSafetyError = isModelImageSafetyError(err);
        const isVisionError = !isImageSafetyError && errorMsg.match(/image|vision|multimodal|media_type|base64.*not supported/i);
        const isModelTimeoutError = this.isModelTimeoutError(err);
        const isTransientProviderError = this.isTransientProviderError(err);
        const relayBudgetErrorReply = this.formatRelayBudgetErrorReply(err);

        let errorReply = ERROR_MESSAGE;
        if (isImageSafetyError) {
          errorReply = MODEL_IMAGE_SAFETY_MESSAGE;
        } else if (relayBudgetErrorReply) {
          errorReply = relayBudgetErrorReply;
        } else if (isVisionError) {
          errorReply = '当前模型不支持图片识别。请使用支持多模态的模型（如 Claude 3.5 Sonnet 或 GPT-4V），或者用文字描述图片内容。';
        } else if (isModelTimeoutError) {
          errorReply = MODEL_TIMEOUT_MESSAGE;
        } else if (isTransientProviderError) {
          errorReply = this.formatTransientProviderErrorReply();
        }

        // 添加错误回复到上下文，保持对话连贯性
        this.messages.push({
          role: 'assistant',
          content: this.formatErrorContextMessage(err, {
            isModelTimeoutError,
            isImageSafetyError,
            isTransientProviderError,
          }),
          __internalErrorArtifact: true,
        });
        this.messages = stripAssistantArtifactsFromMessages(this.turnContextBuilder.removeTransientMessages(this.messages));
        this.lifecycleManager.saveContext(this.messages);

        return { text: errorReply, visibleToUser: true };
      } finally {
        this.planRuntime.clear();
        this.busy = false;
        this.activeAbortController = null;
      }
    });
  }

  // ─── 命令处理 ───────────────────────────────────────

  /** 内置命令 + skill 命令统一入口 */
  async handleCommand(
    command: string,
    args: string[],
    callbacks?: SessionCallbacks,
  ): Promise<CommandResult> {
    return this.withLogContext(async () => {
      const commandName = command.toLowerCase();

      // /stop - 中断当前正在运行的请求
      if (commandName === 'stop') {
        this.requestInterrupt();
        return { handled: true, reply: '正在停止当前请求...' };
      }

      // /clear
      if (commandName === 'clear') {
        if (args.includes('--all')) {
          this.clear();
          return { handled: true, reply: '历史已清空，文件已删除' };
        }
        this.reset();
        return { handled: true, reply: '历史已清空' };
      }

      // /skills
      if (commandName === 'skills') {
        return this.skillRuntime.handleSkillsCommand();
      }

      // /history
      if (commandName === 'history') {
        return {
          handled: true,
          reply: `对话历史信息:\n当前历史长度: ${this.messages.length} 条消息\n上下文压缩: 由 ContextWindowManager 自动管理`,
        };
      }

      // /exit
      if (commandName === 'exit') {
        await this.summarizeAndDestroy();
        return { handled: true, reply: '再见！期待下次与你对话。' };
      }


      return { handled: false };
    });
  }

  // ─── 生命周期 ──────────────────────────────────────

  /** 重置会话状态（仅清内存，保留历史文件） */
  reset(): void {
    this.planRuntime.clear();
    this.stopSubAgents('父会话 reset');
    this.messages = [];
    this.resetCurrentDirectory();
    const state = this.lifecycleManager.reset();
    this.initialized = state.initialized;
    this.promptTrace = undefined;
    this.turnLogRecorder.setPromptMetadata(undefined);
    this.lastActiveAt = state.lastActiveAt;
  }

  /** 清空历史（同时删除文件） */
  clear(): void {
    this.planRuntime.clear();
    this.stopSubAgents('父会话 clear');
    this.messages = [];
    const state = this.lifecycleManager.clear();
    this.resetCurrentDirectory();
    this.initialized = state.initialized;
    this.promptTrace = undefined;
    this.turnLogRecorder.setPromptMetadata(undefined);
    this.lastActiveAt = state.lastActiveAt;
  }

  async summarizeAndDestroy(): Promise<boolean> {
    return this.withLogContext(async () => {
      this.planRuntime.clear();
      this.stopSubAgents('父会话退出');
      if (this.messages.length === 0) return false;
      this.messages = [];
      return true;
    });
  }

  /** 过期或退出时清理内存（保存完整 context） */
  async cleanup(options: SessionCleanupOptions = {}): Promise<void> {
    return this.withLogContext(async () => {
      if (options.stopSubAgents) {
        this.stopSubAgents(options.subAgentStopReason || '父会话清理');
      }
      const subAgentManager = SubAgentManager.getInstance();
      if (typeof (subAgentManager as any).unregisterEventLogger === 'function') {
        subAgentManager.unregisterEventLogger(this.key);
      }
      subAgentManager.unregisterPlatformCallbacks(this.key);
      if (this.messages.length === 0) return;

      try {
        const persistResult = this.lifecycleManager.persistAndClear(this.messages);
        if (persistResult.saved) {
          Logger.info(`会话已保存: ${this.key}, ${persistResult.savedCount} 条消息`);
        }
        this.messages = persistResult.messages;
      } catch (error) {
        Logger.error(`清理会话失败: ${error}`);
      }
    });
  }

  // ─── 查询方法 ──────────────────────────────────────

  isBusy(): boolean {
    return this.busy;
  }

  /** 请求中断当前运行中的对话回合 */
  requestInterrupt(): void {
    this.stopSubAgents('用户请求中止');
    if (!this.busy) return;
    this.interruptRequested = true;
    this.activeAbortController?.abort();
  }

  /** 从 DB 恢复消息（进程重启后调用） */
  restoreFromStore(): boolean {
    return this.withLogContext(() => {
      return this.lifecycleManager.markRestoreFromStore();
    });
  }

  // ─── 私有方法 ──────────────────────────────────────

  private consumeRuntimeFeedback(inputs: RuntimeFeedbackInput[] = []): string[] {
    return this.runtimeFeedbackInbox.consume(inputs);
  }

  private async buildCurrentSystemPrompt(): Promise<{ systemPrompt: string; promptTrace: PromptTraceSnapshot }> {
    const systemPrompt = this.systemPromptOverride
      ? await this.systemPromptOverride()
      : await PromptManager.buildSystemPrompt();
    const promptTrace = PromptManager.buildPromptTraceSnapshot(systemPrompt, {
      source: this.systemPromptOverride ? 'session-provider' : 'prompt-manager',
    });
    return { systemPrompt, promptTrace };
  }

  private async refreshSystemPromptIfNeeded(): Promise<void> {
    if (!this.initialized || !this.promptTrace) return;

    const { systemPrompt, promptTrace } = await this.buildCurrentSystemPrompt();
    const changed = this.diffPromptTrace(promptTrace);
    if (!changed.any) return;

    if (changed.system) {
      this.replacePrimarySystemPrompt(systemPrompt);
    }
    this.applyPromptTrace(promptTrace, 'reload');

    const changedParts = [
      changed.system ? 'system' : '',
      changed.bundle ? 'bundle' : '',
      changed.version ? 'version' : '',
      changed.promptsDir ? 'prompts_dir' : '',
    ].filter(Boolean).join(',');
    Logger.info(`[会话 ${this.key}] Prompt 热加载: changed=${changedParts || 'unknown'}`);
  }

  private diffPromptTrace(next: PromptTraceSnapshot): {
    any: boolean;
    system: boolean;
    bundle: boolean;
    version: boolean;
    promptsDir: boolean;
  } {
    const current = this.promptTrace;
    if (!current) {
      return { any: true, system: true, bundle: true, version: true, promptsDir: true };
    }
    const system = current.system.sha256 !== next.system.sha256;
    const bundle = current.bundle.sha256 !== next.bundle.sha256;
    const version = current.prompt_version !== next.prompt_version;
    const promptsDir = current.prompts_dir !== next.prompts_dir;
    return {
      any: system || bundle || version || promptsDir,
      system,
      bundle,
      version,
      promptsDir,
    };
  }

  private replacePrimarySystemPrompt(systemPrompt: string): void {
    const nextPrompt = systemPrompt.trim();
    const existingIndex = this.messages.findIndex(message => (
      message.role === 'system'
      && !message.__injected
    ));

    if (!nextPrompt) {
      if (existingIndex >= 0) {
        this.messages.splice(existingIndex, 1);
      }
      return;
    }

    const nextMessage: Message = { role: 'system', content: systemPrompt };
    if (existingIndex >= 0) {
      this.messages[existingIndex] = nextMessage;
      return;
    }
    this.messages.unshift(nextMessage);
  }

  private applyPromptTrace(promptTrace: PromptTraceSnapshot, reason: 'init' | 'reload'): void {
    this.promptTrace = promptTrace;
    this.sessionTurnLogger.logPromptTrace(promptTrace);
    this.turnLogRecorder.setPromptMetadata(toPromptTurnMetadata(promptTrace));
    const label = reason === 'reload' ? 'Prompt trace reload' : 'Prompt trace';
    Logger.info(
      `[会话 ${this.key}] ${label}: system=${promptTrace.system.short_hash}, bundle=${promptTrace.bundle.short_hash}, files=${promptTrace.bundle.file_count}, version=${promptTrace.prompt_version}`,
    );
  }

  private createContextCompactionNotifier(callbacks?: SessionCallbacks): ((event: ContextCompactionStatusEvent) => Promise<void>) | undefined {
    if (!callbacks?.onThinking) return undefined;
    return async (event: ContextCompactionStatusEvent) => {
      const message = this.formatContextCompactionStatus(event);
      if (!message) return;
      try {
        await callbacks.onThinking?.(message);
      } catch (err) {
        Logger.warning(`[会话 ${this.key}] 上下文压缩提示发送失败: ${err}`);
      }
    };
  }

  private formatContextCompactionStatus(event: ContextCompactionStatusEvent): string {
    switch (event.status) {
      case 'start':
        return CONTEXT_COMPACTION_START_MESSAGE;
      case 'complete':
        return CONTEXT_COMPACTION_COMPLETE_MESSAGE;
      case 'error':
        return CONTEXT_COMPACTION_ERROR_MESSAGE;
      default:
        return '';
    }
  }

  private stopSubAgents(reason: string): void {
    const result = SubAgentManager.getInstance().stopAllForParent(this.key, reason);
    if (result.stopped > 0) {
      Logger.info(`[会话 ${this.key}] ${reason}，已停止 ${result.stopped} 个后台子任务`);
    }
  }

  private enforceInjectedContextLimit(): void {
    const injectedCount = this.messages.filter(m => m.__injected).length;
    if (injectedCount <= AgentSession.MAX_INJECTED_CONTEXT) return;
    const idx = this.messages.findIndex(m => m.__injected);
    if (idx >= 0) this.messages.splice(idx, 1);
  }

  private isAbortError(error: any): boolean {
    return error?.name === 'AbortError'
      || error?.code === 'ERR_CANCELED'
      || /请求已取消|aborted|aborterror|canceled|cancelled/i.test(String(error?.message || ''));
  }

  private getPartialMessagesFromError(error: AgentTurnRunError): Message[] | null {
    const partialMessages = error?.partialMessages;
    if (!Array.isArray(partialMessages) || partialMessages.length === 0) {
      return null;
    }
    return this.turnContextBuilder.removeTransientMessages(partialMessages);
  }

  private isModelTimeoutError(error: any): boolean {
    const text = String(error?.message || error || '');
    return /API错误\s*\(504\)|request_timed_out|request timed out|default_request_timeout_in_seconds|upstream request timeout|gateway timeout/i.test(text);
  }

  private isTransientProviderError(error: any): boolean {
    const status = this.extractErrorStatus(error);
    if (status && [500, 502, 503, 504, 520, 524, 529].includes(status)) {
      return true;
    }

    const text = String(error?.message || error || '');
    return /unknown error,\s*520|overloaded_error|service unavailable|bad gateway|gateway timeout|upstream (?:error|timeout)|MaxRetriesExceededError|Connection error|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network error|premature close/i.test(text);
  }

  private formatRelayBudgetErrorReply(error: any): string | null {
    const text = String(error?.message || error || '');
    const status = this.extractErrorStatus(error);
    const isBudgetError =
      status === 402
      || /api错误\s*\(402\)|status(?:\s*code)?\s*[:=]?\s*402\b|http(?:\s*status)?\s*[:=]?\s*402\b|payment[_\s-]?required/i.test(text)
      || /budget exceeded|quota exceeded|insufficient quota|insufficient balance|credits? exhausted|monthly budget|model budget|relay budget/i.test(text)
      || /额度.{0,12}(不足|用完|耗尽|超限|达到上限|已用尽)|余额不足|已达.*额度上限/.test(text);

    if (!isBudgetError) {
      return null;
    }

    const model = this.currentModelName();
    const modelLabel = model ? `当前模型 ${model} 的` : '当前模型的';
    if (/model budget exceeded|model quota|模型.{0,8}额度/i.test(text)) {
      return `${modelLabel}中转额度已用完，暂时不能继续调用。\n\n你可以切换到还有额度的模型，或到 CatsCompany 中转页面查看额度；如果这是学校/团队账号，请联系管理员调整额度。`;
    }

    if (/monthly budget exceeded|account budget|user budget|账号.{0,8}额度|本月.{0,8}额度/i.test(text)) {
      return '当前账号的中转额度已用完，暂时不能继续调用模型。\n\n请到 CatsCompany 中转页面查看额度，或联系管理员调整额度。';
    }

    return `模型中转额度不足，当前请求没有继续调用${model ? ` ${model}` : ''}。\n\n你可以切换模型、稍后重试，或到 CatsCompany 中转页面查看额度并联系管理员调整。`;
  }

  private extractErrorStatus(error: any): number | null {
    const status = error?.status || error?.response?.status || error?.error?.status;
    if (typeof status === 'number') return status;

    const text = String(error?.message || error || '');
    const match = text.match(/(?:API错误|HTTP|status(?:\s*code)?)\s*[\(:= ]\s*(\d{3})\b/i);
    if (!match) return null;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private currentModelName(): string | null {
    const config = typeof (this.services.aiService as any).getConfig === 'function'
      ? (this.services.aiService as any).getConfig()
      : {};
    const model = String(config?.model || '').trim();
    return model || null;
  }

  private formatTransientProviderErrorReply(): string {
    const model = this.currentModelName();
    return model
      ? `当前模型 ${model} 的服务临时异常，刚才这次请求没有完成。我已经保留上下文；你可以稍后重试，或临时切换到其他模型继续。`
      : MODEL_TRANSIENT_ERROR_MESSAGE;
  }

  private formatErrorContextMessage(
    error: any,
    flags: {
      isModelTimeoutError?: boolean;
      isImageSafetyError?: boolean;
      isTransientProviderError?: boolean;
    },
  ): string {
    const detail = this.sanitizeErrorMessage(error?.message || String(error));
    if (flags.isModelTimeoutError) {
      return `[处理中断: 模型中转请求超时。已保留本轮已完成的工具结果和上下文；如果用户要求继续，请基于当前上下文继续，避免重复已经完成的工具步骤。错误摘要: ${detail}]`;
    }
    if (flags.isImageSafetyError) {
      return `[处理中断: 上游模型拒绝了当前对话中的图片。已保留本轮已完成的上下文；如果用户要求继续，请提示用户删除或更换相关图片，或新开对话后继续。错误摘要: ${detail}]`;
    }
    if (flags.isTransientProviderError) {
      return `[处理中断: 模型服务临时异常或上游网关错误。已保留本轮上下文；如果用户要求继续，请从当前状态继续，不要重复已经完成的工具步骤。错误摘要: ${detail}]`;
    }
    return `[处理失败: ${detail}]`;
  }

  private sanitizeErrorMessage(message: string): string {
    const normalized = String(message || 'unknown error')
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]')
      .replace(/("?api_?key"?\s*[:=]\s*)"?[^"\s,}]+/gi, '$1[redacted]')
      .replace(/("?authorization"?\s*[:=]\s*)"?[^"\s,}]+/gi, '$1[redacted]')
      .replace(/\s+/g, ' ')
      .trim();
    const maxLength = 600;
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, maxLength)}...(已截断)`;
  }

}
