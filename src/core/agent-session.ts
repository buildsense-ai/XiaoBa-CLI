import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { SkillActivationSignal, SkillInvocationContext } from '../types/skill';
import { ChannelCallbacks } from '../types/tool';
import {
  buildSkillActivationSignal,
  upsertSkillSystemMessage,
} from '../skills/skill-activation-protocol';
import { ConversationRunner, RunnerCallbacks } from './conversation-runner';
import { SubAgentManager } from './sub-agent-manager';
import { PromptManager } from '../utils/prompt-manager';
import { Logger } from '../utils/logger';
import { SessionTurnLogger } from '../utils/session-turn-logger';
import { SessionStore } from '../utils/session-store';
import { Metrics } from '../utils/metrics';
import { ContextCompressor } from './context-compressor';

const TRANSIENT_SUBAGENT_STATUS_PREFIX = '[transient_subagent_status]';
const TRANSIENT_RUNNER_HINT_PREFIX = '[transient_runner_hint]';
const TRANSIENT_SOFT_CHECK_PREFIX = '[transient_soft_check]';
const TRANSIENT_SKILLS_LIST_PREFIX = '[transient_skills_list]';
export const BUSY_MESSAGE = '正在处理上一条消息，请稍候...';
export const ERROR_MESSAGE = '不好意思，刚才处理出了点问题，你再试一次？';

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
  private activeSkillName?: string;
  private activeSkillMaxTurns?: number;
  private pendingRestore?: Message[];
  /** 过期时主动唤醒用户的回调（由平台 SessionManager 注入） */
  private wakeupReply?: (text: string) => Promise<void>;
  /** 外部请求中断当前 run（例如用户在 busy 时发送"停止"） */
  private interruptRequested = false;
  lastActiveAt: number = Date.now();
  private sessionTurnLogger: SessionTurnLogger;
  private compressor: ContextCompressor;

  constructor(
    public readonly key: string,
    private services: AgentServices,
    private sessionType?: string,
  ) {
    const type = sessionType || this.extractSessionType(key);
    this.sessionTurnLogger = new SessionTurnLogger(type, key);
    this.compressor = new ContextCompressor(services.aiService);
  }

  private extractSessionType(key: string): string {
    if (key.startsWith('catscompany:')) return 'catscompany';
    if (key.startsWith('feishu:')) return 'feishu';
    if (key.startsWith('user:')) return 'weixin';
    return 'chat';
  }

  /** 注入主动唤醒回调（由平台 SessionManager 在创建/获取 session 时调用） */
  setWakeupReply(callback: (text: string) => Promise<void>): void {
    this.wakeupReply = callback;
  }

  // ─── 初始化 ─────────────────────────────────────────

  /** 构建系统提示词（幂等，仅首次生效） */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const systemPrompt = await PromptManager.buildSystemPrompt();
    if (systemPrompt.trim()) {
      this.messages.push({ role: 'system', content: systemPrompt });
    }
    if (this.isFeishuSession()) {
      const isGroup = this.key.startsWith('group:');
      const chatType = isGroup ? '群聊' : '私聊';
      const modeInstruction = `【消息模式】你的每次文本输出都会立即自动发送给用户。

工作流程：
1. 简单问答：直接输出文本回答
2. 需要工具：调用工具（read/write/grep 等）后再回答

重要规则：
- 如果还需要调用工具，不要输出任何文本
- 只在最终准备回答用户时才输出文本`;

      this.messages.push({
        role: 'system',
        content: `[surface:feishu:${isGroup ? 'group' : 'private'}]\n当前是飞书${chatType}会话。\n${modeInstruction}`,
      });
    } else if (this.isCatsCompanySession()) {
      const modeInstruction = `【消息模式】你的每次文本输出都会立即自动发送给用户。

工作流程：
1. 简单问答：直接输出文本回答
2. 需要工具：调用工具（read/write/grep 等）后再回答

重要规则：
- 如果还需要调用工具，不要输出任何文本
- 只在最终准备回答用户时才输出文本`;

      this.messages.push({
        role: 'system',
        content: `[surface:catscompany]\n当前是 Cats Company 聊天会话。\n${modeInstruction}`,
      });
    }

    // 加载上次会话摘要（本地文件兜底）
    // 已移除摘要机制

    // 从 DB 恢复未归档的消息
    if (this.pendingRestore) {
      this.messages.push(...this.pendingRestore);
      Logger.info(`[会话 ${this.key}] 已恢复 ${this.pendingRestore.length} 条消息`);
      this.pendingRestore = undefined;

      // 恢复后立即检查是否需要压缩
      const usage = this.compressor.getUsageInfo(this.messages);
      Logger.info(`[${this.key}] 恢复后上下文: ${usage.usedTokens}/${usage.maxTokens} tokens (${usage.usagePercent}%)`);

      if (this.compressor.needsCompaction(this.messages)) {
        Logger.info(`[${this.key}] 超过阈值，开始压缩...`);
        try {
          this.messages = await this.compressor.compact(this.messages);
          Logger.info(`[${this.key}] 压缩完成，当前消息数: ${this.messages.length}`);
        } catch (err) {
          Logger.error(`[${this.key}] 压缩失败: ${err}`);
        }
      }
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
    const injectedCount = this.messages.filter(m => m.__injected).length;
    if (injectedCount > AgentSession.MAX_INJECTED_CONTEXT) {
      const idx = this.messages.findIndex(m => m.__injected);
      if (idx >= 0) this.messages.splice(idx, 1);
    }
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
    // 兼容旧签名：如果传入的对象有 onText/onToolStart 等字段，视为 SessionCallbacks
    let callbacks: SessionCallbacks | undefined;
    let channel: ChannelCallbacks | undefined;

    if (callbacksOrOptions) {
      if ('channel' in callbacksOrOptions || 'callbacks' in callbacksOrOptions) {
        // 新签名 HandleMessageOptions
        const opts = callbacksOrOptions as HandleMessageOptions;
        callbacks = opts.callbacks;
        channel = opts.channel;
      } else {
        // 旧签名 SessionCallbacks
        callbacks = callbacksOrOptions as SessionCallbacks;
      }
    }

    if (this.busy) {
      return { text: BUSY_MESSAGE, visibleToUser: true };
    }

    // 按"单次消息"统计 metrics，避免跨轮次累积导致定位困难
    Metrics.reset();

    this.busy = true;
    this.interruptRequested = false;
    this.lastActiveAt = Date.now();

    // 检查是否需要压缩上下文
    if (this.compressor.needsCompaction(this.messages)) {
      const usage = this.compressor.getUsageInfo(this.messages);
      Logger.info(`[${this.key}] 上下文即将压缩: ${usage.usedTokens}/${usage.maxTokens} tokens (${usage.usagePercent}%)`);
      try {
        this.messages = await this.compressor.compact(this.messages);
        Logger.info(`[${this.key}] 压缩完成，当前消息数: ${this.messages.length}`);
      } catch (err) {
        Logger.error(`[${this.key}] 压缩失败: ${err}`);
      }
    }

    try {
      await this.init();
      const textContent = typeof text === 'string' ? text : '';
      this.tryAutoActivateSkill(textContent);
      this.messages.push({ role: 'user', content: text });


      // 构建上下文消息
      let contextMessages: Message[] = [...this.messages];

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

      // 动态注入当前可用 skills 列表（临时上下文，不持久化）
      // 每次处理消息时重新从磁盘加载 skills，确保 Dashboard 的禁用/启用/安装/删除立即生效
      await this.services.skillManager.loadSkills();

      const skills = this.services.skillManager.getUserInvocableSkills();
      if (skills.length > 0) {
        const skillList = skills.map(s => `- ${s.metadata.name}: ${s.metadata.description}`).join('\n');
        const skillsListMsg: Message = {
          role: 'system',
          content: `${TRANSIENT_SKILLS_LIST_PREFIX}\n你可以使用以下skills（通过skill工具调用）：\n\n${skillList}`,
        };
        const lastUserIdx = contextMessages.length - 1;
        contextMessages.splice(lastUserIdx, 0, skillsListMsg);
      }

      // 运行对话循环（优先用显式设置的 maxTurns，否则从 messages 中检测已激活 skill）
      const detectedSkillName = this.activeSkillName ?? this.detectActiveSkillName();
      if (detectedSkillName) {
        const detectedSkill = this.services.skillManager.getSkill(detectedSkillName);
        this.activeSkillName = detectedSkillName;
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
          shouldContinue: () => !this.interruptRequested,
          toolExecutionContext: {
            sessionId: this.key,
            surface,
            permissionProfile: 'strict',
            channel,
          },
        },
      );
      const runnerCallbacks: RunnerCallbacks = {
        onText: callbacks?.onText,
        onToolStart: callbacks?.onToolStart,
        onToolEnd: callbacks?.onToolEnd,
        onToolDisplay: callbacks?.onToolDisplay,
        onRetry: callbacks?.onRetry,
      };

      const result = await runner.run(contextMessages, runnerCallbacks);
      const persistedMessages = this.removeTransientMessages(result.messages);
      this.messages = [...persistedMessages];

      // 同步 skill 激活状态
      for (const msg of result.newMessages) {
        const activation = this.parseActivationFromSystemMessage(msg);
        if (activation) {
          this.applySkillActivation(activation);
        }
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

      // 替换 base64 图片数据为路径占位符，避免撑爆 context
      for (const msg of this.messages) {
        if (Array.isArray(msg.content)) {
          msg.content = msg.content.map(block => {
            if (block.type === 'image' && block.source?.data) {
              const filePath = (block as any).filePath || '未知路径';
              return { type: 'text' as const, text: `[图片: ${filePath}]` };
            }
            return block;
          });
        }
      }

      // 清除 skill 激活状态（turn-scoped，避免状态泄漏到下一轮）
      this.activeSkillName = undefined;
      this.activeSkillMaxTurns = undefined;

      // 移除 skill 系统消息（下一轮需要时会重新注入）
      this.messages = this.messages.filter(m => {
        if (m.role === 'system' && typeof m.content === 'string') {
          return !m.content.match(/^\[skill:[^\]]+\]/);
        }
        return true;
      });

      // 记录本轮对话到 session log
      const toolCalls = result.newMessages
        .filter(m => m.role === 'assistant' && m.tool_calls)
        .flatMap(m => m.tool_calls || [])
        .map(tc => {
          const resultMsg = result.newMessages.find(m => m.role === 'tool' && m.tool_call_id === tc.id);
          const resultContent = resultMsg?.content || '';
          const resultStr = typeof resultContent === 'string'
            ? resultContent
            : resultContent.map(b => b.type === 'text' ? (b as any).text : '[非文本内容]').join('');

          return {
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
            result: resultStr,
          };
        });

      this.sessionTurnLogger.logTurn(
        text,
        result.response || '',
        toolCalls,
        { prompt: metrics.totalPromptTokens, completion: metrics.totalCompletionTokens }
      );

      return {
        text: result.finalResponseVisible ? (result.response || '[无回复]') : '',
        visibleToUser: result.finalResponseVisible,
        newMessages: result.newMessages,
      };
    } catch (err: any) {
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

      return { text: errorReply, visibleToUser: true };
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


    // skill 斜杠命令
    return this.handleSkillCommand(commandName, args, callbacks);
  }

  // ─── 生命周期 ──────────────────────────────────────

  /** 清空历史 */
  clear(): void {
    SessionStore.getInstance().deleteSession(this.key);
    this.messages = [];
    this.initialized = false;
    this.activeSkillName = undefined;
    this.activeSkillMaxTurns = undefined;
    this.lastActiveAt = Date.now();
  }

  async summarizeAndDestroy(): Promise<boolean> {
    const hasUserMessages = this.messages.some(m => m.role === 'user');
    if (this.messages.length === 0 || !hasUserMessages) {
      return false;
    }

    try {
      const conversationText = this.messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => `${m.role === 'user' ? '\u7528\u6237' : 'AI'}: ${m.content}`)
        .join('\n');

      // \u540c\u65f6\u751f\u6210\u6458\u8981 + \u5224\u65ad\u662f\u5426\u9700\u8981\u4e3b\u52a8\u5524\u9192\uff08\u4e0d\u589e\u52a0\u989d\u5916 AI \u8c03\u7528\uff09
      const summaryPrompt = this.wakeupReply
        ? `\u8bf7\u5bf9\u4ee5\u4e0b\u5bf9\u8bdd\u8fdb\u884c\u5206\u6790\uff0c\u8fd4\u56de JSON \u683c\u5f0f\u7684\u7ed3\u679c\u3002

\u5bf9\u8bdd\u5185\u5bb9\uff1a
${conversationText}

\u8bf7\u8fd4\u56de\u4ee5\u4e0b JSON \u683c\u5f0f\uff08\u4e0d\u8981\u5305\u542b markdown \u4ee3\u7801\u5757\u6807\u8bb0\uff09\uff1a
{
  "summary": "\u7b80\u6d01\u7684\u5bf9\u8bdd\u6458\u8981\uff0c\u4fdd\u7559\u5173\u952e\u4fe1\u606f\u3001\u91cd\u8981\u4e8b\u5b9e\u548c\u4e0a\u4e0b\u6587",
  "wakeup": null \u6216 "\u4e00\u6761\u81ea\u7136\u7684\u6d88\u606f"
}

\u5173\u4e8e wakeup \u5b57\u6bb5\u7684\u5224\u65ad\u89c4\u5219\uff1a
- \u5982\u679c\u6709\u672a\u5b8c\u6210\u7684\u4efb\u52a1\u6216\u627f\u8bfa\uff08\u5982 AI \u8bf4\u201c\u7a0d\u540e\u5e2e\u4f60\u67e5\u201d\u4f46\u6ca1\u505a\uff09\u2192 \u9700\u8981\u5524\u9192
- \u5982\u679c\u6709\u540e\u53f0\u4efb\u52a1\u5df2\u5b8c\u6210\u4f46\u7ed3\u679c\u8fd8\u6ca1\u544a\u8bc9\u7528\u6237 \u2192 \u9700\u8981\u5524\u9192
- \u5982\u679c\u7528\u6237\u6700\u540e\u7684\u95ee\u9898\u6ca1\u6709\u5f97\u5230\u5b8c\u6574\u56de\u7b54 \u2192 \u9700\u8981\u5524\u9192
- \u5982\u679c\u5bf9\u8bdd\u81ea\u7136\u7ed3\u675f\u3001\u7528\u6237\u4e3b\u52a8\u544a\u522b\u3001\u6216\u53ea\u662f\u95f2\u804a \u2192 \u4e0d\u9700\u8981\u5524\u9192\uff08\u8fd4\u56de null\uff09
- \u5524\u9192\u6d88\u606f\u8981\u81ea\u7136\uff0c\u50cf\u52a9\u7406\u4e3b\u52a8\u8ddf\u8fdb\uff0c\u4e0d\u8981\u751f\u786c`
        : `\u8bf7\u5bf9\u4ee5\u4e0b\u5bf9\u8bdd\u8fdb\u884c\u7b80\u6d01\u7684\u6458\u8981\uff0c\u4fdd\u7559\u5173\u952e\u4fe1\u606f\u3001\u91cd\u8981\u4e8b\u5b9e\u548c\u4e0a\u4e0b\u6587\u3002\u6458\u8981\u5e94\u8be5\u7b80\u6d01\u4f46\u5b8c\u6574\uff0c\u4ee5\u4fbf\u672a\u6765\u56de\u5fc6\u65f6\u80fd\u7406\u89e3\u5bf9\u8bdd\u7684\u4e3b\u8981\u5185\u5bb9\u3002

\u5bf9\u8bdd\u5185\u5bb9\uff1a
${conversationText}

\u8bf7\u751f\u6210\u6458\u8981\uff1a`;

      const result = await this.services.aiService.chat([
        { role: 'user', content: summaryPrompt },
      ]);

      // \u89e3\u6790 AI \u8fd4\u56de\u7684\u7ed3\u679c
      let summaryText: string;
      let wakeupMessage: string | null = null;

      if (this.wakeupReply) {
        // \u5c1d\u8bd5\u89e3\u6790 JSON \u683c\u5f0f
        try {
          const raw = result.content || '{}';
          // \u5904\u7406 AI \u53ef\u80fd\u8fd4\u56de\u7684 markdown \u4ee3\u7801\u5757\u5305\u88f9
          const jsonStr = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/i, '').trim();
          const parsed = JSON.parse(jsonStr);
          summaryText = `[\u5bf9\u8bdd\u6458\u8981 - ${new Date().toISOString()}]\n${parsed.summary || result.content || ''}`;
          wakeupMessage = parsed.wakeup || null;
        } catch {
          // JSON \u89e3\u6790\u5931\u8d25\uff0c\u964d\u7ea7\u4e3a\u7eaf\u6458\u8981\uff0c\u4e0d\u5524\u9192
          summaryText = `[\u5bf9\u8bdd\u6458\u8981 - ${new Date().toISOString()}]\n${result.content || ''}`;
          Logger.warning(`[\u4f1a\u8bdd ${this.key}] \u6458\u8981+\u5524\u9192 JSON \u89e3\u6790\u5931\u8d25\uff0c\u964d\u7ea7\u4e3a\u7eaf\u6458\u8981`);
        }
      } else {
        summaryText = `[\u5bf9\u8bdd\u6458\u8981 - ${new Date().toISOString()}]\n${result.content || ''}`;
      }

      // \u4e3b\u52a8\u5524\u9192\uff1a\u5982\u679c AI \u5224\u65ad\u9700\u8981\u901a\u77e5\u7528\u6237\uff0c\u4e14\u6709\u56de\u8c03\u53ef\u7528
      if (wakeupMessage && this.wakeupReply) {
        try {
          await this.wakeupReply(wakeupMessage);
          Logger.info(`[\u4f1a\u8bdd ${this.key}] \u4e3b\u52a8\u5524\u9192\u7528\u6237: ${wakeupMessage.slice(0, 100)}`);
        } catch (err: any) {
          Logger.warning(`[\u4f1a\u8bdd ${this.key}] \u4e3b\u52a8\u5524\u9192\u5931\u8d25: ${err.message}`);
        }
      }


      // \u5f52\u6863\u6301\u4e45\u5316\u6587\u4ef6

      this.messages = [];
      return true;
    } catch (error) {
      Logger.error('\u538b\u7f29\u5386\u53f2\u5931\u8d25: ' + String(error));
      return false;
      return false;
    }
  }

  /** 过期或退出时清理内存（保存完整 context） */
  async cleanup(options?: { checkWakeup?: boolean }): Promise<void> {
    if (this.messages.length === 0) return;

    try {
      // 判断是否需要主动唤醒用户（仅在会话过期时）
      if (options?.checkWakeup && this.wakeupReply) {
        const hasUserMessages = this.messages.some(m => m.role === 'user');
        if (hasUserMessages) {
          const conversationText = this.messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .slice(-10)
            .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
            .join('\n');

          const wakeupPrompt = `请判断以下对话是否需要主动唤醒用户。返回 JSON 格式（不要包含 markdown 代码块）：
{ "wakeup": null 或 "一条自然的消息" }

判断规则：
- 有未完成的任务或承诺 → 需要唤醒
- 后台任务已完成但结果还没告诉用户 → 需要唤醒
- 用户最后的问题没有得到完整回答 → 需要唤醒
- 对话自然结束、用户主动告别、或只是闲聊 → 不需要唤醒（返回 null）

对话内容：
${conversationText}`;

          try {
            const result = await this.services.aiService.chat([
              { role: 'user', content: wakeupPrompt },
            ]);

            const raw = result.content || '{}';
            const jsonStr = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/i, '').trim();
            const parsed = JSON.parse(jsonStr);

            if (parsed && parsed.wakeup && this.wakeupReply) {
              await this.wakeupReply(parsed.wakeup);
              Logger.info(`[会话 ${this.key}] 主动唤醒用户: ${parsed.wakeup.slice(0, 100)}`);
            }
          } catch (err: any) {
            Logger.warning(`[会话 ${this.key}] 唤醒判断失败: ${err.message}`);
          }
        }
      }

      // 保存完整 context 到 SessionStore
      SessionStore.getInstance().saveContext(this.key, this.messages);
      Logger.info(`会话已保存: ${this.key}, ${this.messages.length} 条消息`);

      // 清理内存
      this.messages = [];
    } catch (error) {
      Logger.error(`清理会话失败: ${error}`);
    }
  }

  // ─── 查询方法 ──────────────────────────────────────

  isBusy(): boolean {
    return this.busy;
  }

  /** 请求中断当前运行中的对话回合 */
  requestInterrupt(): void {
    if (!this.busy) return;
    this.interruptRequested = true;
  }

  /** 从 DB 恢复消息（进程重启后调用） */
  restoreFromStore(): boolean {
    const store = SessionStore.getInstance();
    if (!store.hasSession(this.key)) return false;
    const msgs = store.loadContext(this.key);
    if (msgs.length === 0) return false;
    this.pendingRestore = msgs;
    Logger.info(`[会话 ${this.key}] 标记从 DB 恢复 ${msgs.length} 条消息`);
    return true;
  }

  // ─── 私有方法 ──────────────────────────────────────

  /** 从 messages 中检测已激活 skill 的 maxTurns（兜底机制） */
  private detectSkillMaxTurns(): number | undefined {
    for (const msg of this.messages) {
      if (msg.role === 'system' && typeof msg.content === 'string') {
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
      if (msg.role !== 'system' || typeof msg.content !== 'string') continue;
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
      if (msg.content.startsWith(TRANSIENT_RUNNER_HINT_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_SOFT_CHECK_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_SKILLS_LIST_PREFIX)) return false;
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
      return { handled: true, reply: reply.text };
    }

    return { handled: true, reply: `已激活 skill: ${skill.metadata.name}` };
  }

  private applySkillActivation(activation: SkillActivationSignal): void {
    upsertSkillSystemMessage(this.messages, activation);
    this.activeSkillName = activation.skillName;
    this.activeSkillMaxTurns = activation.maxTurns;
  }

  private parseActivationFromSystemMessage(msg: Message): SkillActivationSignal | null {
    if (msg.role !== 'system' || typeof msg.content !== 'string') {
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
    };
  }
}
