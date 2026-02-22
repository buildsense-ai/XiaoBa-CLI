import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { SkillActivationSignal, SkillInvocationContext, SkillToolPolicy } from '../types/skill';
import { FeishuChannelCallbacks } from '../types/tool';
import {
  buildSkillActivationSignal,
  upsertSkillSystemMessage,
} from '../skills/skill-activation-protocol';
import { GauzMemService } from '../utils/gauzmem-service';
import { ConversationRunner, RunnerCallbacks } from './conversation-runner';
import { SubAgentManager } from './sub-agent-manager';
import { PromptManager } from '../utils/prompt-manager';
import { Logger } from '../utils/logger';
import { saveSessionSummary, loadSessionSummary, removeSessionSummary } from '../utils/local-session-store';
import { SessionStore } from '../utils/session-store';
import { Metrics } from '../utils/metrics';

const TRANSIENT_MEMORY_CONTEXT_PREFIX = '[transient_memory_context]';
const TRANSIENT_SUBAGENT_STATUS_PREFIX = '[transient_subagent_status]';
export const BUSY_MESSAGE = '正在处理上一条消息，请稍候...';
export const ERROR_MESSAGE = '不好意思，刚才处理出了点问题，你再试一次？';

// ─── 接口定义 ───────────────────────────────────────────

/** 共享服务集合 */
export interface AgentServices {
  aiService: AIService;
  toolManager: ToolManager;
  skillManager: SkillManager;
  memoryService?: GauzMemService | null;
}

/** 会话回调（由适配层提供） */
export interface SessionCallbacks {
  onText?: (text: string) => void;
  onToolStart?: (name: string) => void;
  onToolEnd?: (name: string, result: string) => void;
  onToolDisplay?: (name: string, content: string) => void;
}

/** 消息处理选项（由平台适配层传入） */
export interface HandleMessageOptions {
  callbacks?: SessionCallbacks;
  /** 飞书通道回调，注入到 ToolExecutionContext 供工具使用 */
  feishuChannel?: FeishuChannelCallbacks;
}

/** 命令处理结果 */
export interface CommandResult {
  handled: boolean;
  reply?: string;
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
 * - 退出时摘要写入记忆
 */
export class AgentSession {
  private messages: Message[] = [];
  private initialized = false;
  private busy = false;
  private _pending: Promise<void> = Promise.resolve();
  private activeSkillName?: string;
  private activeSkillToolPolicy?: SkillToolPolicy;
  private activeSkillMaxTurns?: number;
  private pendingRestore?: Message[];
  private circuitBreakerDisabledTools: string[] = [];
  lastActiveAt: number = Date.now();

  constructor(
    public readonly key: string,
    private services: AgentServices,
  ) {}

  // ─── 初始化 ─────────────────────────────────────────

  /** 构建系统提示词（幂等，仅首次生效） */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const systemPrompt = await PromptManager.buildSystemPrompt();
    this.messages.push({ role: 'system', content: systemPrompt });
    if (this.isFeishuSession()) {
      const isGroup = this.key.startsWith('group:');
      const chatType = isGroup ? '群聊' : '私聊';
      this.messages.push({
        role: 'system',
        content: `[surface:feishu:${isGroup ? 'group' : 'private'}]\n当前是飞书${chatType}会话。你的普通文本输出老师完全看不到，必须调用 feishu_reply 工具才能让老师收到消息。无论多简单的回复（包括打招呼、闲聊），都必须通过 feishu_reply 发送。发完后直接停止，不要再输出收尾文本。`,
      });
    } else if (this.isCatsCompanySession()) {
      this.messages.push({
        role: 'system',
        content: '[surface:catscompany]\n当前是 Cats Company 聊天会话。用户只能看到你通过 feishu_reply / feishu_send_file 发送的内容，你的普通文本输出用户完全看不到。所以：所有要给用户看的话，必须通过工具发送；通过工具发完消息后直接停止，不要再输出任何收尾文本。',
      });
    }

