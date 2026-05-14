import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { ChannelCallbacks } from '../types/tool';
import {
  SessionSkillRuntime,
  SkillReloadHandler,
} from '../skills/session-skill-runtime';
import { PromptManager } from '../utils/prompt-manager';
import { Logger } from '../utils/logger';
import { SessionTurnLogger } from '../utils/session-turn-logger';
import { Metrics } from '../utils/metrics';
import { ContextWindowManager } from './context-window-manager';
import {
  RuntimeFeedbackInbox,
  RuntimeFeedbackInput,
  RuntimeFeedbackOptions,
} from './runtime-feedback-inbox';
import { TurnLogRecorder } from './turn-log-recorder';
import { TurnContextBuilder } from './turn-context-builder';
import { AgentTurnController } from './agent-turn-controller';
import { PlanRuntime } from './plan-runtime';
import { SessionLifecycleManager } from './session-lifecycle-manager';
import { SubAgentManager } from './sub-agent-manager';
import type { PendingUserInputProvider } from './conversation-runner';

export type { RuntimeFeedbackInput, RuntimeFeedbackOptions } from './runtime-feedback-inbox';

export const BUSY_MESSAGE = '正在处理上一条消息，请稍候...';
export const ERROR_MESSAGE = '不好意思，刚才处理出了点问题，你再试一次？';

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
  onThinking?: (thinking: string) => void;
  onToolStart?: (name: string, toolUseId: string, input: any) => void;
  onToolEnd?: (name: string, toolUseId: string, result: string) => void;
  onToolDisplay?: (name: string, content: string) => void;
  onRetry?: (attempt: number, maxRetries: number) => void;
}

/** 消息处理选项（由平台适配层传入） */
export interface HandleMessageOptions {
  callbacks?: SessionCallbacks;
  /** 平台通道回调，注入到 ToolExecutionContext 供工具使用 */
  channel?: ChannelCallbacks;
  /** 当前 turn 专属、给 agent 可见的运行时反馈 */
  runtimeFeedback?: RuntimeFeedbackInput[];
  /** Pulls user messages that arrived while this session was busy. */
  pendingUserInputProvider?: PendingUserInputProvider;
}

export interface HandleRuntimeObservationOptions extends HandleMessageOptions {
  /** 内部 observation 来源，例如 subagent_result */
  source?: string;
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
  private planRuntime = new PlanRuntime();
  private runtimeFeedbackInbox = new RuntimeFeedbackInbox();
  private lifecycleManager: SessionLifecycleManager;

  constructor(
    public readonly key: string,
    private services: AgentServices,
    private sessionType?: string,
  ) {
    const type = sessionType || this.extractSessionType(key);
    this.sessionTurnLogger = new SessionTurnLogger(type, key);
    this.turnLogRecorder = new TurnLogRecorder(this.sessionTurnLogger);
    this.contextWindowManager = new ContextWindowManager(services.aiService);
    this.skillRuntime = new SessionSkillRuntime(services.skillManager, key);
    this.lifecycleManager = new SessionLifecycleManager({
      sessionKey: key,
      runtimeFeedbackInbox: this.runtimeFeedbackInbox,
    });
    this.turnController = new AgentTurnController({
      sessionKey: key,
      sessionType,
      services,
      skillRuntime: this.skillRuntime,
      planRuntime: this.planRuntime,
      turnContextBuilder: this.turnContextBuilder,
      turnLogRecorder: this.turnLogRecorder,
    });
    const subAgentManager = SubAgentManager.getInstance();
    if (typeof (subAgentManager as any).registerEventLogger === 'function') {
      subAgentManager.registerEventLogger(key, (event, info) => {
        this.sessionTurnLogger.logSubAgentEvent(event, info);
      });
    }
  }

