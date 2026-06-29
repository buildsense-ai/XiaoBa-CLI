import { ContentBlock, Message } from '../types';
import { randomUUID } from 'crypto';
import type {
  ExecutionScope,
  ScopedDeviceGrant,
  ScopedDeviceSelection,
  ScopedLocalDeviceGrant,
  ScopedLocalFileGrant,
  SessionRoute,
} from '../types/session-identity';
import {
  ChannelCallbacks,
  DeviceRpcTransport,
  TargetRoutes,
  ThinToolRpcTransport,
  ToolExecutionConfirmationRequest,
  ToolExecutionConfirmationResult,
} from '../types/tool';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { SessionSkillRuntime } from '../skills/session-skill-runtime';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';
import { ConversationRunner, RunnerCallbacks, PendingUserInputProvider } from './conversation-runner';
import { resolveSessionSurface } from './session-surface';
import { TurnContextBuilder } from './turn-context-builder';
import { TurnLogRecorder } from './turn-log-recorder';
import { PlanRuntime } from './plan-runtime';
import { getPetService } from '../pet/pet-service';
import {
  buildSyntheticObservationLifecycleEvent,
  describeSyntheticObservationForLog,
  InMemorySyntheticObservationQueue,
  SyntheticObservation,
  SyntheticObservationQueue,
  SyntheticObservationTiming,
  withSyntheticObservationTiming,
} from './synthetic-observation';
import { MemorySidecarBranchHandle, startMemorySidecarBranch } from './sidecar-memory-branch';
import { ModeRouterSidecarBranchHandle, startModeRouterSidecarBranch } from './sidecar-mode-router-branch';
import { isBranchAgentsEnabled } from './branch-agent-settings';
import { PromptModeRuntime } from './prompt-mode-runtime';
import { findFixedPromptModeState, listPromptModeDefinitions, FixedPromptModeState } from '../runtime/prompt-modes';

export interface AgentTurnServices {
  aiService: AIService;
  toolManager: ToolManager;
  skillManager: SkillManager;
}

export interface AgentTurnCallbacks {
  onText?: (text: string) => void;
  onAssistantText?: (text: string) => void | Promise<void>;
  onThinking?: (thinking: string) => void;
  onToolStart?: (name: string, toolUseId: string, input: any) => void;
  onToolEnd?: (name: string, toolUseId: string, result: string) => void;
  onToolDisplay?: (name: string, content: string) => void;
  onRetry?: (attempt: number, maxRetries: number) => void;
  confirmToolExecution?: (request: ToolExecutionConfirmationRequest) => Promise<ToolExecutionConfirmationResult>;
}

export interface RunAgentTurnParams {
  input: string | ContentBlock[];
  messages: Message[];
  runtimeFeedback: string[];
  runtimeObservationSource?: string;
  callbacks?: AgentTurnCallbacks;
  channel?: ChannelCallbacks;
  sessionRoute?: SessionRoute;
  executionScope?: ExecutionScope;
  localDeviceGrant?: ScopedLocalDeviceGrant;
  deviceGrants?: ScopedDeviceGrant[];
  deviceSelection?: ScopedDeviceSelection;
  deviceRpc?: DeviceRpcTransport;
  thinToolRpc?: ThinToolRpcTransport;
  targetRoutes?: TargetRoutes;
  localFileGrants?: ScopedLocalFileGrant[];
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

export interface AgentTurnRunError extends Error {
  partialMessages?: Message[];
}

export interface AgentTurnControllerOptions {
  sessionKey: string;
  sessionType?: string;
  sessionRoute?: SessionRoute;
  services: AgentTurnServices;
  skillRuntime: SessionSkillRuntime;
  planRuntime: PlanRuntime;
  turnContextBuilder: TurnContextBuilder;
  turnLogRecorder: TurnLogRecorder;
  workspaceRoot: string;
  getCurrentDirectory: () => string;
  updateCurrentDirectory: (directory: string) => void;
}

interface MemoryBranchSlot {
  queue: InMemorySyntheticObservationQueue;
  handle: MemorySidecarBranchHandle;
  originTurn: number;
  done: boolean;
}

interface ModeRouterBranchSlot {
  queue: InMemorySyntheticObservationQueue;
  handle: ModeRouterSidecarBranchHandle;
  originTurn: number;
  done: boolean;
}

/**
 * Runs one user turn: durable input -> transient context -> model/tool loop -> state/log sync.
 */
export class AgentTurnController {
  private turnSequence = 0;
  private memoryBranchCarryover: MemoryBranchSlot | null = null;
  private modeRouterCarryover: ModeRouterBranchSlot | null = null;
  private promptModeRuntime = new PromptModeRuntime();

