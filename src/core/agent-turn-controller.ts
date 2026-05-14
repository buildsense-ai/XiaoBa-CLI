import { ContentBlock, Message } from '../types';
import { ChannelCallbacks } from '../types/tool';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { SessionSkillRuntime } from '../skills/session-skill-runtime';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';
import { ConversationRunner, RunnerCallbacks, PendingUserInputProvider } from './conversation-runner';
import { PlanRuntime } from './plan-runtime';
import { resolveSessionSurface } from './session-surface';
import { TurnContextBuilder } from './turn-context-builder';
import { TurnLogRecorder } from './turn-log-recorder';
import { SubAgentManager } from './sub-agent-manager';

export interface AgentTurnServices {
  aiService: AIService;
  toolManager: ToolManager;
  skillManager: SkillManager;
}

export interface AgentTurnCallbacks {
  onText?: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolStart?: (name: string, toolUseId: string, input: any) => void;
  onToolEnd?: (name: string, toolUseId: string, result: string) => void;
  onToolDisplay?: (name: string, content: string) => void;
  onRetry?: (attempt: number, maxRetries: number) => void;
}

export interface RunAgentTurnParams {
  input: string | ContentBlock[];
  messages: Message[];
  runtimeFeedback: string[];
  runtimeObservationSource?: string;
  callbacks?: AgentTurnCallbacks;
  channel?: ChannelCallbacks;
  pendingUserInputProvider?: PendingUserInputProvider;
  abortSignal?: AbortSignal;
  shouldContinue: () => boolean;
}

export interface RunAgentTurnResult {
  text: string;
  visibleToUser: boolean;
  newMessages: Message[];
  messages: Message[];
}

export interface AgentTurnControllerOptions {
  sessionKey: string;
  sessionType?: string;
  services: AgentTurnServices;
  skillRuntime: SessionSkillRuntime;
  planRuntime: PlanRuntime;
  turnContextBuilder: TurnContextBuilder;
  turnLogRecorder: TurnLogRecorder;
}

/**
 * Runs one user turn: durable input -> transient context -> model/tool loop -> state/log sync.
 */
export class AgentTurnController {
  constructor(private readonly options: AgentTurnControllerOptions) {}

  async run(params: RunAgentTurnParams): Promise<RunAgentTurnResult> {
    const inputMessage: Message = {
      role: 'user',
      content: params.input,
      ...(params.runtimeObservationSource && {
        __runtimeObservation: true,
        runtimeObservationSource: params.runtimeObservationSource,
      }),
    };
    params.messages.push(inputMessage);

    const turnContext = await this.options.turnContextBuilder.build({
      sessionKey: this.options.sessionKey,
      durableMessages: params.messages,
      runtimeFeedback: params.runtimeFeedback,
      skillRuntime: this.options.skillRuntime,
      planRuntime: this.options.planRuntime,
    });

    const runner = this.createRunner({
      channel: params.channel,
      pendingUserInputProvider: params.pendingUserInputProvider,
      abortSignal: params.abortSignal,
      shouldContinue: params.shouldContinue,
    });

    const result = await runner.run(turnContext.messages, this.toRunnerCallbacks(params.callbacks));
    const nextMessages = this.options.turnContextBuilder.removeTransientMessages(result.messages);

    const metrics = Metrics.getSummary();
    this.logMetrics(metrics);

    this.replaceBase64Images(nextMessages);

    const responseText = result.finalResponseVisible
      ? this.appendActiveSubAgentNotice(result.response || '[无回复]', nextMessages)
      : '';

    this.options.turnLogRecorder.recordTurn({
      userInput: params.input,
      runtimeObservationSource: params.runtimeObservationSource,
      result: {
        ...result,
        response: responseText,
        messages: nextMessages,
      },
      tokens: { prompt: metrics.totalPromptTokens, completion: metrics.totalCompletionTokens },
      runtimeFeedback: turnContext.runtimeFeedbackForLog,
    });

    return {
      text: responseText,
      visibleToUser: result.finalResponseVisible,
      newMessages: result.newMessages,
      messages: nextMessages,
    };
  }

