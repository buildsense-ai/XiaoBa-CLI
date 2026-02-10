import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { SkillExecutor } from '../skills/skill-executor';
import { SkillInvocationContext } from '../types/skill';
import { GauzMemService } from '../utils/gauzmem-service';
import { ConversationRunner, RunnerCallbacks } from './conversation-runner';
import { PromptManager } from '../utils/prompt-manager';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';

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
  private activeSkillMaxTurns?: number;
  lastActiveAt: number = Date.now();

  constructor(
    public readonly key: string,
    private services: AgentServices,
  ) {}

  // ─── 初始化 ─────────────────────────────────────────

  /** 构建系统提示词（幂等，仅首次生效） */
  async init(): Promise<void> {
    if (this.messages.length > 0) return;
    const systemPrompt = await PromptManager.buildSystemPrompt();
    this.messages.push({ role: 'system', content: systemPrompt });
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

    const prompt = SkillExecutor.execute(skill, context);
    const skillMarker = `[skill:${skillName}]`;
    const taggedPrompt = `${skillMarker}\n${prompt}`;

    this.messages.push({ role: 'system', content: taggedPrompt });
    this.activeSkillMaxTurns = skill.metadata.maxTurns;

    Logger.info(`[${this.key}] 启动时激活 skill: ${skill.metadata.name}${skill.metadata.maxTurns ? ` (maxTurns=${skill.metadata.maxTurns})` : ''}`);
    return true;
  }

  // ─── 消息处理 ───────────────────────────────────────

  /** 完整消息处理管线：记忆搜索 → AI 推理 → 工具循环 → 同步历史 */
  async handleMessage(text: string, callbacks?: SessionCallbacks): Promise<string> {
    if (this.busy) {
      return '正在处理上一条消息，请稍候...';
    }

    this.busy = true;
    this.lastActiveAt = Date.now();

    try {
      await this.init();
      this.messages.push({ role: 'user', content: text });

      // 搜索相关记忆，作为临时上下文注入
      let contextMessages: Message[] = [...this.messages];
      const memoryService = this.services.memoryService;
      if (memoryService) {
        const memories = await memoryService.searchMemory(text);
        if (memories.length > 0) {
          const memoryContext = memoryService.formatMemoriesAsContext(memories);
          contextMessages = [
            ...this.messages.slice(0, -1),
            { role: 'system', content: memoryContext },
            this.messages[this.messages.length - 1],
          ];
        }
      }

      // 运行对话循环（优先用显式设置的 maxTurns，否则从 messages 中检测已激活 skill）
      const effectiveMaxTurns = this.activeSkillMaxTurns ?? this.detectSkillMaxTurns();
      const runner = new ConversationRunner(
        this.services.aiService,
        this.services.toolManager,
        effectiveMaxTurns ? { maxTurns: effectiveMaxTurns } : undefined,
      );
      const runnerCallbacks: RunnerCallbacks = {
        onText: callbacks?.onText,
        onToolStart: callbacks?.onToolStart,
        onToolEnd: callbacks?.onToolEnd,
        onToolDisplay: callbacks?.onToolDisplay,
      };

      const result = await runner.run(contextMessages, runnerCallbacks);

      // 将工具调用中间消息同步回 messages（通过 RunResult.newMessages，不受上下文压缩影响）
      for (const msg of result.newMessages) {
        this.messages.push(msg);
      }
      this.messages.push({ role: 'assistant', content: result.response });

      // 输出本次请求的 metrics 摘要
      const metrics = Metrics.getSummary();
      if (metrics.aiCalls > 0 || metrics.toolCalls > 0) {
        Logger.info(
          `[Metrics] AI调用: ${metrics.aiCalls}次, ` +
          `tokens: ${metrics.totalPromptTokens}+${metrics.totalCompletionTokens}=${metrics.totalTokens}, ` +
          `工具调用: ${metrics.toolCalls}次, 工具耗时: ${metrics.toolDurationMs}ms`
        );
      }

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

    // skill 斜杠命令
    return this.handleSkillCommand(commandName, args, callbacks);
  }

  // ─── 生命周期 ──────────────────────────────────────

  /** 清空历史 */
  clear(): void {
    this.messages = [];
    this.lastActiveAt = Date.now();
  }

  /** 压缩历史写入记忆，然后清空 */
  async summarizeAndDestroy(): Promise<boolean> {
    const memoryService = this.services.memoryService;
    const hasUserMessages = this.messages.some(m => m.role === 'user');
    if (this.messages.length === 0 || !memoryService || !hasUserMessages) {
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
      const writeSuccess = await memoryService.writeMemory(summaryText, 'agent');

      if (writeSuccess) {
        Logger.info(`已压缩 ${this.messages.length} 条消息并写入记忆系统`);
      } else {
        Logger.warning('已生成摘要但写入记忆系统失败');
      }

      this.messages = [];
      return writeSuccess;
    } catch (error) {
      Logger.error('压缩历史失败: ' + String(error));
      return false;
    }
  }

  // ─── 查询方法 ──────────────────────────────────────

  isBusy(): boolean {
    return this.busy;
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

    const prompt = SkillExecutor.execute(skill, context);
    const skillMarker = `[skill:${commandName}]`;
    const taggedPrompt = `${skillMarker}\n${prompt}`;

    await this.init();

    // 移除同名 skill 的旧注入，防止累积
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (
        this.messages[i].role === 'system' &&
        this.messages[i].content?.startsWith(skillMarker)
      ) {
        this.messages.splice(i, 1);
      }
    }

    this.messages.push({ role: 'system', content: taggedPrompt });
    this.activeSkillMaxTurns = skill.metadata.maxTurns;
    Logger.info(`[${this.key}] 已激活 skill: ${skill.metadata.name}${skill.metadata.maxTurns ? ` (maxTurns=${skill.metadata.maxTurns})` : ''}`);

    // 如果有参数，自动作为用户消息发送给 AI
    if (args.length > 0) {
      const reply = await this.handleMessage(args.join(' '), callbacks);
      return { handled: true, reply };
    }

    return { handled: true, reply: `已激活 skill: ${skill.metadata.name}` };
  }
}