    // 加载上次会话摘要（本地文件兜底）
    if (this.isChatSession()) {
      const previousSummary = loadSessionSummary(this.key);
      if (previousSummary) {
        this.messages.push({
          role: 'system',
          content: `[previous_session_summary]\n以下是你与该用户上次对话的摘要，请参考以保持上下文连贯：\n\n${previousSummary}`,
        });
        removeSessionSummary(this.key);
        Logger.info(`已加载上次会话摘要: ${this.key}`);
      }

    }

    // 从 DB 恢复未归档的消息
    if (this.pendingRestore) {
      this.messages.push(...this.pendingRestore);
      Logger.info(`[会话 ${this.key}] 已恢复 ${this.pendingRestore.length} 条消息`);
      this.pendingRestore = undefined;
    }
  }

  /**
   * 启动时激活指定 skill，将其 prompt 注入系统消息。
   * 用于 --skill 参数，在会话开始前绑定 skill 上下文。
   */
  async activateSkill(skillName: string): Promise<boolean> {
    const skill = this.services.skillManager.getSkill(skillName);
    if (!skill) {
      Logger.warning(`Skill "${skillName}" 未找到`);
      return false;
    }

    await this.init();

    const context: SkillInvocationContext = {
      skillName,
      arguments: [],
      rawArguments: '',
      userMessage: '',
    };
    const activation = buildSkillActivationSignal(skill, context);
    this.applySkillActivation(activation);

    Logger.info(`[${this.key}] 启动时激活 skill: ${skill.metadata.name}${skill.metadata.maxTurns ? ` (maxTurns=${skill.metadata.maxTurns})` : ''}`);
    return true;
  }

  // ─── 消息处理 ───────────────────────────────────────

  private static readonly MAX_INJECTED_CONTEXT = 30;

  /** 静默注入上下文消息，不触发 AI 推理。超过上限自动丢弃最早的注入消息。 */
  injectContext(text: string): void {
    this.messages.push({ role: 'user', content: text, __injected: true });
    this.lastActiveAt = Date.now();

    // 滑动窗口：超过上限时丢弃最早的注入消息
    let injectedCount = this.messages.filter(m => m.__injected).length;
    while (injectedCount > AgentSession.MAX_INJECTED_CONTEXT) {
      const idx = this.messages.findIndex(m => m.__injected);
      if (idx < 0) break;
      this.messages.splice(idx, 1);
      injectedCount--;
    }
  }

