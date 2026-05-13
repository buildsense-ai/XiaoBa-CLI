import { ContentBlock, Message } from '../types';
import * as crypto from 'crypto';
import { ChannelCallbacks } from '../types/tool';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { SessionSkillRuntime } from '../skills/session-skill-runtime';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';
import { ConversationRunner, RunnerCallbacks, PendingUserInputProvider, RunResult } from './conversation-runner';
import { resolveSessionSurface } from './session-surface';
import { TurnContextBuilder } from './turn-context-builder';
import { TurnLogRecorder } from './turn-log-recorder';
import { PlanRuntime } from './plan-runtime';
import { GauzMemClient } from '../utils/gauzmem-client';

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
  workspaceRoot: string;
  getCurrentDirectory: () => string;
  updateCurrentDirectory: (directory: string) => void;
}

/**
 * Runs one user turn: durable input -> transient context -> model/tool loop -> state/log sync.
 */
export class AgentTurnController {
  constructor(private readonly options: AgentTurnControllerOptions) {}

  async run(params: RunAgentTurnParams): Promise<RunAgentTurnResult> {
    params.messages.push({
      role: 'user',
      content: params.input,
      ...(params.runtimeObservationSource && {
        __runtimeObservation: true,
        runtimeObservationSource: params.runtimeObservationSource,
      }),
    });

    const turnContext = await this.options.turnContextBuilder.build({
      sessionKey: this.options.sessionKey,
      sessionType: this.options.sessionType,
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

    this.options.turnLogRecorder.recordTurn({
      userInput: params.input,
      result,
      tokens: { prompt: metrics.totalPromptTokens, completion: metrics.totalCompletionTokens },
      runtimeFeedback: turnContext.runtimeFeedbackForLog,
      runtimeObservationSource: params.runtimeObservationSource,
    });
    await this.recordGauzMemTurnMetadata({
      input: params.input,
      result,
      runIds: uniqueStrings([
        ...turnContext.gauzMemRunIds,
        ...(result.gauzMemRunIds || []),
      ]),
      passiveRuns: turnContext.gauzMemPassiveRuns,
    });

    return {
      text: result.finalResponseVisible ? (result.response || '[无回复]') : '',
      visibleToUser: result.finalResponseVisible,
      newMessages: result.newMessages,
      messages: nextMessages,
    };
  }

  private async recordGauzMemTurnMetadata(input: {
    input: string | ContentBlock[];
    result: RunResult;
    runIds: string[];
    passiveRuns: Array<Record<string, unknown>>;
  }): Promise<void> {
    if (input.runIds.length === 0) return;
    const client = new GauzMemClient();
    if (!client.enabled) return;
    try {
      const userText = contentToPlainText(input.input);
      const assistantText = input.result.response || '';
      await client.recordTurnMetadata({
        turnId: `xiaoba_${shortHash(`${this.options.sessionKey}:${Date.now()}:${userText}`)}`,
        sessionId: this.options.sessionKey,
        sessionType: this.options.sessionType,
        userTextHash: shortHash(userText),
        assistantTextHash: shortHash(assistantText),
        gauzmemRunIds: input.runIds,
        metadata: {
          visibleToUser: input.result.finalResponseVisible,
          activeRunCount: input.result.gauzMemRunIds?.length || 0,
          passive: { runs: input.passiveRuns },
          activeSearches: input.result.gauzMemRuns || [],
        },
      });
    } catch {
      // GauzMem turn metadata helps metabolism, but must not block XiaoBa.
    }
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
        toolExecutionContext: {
          sessionId: this.options.sessionKey,
          surface,
          permissionProfile: 'strict',
          workspaceRoot: this.options.workspaceRoot,
          workingDirectory: this.options.getCurrentDirectory(),
          getCurrentDirectory: this.options.getCurrentDirectory,
          updateCurrentDirectory: this.options.updateCurrentDirectory,
          planRuntime: this.options.planRuntime,
          runtimeServices: {
            aiService: this.options.services.aiService,
            skillManager: this.options.services.skillManager,
          },
          abortSignal: options.abortSignal,
          channel: options.channel,
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

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function contentToPlainText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map(block => block.type === 'text' ? block.text : '[image]')
    .join('');
}

function shortHash(text: string): string {
  return crypto.createHash('sha256').update(text || '').digest('hex').slice(0, 16);
}
