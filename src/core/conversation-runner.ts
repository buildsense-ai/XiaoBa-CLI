import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { ToolCall, ToolExecutor } from '../types/tool';
import { StreamCallbacks } from '../providers/provider';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';
import { ContextCompressor } from './context-compressor';

/**
 * 对话运行回调
 */
export interface RunnerCallbacks {
  /** 流式文本片段 */
  onText?: (text: string) => void;
  /** 工具开始执行 */
  onToolStart?: (name: string) => void;
  /** 工具执行完成 */
  onToolEnd?: (name: string, result: string) => void;
  /** 需要显示工具输出（如 task_planner） */
  onToolDisplay?: (name: string, content: string) => void;
}

/**
 * 对话运行结果
 */
export interface RunResult {
  /** 最终文本回复 */
  response: string;
  /** 完整的消息列表（包含工具调用中间过程） */
  messages: Message[];
  /** 本次 run() 期间新增的 assistant/tool 消息（不含最终纯文本回复） */
  newMessages: Message[];
}

/** ConversationRunner 构造选项 */
export interface RunnerOptions {
  maxTurns?: number;
  maxContextTokens?: number;
  /** false 时用 aiService.chat() 代替 chatStream()（默认 true） */
  stream?: boolean;
  /** 供 agent 检查 stop 状态，返回 false 时提前退出循环 */
  shouldContinue?: () => boolean;
  /** 是否启用上下文压缩（默认 true，agent 用 false） */
  enableCompression?: boolean;
}

/**
 * ConversationRunner - 核心对话循环
 *
 * 封装 "发送消息 → 检查工具调用 → 执行工具 → 回传结果 → 继续推理" 的循环。
 * 依赖 ToolExecutor 抽象，同时支持 ToolManager（主会话）和 AgentToolExecutor（子 agent）。
 */
export class ConversationRunner {
  private maxTurns: number;
  private compressor: ContextCompressor;
  private stream: boolean;
  private shouldContinue?: () => boolean;
  private enableCompression: boolean;

  constructor(
    private aiService: AIService,
    private toolExecutor: ToolExecutor,
    options?: RunnerOptions,
  ) {
    this.maxTurns = options?.maxTurns ?? 150;
    this.stream = options?.stream ?? true;
    this.shouldContinue = options?.shouldContinue;
    this.enableCompression = options?.enableCompression ?? true;
    this.compressor = new ContextCompressor({
      maxContextTokens: options?.maxContextTokens,
    });
  }

  /**
   * 执行对话循环
   * @param messages 当前消息列表（会被原地修改，追加工具调用中间消息）
   * @param callbacks 可选的 UI 回调
   * @returns 最终文本回复和完整消息列表
   */
  async run(messages: Message[], callbacks?: RunnerCallbacks): Promise<RunResult> {
    const tools = this.toolExecutor.getToolDefinitions();
    const newMessages: Message[] = [];
    let turns = 0;

    while (turns++ < this.maxTurns) {
      // shouldContinue 回调检查（供 agent 检查 stop 状态）
      if (this.shouldContinue && !this.shouldContinue()) {
        break;
      }

      // ===== 上下文压缩检查（可选） =====
      if (this.enableCompression && this.compressor.needsCompaction(messages)) {
        const usage = this.compressor.getUsageInfo(messages);
        Logger.info(`上下文使用率 ${usage.usagePercent}%，触发压缩...`);
        const compacted = this.compressor.compact(messages);
        // 原地替换 messages 内容（保持外部引用有效）
        messages.length = 0;
        messages.push(...compacted);
      }

      // 根据 stream 选项选择调用方式
      let response;
      if (this.stream) {
        const streamCallbacks: StreamCallbacks = {
          onText: (text) => callbacks?.onText?.(text),
        };
        response = await this.aiService.chatStream(messages, tools, streamCallbacks);
      } else {
        response = await this.aiService.chat(messages, tools);
      }

      // 记录 AI 调用 metrics
      if (response.usage) {
        Metrics.recordAICall(this.stream ? 'stream' : 'chat', response.usage);
      }

      // 没有工具调用，返回最终回复
      if (!response.toolCalls || response.toolCalls.length === 0) {
        return {
          response: response.content || '',
          messages,
          newMessages
        };
      }

      // 有工具调用 → 追加 assistant 消息
      const assistantMsg: Message = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls
      };
      messages.push(assistantMsg);
      newMessages.push(assistantMsg);

      // 执行每个工具调用
      for (const toolCall of response.toolCalls) {
        callbacks?.onToolStart?.(toolCall.function.name);

        const toolStart = Date.now();
        const result = await this.toolExecutor.executeTool(toolCall, messages);
        Metrics.recordToolCall(toolCall.function.name, Date.now() - toolStart);

        this.handleToolDisplay(toolCall, result.content, callbacks);

        const toolMsg: Message = {
          role: 'tool',
          content: result.content,
          tool_call_id: result.tool_call_id,
          name: result.name
        };
        messages.push(toolMsg);
        newMessages.push(toolMsg);

        callbacks?.onToolEnd?.(toolCall.function.name, result.content);
      }
    }

    Logger.warning(`达到最大工具调用轮次 (${this.maxTurns})`);
    return {
      response: '[达到最大工具调用轮次，请继续对话]',
      messages,
      newMessages
    };
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
}
