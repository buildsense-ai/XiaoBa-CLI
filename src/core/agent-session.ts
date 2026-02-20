import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { SkillActivationSignal, SkillInvocationContext, SkillToolPolicy } from '../types/skill';
import {
  buildSkillActivationSignal,
  upsertSkillSystemMessage,
} from '../skills/skill-activation-protocol';
import { ConversationRunner, RunnerCallbacks } from './conversation-runner';
import { SubAgentManager } from './sub-agent-manager';
import { PromptManager } from '../utils/prompt-manager';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';
import { ContextDebugLogger } from '../utils/context-debug-logger';
import { GauzMemService } from '../utils/gauzmem-service';
import {
  loadPreferences,
  savePreferences,
  getPreferencesFilePath,
  UserPreferences,
} from '../utils/preferences';

const TRANSIENT_SUBAGENT_STATUS_PREFIX = '[transient_subagent_status]';
const TRANSIENT_LONG_TERM_MEMORY_PREFIX = '[long_term_memory]';
const MAX_LOCAL_TURNS = 10; // 保留最近 N 轮对话（N*2 条 user+assistant 消息）
export const BUSY_MESSAGE = '正在处理上一条消息，请稍候...';

// ─── 接口定义 ───────────────────────────────────────────

/** 共享服务集合 */
export interface AgentServices {
  aiService: AIService;
  toolManager: ToolManager;
  skillManager: SkillManager;
}

/** 会话回调（由适配层提供） */
export interface SessionCallbacks {
  onText?: (text: string) => void;
  onToolStart?: (name: string) => void;
  onToolEnd?: (name: string, result: string) => void;
  onToolDisplay?: (name: string, content: string) => void;
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
  private busy = false;
  private messageQueue: string[] = [];
  private activeSkillName?: string;
  private activeSkillToolPolicy?: SkillToolPolicy;
  private activeSkillMaxTurns?: number;
  lastActiveAt: number = Date.now();

  /** 从 session key 派生的会话标识，用于 GauzMem run_id */
  readonly runId: string;
  /** 从 session key 前缀推断的平台标识 */
  readonly platformId: string;
  private readonly gauzMem: GauzMemService;

  constructor(
    public readonly key: string,
    private services: AgentServices,
  ) {
    this.runId = key;
    this.platformId = this.derivePlatformId();
    this.gauzMem = GauzMemService.getInstance();
  }

  /** 从 session key 前缀推断平台 */
  private derivePlatformId(): string {
    if (this.key.startsWith('user:') || this.key.startsWith('group:')) return 'feishu';
    if (this.key.startsWith('cc_user:') || this.key.startsWith('cc_group:')) return 'catscompany';
    if (this.key === 'cli') return 'cli';
    if (this.key.startsWith('bridge:')) return 'bridge';
    return 'unknown';
  }

  // ─── 初始化 ─────────────────────────────────────────