  private extractSessionType(key: string): string {
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

  /** 构建系统提示词（幂等，仅首次生效） */
  async init(): Promise<void> {
    if (this.initialized) return;
    const systemPrompt = this.systemPromptOverride
      ? await this.systemPromptOverride()
      : await PromptManager.buildSystemPrompt();
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

      this.messages = await this.contextWindowManager.compactIfNeeded(this.messages, {
        sessionKey: this.key,
        reason: '恢复后',
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
   * 处理运行时 observation（例如子 agent 完成结果）。
   *
   * 外部模型 API 仍以 role=user 承载这段文本，但 CatsCo 内部会保留
   * __runtimeObservation/runtimeObservationSource 标记，用于日志、持久化和后续边界判断。
   */
  async handleRuntimeObservation(
    text: string,
    options: HandleRuntimeObservationOptions = {},
  ): Promise<HandleMessageResult> {
    const { source = 'runtime_observation', ...handleOptions } = options;
    return this.handleInput(text, handleOptions, source);
  }

  private async handleInput(
    text: string | import('../types').ContentBlock[],
    callbacksOrOptions?: SessionCallbacks | HandleMessageOptions,
    runtimeObservationSource?: string,
  ): Promise<HandleMessageResult> {
    return this.withLogContext(async () => {
      // 兼容旧签名：如果传入的对象有 onText/onToolStart 等字段，视为 SessionCallbacks
      let callbacks: SessionCallbacks | undefined;
      let channel: ChannelCallbacks | undefined;
      let runtimeFeedbackInputs: RuntimeFeedbackInput[] = [];
      let pendingUserInputProvider: PendingUserInputProvider | undefined;

      if (callbacksOrOptions) {
        if (
          'channel' in callbacksOrOptions
          || 'callbacks' in callbacksOrOptions
          || 'runtimeFeedback' in callbacksOrOptions
          || 'pendingUserInputProvider' in callbacksOrOptions
        ) {
          // 新签名 HandleMessageOptions
          const opts = callbacksOrOptions as HandleMessageOptions;
          callbacks = opts.callbacks;
          channel = opts.channel;
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

      this.messages = await this.contextWindowManager.compactIfNeeded(this.messages, {
        sessionKey: this.key,
        reason: '处理前',
      });

      try {
        await this.init();
        const result = await this.turnController.run({
          input: text,
          messages: this.messages,
          runtimeFeedback,
          runtimeObservationSource,
          callbacks,
          channel,
          pendingUserInputProvider,
          abortSignal: this.activeAbortController.signal,
          shouldContinue: () => !this.interruptRequested,
        });
        this.messages = result.messages;
        this.lifecycleManager.saveContext(this.messages);
        return result;
      } catch (err: any) {
        if (this.interruptRequested || this.activeAbortController?.signal.aborted || isAbortError(err)) {
          Logger.info(`[会话 ${this.key}] 当前回合已中止`);
          this.messages = this.turnContextBuilder.removeTransientMessages(this.messages);
          return { text: '', visibleToUser: false };
        }

        // 不删除用户消息，而是添加一个错误回复，保持上下文连贯
        // 这样用户说"继续"时可以接上
        Logger.error(`[会话 ${this.key}] 处理失败: ${err.message}`);

        // 识别多模态相关错误
        const errorMsg = err.message || String(err);
        const isVisionError = errorMsg.match(/image|vision|multimodal|media_type|base64.*not supported/i);

        let errorReply = ERROR_MESSAGE;
        if (isVisionError) {
          errorReply = '当前模型不支持图片识别。请使用支持多模态的模型（如 Claude 3.5 Sonnet 或 GPT-4V），或者用文字描述图片内容。';
        }

        // 添加错误回复到上下文，保持对话连贯性
        this.messages.push({
          role: 'assistant',
          content: `[处理失败: ${err.message}]`
        });
        this.messages = this.turnContextBuilder.removeTransientMessages(this.messages);
        this.lifecycleManager.saveContext(this.messages);

        return { text: errorReply, visibleToUser: true };
      } finally {
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
    this.stopSubAgents('父会话 reset');
    this.planRuntime.clear();
    this.messages = [];
    const state = this.lifecycleManager.reset();
    this.initialized = state.initialized;
    this.lastActiveAt = state.lastActiveAt;
  }

  /** 清空历史（同时删除文件） */
  clear(): void {
    this.stopSubAgents('父会话 clear');
    this.planRuntime.clear();
    this.messages = [];
    const state = this.lifecycleManager.clear();
    this.initialized = state.initialized;
    this.lastActiveAt = state.lastActiveAt;
  }

  async summarizeAndDestroy(): Promise<boolean> {
    return this.withLogContext(async () => {
      this.stopSubAgents('父会话退出');
      this.planRuntime.clear();
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
      if (typeof (subAgentManager as any).unregisterPlatformCallbacks === 'function') {
        subAgentManager.unregisterPlatformCallbacks(this.key);
      }
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

}

function isAbortError(error: any): boolean {
  return error?.name === 'AbortError'
    || error?.code === 'ERR_CANCELED'
    || /aborted|aborterror|canceled|cancelled|请求已取消/i.test(String(error?.message || ''));
}
