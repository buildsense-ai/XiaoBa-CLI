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
import type { TurnSkillSnapshotStore } from '../skills/turn-skill-snapshot';
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
import { MetricsCollector } from '../utils/metrics';
import { ContextWindowManager } from './context-window-manager';
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
import {
  classifyModelError,
  isModelImageSafetyError,
  type ModelErrorCategory,
} from '../utils/model-error-classifier';
import {
  readModelErrorDiagnostics,
  type ModelErrorPhase,
} from '../utils/model-error-observability';
import { stripAssistantArtifactsFromMessages } from '../utils/transcript-artifacts';
import type { PromptTraceSnapshot } from '../utils/prompt-observability';
import { toPromptTurnMetadata } from '../utils/prompt-observability';
import type { StreamRetryInfo } from '../providers/provider';
import {
  reconcileCurrentBotPromptBeforeTurn,
  scheduleCurrentBotPromptReconcile,
} from '../bot-definition/prompt-sync';
import { collectRemoteContextWatermarks } from './remote-context-watermarks';
import {
  CheckpointCompactionCoordinator,
  type CheckpointCompactionPhase,
  isCheckpointCompactionEnabled,
  splitDurableAndTransient,
} from './checkpoint-compaction';
import { estimateToolsTokens } from './token-estimator';
import {
  CheckpointCandidate,
  createCheckpointSnapshot,
  hashMessages,
  hasCompleteToolExchanges,
} from './checkpoint-candidate';
import type { SessionRuntimeLogEvent, TurnErrorPayload } from '../utils/session-log-schema';

export type { RuntimeFeedbackInput, RuntimeFeedbackOptions } from './runtime-feedback-inbox';

export interface DurableRemoteContextEntry {
  source: string;
  id: number;
  role?: 'user' | 'assistant';
  content: string;
}

export const BUSY_MESSAGE = '正在处理上一条消息，请稍候...';
export const ERROR_MESSAGE = '本次处理未能完成，请稍后再试。';
export const MODEL_TIMEOUT_MESSAGE = '模型响应超时，本轮上下文已保留，请稍后继续。';
export const MODEL_TRANSIENT_ERROR_MESSAGE = '模型服务暂时不可用，请稍后再试。';
export const EMPTY_MODEL_RESPONSE_MESSAGE = '模型本轮未返回有效内容，请重新发送上一条消息；若仍失败，请切换模型或稍后再试。';
export const MODEL_RECOVERY_FAILED_MESSAGE = '模型服务暂时不稳定，系统已尝试自动恢复但仍未成功，请稍后继续。';
export const MODEL_REQUEST_FAILED_MESSAGE = '模型服务暂时不稳定，本次处理未能完成，请稍后继续。';
export const CONTEXT_COMPACTION_START_MESSAGE = '正在压缩上下文，整理较早的对话内容。';
export const CONTEXT_COMPACTION_COMPLETE_MESSAGE = '上下文压缩完成，继续处理当前请求。';
export const CONTEXT_COMPACTION_ERROR_MESSAGE = '上下文压缩失败，已保留原上下文继续处理。';
export const CONTEXT_CHECKPOINT_BLOCKED_MESSAGE = '上下文检查点创建失败，会话已冻结以保护完整历史。请清空会话或恢复模型配置后重试。';
const CONTEXT_CHECKPOINT_BLOCKED_ERROR = 'CONTEXT_CHECKPOINT_BLOCKED';
const CHECKPOINT_CANDIDATE_TTL_MS = 5 * 60 * 1000;
const CHECKPOINT_PROVIDER_REQUEST_LIMIT = 18;
const CHECKPOINT_CANDIDATE_TRIGGER_PERCENT = 75;
const CHECKPOINT_CANDIDATE_SERIAL_THRESHOLD_PERCENT = 85;

// ─── 接口定义 ───────────────────────────────────────────

/** 共享服务集合 */
export interface AgentServices {
  aiService: AIService;
  /** Dedicated runtime used only by the Memory Search Branch. */
  memoryBranch?: {
    enabled: boolean;
    modelSource: 'inherit' | 'catalog' | 'custom';
    aiService: AIService;
  };
  toolManager: ToolManager;
  skillManager: SkillManager;
  /** Optional so tests and embedded legacy runtimes keep their existing path. */
  turnSkillSnapshotStore?: TurnSkillSnapshotStore;
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
  /** 当前 turn 的短期 Artifact context ref；不进入模型消息或持久历史。 */
  artifactContextRef?: string;
  /** 当前 turn 的短期 Artifact task ref；不进入模型消息或持久历史。 */
  artifactTaskRef?: string;
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
  /** Explicit lifecycle result for adapters that expose per-turn task state. */
  taskOutcome?: 'completed' | 'failed' | 'cancelled';
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
  private lifecycleGeneration = 0;
  lastActiveAt: number = Date.now();
  private sessionTurnLogger: SessionTurnLogger;
  private turnLogRecorder: TurnLogRecorder;
  private turnContextBuilder = new TurnContextBuilder();
  private turnController: AgentTurnController;
  private contextWindowManager: ContextWindowManager;
  private checkpointCompactionCoordinator: CheckpointCompactionCoordinator;
  private checkpointCandidateCoordinator: CheckpointCompactionCoordinator;
  private readonly useCheckpointCompaction: boolean;
  private readonly useCheckpointCandidates: boolean;
  private checkpointCandidate: CheckpointCandidate | null = null;
  private checkpointCandidatePromise: Promise<boolean> | null = null;
  private checkpointCandidateAbortController: AbortController | null = null;
  private checkpointCandidateSuppressed = false;
  /** A failed candidate still requires serial fallback once the stop point is reached. */
  private checkpointCandidateFallbackRequired = false;
  private checkpointBlockedReason: string | null = null;
  private checkpointCandidateSequence = 0;
  /** Epoch for destructive transcript replacement; tail appends keep the same epoch. */
  private checkpointRevision = 0;
  private skillRuntime: SessionSkillRuntime;
  private runtimeFeedbackInbox = new RuntimeFeedbackInbox();
  private planRuntime = new PlanRuntime();
  private lifecycleManager: SessionLifecycleManager;
  private readonly defaultDirectory: string;
  private readonly metrics = new MetricsCollector();
  private resumeInFlight = false;
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
    const checkpointCandidatesEnabled = process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED !== 'false';
    this.checkpointCompactionCoordinator = new CheckpointCompactionCoordinator(
      services.aiService,
      {
        maxContextTokens: contextWindow.promptBudgetTokens,
        ...(checkpointCandidatesEnabled ? { compactionThreshold: 0.85 } : {}),
      },
    );
    this.checkpointCandidateCoordinator = new CheckpointCompactionCoordinator(
      services.aiService,
      {
        maxContextTokens: contextWindow.promptBudgetTokens,
        compactionThreshold: CHECKPOINT_CANDIDATE_TRIGGER_PERCENT / 100,
      },
    );
    this.useCheckpointCompaction = isCheckpointCompactionEnabled();
    this.useCheckpointCandidates = checkpointCandidatesEnabled;
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
      checkpointCompactionCoordinator: this.useCheckpointCompaction
        ? this.checkpointCompactionCoordinator
        : undefined,
      metrics: this.metrics,
      persistCheckpoint: messages => {
        if (!this.persistCheckpoint(messages)) {
          throw new Error('Failed to persist continuation checkpoint');
        }
      },
      checkpointCandidateBoundary: messages => (
        this.handleCheckpointCandidateBoundary(messages, this.lifecycleGeneration)
      ),
      beforeModelRequest: (messages, tools) => {
        if (this.checkpointBlockedReason) {
          throw new Error(CONTEXT_CHECKPOINT_BLOCKED_ERROR);
        }
        const usage = this.getContextUsageInfo(messages);
        const toolTokens = estimateToolsTokens(tools);
        if (usage.usedTokens + toolTokens >= usage.maxTokens * 0.85) {
          throw new Error(CONTEXT_CHECKPOINT_BLOCKED_ERROR);
        }
      },
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
    const lifecycleGeneration = this.lifecycleGeneration;
    const initSignal = options.signal ?? this.activeAbortController?.signal;
    const { systemPrompt, promptTrace } = await this.buildCurrentSystemPrompt();
    if (initSignal?.aborted || this.interruptRequested || lifecycleGeneration !== this.lifecycleGeneration) {
      Logger.info(`[会话 ${this.key}] 初始化期间会话已重置，忽略旧初始化结果`);
      return;
    }
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