  /**
   * 完整消息处理管线：记忆搜索 → AI 推理 → 工具循环 → 同步历史
   *
   * @param text 用户消息文本
   * @param callbacksOrOptions 旧签名兼容 SessionCallbacks，新签名用 HandleMessageOptions
   */
  async handleMessage(
    text: string,
    callbacksOrOptions?: SessionCallbacks | HandleMessageOptions,
  ): Promise<string> {
    // 兼容旧签名：如果传入的对象有 onText/onToolStart 等字段，视为 SessionCallbacks
    let callbacks: SessionCallbacks | undefined;
    let feishuChannel: FeishuChannelCallbacks | undefined;

    if (callbacksOrOptions) {
      if ('feishuChannel' in callbacksOrOptions || 'callbacks' in callbacksOrOptions) {
        // 新签名 HandleMessageOptions
        const opts = callbacksOrOptions as HandleMessageOptions;
        callbacks = opts.callbacks;
        feishuChannel = opts.feishuChannel;
      } else {
        // 旧签名 SessionCallbacks
        callbacks = callbacksOrOptions as SessionCallbacks;
      }
    }

    if (this.busy) {
      return BUSY_MESSAGE;
    }

    // 按"单次消息"统计 metrics，避免跨轮次累积导致定位困难
    Metrics.reset();

    this.busy = true;
    this.lastActiveAt = Date.now();
    let resolvePending: () => void;
    const done = new Promise<void>(r => { resolvePending = r; });
    this._pending = this._pending.then(() => done);

    try {
      await this.init();
      this.tryAutoActivateSkill(text);
      this.messages.push({ role: 'user', content: text });


      // 搜索相关记忆，作为临时上下文注入
      let contextMessages: Message[] = [...this.messages];
      let memoryInjected = false;
      const memoryService = this.services.memoryService;
      if (memoryService) {
        const memories = await memoryService.searchMemory(text);
        if (memories.length > 0) {
          const memoryContext = memoryService.formatMemoriesAsContext(memories);
          const memorySystemMessage: Message = {
            role: 'system',
            content: `${TRANSIENT_MEMORY_CONTEXT_PREFIX}\n${memoryContext}`,
          };
          memoryInjected = true;
          contextMessages = [
            ...this.messages.slice(0, -1),
            memorySystemMessage,
            this.messages[this.messages.length - 1],
          ];
        }
      }

      // 注入后台子智能体状态（临时上下文，不持久化）
      const subAgentManager = SubAgentManager.getInstance();
      const runningSubAgents = subAgentManager.listByParent(this.key);
      if (runningSubAgents.length > 0) {
        const statusLines = runningSubAgents.map(s => {
          const statusLabel = s.status === 'running' ? '运行中' : s.status === 'completed' ? '已完成' : s.status === 'failed' ? '失败' : '已停止';
          const latest = s.progressLog[s.progressLog.length - 1] ?? '';
          const summary = s.status === 'completed' && s.resultSummary ? `\n  结果: ${s.resultSummary.slice(0, 200)}` : '';
          return `- [${s.id}] ${s.taskDescription} (${statusLabel}) ${latest}${summary}`;
        }).join('\n');

        const subagentStatusMsg: Message = {
          role: 'system',
          content: `${TRANSIENT_SUBAGENT_STATUS_PREFIX}\n当前有 ${runningSubAgents.length} 个后台子任务：\n${statusLines}\n\n用户如果询问任务进度，请基于以上信息回答。如果用户要求停止任务，使用 stop_subagent 工具。`,
        };
        // 插入到最后一条用户消息之前
        const lastUserIdx = contextMessages.length - 1;
        contextMessages.splice(lastUserIdx, 0, subagentStatusMsg);
      }

      // 运行对话循环（优先用显式设置的 maxTurns，否则从 messages 中检测已激活 skill）
      const detectedSkillName = this.activeSkillName ?? this.detectActiveSkillName();
      if (detectedSkillName) {
        const detectedSkill = this.services.skillManager.getSkill(detectedSkillName);
        this.activeSkillName = detectedSkillName;
        this.activeSkillToolPolicy = detectedSkill?.metadata.toolPolicy;
        this.activeSkillMaxTurns = detectedSkill?.metadata.maxTurns;
      }

      const effectiveMaxTurns = this.activeSkillMaxTurns ?? this.detectSkillMaxTurns();
      const surface = this.isCatsCompanySession()
        ? 'catscompany'
        : this.isFeishuSession()
          ? 'feishu'
          : 'cli';
      const runner = new ConversationRunner(
        this.services.aiService,
        this.services.toolManager,
        {
          ...(effectiveMaxTurns ? { maxTurns: effectiveMaxTurns } : {}),
          initialSkillName: this.activeSkillName,
          initialSkillToolPolicy: this.activeSkillToolPolicy,
          preDisabledTools: this.circuitBreakerDisabledTools.length > 0
            ? this.circuitBreakerDisabledTools
            : undefined,
          toolExecutionContext: {
            sessionId: this.key,
            surface,
            permissionProfile: 'strict',
            feishuChannel,
          },
        },
      );
      const runnerCallbacks: RunnerCallbacks = {
        onText: callbacks?.onText,
        onToolStart: callbacks?.onToolStart,
        onToolEnd: callbacks?.onToolEnd,
        onToolDisplay: callbacks?.onToolDisplay,
      };

      const result = await runner.run(contextMessages, runnerCallbacks);

      // 回收熔断状态，跨消息持久化
      this.circuitBreakerDisabledTools = result.disabledTools;

      // 优先采用 runner 返回的完整消息（含压缩结果），修复历史持续膨胀问题
      // 始终清理临时上下文（记忆 + 子智能体状态），避免持久化到历史
      const persistedMessages = this.removeTransientMessages(result.messages);
      this.messages = [...persistedMessages];

      // 同步 skill 激活状态
      for (const msg of result.newMessages) {
        const activation = this.parseActivationFromSystemMessage(msg);
        if (activation) {
          this.applySkillActivation(activation);
        }
      }

      // runner 在"最终无工具调用"时不会自动附加 assistant 消息，这里补齐
      const lastMessage = this.messages[this.messages.length - 1];
      if (
        !lastMessage ||
        lastMessage.role !== 'assistant' ||
        (lastMessage.content || '') !== (result.response || '')
      ) {
        this.messages.push({ role: 'assistant', content: result.response });
      }

      // 输出本次请求的 metrics 摘要
      const metrics = Metrics.getSummary();
      if (metrics.aiCalls > 0 || metrics.toolCalls > 0) {
        Logger.info(
          `[Metrics] AI调用: ${metrics.aiCalls}次, ` +
          `tokens: ${metrics.totalPromptTokens}+${metrics.totalCompletionTokens}=${metrics.totalTokens}, ` +
          `工具调用: ${metrics.toolCalls}次, 工具耗时: ${metrics.toolDurationMs}ms`
        );
      }

      // 持久化本轮所有消息（用户 + assistant/tool）
      if (this.isChatSession()) {
        const newMsgs = [{ role: 'user' as const, content: text }, ...result.newMessages.filter(m => m.role !== 'system' && !(m as any).__injected)];
        if (newMsgs.length > 0) {
          SessionStore.getInstance().appendMessages(this.key, newMsgs);
        }
      }

      return result.response || '[无回复]';
    } catch (err: any) {
      // 清理孤立的 user 消息，避免污染后续对话
      if (this.messages.length > 0 && this.messages[this.messages.length - 1].role === 'user') {
        this.messages.pop();
      }
      Logger.error(`[会话 ${this.key}] 处理失败: ${err.message}`);
      return ERROR_MESSAGE;
    } finally {
      this.busy = false;
      resolvePending!();
    }
  }