  constructor(private readonly options: AgentTurnControllerOptions) {}

  async run(params: RunAgentTurnParams): Promise<RunAgentTurnResult> {
    const turnNumber = ++this.turnSequence;
    const episodeId = this.createEpisodeId(turnNumber);
    const previousCarryoverMemoryBranch = this.memoryBranchCarryover;
    const previousCarryoverModeRouter = this.modeRouterCarryover;
    const branchAgentsEnabled = isBranchAgentsEnabled();
    const carryoverMemoryBranch = branchAgentsEnabled ? previousCarryoverMemoryBranch : null;
    this.memoryBranchCarryover = null;
    this.modeRouterCarryover = null;
    if (!branchAgentsEnabled) {
      this.expireMemoryBranch(previousCarryoverMemoryBranch, 'branch_agents_disabled');
    }

    params.messages.push({
      role: 'user',
      content: params.input,
      __episodeId: episodeId,
      __episodeInputKind: 'root',
      ...(params.runtimeObservationSource && {
        __runtimeObservation: true,
        runtimeObservationSource: params.runtimeObservationSource,
      }),
    });

    this.promptModeRuntime.beginTurn(turnNumber);
    const fixedMode = findFixedPromptModeState(params.messages);
    const promptModeRouterEnabled = this.isPromptModeRouterEnabled(branchAgentsEnabled, fixedMode);
    const carryoverModeRouter = promptModeRouterEnabled ? previousCarryoverModeRouter : null;
    if (!promptModeRouterEnabled) {
      this.promptModeRuntime.clear(fixedMode ? 'fixed_mode_active' : 'prompt_mode_router_disabled');
      this.expireModeRouterBranch(
        previousCarryoverModeRouter,
        fixedMode ? 'fixed_mode_active' : 'prompt_mode_router_disabled',
      );
    }

    const turnContext = await this.options.turnContextBuilder.build({
      sessionKey: this.options.sessionKey,
      sessionType: this.options.sessionType,
      sessionRoute: params.sessionRoute ?? this.options.sessionRoute,
      executionScope: params.executionScope,
      localDeviceGrant: params.localDeviceGrant,
      deviceGrants: params.deviceGrants,
      deviceSelection: params.deviceSelection,
      targetRoutes: params.targetRoutes,
      localFileGrants: params.localFileGrants,
      durableMessages: params.messages,
      runtimeFeedback: params.runtimeFeedback,
      skillRuntime: this.options.skillRuntime,
      planRuntime: this.options.planRuntime,
      promptModeRoutingEnabled: promptModeRouterEnabled,
    });

    const currentMemoryBranch = this.startMemorySidecarIfEnabled({
      turnNumber,
      input: params.input,
      messages: params.messages,
      abortSignal: params.abortSignal,
    });
    const currentModeRouter = this.startModeRouterIfEnabled({
      enabled: promptModeRouterEnabled,
      turnNumber,
      input: params.input,
      messages: params.messages,
      abortSignal: params.abortSignal,
    });

    const runner = this.createRunner({
      channel: params.channel,
      executionScope: params.executionScope,
      localDeviceGrant: params.localDeviceGrant,
      deviceGrants: params.deviceGrants,
      deviceSelection: params.deviceSelection,
      deviceRpc: params.deviceRpc,
      thinToolRpc: params.thinToolRpc,
      targetRoutes: params.targetRoutes,
      localFileGrants: params.localFileGrants,
      executionContext: turnContext.executionContext,
      pendingUserInputProvider: params.pendingUserInputProvider,
      confirmToolExecution: params.callbacks?.confirmToolExecution,
      episodeId,
      syntheticObservationProvider: () => this.drainMemoryObservations(
        carryoverMemoryBranch,
        currentMemoryBranch,
      ),
      runtimeTransientProvider: () => this.buildPromptModeTransientMessages(
        carryoverModeRouter,
        currentModeRouter,
        turnNumber,
        fixedMode,
      ),
      abortSignal: params.abortSignal,
      shouldContinue: params.shouldContinue,
    });

    let result;
    try {
      result = await runner.run(turnContext.messages, this.toRunnerCallbacks(params.callbacks));
      this.markEpisodeMessages(result.newMessages, episodeId);
    } catch (error: any) {
      const partialMessages = this.options.turnContextBuilder.removeTransientMessages(turnContext.messages);
      this.replaceBase64Images(partialMessages);
      if (partialMessages.length > 0) {
        (error as AgentTurnRunError).partialMessages = partialMessages;
      }
      throw error;
    } finally {
      this.expireMemoryBranch(carryoverMemoryBranch, 'carryover_ttl_expired');
      this.expireModeRouterBranch(carryoverModeRouter, 'carryover_ttl_expired');
      if (result && currentMemoryBranch && this.shouldCarryMemoryBranch(currentMemoryBranch)) {
        this.memoryBranchCarryover = currentMemoryBranch;
      } else {
        this.expireMemoryBranch(currentMemoryBranch, result ? 'current_branch_consumed' : 'turn_failed');
      }
      if (result && currentModeRouter && this.shouldCarryModeRouterBranch(currentModeRouter)) {
        this.modeRouterCarryover = currentModeRouter;
      } else {
        this.expireModeRouterBranch(currentModeRouter, result ? 'current_branch_consumed' : 'turn_failed');
      }
    }
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

    if (result.finalResponseVisible) {
      this.recordPetTurnCompletion('message_completed');
      this.recordPetTurnCompletion('task_completed');
    }

    return {
      text: result.finalResponseVisible ? (result.response || '[无回复]') : '',
      visibleToUser: result.finalResponseVisible,
      newMessages: result.newMessages,
      messages: nextMessages,
    };
  }