  /** 构建系统提示词（幂等，仅首次生效） */
  async init(): Promise<void> {
    if (this.messages.length > 0) return;
    const toolNames = this.services.toolManager.getToolDefinitions().map(t => t.name);
    const systemPrompt = await PromptManager.buildSystemPrompt(toolNames);
    this.messages.push({ role: 'system', content: systemPrompt });

    // 注入会话上下文（platform / session / user）
    this.messages.push({
      role: 'system',
      content: `[session_context]\nplatform: ${this.platformId}\nsession: ${this.runId}`,
    });

    if (this.isFeishuSession()) {
      this.messages.push({
        role: 'system',
        content: '[surface:feishu]\n当前是飞书会话。用户只能看到 send_message / send_file 发出的内容，你的普通文本回复用户看不到。',
      });
    } else if (this.isCatsCompanySession()) {
      this.messages.push({
        role: 'system',
        content: '[surface:catscompany]\n当前是 CatsCompany 聊天会话。用户只能看到 send_message / send_file 发出的内容，你的普通文本回复用户看不到。',
      });
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

  /** 完整消息处理管线：记忆写入 → 记忆召回 → AI 推理 → 工具循环 → 同步历史 */
  async handleMessage(text: string, callbacks?: SessionCallbacks): Promise<string> {
    if (this.busy) {
      return BUSY_MESSAGE;
    }

    // 按"单次消息"统计 metrics，避免跨轮次累积导致定位困难
    Metrics.reset();

    this.busy = true;
    this.lastActiveAt = Date.now();

    try {
      await this.init();
      this.tryAutoActivateSkill(text);

      // ── GauzMem: fire-and-forget 写入用户消息 ──
      if (this.gauzMem.isAvailable()) {
        this.gauzMem.writeMessage(text, 'user', this.platformId, this.runId).catch(() => {});
      }

      this.messages.push({ role: 'user', content: text });

      let contextMessages: Message[] = [...this.messages];

      // ── GauzMem: 被动记忆召回 → 注入 transient system message ──
      // 生成 request_id 用于贯穿 client/server 日志
      const requestId = crypto.randomUUID();
      let recallResult: import('../utils/gauzmem-service').RecallResult | null = null;

      if (this.gauzMem.isAvailable()) {
        try {
          recallResult = await this.gauzMem.recallWithMetadata(
            text,
            { maxSeeds: 5, minRelevance: 0.6, maxHops: 1, maxFactsPerSubgraph: 15 },
            requestId,
          );
          if (recallResult?.recall) {
            const memoryMsg: Message = {
              role: 'system',
              content: `${TRANSIENT_LONG_TERM_MEMORY_PREFIX}\n以下是与当前对话相关的长期记忆，供你参考：\n\n${recallResult.recall}`,
            };
            // 插入到最后一条用户消息之前
            const lastUserIdx = contextMessages.length - 1;
            contextMessages.splice(lastUserIdx, 0, memoryMsg);
          }
        } catch {
          // recall 失败不影响主流程
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

      // Context debug logger
      const debugLogger = new ContextDebugLogger(requestId, this.key, text);
      const allToolDefs = this.services.toolManager.getToolDefinitions();
      debugLogger.recordContextModules(contextMessages, allToolDefs, recallResult);

      const runner = new ConversationRunner(
        this.services.aiService,
        this.services.toolManager,
        {
          ...(effectiveMaxTurns ? { maxTurns: effectiveMaxTurns } : {}),
          initialSkillName: this.activeSkillName,
          initialSkillToolPolicy: this.activeSkillToolPolicy,
          debugLogger,
          drainQueue: () => this.drainQueue(),
          toolExecutionContext: {
            sessionId: this.key,
            surface,
            permissionProfile: 'strict',
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

      // ── GauzMem: fire-and-forget 写入 agent 回复 ──
      // 优先提取 send_message 实际发出的内容（用户可见），而非 final answer（可能是 "ok"）
      if (this.gauzMem.isAvailable()) {
        const sentMessages = this.extractSentMessages(result.messages);
        const agentContent = sentMessages.length > 0
          ? sentMessages.join('\n')
          : result.response;
        if (agentContent) {
          this.gauzMem.writeMessage(agentContent, 'agent', this.platformId, this.runId).catch(() => {});
        }
      }

      // ── GauzMem 可用时裁剪本地历史，只保留最近 N 轮 ──
      if (this.gauzMem.isAvailable()) {
        this.trimLocalHistory();
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

      // ── 完整 turn 日志（用于数据分析）──
      Logger.info(
        `[Turn Log] request_id=${requestId} ` +
        `query="${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" ` +
        `recall_facts=${recallResult?.factsCount ?? 0} ` +
        `recall_ids=[${(recallResult?.factIds ?? []).slice(0, 10).join(',')}] ` +
        `recall_latency=${recallResult?.latencyMs ?? 'N/A'}ms ` +
        `tokens=${metrics.totalPromptTokens}+${metrics.totalCompletionTokens} ` +
        `tools=${metrics.toolCalls}`
      );

      // Context debug: 记录最终结果并写入文件
      const sentMessages = this.extractSentMessages(result.messages);
      debugLogger.recordFinal(sentMessages, metrics.totalPromptTokens, metrics.totalCompletionTokens, metrics.toolCalls);
      debugLogger.flush();

      return result.response || '[无回复]';
    } catch (err: any) {
      // 清理孤立的 user 消息，避免污染后续对话
      if (this.messages.length > 0 && this.messages[this.messages.length - 1].role === 'user') {
        this.messages.pop();
      }
      Logger.error(`[会话 ${this.key}] 处理失败: ${err.message}`);
      return `处理消息时出错: ${err.message}`;
    } finally {
      this.busy = false;
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

    // /settings 或 /pref
    if (commandName === 'settings' || commandName === 'pref') {
      return this.handleSettingsCommand(args);
    }

    // skill 斜杠命令
    return this.handleSkillCommand(commandName, args, callbacks);
  }

  // ─── 生命周期 ──────────────────────────────────────

  /** 清空历史 */
  clear(): void {
    this.messages = [];
    this.messageQueue = [];
    this.activeSkillName = undefined;
    this.activeSkillToolPolicy = undefined;
    this.activeSkillMaxTurns = undefined;
    this.lastActiveAt = Date.now();
  }

  /** 清空历史并销毁会话 */
  async summarizeAndDestroy(): Promise<boolean> {
    if (this.messages.length === 0) {
      return false;
    }
    this.messages = [];
    this.messageQueue = [];
    return true;
  }

  // ─── 查询方法 ──────────────────────────────────────

  isBusy(): boolean {
    return this.busy;
  }

  enqueue(text: string): void {
    this.messageQueue.push(text);
    if (this.gauzMem.isAvailable()) {
      this.gauzMem.writeMessage(text, 'user', this.platformId, this.runId).catch(() => {});
    }
  }

  getQueueLength(): number {
    return this.messageQueue.length;
  }

  private drainQueue(): string[] {
    const msgs = [...this.messageQueue];
    this.messageQueue = [];
    return msgs;
  }

  getHistoryLength(): number {
    return this.messages.length;
  }

  getMessages(): Message[] {
    return this.messages;
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
      if (msg.content.startsWith(TRANSIENT_SUBAGENT_STATUS_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_LONG_TERM_MEMORY_PREFIX)) return false;
      return true;
    });
  }

  /**
   * 裁剪本地历史：保留 system 消息 + 最近 MAX_LOCAL_TURNS 轮对话。
   * GauzMem 可用时调用，因为长期记忆已持久化到服务端。
   */
  /**
   * 从 messages 中提取 send_message 工具实际发出的内容
   */
  private extractSentMessages(messages: Message[]): string[] {
    const sent: string[] = [];
    for (const msg of messages) {
      if (msg.role !== 'assistant' || !msg.tool_calls) continue;
      for (const tc of msg.tool_calls) {
        if (tc.function.name !== 'send_message') continue;
        try {
          const args = JSON.parse(tc.function.arguments);
          if (args.message) sent.push(args.message);
        } catch { /* ignore */ }
      }
    }
    return sent;
  }

  private trimLocalHistory(): void {
    // 分离 system 消息和对话消息
    const systemMessages: Message[] = [];
    const conversationMessages: Message[] = [];
    for (const msg of this.messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg);
      } else {
        conversationMessages.push(msg);
      }
    }

    // 计算需要保留的对话消息数量（N 轮 = N*2 条 user+assistant）
    const maxConversationMessages = MAX_LOCAL_TURNS * 2;
    if (conversationMessages.length <= maxConversationMessages) return;

    const trimmed = conversationMessages.slice(-maxConversationMessages);
    this.messages = [...systemMessages, ...trimmed];
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

  /** /settings 命令 - 查看或修改偏好 */
  private handleSettingsCommand(args: string[]): CommandResult {
    const prefs = loadPreferences();
    const prefPath = getPreferencesFilePath();

    // 无参数：显示当前偏好
    if (args.length === 0) {
      return {
        handled: true,
        reply: `当前偏好设置：

- AI 名字: ${prefs.agent_name}
- 对你的称呼: ${prefs.user_name}
- 已初始化: ${prefs.initialized ? '是' : '否'}
- 偏好文件: ${prefPath}

修改方式：
- /settings agent_name <新名字>
- /settings user_name <新称呼>
- /settings reset（重置为默认值）`,
      };
    }

    const subCommand = args[0].toLowerCase();
    const value = args.slice(1).join(' ').trim();

    // /settings reset
    if (subCommand === 'reset') {
      const defaultPrefs: UserPreferences = {
        agent_name: '小八',
        user_name: '主人',
        initialized: true,
        created_at: prefs.created_at,
        updated_at: new Date().toISOString().slice(0, 10),
      };
      savePreferences(defaultPrefs);
      return { handled: true, reply: '偏好已重置为默认值。下一轮对话生效。' };
    }

    // /settings agent_name <名字>
    if (subCommand === 'agent_name' && value) {
      const updated = { ...prefs, agent_name: value };
      savePreferences(updated);
      return { handled: true, reply: `好的，以后我叫"${value}"了。下一轮对话生效。` };
    }

    // /settings user_name <称呼>
    if (subCommand === 'user_name' && value) {
      const updated = { ...prefs, user_name: value };
      savePreferences(updated);
      return { handled: true, reply: `好的，以后叫你"${value}"。下一轮对话生效。` };
    }

    // /settings initialized true/false（调试用）
    if (subCommand === 'initialized') {
      const initialized = value === 'true';
      const updated = { ...prefs, initialized };
      savePreferences(updated);
      return { handled: true, reply: `initialized 已设为 ${initialized}。` };
    }

    return {
      handled: true,
      reply: `未识别的设置命令。用法：
- /settings（查看当前偏好）
- /settings agent_name <名字>
- /settings user_name <称呼>
- /settings reset`,
    };
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
