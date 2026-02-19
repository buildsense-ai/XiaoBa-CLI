import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { SkillInvocationContext } from '../types/skill';
import { FeishuChannelCallbacks } from '../types/tool';
import {
  buildSkillActivationSignal,
  upsertSkillSystemMessage,
} from '../skills/skill-activation-protocol';
import { ConversationRunner, RunnerCallbacks } from './conversation-runner';
import { PromptManager } from '../utils/prompt-manager';
import { Logger } from '../utils/logger';
import { isToolAllowed } from '../utils/safety';
import * as path from 'path';
import * as fs from 'fs';

// ─── 类型定义 ───────────────────────────────────────────

export type SubAgentStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'waiting_for_input';

export interface SubAgentInfo {
  id: string;
  skillName: string;
  taskDescription: string;
  status: SubAgentStatus;
  createdAt: number;
  completedAt?: number;
  /** 进度日志 */
  progressLog: string[];
  /** 最终结果摘要 */
  resultSummary?: string;
  /** 子智能体挂起时的待确认问题 */
  pendingQuestion?: string;
}

export interface SubAgentSpawnOptions {
  skillName: string;
  taskDescription: string;
  userMessage: string;
  workingDirectory: string;
  /** 飞书回调：让 SubAgent 能主动给用户发消息 */
  feishuReply?: (text: string) => Promise<void>;
  feishuSendFile?: (filePath: string, fileName: string) => Promise<void>;
  /** 向主 agent 投递消息（子智能体挂起时触发主 agent 推理） */
  notifyParent?: (subAgentId: string, taskDescription: string, question: string) => Promise<void>;
}

// ─── SubAgentSession ────────────────────────────────────

/**
 * SubAgentSession - 独立运行的后台子智能体
 *
 * 拥有自己的 messages[]、ConversationRunner、skill 上下文。
 * 通过 feishuReply 回调主动向用户推送进度。
 * 主会话不 await 它，fire-and-forget。
 */
export class SubAgentSession {
  readonly id: string;
  readonly skillName: string;
  readonly taskDescription: string;
  status: SubAgentStatus = 'running';
  progressLog: string[] = [];
  resultSummary?: string;
  createdAt = Date.now();
  completedAt?: number;

  private messages: Message[] = [];
  private stopped = false;
  /** 子智能体执行期间创建的文件路径（用于自动发送产出） */
  private outputFiles: string[] = [];
  /** 挂起等待主 agent 回答的问题 */
  private pendingQuestion: string | null = null;
  private pendingResolve: ((answer: string) => void) | null = null;
  private pendingWaitPromise: Promise<string> | null = null;

  // ─── 会话级重试配置 ──────────────────────────────────
  private static readonly SESSION_MAX_RETRIES = 2;
  private static readonly SESSION_RETRY_BASE_DELAY_MS = 5000;

  private static isRetryableError(err: any): boolean {
    const msg = String(err?.message || '').toLowerCase();
    return /429|rate.?limit|too many requests|overloaded|频率|并发/.test(msg)
      || /\b50[023]\b|529/.test(msg)
      || /econnreset|etimedout|econnaborted/.test(msg);
  }

  constructor(
    id: string,
    private aiService: AIService,
    private skillManager: SkillManager,
    private options: SubAgentSpawnOptions,
  ) {
    this.id = id;
    this.skillName = options.skillName;
    this.taskDescription = options.taskDescription;
  }

  /**
   * 后台执行（带会话级重试）。调用方不 await，fire-and-forget。
   */
  async run(): Promise<void> {
    let lastError: any;

    for (let attempt = 0; attempt <= SubAgentSession.SESSION_MAX_RETRIES; attempt++) {
      if (this.stopped) {
        this.status = 'stopped';
        this.completedAt = Date.now();
        return;
      }

      // 重试前：等待 + 重置状态
      if (attempt > 0) {
        const delay = SubAgentSession.SESSION_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        Logger.warning(`[SubAgent ${this.id}] 第 ${attempt} 次重试，${delay}ms 后开始`);
        this.reportProgress(`第 ${attempt} 次重试（${lastError?.message}）`);
        await new Promise(resolve => setTimeout(resolve, delay));
        this.messages = [];
        this.outputFiles = [];
      }

      try {
        await this._executeOnce();
        return; // 成功，直接返回
      } catch (err: any) {
        lastError = err;
        if (this.stopped) break;
        if (!SubAgentSession.isRetryableError(err) || attempt === SubAgentSession.SESSION_MAX_RETRIES) {
          break; // 不可重试 或 重试次数用尽
        }
        Logger.warning(`[SubAgent ${this.id}] 可重试错误: ${err.message}`);
      }
    }

    // 最终失败
    this.status = this.stopped ? 'stopped' : 'failed';
    this.completedAt = Date.now();
    this.resultSummary = `执行失败: ${lastError?.message}`;
    Logger.error(`[SubAgent ${this.id}] ${this.stopped ? '已停止' : '失败'}: ${lastError?.message}`);
  }