  private createEpisodeId(turnNumber: number): string {
    return `episode:${turnNumber}:${randomUUID().slice(0, 8)}`;
  }

  private markEpisodeMessages(messages: Message[], episodeId: string): void {
    for (const message of messages) {
      if (message.__episodeId) continue;
      message.__episodeId = episodeId;
    }
  }

  private createRunner(options: {
    channel?: ChannelCallbacks;
    executionScope?: ExecutionScope;
    localDeviceGrant?: ScopedLocalDeviceGrant;
    deviceGrants?: ScopedDeviceGrant[];
    deviceSelection?: ScopedDeviceSelection;
    deviceRpc?: DeviceRpcTransport;
    thinToolRpc?: ThinToolRpcTransport;
    targetRoutes?: TargetRoutes;
    localFileGrants?: ScopedLocalFileGrant[];
    executionContext?: import('./runtime-context-builder').ExecutionContextSnapshot;
    pendingUserInputProvider?: PendingUserInputProvider;
    confirmToolExecution?: AgentTurnCallbacks['confirmToolExecution'];
    episodeId?: string;
    syntheticObservationProvider?: () => SyntheticObservation[];
    runtimeTransientProvider?: () => Message[];
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
        syntheticObservationProvider: options.syntheticObservationProvider,
        runtimeTransientProvider: options.runtimeTransientProvider,
        episodeId: options.episodeId,
        // AgentSession/ContextWindowManager compacts durable history before the turn.
        // Runner-level compaction can fold transient runtime feedback into summary.
        enableCompression: false,
        toolExecutionContext: {
          sessionId: this.options.sessionKey,
          surface,
          permissionProfile: options.confirmToolExecution ? 'strict' : undefined,
          workspaceRoot: this.options.workspaceRoot,
          workingDirectory: this.options.getCurrentDirectory(),
          getCurrentDirectory: this.options.getCurrentDirectory,
          updateCurrentDirectory: this.options.updateCurrentDirectory,
          planRuntime: this.options.planRuntime,
          promptModeRuntime: this.promptModeRuntime,
          runtimeServices: {
            aiService: this.options.services.aiService,
            skillManager: this.options.services.skillManager,
          },
          abortSignal: options.abortSignal,
          channel: options.channel,
          executionScope: options.executionScope,
          localDeviceGrant: options.localDeviceGrant,
          deviceGrants: options.deviceGrants,
          deviceSelection: options.deviceSelection,
          deviceRpc: options.deviceRpc,
          thinToolRpc: options.thinToolRpc,
          targetRoutes: options.targetRoutes,
          executionContext: options.executionContext,
          localFileGrants: options.localFileGrants,
          confirmToolExecution: options.confirmToolExecution,
        },
      },
    );
  }