      const usage = this.getContextUsageInfo(this.messages);
      Logger.info(`[${this.key}] 恢复后上下文: ${usage.usedTokens}/${usage.maxTokens} tokens (${usage.usagePercent}%)`);

      const compactionSignal = initSignal;
      const messagesBeforeRestoreCompaction = stripAssistantArtifactsFromMessages(this.messages);
      const compactionResult = await this.compactContextIfNeeded(
        messagesBeforeRestoreCompaction,
        'restore',
        '恢复后',
        compactionSignal,
        options.callbacks,
      );
      if (compactionSignal?.aborted || this.interruptRequested || lifecycleGeneration !== this.lifecycleGeneration) {
        Logger.info(`[会话 ${this.key}] 当前请求已取消或会话已重置，忽略恢复压缩的旧结果`);
        return;
      }
      if (compactionResult.compacted) {
        if (this.persistCheckpoint(compactionResult.messages)) {
          this.messages = compactionResult.messages;
        } else {
          Logger.warning(`[会话 ${this.key}] 恢复检查点持久化失败，保留原始上下文`);
          this.messages = messagesBeforeRestoreCompaction;
        }
      } else {
        this.messages = compactionResult.messages;
      }
    }

    if (injectedContext.length > 0) {
      this.messages.push(...injectedContext);
    }
  }

  // ─── 消息处理 ───────────────────────────────────────

  private static readonly MAX_INJECTED_CONTEXT = 30;

  /** 静默注入瞬时运行上下文，不触发 AI 推理。超过上限自动丢弃最早的注入消息。 */
  injectContext(text: string): void {
    this.messages.push({ role: 'user', content: text, __injected: true });
    this.lastActiveAt = Date.now();
    this.enforceInjectedContextLimit();
  }

  /**
   * 追加远端耐久会话历史。先恢复本地会话，再纳入统一 token 压缩并落盘；
   * 调用方只有在返回 true 后才能推进远端游标，避免崩溃或写盘失败造成永久漏历史。
   */
  async appendDurableContext(
    inputs: Array<string | DurableRemoteContextEntry>,
    cursorUpdate?: { source: string; cursor: number },
  ): Promise<boolean> {
    const lifecycleGeneration = this.lifecycleGeneration;
    await this.init();
    if (lifecycleGeneration !== this.lifecycleGeneration) return false;

    const knownRemoteIds = new Set(this.messages
      .filter(message => message.__remoteContextSource && Number(message.__remoteContextId) > 0)
      .map(message => `${message.__remoteContextSource}:${message.__remoteContextId}`));
    const remoteContextWatermarks = collectRemoteContextWatermarks(this.messages);
    const durableEntries = inputs
      .map(input => typeof input === 'string'
        ? { content: input }
        : input)
      .filter(entry => typeof entry.content === 'string' && entry.content.trim())
      .filter(entry => {
        if (!('source' in entry) || !('id' in entry) || !entry.source || entry.id <= 0) return true;
        const key = `${entry.source}:${entry.id}`;
        if (
          knownRemoteIds.has(key)
          || entry.id <= (remoteContextWatermarks[entry.source] || 0)
        ) {
          return false;
        }
        knownRemoteIds.add(key);
        return true;
      });
    if (durableEntries.length === 0) {
      return cursorUpdate
        ? this.lifecycleManager.saveRemoteContextCursor(cursorUpdate.source, cursorUpdate.cursor)
        : true;
    }
    const messagesBeforeAppend = [...this.messages];
    this.messages.push(...durableEntries.map(entry => ({
      role: 'role' in entry && entry.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: entry.content,
      ...('source' in entry && 'id' in entry ? {
        __remoteContextSource: entry.source,
        __remoteContextId: entry.id,
      } : {}),
    })));
    const messagesBeforeCompaction = stripAssistantArtifactsFromMessages(this.messages);
    const compactionResult = await this.compactContextIfNeeded(
      messagesBeforeCompaction,
      'restore',
      '群聊历史补入',
    );
    if (lifecycleGeneration !== this.lifecycleGeneration) return false;
    this.messages = compactionResult.messages;
    this.lastActiveAt = Date.now();
    if (!this.lifecycleManager.saveContext(this.messages)) {
      this.messages = messagesBeforeAppend;
      return false;
    }
    if (!cursorUpdate) return true;
    if (this.lifecycleManager.saveRemoteContextCursor(cursorUpdate.source, cursorUpdate.cursor)) return true;

    this.messages = messagesBeforeAppend;
    if (!this.lifecycleManager.saveContext(this.messages)) {
      Logger.error(`[${this.key}] 远端游标落盘失败后，本地历史回滚也失败`);
    }
    return false;
  }

  getRemoteContextCursor(source: string): number {
    return this.lifecycleManager.loadRemoteContextCursor(source);
  }

  saveRemoteContextCursor(source: string, cursor: number): boolean {
    return this.lifecycleManager.saveRemoteContextCursor(source, cursor);
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
      let artifactContextRef: string | undefined;
      let artifactTaskRef: string | undefined;
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
          || 'artifactContextRef' in callbacksOrOptions
          || 'artifactTaskRef' in callbacksOrOptions
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
          artifactContextRef = opts.artifactContextRef;
          artifactTaskRef = opts.artifactTaskRef;
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
      if (this.checkpointBlockedReason) {
        return {
          text: CONTEXT_CHECKPOINT_BLOCKED_MESSAGE,
          visibleToUser: true,
          taskOutcome: 'failed',
        };
      }
      const lifecycleGeneration = this.lifecycleGeneration;

      const runtimeFeedback = this.consumeRuntimeFeedback(runtimeFeedbackInputs);

      // 按"单次消息"统计 metrics，避免跨轮次累积导致定位困难
      this.metrics.reset();

      this.busy = true;
      this.interruptRequested = false;
      this.activeAbortController = new AbortController();
      this.lastActiveAt = Date.now();
      const turnStartedAt = Date.now();
      let failurePhase: ModelErrorPhase = 'pre_turn_compaction';

      try {
        await reconcileCurrentBotPromptBeforeTurn();
        await this.refreshSystemPromptIfNeeded(lifecycleGeneration, this.activeAbortController.signal);
      } catch (error: any) {
        Logger.warning(`[会话 ${this.key}] Prompt 热加载失败，继续使用上一版: ${error?.message || error}`);
      }

      try {
        const messagesBeforeCompaction = stripAssistantArtifactsFromMessages(this.messages);
        const messagesForCompaction = await this.handleCheckpointCandidateBoundary(
          messagesBeforeCompaction,
          lifecycleGeneration,
          'pre_turn',
        );
        const compactionResult = await this.compactContextIfNeeded(
          messagesForCompaction,
          'pre_turn',
          '处理前',
          this.activeAbortController.signal,
          callbacks,
        );
        if (this.interruptRequested || this.activeAbortController.signal.aborted) {
          Logger.info(`[会话 ${this.key}] 当前请求已取消，忽略压缩在中断后的返回`);
          this.saveInterruptedContextIfCurrent(lifecycleGeneration);
          return { text: '已停止当前请求。', visibleToUser: true, taskOutcome: 'cancelled' };
        }
        if (compactionResult.compacted) {
          if (this.persistCheckpoint(compactionResult.messages)) {
            this.checkpointRevision++;
            this.messages = compactionResult.messages;
          } else {
            Logger.warning(`[会话 ${this.key}] 处理前检查点持久化失败，保留原始上下文`);
            this.messages = messagesForCompaction;
          }
        } else {
          this.messages = compactionResult.messages;
        }
        if (this.useCheckpointCompaction
          && this.isCheckpointCandidateSerialThresholdReached(
            this.getContextUsageInfo(this.messages),
          )) {
          throw new Error(CONTEXT_CHECKPOINT_BLOCKED_ERROR);
        }

        failurePhase = 'session_init';
        await this.init({
          callbacks,
          signal: this.activeAbortController.signal,
        });
        if (this.interruptRequested || this.activeAbortController.signal.aborted) {
          Logger.info(`[会话 ${this.key}] 当前请求已取消，不再启动模型回合`);
          this.saveInterruptedContextIfCurrent(lifecycleGeneration);
          return { text: '已停止当前请求。', visibleToUser: true, taskOutcome: 'cancelled' };
        }
        failurePhase = 'agent_turn';
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
          artifactContextRef,
          artifactTaskRef,
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
        if (this.interruptRequested || this.activeAbortController.signal.aborted) {
          Logger.info(`[会话 ${this.key}] 当前请求已取消，忽略模型在中断后的返回`);
          this.messages = this.turnContextBuilder.removeTransientMessages(this.messages);
          this.saveInterruptedContextIfCurrent(lifecycleGeneration);
          return { text: '已停止当前请求。', visibleToUser: true, taskOutcome: 'cancelled' };
        }
        this.messages = result.messages;
        failurePhase = 'result_persistence';
        this.lifecycleManager.saveContext(this.messages);
        return { ...result, taskOutcome: 'completed' };
      } catch (err: any) {
        if (this.isAbortError(err) || this.interruptRequested || this.activeAbortController.signal.aborted) {
          Logger.info(`[会话 ${this.key}] 当前请求已取消`);
          this.messages = this.turnContextBuilder.removeTransientMessages(this.messages);
          this.saveInterruptedContextIfCurrent(lifecycleGeneration);
          return { text: '已停止当前请求。', visibleToUser: true, taskOutcome: 'cancelled' };
        }

        if (String(err?.message || err) === CONTEXT_CHECKPOINT_BLOCKED_ERROR
          || String(err?.cause?.message || '') === CONTEXT_CHECKPOINT_BLOCKED_ERROR) {
          this.checkpointBlockedReason ??= CONTEXT_CHECKPOINT_BLOCKED_ERROR;
          const blockedMessages = this.getPartialMessagesFromError(err) || this.messages;
          this.messages = stripAssistantArtifactsFromMessages(
            this.turnContextBuilder.removeTransientMessages(blockedMessages),
          );
          this.lifecycleManager.saveContext(this.messages);
          Logger.error(`[会话 ${this.key}] 上下文检查点失败，会话已冻结并保留完整历史`);
          return {
            text: CONTEXT_CHECKPOINT_BLOCKED_MESSAGE,
            visibleToUser: true,
            taskOutcome: 'failed',
          };
        }

        const recoveredMessages = this.getPartialMessagesFromError(err);
        const partialProgressPreserved = recoveredMessages
          ? this.hasRecoverablePartialProgress(recoveredMessages)
          : false;
        if (recoveredMessages) {
          this.messages = recoveredMessages;
        }

        // 识别多模态相关错误
        const errorMsg = err.message || String(err);
        const isImageSafetyError = isModelImageSafetyError(err);
        const isVisionError = !isImageSafetyError && errorMsg.match(/image|vision|multimodal|media_type|base64.*not supported/i);
        const isModelTimeoutError = this.isModelTimeoutError(err);
        const isTransientProviderError = this.isTransientProviderError(err);
        const isEmptyModelResponseError = this.isEmptyModelResponseError(err);
        const isRelayBudgetError = this.isRelayBudgetError(err);
        const closestDiagnostics = readModelErrorDiagnostics(err);
        const classified = classifyModelError(err, {
          isImageSafetyError,
          isRelayBudgetError,
          isVisionError: Boolean(isVisionError),
          isTimeout: isModelTimeoutError,
          isEmptyResponse: isEmptyModelResponseError,
          isTransient: isTransientProviderError,
        }, {
          provider: this.currentProviderName() ?? undefined,
          model: this.currentModelName() ?? undefined,
          phase: closestDiagnostics?.phase ?? failurePhase,
        });
        const diagnostics = classified.diagnostics;
        const retry = diagnostics.retry;
        const errorPayload: TurnErrorPayload = {
          error_code: classified.error_code,
          category: classified.category,
          classification_confidence: classified.confidence,
          outcome: 'conversation_interrupted',
          phase: diagnostics.phase ?? failurePhase,
          error_origin: diagnostics.origin,
          recovery_action: classified.recovery_action,
          retry_strategy: classified.retry_strategy,
          model: diagnostics.model ?? this.currentModelName(),
          provider: diagnostics.provider ?? this.currentProviderName(),
          http_status: diagnostics.http_status ?? this.extractErrorStatus(err),
          provider_code: diagnostics.provider_code,
          provider_type: diagnostics.provider_type,
          provider_request_id: diagnostics.request_id,
          provider_response_id: diagnostics.response_id,
          terminal_event: diagnostics.terminal_event,
          provider_failure_phase: diagnostics.failure_phase,
          error_fingerprint: diagnostics.fingerprint,
          stack_fingerprint: diagnostics.stack_fingerprint,
          top_frame: diagnostics.top_frame,
          error_summary: diagnostics.error_summary,
          attempt_count: retry?.attempt_count ?? 1,
          retry_count: retry?.retry_count ?? 0,
          retry_stop_reason: retry?.stop_reason ?? 'unknown',
          retry_elapsed_ms: retry?.elapsed_ms ?? 0,
          turn_elapsed_ms: Date.now() - turnStartedAt,
          partial_progress_preserved: partialProgressPreserved,
          episode_id: diagnostics.attempt?.episode_id,
          model_call_id: diagnostics.attempt?.call_id,
          model_attempt_id: diagnostics.attempt?.attempt_id,
          model_attempt_number: diagnostics.attempt?.attempt_number,
        };

        // 只有真正退出本轮并返回 taskOutcome=failed 的路径才写 turn_error。
        Logger.error(
          `[会话 ${this.key}] 处理中断: ${diagnostics.error_summary}`,
          {
            type: 'turn_error',
            payload: errorPayload as unknown as Record<string, unknown>,
          } as SessionRuntimeLogEvent,
        );

        const errorReply = this.formatClassifiedErrorReply(
          classified.category,
          classified.user_message,
          retry?.retry_count ?? 0,
        );

        // 添加错误回复到上下文，保持对话连贯性
        this.messages.push({
          role: 'assistant',
          content: this.formatErrorContextMessage(err, {
            isModelTimeoutError,
            isImageSafetyError,
            isTransientProviderError,
            isEmptyModelResponseError,
          }),
          __internalErrorArtifact: true,
        });
        this.messages = stripAssistantArtifactsFromMessages(this.turnContextBuilder.removeTransientMessages(this.messages));
        this.lifecycleManager.saveContext(this.messages);

        return { text: errorReply, visibleToUser: true, taskOutcome: 'failed' };
      } finally {
        if (this.interruptRequested || lifecycleGeneration !== this.lifecycleGeneration) {
          this.cancelCheckpointCandidate();
        }
        this.planRuntime.clear();
        scheduleCurrentBotPromptReconcile();
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

      // /resume - retry a recoverable checkpoint without deleting history
      if (commandName === 'resume') {
        if (this.busy) return { handled: true, reply: BUSY_MESSAGE };
        const resumed = await this.resumeCheckpoint();
        return {
          handled: true,
          reply: resumed
            ? '会话已恢复，完整历史已保留，可以继续对话。'
            : CONTEXT_CHECKPOINT_BLOCKED_MESSAGE,
        };
      }

      // /clear
      if (commandName === 'clear') {
        this.requestInterrupt();
        if (args.includes('--all')) {
          const persisted = this.clear();
          return {
            handled: true,
            reply: persisted
              ? '历史已清空，文件已删除'
              : '历史已在当前进程清空，但文件删除失败，请重试 /clear --all。',
          };
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

  /** Retry a blocked checkpoint using the latest transcript without clearing it. */
  async resumeCheckpoint(): Promise<boolean> {
    if (this.busy || this.resumeInFlight) return false;
    this.resumeInFlight = true;
    try {
      const generation = this.lifecycleGeneration;
      if (!this.checkpointBlockedReason) return true;
      const source = stripAssistantArtifactsFromMessages(
        this.turnContextBuilder.removeTransientMessages(this.messages),
      );
      // Recovery is deliberately synchronous; it must not launch another candidate.
      const coordinator = this.checkpointCompactionCoordinator;
      let result;
      try {
        result = await coordinator.compactIfNeeded(source, {
          sessionKey: this.key,
          phase: 'restore',
          toolTokens: this.getToolDefinitionTokens(),
          providerRequestBudget: { maxRequests: CHECKPOINT_PROVIDER_REQUEST_LIMIT, usedRequests: 0 },
          recordMetrics: false,
          metrics: this.metrics,
        });
      } catch (error) {
        if (generation === this.lifecycleGeneration) {
          this.checkpointBlockedReason = CONTEXT_CHECKPOINT_BLOCKED_ERROR;
        }
        Logger.warning(`[会话 ${this.key}] resume checkpoint failed closed: ${String((error as any)?.message || error)}`);
        return false;
      }
      if (generation !== this.lifecycleGeneration) return false;
      if (result.compacted) {
        if (this.isCheckpointCandidateSerialThresholdReached(this.getContextUsageInfo(result.messages))
          || !this.persistCheckpoint(result.messages)) {
          this.checkpointBlockedReason = CONTEXT_CHECKPOINT_BLOCKED_ERROR;
          return false;
        }
        this.checkpointRevision++;
        this.messages = result.messages;
      } else if (this.isCheckpointCandidateSerialThresholdReached(this.getContextUsageInfo(source))) {
        this.checkpointBlockedReason = CONTEXT_CHECKPOINT_BLOCKED_ERROR;
        return false;
      }
      this.checkpointBlockedReason = null;
      this.checkpointCandidateFallbackRequired = false;
      this.checkpointCandidateSuppressed = false;
      return true;
    } finally {
      this.resumeInFlight = false;
    }
  }

  /** 重置会话状态（仅清内存，保留历史文件） */
  reset(): void {
    this.lifecycleGeneration++;
    this.checkpointRevision++;
    this.cancelCheckpointCandidate();
    this.checkpointCandidateFallbackRequired = false;
    this.checkpointBlockedReason = null;
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

  /** 清空历史（同时删除文件），返回本地文件与状态是否都删除成功。 */
  clear(): boolean {
    this.lifecycleGeneration++;
    this.checkpointRevision++;
    this.cancelCheckpointCandidate();
    this.checkpointCandidateFallbackRequired = false;
    this.checkpointBlockedReason = null;
    this.planRuntime.clear();
    this.stopSubAgents('父会话 clear');
    this.messages = [];
    const state = this.lifecycleManager.clear();
    this.currentDirectory = this.defaultDirectory;
    this.initialized = state.initialized;
    this.promptTrace = undefined;
    this.turnLogRecorder.setPromptMetadata(undefined);
    this.lastActiveAt = state.lastActiveAt;
    return state.persisted;
  }

  async summarizeAndDestroy(): Promise<boolean> {
    this.lifecycleGeneration++;
    this.checkpointRevision++;
    return this.withLogContext(async () => {
      this.planRuntime.clear();
      this.cancelCheckpointCandidate();
      this.stopSubAgents('父会话退出');
      if (this.messages.length === 0) return false;
      this.messages = [];
      return true;
    });
  }

  /** 过期或退出时清理内存（保存完整 context） */
  async cleanup(options: SessionCleanupOptions = {}): Promise<void> {
    this.lifecycleGeneration++;
    this.checkpointRevision++;
    return this.withLogContext(async () => {
      this.cancelCheckpointCandidate();
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
    if (this.resumeInFlight) {
      this.lifecycleGeneration++;
      this.checkpointRevision++;
    }
    this.stopSubAgents('用户请求中止');
    this.cancelCheckpointCandidate();
    if (!this.busy) return;
    this.interruptRequested = true;
    this.activeAbortController?.abort();
  }

  private saveInterruptedContextIfCurrent(lifecycleGeneration: number): void {
    if (lifecycleGeneration !== this.lifecycleGeneration) return;
    this.lifecycleManager.saveContext(this.messages);
  }

  /** 从 DB 恢复消息（进程重启后调用） */
  restoreFromStore(): boolean {
    return this.withLogContext(() => {
      return this.lifecycleManager.markRestoreFromStore();
    });
  }

  // ─── 私有方法 ──────────────────────────────────────

  private commitReadyCheckpointCandidate(messages: Message[]): Message[] | null {
    const candidate = this.checkpointCandidate;
    if (!candidate || candidate.status !== 'ready') return null;
    const { durable, transient } = splitDurableAndTransient(messages);
    const boundaryMessages = durable.slice(0, candidate.snapshot.boundaryMessageCount);
    const boundaryEpisodeId = [...boundaryMessages].reverse()
      .find(message => message.__episodeId)?.__episodeId;
    const prepared = candidate.prepareCommit(
      durable,
      this.checkpointRevision,
      boundaryEpisodeId,
    );
    if (!prepared.messages) {
      if (prepared.status === 'stale') {
        this.checkpointCandidateFallbackRequired = true;
        this.logCheckpointCandidateEvent(candidate, 'stale', 'async_candidate');
        this.clearCheckpointCandidateSlot(candidate);
      }
      return null;
    }
    const committedMessages = [...prepared.messages, ...transient];
    if (this.isCheckpointCandidateSerialThresholdReached(
      this.getContextUsageInfo(committedMessages),
    )) {
      this.checkpointCandidateFallbackRequired = true;
      this.cancelCheckpointCandidate();
      return null;
    }
    if (!hasCompleteToolExchanges(committedMessages)) {
      this.checkpointCandidateFallbackRequired = true;
      this.cancelCheckpointCandidate();
      return null;
    }
    if (!this.persistCheckpoint(committedMessages)) {
      this.checkpointCandidateFallbackRequired = true;
      this.cancelCheckpointCandidate();
      Logger.warning(`[会话 ${this.key}] 异步检查点持久化失败，保留原始上下文`);
      return null;
    }
    if (!candidate.confirmCommit()) {
      // Persistence succeeded, so keep memory aligned with the durable projection.
      candidate.cancel();
      this.checkpointRevision++;
      this.checkpointCandidateFallbackRequired = false;
      this.checkpointCandidate = null;
      this.checkpointCandidateAbortController = null;
      this.checkpointCandidatePromise = null;
      return committedMessages;
    }
    this.checkpointRevision++;
    this.checkpointCandidateFallbackRequired = false;
    this.checkpointCandidate = null;
    this.checkpointCandidateAbortController = null;
    this.checkpointCandidatePromise = null;
    this.logCheckpointCandidateEvent(candidate, 'committed', 'async_candidate');
    return committedMessages;
  }

  private async handleCheckpointCandidateBoundary(
    messages: Message[],
    lifecycleGeneration: number,
    phase: CheckpointCompactionPhase = 'mid_turn',
  ): Promise<Message[]> {
    if (this.checkpointBlockedReason) {
      throw new Error(CONTEXT_CHECKPOINT_BLOCKED_ERROR);
    }
    const messagesBeforeCompaction = stripAssistantArtifactsFromMessages(messages);
    const stopPointReached = this.isCheckpointCandidateSerialThresholdReached(
      this.getContextUsageInfo(messagesBeforeCompaction),
    );
    const candidateAtBoundary = this.checkpointCandidate;
    this.coordinateCheckpointCandidate(messagesBeforeCompaction);
    await this.waitForCheckpointCandidateAtStopPoint(messagesBeforeCompaction);
    this.coordinateCheckpointCandidate(messagesBeforeCompaction);
    const committed = this.commitReadyCheckpointCandidate(messagesBeforeCompaction);
    if (committed) return committed;
    if (this.checkpointBlockedReason === 'checkpoint_authentication') {
      throw new Error(CONTEXT_CHECKPOINT_BLOCKED_ERROR);
    }

    if (stopPointReached && (candidateAtBoundary || this.checkpointCandidateFallbackRequired)) {
      const fallbackStartedAt = Date.now();
      const fallbackProviderBudget = {
        maxRequests: CHECKPOINT_PROVIDER_REQUEST_LIMIT,
        usedRequests: 0,
      };
      const fallback = await this.checkpointCompactionCoordinator.compactIfNeeded(
        messagesBeforeCompaction,
        {
          sessionKey: this.key,
          phase,
          toolTokens: this.getToolDefinitionTokens(),
          signal: this.activeAbortController?.signal,
          providerRequestBudget: fallbackProviderBudget,
        },
      );
      const fallbackWithinBudget = fallback.compacted
        && !this.isCheckpointCandidateSerialThresholdReached(
          this.getContextUsageInfo(fallback.messages),
        );
      const fallbackPersisted = fallbackWithinBudget
        && this.persistCheckpoint(fallback.messages);
      const fallbackOutcome = fallbackPersisted ? 'committed' : 'failed';
      const config = typeof (this.services.aiService as any).getConfig === 'function'
        ? (this.services.aiService as any).getConfig()
        : {};
      Logger.runtimeEvent(
        fallbackPersisted ? 'INFO' : 'WARN',
        `[${this.key}] checkpoint_summary mode=serial_fallback outcome=${fallbackOutcome}`,
        {
          type: 'checkpoint_summary',
          payload: {
            category: 'checkpoint_summary',
            mode: 'serial_fallback',
            outcome: fallbackOutcome,
            model: config.model,
            provider: config.provider,
            started_at: fallbackStartedAt,
            duration_ms: Date.now() - fallbackStartedAt,
            snapshot_tokens: this.getContextUsageInfo(messagesBeforeCompaction).usedTokens,
            attempts: fallback.summaryAttempts || 1,
            provider_requests: fallbackProviderBudget.usedRequests,
            provider_request_limit: fallbackProviderBudget.maxRequests,
            summary_input_tokens: fallback.summaryUsage?.promptTokens || 0,
            summary_output_tokens: fallback.summaryUsage?.completionTokens || 0,
            cache_read_tokens: fallback.summaryUsage?.cachedReadTokens || 0,
            cache_write_tokens: fallback.summaryUsage?.cachedWriteTokens || 0,
          },
        },
      );
      if (fallbackPersisted) {
        this.checkpointRevision++;
        this.checkpointCandidateFallbackRequired = false;
        return fallback.messages;
      }
      this.checkpointCandidateFallbackRequired = true;
      throw new Error(CONTEXT_CHECKPOINT_BLOCKED_ERROR);
    }

    this.startCheckpointCandidateIfEligible(lifecycleGeneration, messagesBeforeCompaction, phase);
    return messagesBeforeCompaction;
  }

  private async waitForCheckpointCandidateAtStopPoint(messages: Message[]): Promise<void> {
    if (!this.checkpointCandidate || !this.checkpointCandidatePromise) return;
    const usage = this.getContextUsageInfo(messages);
    if (!this.isCheckpointCandidateSerialThresholdReached(usage)) return;
    const candidate = this.checkpointCandidate;
    const generation = this.checkpointCandidatePromise;
    candidate.markStopReached();
    const remainingMs = Math.max(
      0,
      CHECKPOINT_CANDIDATE_TTL_MS - (Date.now() - candidate.snapshot.startedAt),
    );
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>(resolve => {
      deadlineTimer = setTimeout(() => resolve('deadline'), remainingMs);
      deadlineTimer.unref?.();
    });
    const outcome = await Promise.race([
      generation.then(() => 'settled' as const),
      deadline,
    ]);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (outcome === 'deadline' && candidate.status === 'running') {
      this.checkpointCandidateAbortController?.abort();
      candidate.fail('deadline');
      this.logCheckpointCandidateEvent(candidate, 'failed', 'async_candidate');
      if (this.checkpointCandidate === candidate) {
        this.checkpointCandidateFallbackRequired = true;
        this.checkpointCandidate = null;
        this.checkpointCandidateAbortController = null;
        this.checkpointCandidatePromise = null;
        this.checkpointCandidateSuppressed = true;
      }
    }
  }

  private coordinateCheckpointCandidate(messages: Message[]): void {
    if (!this.checkpointCandidate) return;
    if (Date.now() - this.checkpointCandidate.snapshot.startedAt >= CHECKPOINT_CANDIDATE_TTL_MS) {
      this.checkpointCandidateFallbackRequired = true;
      this.cancelCheckpointCandidate();
      return;
    }
    const usage = this.getContextUsageInfo(messages);
    if (this.isCheckpointCandidateSerialThresholdReached(usage)) {
      return;
    }
    if (this.checkpointCandidate.status === 'ready') {
      const durable = splitDurableAndTransient(messages).durable;
      const boundary = this.checkpointCandidate.snapshot.boundaryMessageCount;
      const currentBoundary = durable.slice(0, boundary);
      if (currentBoundary.length !== boundary
        || this.checkpointCandidate.snapshot.durableHash !== hashMessages(currentBoundary)) {
        this.checkpointCandidateFallbackRequired = true;
        this.cancelCheckpointCandidate();
      }
    }
  }

  private startCheckpointCandidateIfEligible(
    lifecycleGeneration: number,
    messages: Message[] = this.messages,
    phase: CheckpointCompactionPhase = 'pre_turn',
  ): void {
    if (
      !this.useCheckpointCompaction
      || !this.useCheckpointCandidates
      || this.checkpointCandidate
      || this.checkpointCandidateFallbackRequired
    ) return;
    const usage = this.getContextUsageInfo(messages);
    if (this.checkpointCandidateSuppressed && usage.usagePercent < CHECKPOINT_CANDIDATE_TRIGGER_PERCENT) {
      this.checkpointCandidateSuppressed = false;
    }
    if (this.checkpointCandidateSuppressed) return;
    if (usage.usagePercent < CHECKPOINT_CANDIDATE_TRIGGER_PERCENT
      || this.isCheckpointCandidateSerialThresholdReached(usage)) return;

    const durableMessages = splitDurableAndTransient(
      this.turnContextBuilder.removeTransientMessages(stripAssistantArtifactsFromMessages(messages)),
    ).durable;
    const episodeId = [...durableMessages].reverse().find(message => message.__episodeId)?.__episodeId;
    const candidate = new CheckpointCandidate(
      `checkpoint:${this.key}:${++this.checkpointCandidateSequence}`,
      createCheckpointSnapshot(
        durableMessages,
        {
          revision: this.checkpointRevision,
          episodeId,
        },
      ),
    );
    const abortController = new AbortController();
    this.checkpointCandidate = candidate;
    this.checkpointCandidateAbortController = abortController;
    this.logCheckpointCandidateEvent(candidate, 'started', 'async_candidate');

    const deadlineTimer = setTimeout(() => abortController.abort(), CHECKPOINT_CANDIDATE_TTL_MS);
    deadlineTimer.unref?.();
    const generation = candidate.generate(this.checkpointCandidateCoordinator, {
      sessionKey: this.key,
      phase,
      episodeId,
      toolTokens: this.getToolDefinitionTokens(),
      signal: abortController.signal,
      providerRequestBudget: {
        maxRequests: CHECKPOINT_PROVIDER_REQUEST_LIMIT,
        usedRequests: 0,
      },
      recordMetrics: true,
      metricsScope: 'background',
      metrics: this.metrics,
      metricsContext: {
        sessionKey: this.key,
        candidateId: candidate.id,
        episodeId,
        phase,
      },
    });
    this.checkpointCandidatePromise = generation;
    void generation.finally(() => {
      clearTimeout(deadlineTimer);
      if (lifecycleGeneration !== this.lifecycleGeneration
        || this.checkpointCandidate !== candidate) {
        return;
      }
      this.checkpointCandidateAbortController = null;
      this.checkpointCandidatePromise = null;
      this.logCheckpointCandidateEvent(candidate, candidate.status, 'async_candidate');
      if (candidate.status === 'failed') {
        this.checkpointCandidateSuppressed = true;
        if (candidate.failureReason !== 'authentication') {
          this.checkpointCandidateFallbackRequired = true;
        }
        if (candidate.failureReason === 'authentication') {
          this.checkpointBlockedReason = 'checkpoint_authentication';
          this.lifecycleManager.saveContext(this.messages);
        }
        this.checkpointCandidate = null;
      }
    });
  }

  private isCheckpointCandidateSerialThresholdReached(usage: {
    usedTokens: number;
    toolTokens?: number;
    maxTokens: number;
  }): boolean {
    return usage.usedTokens + (usage.toolTokens || 0)
      >= usage.maxTokens * (CHECKPOINT_CANDIDATE_SERIAL_THRESHOLD_PERCENT / 100);
  }

  private logCheckpointCandidateEvent(
    candidate: CheckpointCandidate,
    outcome: string,
    mode: 'async_candidate' | 'serial_fallback',
  ): void {
    const config = typeof (this.services.aiService as any).getConfig === 'function'
      ? (this.services.aiService as any).getConfig()
      : {};
    const endedAt = candidate.settledAt || candidate.readyAt || Date.now();
    const terminalTimestamp = candidate.settledAt || endedAt;
    Logger.runtimeEvent(
      outcome === 'failed' ? 'WARN' : 'INFO',
      `[${this.key}] checkpoint_summary mode=${mode} outcome=${outcome} candidate=${candidate.id}`,
      {
        type: 'checkpoint_summary',
        payload: {
          category: 'checkpoint_summary',
          mode,
          outcome,
          failure_reason: candidate.failureReason,
          candidate_id: candidate.id,
          model: config.model,
          provider: config.provider,
          snapshot_tokens: candidate.snapshot.usedTokens,
          started_at: candidate.snapshot.startedAt,
          ready_at: candidate.readyAt,
          settled_at: candidate.settledAt,
          committed_at: outcome === 'committed' ? terminalTimestamp : undefined,
          stale_at: outcome === 'stale' ? terminalTimestamp : undefined,
          cancelled_at: outcome === 'cancelled' ? terminalTimestamp : undefined,
          failed_at: outcome === 'failed' ? terminalTimestamp : undefined,
          duration_ms: Math.max(0, endedAt - candidate.snapshot.startedAt),
          summary_duration_ms: candidate.readyAt === undefined
            ? undefined
            : Math.max(0, candidate.readyAt - candidate.snapshot.startedAt),
          trigger_to_stop_duration_ms: candidate.stopReachedAt === undefined
            ? undefined
            : Math.max(0, candidate.stopReachedAt - candidate.snapshot.startedAt),
          attempts: candidate.attempts,
          provider_requests: candidate.providerRequestBudget?.usedRequests || 0,
          provider_request_limit: candidate.providerRequestBudget?.maxRequests
            || CHECKPOINT_PROVIDER_REQUEST_LIMIT,
          summary_attempts: candidate.summaryAttempts,
          summary_input_tokens: candidate.summaryUsage.promptTokens,
          summary_output_tokens: candidate.summaryUsage.completionTokens,
          cache_read_tokens: candidate.summaryUsage.cachedReadTokens || 0,
          cache_write_tokens: candidate.summaryUsage.cachedWriteTokens || 0,
        },
      },
    );
  }

  private clearCheckpointCandidateSlot(candidate: CheckpointCandidate): void {
    if (this.checkpointCandidate !== candidate) return;
    this.checkpointCandidateAbortController?.abort();
    this.checkpointCandidate = null;
    this.checkpointCandidatePromise = null;
    this.checkpointCandidateAbortController = null;
  }

  private cancelCheckpointCandidate(): void {
    const candidate = this.checkpointCandidate;
    candidate?.cancel();
    if (candidate) {
      this.logCheckpointCandidateEvent(candidate, candidate.status, 'async_candidate');
      if (candidate.status === 'failed') this.checkpointCandidateSuppressed = true;
      this.clearCheckpointCandidateSlot(candidate);
      return;
    }
    this.checkpointCandidateAbortController?.abort();
    this.checkpointCandidatePromise = null;
    this.checkpointCandidateAbortController = null;
  }

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

  private async refreshSystemPromptIfNeeded(
    lifecycleGeneration: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.initialized || !this.promptTrace) return;

    const { systemPrompt, promptTrace } = await this.buildCurrentSystemPrompt();
    if (signal?.aborted || this.interruptRequested || lifecycleGeneration !== this.lifecycleGeneration) {
      Logger.info(`[会话 ${this.key}] Prompt 热加载期间会话已重置，忽略旧热加载结果`);
      return;
    }
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

  private getContextUsageInfo(messages: Message[]): {
    usedTokens: number;
    toolTokens?: number;
    maxTokens: number;
    usagePercent: number;
  } {
    if (!this.useCheckpointCompaction) {
      return this.contextWindowManager.getUsageInfo(messages);
    }
    return this.checkpointCompactionCoordinator.getUsageInfo(
      messages,
      this.getToolDefinitionTokens(),
    );
  }

  private async compactContextIfNeeded(
    messages: Message[],
    phase: CheckpointCompactionPhase,
    reason: string,
    signal?: AbortSignal,
    callbacks?: SessionCallbacks,
  ): Promise<{ messages: Message[]; compacted: boolean }> {
    if (!this.useCheckpointCompaction || !this.useCheckpointCandidates) {
      return this.contextWindowManager.compactIfNeeded(messages, {
        sessionKey: this.key,
        reason,
        signal,
        onStatus: this.createContextCompactionNotifier(callbacks),
      });
    }
    return this.checkpointCompactionCoordinator.compactIfNeeded(messages, {
      sessionKey: this.key,
      phase,
      toolTokens: this.getToolDefinitionTokens(),
      signal,
      onStatus: this.createContextCompactionNotifier(callbacks),
      metrics: this.metrics,
    });
  }

  private getToolDefinitionTokens(): number {
    return estimateToolsTokens(this.services.toolManager.getToolDefinitions());
  }

  private persistCheckpoint(messages: Message[]): boolean {
    const durable = this.turnContextBuilder.removeTransientMessages(
      stripAssistantArtifactsFromMessages(messages),
    );
    return this.lifecycleManager.saveContext(durable);
  }

  private createContextCompactionNotifier(callbacks?: SessionCallbacks): ((event: {
    status: 'start' | 'complete' | 'error';
  }) => Promise<void>) | undefined {
    if (!callbacks?.onThinking) return undefined;
    return async (event) => {
      const message = this.formatContextCompactionStatus(event);
      if (!message) return;
      try {
        await callbacks.onThinking?.(message);
      } catch (err) {
        Logger.warning(`[会话 ${this.key}] 上下文压缩提示发送失败: ${err}`);
      }
    };
  }

  private formatContextCompactionStatus(event: {
    status: 'start' | 'complete' | 'error';
  }): string {
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

  private hasRecoverablePartialProgress(messages: Message[]): boolean {
    let rootIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].__episodeInputKind === 'root') {
        rootIndex = index;
        break;
      }
    }
    if (rootIndex < 0) return false;
    const episodeId = messages[rootIndex].__episodeId;
    return messages.slice(rootIndex + 1).some(message =>
      (!episodeId || message.__episodeId === episodeId)
      && (message.role === 'tool' || message.role === 'assistant')
    );
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

  private isEmptyModelResponseError(error: any): boolean {
    const code = String(error?.code || error?.cause?.code || '').toUpperCase();
    if (code === 'EMPTY_MODEL_RESPONSE') {
      return true;
    }
    return /模型未返回有效内容|模型返回了空响应/i.test(String(error?.message || error || ''));
  }

  private isRelayBudgetError(error: any): boolean {
    const text = String(error?.message || error || '');
    const status = this.extractErrorStatus(error);
    return (
      status === 402
      || /api错误\s*\(402\)|status(?:\s*code)?\s*[:=]?\s*402\b|http(?:\s*status)?\s*[:=]?\s*402\b|payment[_\s-]?required/i.test(text)
      || /budget exceeded|quota exceeded|insufficient quota|insufficient balance|credits? exhausted|monthly budget|model budget|relay budget/i.test(text)
      || /额度.{0,12}(不足|用完|耗尽|超限|达到上限|已用尽)|余额不足|已达.*额度上限/.test(text)
    );
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

  private currentProviderName(): string | null {
    const config = typeof (this.services.aiService as any).getConfig === 'function'
      ? (this.services.aiService as any).getConfig()
      : {};
    const provider = String(config?.provider || '').trim();
    return provider || null;
  }

  private formatClassifiedErrorReply(
    category: ModelErrorCategory,
    fallback: string,
    retryCount: number,
  ): string {
    if (
      category === 'image_safety'
      || category === 'vision_unsupported'
      || category === 'input_too_large'
    ) {
      return fallback;
    }
    return retryCount > 0
      ? MODEL_RECOVERY_FAILED_MESSAGE
      : MODEL_REQUEST_FAILED_MESSAGE;
  }

  private formatErrorContextMessage(
    error: any,
    flags: {
      isModelTimeoutError?: boolean;
      isImageSafetyError?: boolean;
      isTransientProviderError?: boolean;
      isEmptyModelResponseError?: boolean;
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
    if (flags.isEmptyModelResponseError) {
      return `[处理中断: 模型未返回正文或工具调用，自动重试后仍未恢复。已保留本轮上下文；如果用户重试，请正常处理上一条请求。错误摘要: ${detail}]`;
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