  /**
   * 单次执行核心逻辑（不含重试）
   */
  private async _executeOnce(): Promise<void> {
    // 1. 构建独立的 system prompt
    const systemPrompt = await PromptManager.buildSystemPrompt();
    this.messages.push({ role: 'system', content: systemPrompt });

    // 2. 注入 skill
    const skill = this.skillManager.getSkill(this.skillName);
    if (!skill) {
      throw new Error(`Skill "${this.skillName}" 未找到`);
    }

    const invocationContext: SkillInvocationContext = {
      skillName: this.skillName,
      arguments: [],
      rawArguments: '',
      userMessage: this.options.userMessage,
    };
    const activation = buildSkillActivationSignal(skill, invocationContext);
    upsertSkillSystemMessage(this.messages, activation);

    // 3. 注入用户消息
    this.messages.push({ role: 'user', content: this.options.userMessage });

    // 4. 创建独立的 ToolManager
    const toolManager = new ToolManager(this.options.workingDirectory, {
      sessionId: `subagent:${this.id}`,
      surface: 'agent',
      permissionProfile: 'strict',
    });

    // 5. 构建飞书通道回调（通过 context 传递，替代 bindSession）
    const feishuChannel = this.buildFeishuChannel();

    // 6. 预检测被策略阻断的工具，避免子智能体浪费 turn
    const preDisabledTools = toolManager.getToolDefinitions()
      .map(t => t.name)
      .filter(name => !isToolAllowed(name).allowed);

    // 子智能体不允许再派遣子智能体（防止无限递归）
    const subagentTools = ['spawn_subagent', 'check_subagent', 'stop_subagent', 'resume_subagent'];
    preDisabledTools.push(...subagentTools);

    // 7. 创建独立的 ConversationRunner
    const runner = new ConversationRunner(this.aiService, toolManager, {
      maxTurns: skill.metadata.maxTurns ?? 100,
      initialSkillName: this.skillName,
      initialSkillToolPolicy: skill.metadata.toolPolicy,
      enableCompression: true,
      shouldContinue: () => !this.stopped,
      preDisabledTools,
      toolExecutionContext: {
        sessionId: `subagent:${this.id}`,
        surface: 'agent',
        permissionProfile: 'strict',
        feishuChannel,
      },
    });

    // 8. 用 callbacks 捕获进度
    const callbacks: RunnerCallbacks = {
      onToolEnd: (name, result) => {
        this.detectAndReportProgress(name, result);
      },
    };

    this.reportProgress(`开始执行：${this.taskDescription}`);
    const runResult = await runner.run(this.messages, callbacks);

    // 9. 完成
    this.status = 'completed';
    this.completedAt = Date.now();
    this.resultSummary = runResult.response;

    // 自动发送产出文件（兜底：即使 AI 忘了调 feishu_send_file，关键文件也能送达）
    await this.autoSendDeliverables();

    Logger.success(`[SubAgent ${this.id}] 完成: ${this.taskDescription}`);
  }

  stop(): void {
    this.stopped = true;
    this.status = 'stopped';
    this.completedAt = Date.now();
    // 如果正在挂起等待，解除阻塞
    if (this.pendingResolve) {
      this.pendingResolve('（任务已被停止）');
      this.pendingResolve = null;
      this.pendingQuestion = null;
      this.pendingWaitPromise = null;
    }
  }

  /**
   * 恢复挂起的子智能体（由主 agent 通过 resume_subagent 调用）
   * @returns 是否成功恢复
   */
  resume(answer: string): boolean {
    if (!this.pendingResolve || this.status !== 'waiting_for_input') {
      return false;
    }
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.pendingQuestion = null;
    this.status = 'running';
    this.reportProgress(`收到回复，继续执行`);
    resolve(answer);
    return true;
  }

  getInfo(): SubAgentInfo {
    return {
      id: this.id,
      skillName: this.skillName,
      taskDescription: this.taskDescription,
      status: this.status,
      createdAt: this.createdAt,
      completedAt: this.completedAt,
      progressLog: [...this.progressLog],
      resultSummary: this.resultSummary,
      pendingQuestion: this.pendingQuestion ?? undefined,
    };
  }