  private startMemorySidecarIfEnabled(options: {
    turnNumber: number;
    input: string | ContentBlock[];
    messages: Message[];
    abortSignal?: AbortSignal;
  }): MemoryBranchSlot | null {
    if (!isBranchAgentsEnabled()) {
      return null;
    }
    if (process.env.XIAOBA_MEMORY_SIDECAR_ENABLED === 'false') {
      return null;
    }
    if (!(this.options.services.aiService instanceof AIService)) {
      return null;
    }
    const queue = new InMemorySyntheticObservationQueue();
    const slot: MemoryBranchSlot = {
      queue,
      originTurn: options.turnNumber,
      done: false,
      handle: this.createMemorySidecarHandle({
        input: options.input,
        messages: options.messages,
        queue,
        abortSignal: options.abortSignal,
      }),
    };
    slot.handle.done.finally(() => {
      slot.done = true;
    });
    return slot;
  }

  private startModeRouterIfEnabled(options: {
    enabled: boolean;
    turnNumber: number;
    input: string | ContentBlock[];
    messages: Message[];
    abortSignal?: AbortSignal;
  }): ModeRouterBranchSlot | null {
    if (!options.enabled) {
      return null;
    }
    if (!(this.options.services.aiService instanceof AIService)) {
      return null;
    }
    if (listPromptModeDefinitions().length === 0) {
      return null;
    }
    const queue = new InMemorySyntheticObservationQueue();
    const slot: ModeRouterBranchSlot = {
      queue,
      originTurn: options.turnNumber,
      done: false,
      handle: this.createModeRouterHandle({
        input: options.input,
        messages: options.messages,
        queue,
        abortSignal: options.abortSignal,
      }),
    };
    slot.handle.done.finally(() => {
      slot.done = true;
    });
    return slot;
  }

  private drainMemoryObservations(
    carryover: MemoryBranchSlot | null,
    current: MemoryBranchSlot | null,
  ): SyntheticObservation[] {
    return [
      ...this.drainMemoryBranch(carryover, 'late_previous_turn'),
      ...this.drainMemoryBranch(current, 'current_turn'),
    ];
  }

  private drainMemoryBranch(
    slot: MemoryBranchSlot | null,
    timing: SyntheticObservationTiming,
  ): SyntheticObservation[] {
    if (!slot) return [];
    return slot.queue.drain().map(observation =>
      this.withMemoryBranchObservationMetadata(observation, timing, slot.originTurn)
    );
  }

  private shouldCarryMemoryBranch(slot: MemoryBranchSlot): boolean {
    return !slot.done || slot.queue.size() > 0;
  }

  private shouldCarryModeRouterBranch(slot: ModeRouterBranchSlot): boolean {
    return !slot.done || slot.queue.size() > 0;
  }

  private expireMemoryBranch(slot: MemoryBranchSlot | null, reason: string): void {
    if (!slot) return;
    slot.handle.cancel();
    const droppedObservations = slot.queue.cancel()
      .map(observation => this.withMemoryBranchObservationMetadata(
        observation,
        'late_previous_turn',
        slot.originTurn,
      ));
    if (droppedObservations.length > 0) {
      Logger.info(
        `[${this.options.sessionKey}] dropped ${droppedObservations.length} unconsumed synthetic runtime observation(s): `
        + `reason=${reason} origin_turn=${slot.originTurn} `
        + droppedObservations.map(describeSyntheticObservationForLog).join(' | ')
      );
      for (const observation of droppedObservations) {
        Logger.runtimeEvent(
          'INFO',
          `[${this.options.sessionKey}] synthetic_observation_lifecycle dropped id=${observation.id || '(unassigned)'}`,
          buildSyntheticObservationLifecycleEvent(observation, {
            outcome: 'dropped',
            reason,
            originTurn: slot.originTurn,
          }),
        );
      }
    } else if (!slot.done && reason === 'carryover_ttl_expired') {
      Logger.info(
        `[${this.options.sessionKey}] cancelled unfinished memory branch carryover: `
        + `reason=${reason} origin_turn=${slot.originTurn}`
      );
    }
  }

  private expireModeRouterBranch(slot: ModeRouterBranchSlot | null, reason: string): void {
    if (!slot) return;
    slot.handle.cancel();
    const droppedObservations = slot.queue.cancel();
    if (droppedObservations.length > 0) {
      Logger.info(
        `[${this.options.sessionKey}] dropped ${droppedObservations.length} unconsumed prompt mode router observation(s): `
        + `reason=${reason} origin_turn=${slot.originTurn} `
        + droppedObservations.map(describeSyntheticObservationForLog).join(' | ')
      );
      for (const observation of droppedObservations) {
        Logger.runtimeEvent(
          'INFO',
          `[${this.options.sessionKey}] prompt_mode_router_lifecycle dropped id=${observation.id || '(unassigned)'}`,
          buildSyntheticObservationLifecycleEvent(observation, {
            outcome: 'dropped',
            reason,
            originTurn: slot.originTurn,
          }),
        );
      }
    } else if (!slot.done && reason === 'carryover_ttl_expired') {
      Logger.info(
        `[${this.options.sessionKey}] cancelled unfinished prompt mode router carryover: `
        + `reason=${reason} origin_turn=${slot.originTurn}`
      );
    }
  }