  // ─── 命令处理 ───────────────────────────────────────

  /** 内置命令 + skill 命令统一入口 */
  async handleCommand(
    command: string,
    args: string[],
    callbacks?: SessionCallbacks,
  ): Promise<CommandResult> {
    const commandName = command.toLowerCase();

    // /clear
    if (commandName === 'clear') {
      this.clear();
      return { handled: true, reply: '会话已清空' };
    }

    // /skills
    if (commandName === 'skills') {
      return this.handleSkillsCommand();
    }

    // /history
    if (commandName === 'history') {
      return {
        handled: true,
        reply: `对话历史信息:\n当前历史长度: ${this.messages.length} 条消息\n上下文压缩: 由 ConversationRunner 自动管理`,
      };
    }

    // /exit
    if (commandName === 'exit') {
      await this.summarizeAndDestroy();
      return { handled: true, reply: '再见！期待下次与你对话。' };
    }

    // skill 斜杠命令
    return this.handleSkillCommand(commandName, args, callbacks);
  }

  // ─── 生命周期 ──────────────────────────────────────

  /** 清空历史 */
  clear(): void {
    SessionStore.getInstance().archiveSession(this.key);
    this.messages = [];
    this.initialized = false;
    this.activeSkillName = undefined;
    this.activeSkillToolPolicy = undefined;
    this.activeSkillMaxTurns = undefined;
    this.circuitBreakerDisabledTools = [];
    this.lastActiveAt = Date.now();
  }