  // ─── 私有方法 ──────────────────────────────────────

  /**
   * 构建飞书通道回调，注入到 toolExecutionContext。
   * 子智能体的 feishuReply/feishuSendFile 回调已经封装了 chatId，
   * 所以这里用空 chatId，回调内部忽略 chatId 参数。
   */
  private buildFeishuChannel(): FeishuChannelCallbacks | undefined {
    if (!this.options.feishuReply && !this.options.feishuSendFile) {
      return undefined;
    }

    const channel: FeishuChannelCallbacks = {
      chatId: '', // 子智能体的回调已封装目标 chatId
      reply: async (_chatId: string, text: string) => {
        if (this.options.feishuReply) {
          await this.options.feishuReply(text);
        }
      },
      sendFile: async (_chatId: string, filePath: string, fileName: string) => {
        if (this.options.feishuSendFile) {
          await this.options.feishuSendFile(filePath, fileName);
        }
      },
    };

    // ask_user_question：子智能体挂起，反馈给主 agent 决策
    if (this.options.notifyParent) {
      channel.askUser = {
        send: async (question: string) => {
          this.pendingQuestion = question;
          this.status = 'waiting_for_input';
          this.reportProgress(`等待主 agent 指示：${question}`);
          // 先创建 Promise 再通知主 agent，避免 resume() 先于 waitFn 到达
          this.pendingWaitPromise = new Promise<string>((resolve) => {
            this.pendingResolve = resolve;
          });
          if (this.options.notifyParent) {
            await this.options.notifyParent(this.id, this.taskDescription, question);
          }
        },
        wait: () => this.pendingWaitPromise!,
      };
    }

    return channel;
  }

  private reportProgress(message: string): void {
    this.progressLog.push(message);
    // 仅记录到 progressLog，不推飞书
    // 主 agent 通过 check_subagent 查看进度后自行决定是否告知用户
  }

  private detectAndReportProgress(toolName: string, result: string): void {
    // 从工具结果中提取文件路径，用于自动发送产出
    if (toolName === 'write_file' || toolName === 'pptx_generator') {
      const filePath = this.extractFilePath(toolName, result);
      if (filePath) {
        this.outputFiles.push(filePath);
      }
    }

    // 记录有意义的进度（基于章节分析文件，而非所有 write_file）
    if (toolName === 'write_file' && result.includes('chapters/')) {
      const match = result.match(/chapters\/\d+_([^/]+)\//);
      const chapterSlug = match ? match[1] : null;
      this.reportProgress(chapterSlug ? `已完成章节: ${chapterSlug}` : `已完成 ${this.progressLog.length} 个阶段`);
    } else if (toolName === 'pptx_generator') {
      this.reportProgress('PPT 生成完成');
    } else if (toolName === 'write_file' && result.includes('summary.md')) {
      this.reportProgress('全文总结完成');
    }
  }

  /** 从工具结果中提取文件路径 */
  private extractFilePath(toolName: string, result: string): string | null {
    if (toolName === 'pptx_generator') {
      // pptx_generator 返回 JSON，包含 output_path
      try {
        const parsed = JSON.parse(result);
        return parsed.output_path || null;
      } catch {
        return null;
      }
    }
    // write_file 返回格式: "成功创建文件: <path>\n..."
    const match = result.match(/成功(?:创建|覆盖)文件:\s*(.+?)(?:\n|$)/);
    return match ? match[1].trim() : null;
  }

  /** 可交付文件扩展名 */
  private static readonly DELIVERABLE_EXTS = new Set(['.pptx', '.pdf', '.docx', '.xlsx', '.zip']);

  /** 完成后自动发送产出文件（兜底机制） */
  private async autoSendDeliverables(): Promise<void> {
    if (!this.options.feishuSendFile) return;

    const deliverables = this.outputFiles.filter(f => {
      const ext = path.extname(f).toLowerCase();
      return SubAgentSession.DELIVERABLE_EXTS.has(ext);
    });

    for (const filePath of deliverables) {
      try {
        // 解析绝对路径
        const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.options.workingDirectory, filePath);
        if (!fs.existsSync(absPath)) {
          Logger.warning(`[SubAgent ${this.id}] 产出文件不存在，跳过发送: ${absPath}`);
          continue;
        }
        const fileName = path.basename(absPath);
        await this.options.feishuSendFile(absPath, fileName);
        Logger.info(`[SubAgent ${this.id}] 自动发送产出文件: ${fileName}`);
      } catch (err: any) {
        Logger.warning(`[SubAgent ${this.id}] 发送产出文件失败: ${filePath} - ${err.message}`);
      }
    }
  }
}