  private createMemorySidecarHandle(options: {
    input: string | ContentBlock[];
    messages: Message[];
    queue: SyntheticObservationQueue;
    abortSignal?: AbortSignal;
  }): MemorySidecarBranchHandle {
    return startMemorySidecarBranch({
      sessionKey: this.options.sessionKey,
      input: options.input,
      recentMessages: options.messages,
      workingDirectory: this.options.getCurrentDirectory(),
      aiService: this.options.services.aiService,
      queue: options.queue,
      signal: options.abortSignal,
    });
  }

  private createModeRouterHandle(options: {
    input: string | ContentBlock[];
    messages: Message[];
    queue: SyntheticObservationQueue;
    abortSignal?: AbortSignal;
  }): ModeRouterSidecarBranchHandle {
    return startModeRouterSidecarBranch({
      sessionKey: this.options.sessionKey,
      input: options.input,
      recentMessages: options.messages,
      workingDirectory: this.options.getCurrentDirectory(),
      aiService: this.options.services.aiService,
      queue: options.queue,
      activeMode: this.promptModeRuntime.getActiveMode(),
      signal: options.abortSignal,
    });
  }

  private buildPromptModeTransientMessages(
    carryover: ModeRouterBranchSlot | null,
    current: ModeRouterBranchSlot | null,
    turnNumber: number,
    fixedMode?: FixedPromptModeState,
  ): Message[] {
    if (fixedMode) return [];
    const observations = [
      ...this.drainModeRouterBranch(carryover, 'late_previous_turn'),
      ...this.drainModeRouterBranch(current, 'current_turn'),
    ];
    this.promptModeRuntime.applyRouterObservations(observations, turnNumber);
    const message = this.promptModeRuntime.buildTransientMessage({
      turnNumber,
      fixedMode,
    });
    return message ? [message] : [];
  }

  private drainModeRouterBranch(
    slot: ModeRouterBranchSlot | null,
    timing: SyntheticObservationTiming,
  ): SyntheticObservation[] {
    if (!slot) return [];
    return slot.queue.drain().map(observation =>
      this.withModeRouterObservationMetadata(observation, timing, slot.originTurn)
    );
  }

  private isPromptModeRouterEnabled(
    branchAgentsEnabled: boolean,
    fixedMode?: FixedPromptModeState,
  ): boolean {
    if (fixedMode) return false;
    if (!branchAgentsEnabled) return false;
    if (process.env.XIAOBA_PROMPT_MODE_ROUTER_ENABLED !== 'true') return false;
    if (!(this.options.services.aiService instanceof AIService)) return false;
    if (listPromptModeDefinitions().length === 0) return false;
    return true;
  }

  private withMemoryBranchObservationMetadata(
    observation: SyntheticObservation,
    timing: SyntheticObservationTiming,
    originTurn: number,
  ): SyntheticObservation {
    const timed = withSyntheticObservationTiming(observation, timing);
    return {
      ...timed,
      metadata: {
        ...(timed.metadata || {}),
        originTurn,
      },
    };
  }

  private withModeRouterObservationMetadata(
    observation: SyntheticObservation,
    timing: SyntheticObservationTiming,
    originTurn: number,
  ): SyntheticObservation {
    return {
      ...observation,
      timing,
      metadata: {
        ...(observation.metadata || {}),
        timing,
        originTurn,
      },
    };
  }

  private toRunnerCallbacks(callbacks?: AgentTurnCallbacks): RunnerCallbacks {
    return {
      onText: callbacks?.onText,
      onAssistantText: callbacks?.onAssistantText,
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

  private recordPetTurnCompletion(eventType: 'message_completed' | 'task_completed'): void {
    getPetService().recordEvent({
      event_type: eventType,
      session_id: this.options.sessionKey,
      metadata: {
        surface: resolveSessionSurface(this.options.sessionKey, this.options.sessionType),
      },
    });
  }
}