  private appendActiveSubAgentNotice(response: string, messages: Message[]): string {
    const activeSubAgents = SubAgentManager.getInstance()
      .listByParent(this.options.sessionKey)
      .filter(subAgent => subAgent.status === 'running' || subAgent.status === 'waiting_for_input');

    if (activeSubAgents.length === 0) return response;

    const labels = activeSubAgents
      .slice(0, 3)
      .map(subAgent => {
        const name = subAgent.displayName || subAgent.id.slice(0, 8);
        return `${name}: ${subAgent.taskDescription}`;
      })
      .join('；');
    const more = activeSubAgents.length > 3 ? `；另有 ${activeSubAgents.length - 3} 个` : '';
    const notice = `\n\n（阶段性回复：后台还有 ${activeSubAgents.length} 个子任务在运行：${labels}${more}。完成后我会再补充。）`;
    const nextResponse = response.trimEnd() + notice;

    const lastAssistant = [...messages].reverse().find(message => (
      message.role === 'assistant'
      && typeof message.content === 'string'
      && message.content.trimEnd() === response.trimEnd()
    ));
    if (lastAssistant && typeof lastAssistant.content === 'string') {
      lastAssistant.content = nextResponse;
    }

    return nextResponse;
  }

  private createRunner(options: {
    channel?: ChannelCallbacks;
    pendingUserInputProvider?: PendingUserInputProvider;
    abortSignal?: AbortSignal;
    shouldContinue: () => boolean;
  }): ConversationRunner {
    const surface = resolveSessionSurface(this.options.sessionKey, this.options.sessionType);
    return new ConversationRunner(
      this.options.services.aiService,
      this.options.services.toolManager,
      {
        shouldContinue: options.shouldContinue,
        pendingUserInputProvider: options.pendingUserInputProvider,
        // AgentSession/ContextWindowManager compacts durable history before the turn.
        // Runner-level compaction can fold transient runtime feedback into summary.
        enableCompression: false,
        compactStaleToolResults: true,
        toolExecutionContext: {
          sessionId: this.options.sessionKey,
          surface,
          permissionProfile: 'strict',
          channel: options.channel,
          abortSignal: options.abortSignal,
          planRuntime: this.options.planRuntime,
          runtimeServices: {
            aiService: this.options.services.aiService,
            skillManager: this.options.services.skillManager,
          },
        },
      },
    );
  }

  private toRunnerCallbacks(callbacks?: AgentTurnCallbacks): RunnerCallbacks {
    return {
      onText: callbacks?.onText,
      onThinking: callbacks?.onThinking,
      onToolStart: callbacks?.onToolStart,
      onToolEnd: callbacks?.onToolEnd,
      onToolDisplay: callbacks?.onToolDisplay,
      onRetry: callbacks?.onRetry,
    };
  }

  private logMetrics(metrics: ReturnType<typeof Metrics.getSummary>): void {
    if (metrics.aiCalls === 0 && metrics.toolCalls === 0) return;
    Logger.info(
      `[Metrics] AI调用: ${metrics.aiCalls}次, `
      + `tokens: ${metrics.totalPromptTokens}+${metrics.totalCompletionTokens}=${metrics.totalTokens}, `
      + `工具调用: ${metrics.toolCalls}次, 工具耗时: ${metrics.toolDurationMs}ms`
    );
  }

  private replaceBase64Images(messages: Message[]): void {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;
      msg.content = msg.content.map(block => {
        if (block.type === 'image' && block.source?.data) {
          const filePath = (block as any).filePath || '未知路径';
          return { type: 'text' as const, text: `[图片: ${filePath}]` };
        }
        return block;
      });
    }
  }
}