  /** 压缩历史写入记忆（本地文件兜底 + GauzMem），然后清空 */
  async summarizeAndDestroy(): Promise<boolean> {
    const hasUserMessages = this.messages.some(m => m.role === 'user');
    if (this.messages.length === 0 || !hasUserMessages) {
      return false;
    }

    try {
      const conversationText = this.messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
        .join('\n');

      const summaryPrompt = `请对以下对话进行简洁的摘要，保留关键信息、重要事实和上下文。摘要应该简洁但完整，以便未来回忆时能理解对话的主要内容。

对话内容：
${conversationText}

请生成摘要：`;

      const summary = await this.services.aiService.chat([
        { role: 'user', content: summaryPrompt },
      ]);

      const summaryText = `[对话摘要 - ${new Date().toISOString()}]\n${summary.content || ''}`;

      // 本地文件兜底：始终写入本地
      const localSuccess = saveSessionSummary(this.key, summaryText, Logger.getLogFilePath() || undefined);

      // GauzMem：如果可用也写入
      const memoryService = this.services.memoryService;
      if (memoryService) {
        const remoteSuccess = await memoryService.writeMemory(summaryText, 'agent');
        if (remoteSuccess) {
          Logger.info(`已压缩 ${this.messages.length} 条消息并写入记忆系统`);
        }
      }

      if (localSuccess) {
        Logger.info(`已压缩 ${this.messages.length} 条消息并写入本地文件`);
      }

      // 归档持久化文件
      SessionStore.getInstance().archiveSession(this.key);

      this.messages = [];
      return localSuccess;
    } catch (error) {
      Logger.error('压缩历史失败: ' + String(error));
      return false;
    }
  }

  // ─── 查询方法 ──────────────────────────────────────

  isBusy(): boolean {
    return this.busy;
  }

  /** 从 DB 恢复消息（进程重启后调用） */
  restoreFromStore(): boolean {
    const store = SessionStore.getInstance();
    if (!store.hasActiveSession(this.key)) return false;
    const msgs = store.loadMessages(this.key);
    if (msgs.length === 0) return false;
    this.pendingRestore = msgs;
    Logger.info(`[会话 ${this.key}] 标记从 DB 恢复 ${msgs.length} 条消息`);
    return true;
  }

  // ─── 私有方法 ──────────────────────────────────────

  /** 从 messages 中检测已激活 skill 的 maxTurns（兜底机制） */
  private detectSkillMaxTurns(): number | undefined {
    for (const msg of this.messages) {
      if (msg.role === 'system' && msg.content) {
        const match = msg.content.match(/^\[skill:([^\]]+)\]/);
        if (match) {
          const skill = this.services.skillManager.getSkill(match[1]);
          if (skill?.metadata.maxTurns) {
            return skill.metadata.maxTurns;
          }
        }
      }
    }
    return undefined;
  }

  private detectActiveSkillName(): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role !== 'system' || !msg.content) continue;
      const match = msg.content.match(/^\[skill:([^\]]+)\]/);
      if (match) {
        return match[1];
      }
    }
    return undefined;
  }

  private tryAutoActivateSkill(userText: string): void {
    const input = userText.trim();
    if (!input) return;

    // 斜杠命令路径由 handleCommand 处理，这里不重复自动激活
    if (input.startsWith('/')) return;
    if (this.isAttachmentOnlyInput(input)) return;

    // 已有激活 skill 时不自动切换，避免任务中途漂移
    if (this.activeSkillName) return;

    const matched = this.services.skillManager.findAutoInvocableSkillByText(input);
    if (!matched) return;

    const context: SkillInvocationContext = {
      skillName: matched.metadata.name,
      arguments: [],
      rawArguments: '',
      userMessage: input,
    };
    const activation = buildSkillActivationSignal(matched, context);
    this.applySkillActivation(activation);

    Logger.info(`[${this.key}] 自动激活 skill: ${matched.metadata.name}`);
  }

  private isAttachmentOnlyInput(input: string): boolean {
    if (input.startsWith('[文件]') || input.startsWith('[图片]')) {
      return true;
    }

    if (input.startsWith('[用户仅上传了附件，暂未给出明确任务]')) {
      return true;
    }

    const attachmentMarker = '[用户已上传附件]';
    const markerIndex = input.indexOf(attachmentMarker);
    if (markerIndex >= 0) {
      const prefix = input.slice(0, markerIndex).trim();
      if (!prefix) {
        return true;
      }
    }

    return false;
  }

  private isFeishuSession(): boolean {
    return this.key.startsWith('user:') || this.key.startsWith('group:');
  }

  private isCatsCompanySession(): boolean {
    return this.key.startsWith('cc_user:') || this.key.startsWith('cc_group:');
  }

  private isChatSession(): boolean {
    return this.isFeishuSession() || this.isCatsCompanySession();
  }

  private removeTransientMessages(messages: Message[]): Message[] {
    return messages.filter(msg => {
      if (msg.role !== 'system' || typeof msg.content !== 'string') return true;
      if (msg.content.startsWith(TRANSIENT_MEMORY_CONTEXT_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_SUBAGENT_STATUS_PREFIX)) return false;
      return true;
    });
  }

  /** /skills 命令 */
  private handleSkillsCommand(): CommandResult {
    const skills = this.services.skillManager.getUserInvocableSkills();
    if (skills.length === 0) {
      return { handled: true, reply: '暂无可用的 skills。' };
    }
    const lines = skills.map(s => {
      const hint = s.metadata.argumentHint ? ` ${s.metadata.argumentHint}` : '';
      return `/${s.metadata.name}${hint}\n  ${s.metadata.description}`;
    });
    return { handled: true, reply: '可用的 Skills:\n\n' + lines.join('\n\n') };
  }

  /** skill 斜杠命令处理 */
  private async handleSkillCommand(
    commandName: string,
    args: string[],
    callbacks?: SessionCallbacks,
  ): Promise<CommandResult> {
    const skill = this.services.skillManager.getSkill(commandName);
    if (!skill) return { handled: false };

    if (!skill.metadata.userInvocable) {
      return { handled: true, reply: `Skill "${commandName}" 不允许用户调用` };
    }

    // 执行 skill，生成 prompt
    const context: SkillInvocationContext = {
      skillName: commandName,
      arguments: args,
      rawArguments: args.join(' '),
      userMessage: `/${commandName} ${args.join(' ')}`.trim(),
    };
    const activation = buildSkillActivationSignal(skill, context);

    await this.init();
    this.applySkillActivation(activation);
    Logger.info(`[${this.key}] 已激活 skill: ${skill.metadata.name}${skill.metadata.maxTurns ? ` (maxTurns=${skill.metadata.maxTurns})` : ''}`);

    // 如果有参数，自动作为用户消息发送给 AI
    if (args.length > 0) {
      const reply = await this.handleMessage(args.join(' '), callbacks);
      return { handled: true, reply };
    }

    return { handled: true, reply: `已激活 skill: ${skill.metadata.name}` };
  }

  private applySkillActivation(activation: SkillActivationSignal): void {
    upsertSkillSystemMessage(this.messages, activation);
    this.activeSkillName = activation.skillName;
    this.activeSkillToolPolicy = activation.toolPolicy;
    this.activeSkillMaxTurns = activation.maxTurns;
  }

  private parseActivationFromSystemMessage(msg: Message): SkillActivationSignal | null {
    if (msg.role !== 'system' || !msg.content) {
      return null;
    }

    const markerMatch = msg.content.match(/^\[skill:([^\]]+)\]/);
    if (!markerMatch) {
      return null;
    }

    const skillName = markerMatch[1];
    const prompt = msg.content.slice(markerMatch[0].length).replace(/^\n/, '');
    const skill = this.services.skillManager.getSkill(skillName);

    return {
      __type__: 'skill_activation',
      skillName,
      prompt,
      maxTurns: skill?.metadata.maxTurns,
      toolPolicy: skill?.metadata.toolPolicy,
    };
  }
}
