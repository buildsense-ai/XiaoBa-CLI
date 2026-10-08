import { ContentBlock, Message } from '../types';
import { randomUUID } from 'crypto';
import type {
  ExecutionScope,
  ScopedDeviceGrant,
  ScopedDeviceSelection,
  ScopedLocalDeviceGrant,
  ScopedLocalFileGrant,
  SessionRoute,
  SkillConnectorGrant,
} from '../types/session-identity';
import {
  ChannelCallbacks,
  DeviceRpcTransport,
  TargetRoutes,
  ThinToolRpcTransport,
  ToolExecutionConfirmationRequest,
  ToolExecutionConfirmationResult,
} from '../types/tool';
import type { StreamRetryInfo } from '../providers/provider';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { SessionSkillRuntime } from '../skills/session-skill-runtime';
import {
  TurnSkillSnapshotLease,
  TurnSkillSnapshotStore,
} from '../skills/turn-skill-snapshot';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';
import { ConversationRunner, RunnerCallbacks, PendingUserInputProvider } from './conversation-runner';
import { resolveSessionSurface } from './session-surface';
import { TurnContextBuilder } from './turn-context-builder';
import { TurnLogRecorder } from './turn-log-recorder';
import { PlanRuntime } from './plan-runtime';
import {
  BranchCitationReport,
  collectAssistantCitationText,
  collectBranchCitationUsage,
  matchBranchCitations,
} from './branch-citation-reporter';
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
import type { CatsLogMemoryBackend } from '../utils/catslog-memory-provider';
import type { CheckpointCompactionCoordinator } from './checkpoint-compaction';
import type { MemoryBranchBudget } from './branch-budget';

const EMPTY_FINAL_RESPONSE_MESSAGE = '模型本轮未返回有效内容。请重新发送上一条消息；若仍失败，请切换模型或稍后再试。';

/** Injection-timing telemetry caps: bounded event payloads, ids only. */
const MAX_INJECTION_TIMING_IDS = 64;

type InjectionFirstActionKind = 'tool_call' | 'text';

/**
 * Per-turn injection-timeline telemetry (bounded, fire-and-forget). Records
 * when drained memory observations are consumed at the runner injection seam
 * (`injection_consumed`) and when the parent agent's first action completes
 * (`injection_first_action_ms`) — the earliest of the first assistant
 * tool_call dispatch and the final assistant text when no tool dispatch
 * happened. Payloads carry ids, counts and ms only — never message text,
 * refs or raw content. Turn↔observation correlation stays via the branch
 * session id already present in observation metadata.
 */
class TurnInjectionTiming {
  private consumedCount = 0;
  private firstActionMs?: number;
  private firstActionKind?: InjectionFirstActionKind;
  private emittedFirstAction = false;

  constructor(private readonly context: {
    sessionKey: string;
    turnNumber: number;
    turnStartedAt: number;
  }) {}

  /** Called once per drain batch that the runner actually injects. */
  recordConsumed(observations: readonly SyntheticObservation[]): void {
    this.consumedCount += observations.length;
    try {
      const observationIds: string[] = [];
      const branchIds = new Set<string>();
      const originTurns = new Set<number>();
      let carryoverCount = 0;
      for (const observation of observations) {
        if (observationIds.length < MAX_INJECTION_TIMING_IDS) {
          observationIds.push(String(observation.id || '').trim() || '(unassigned)');
        }
        const metadata = observation.metadata || {};
        if (typeof metadata.branchId === 'string' && metadata.branchId) branchIds.add(metadata.branchId);
        if (typeof metadata.originTurn === 'number') originTurns.add(metadata.originTurn);
        if (observation.timing === 'late_previous_turn' || metadata.timing === 'late_previous_turn') {
          carryoverCount += 1;
        }
      }
      Logger.runtimeEvent('INFO', `[${this.context.sessionKey}] injection_consumed count=${observations.length}`, {
        type: 'injection_consumed',
        payload: {
          session_key: this.context.sessionKey,
          turn: this.context.turnNumber,
          count: observations.length,
          observation_ids: observationIds,
          branch_ids: [...branchIds].slice(0, MAX_INJECTION_TIMING_IDS),
          origin_turns: [...originTurns].slice(0, MAX_INJECTION_TIMING_IDS),
          carryover: carryoverCount > 0,
          carryover_count: carryoverCount,
          since_turn_start_ms: Date.now() - this.context.turnStartedAt,
        },
      });
    } catch {
      // Fire-and-forget: telemetry must never break a turn.
    }
    this.tryEmitFirstAction();
  }

  /**
   * First action of the turn. The earliest call wins: tool dispatch is
   * recorded from the runner's onToolStart seam; the final assistant text is
   * recorded after the runner resolves (text counts only when no tool
   * dispatch happened, since text preceding tool calls is tool-prelude).
   */
  recordFirstAction(kind: InjectionFirstActionKind): void {
    if (this.firstActionMs !== undefined) return;
    this.firstActionMs = Date.now() - this.context.turnStartedAt;
    this.firstActionKind = kind;
    this.tryEmitFirstAction();
  }

  /** Emits once, when both a consumed injection and a first action exist. */
  private tryEmitFirstAction(): void {
    if (this.emittedFirstAction || this.firstActionMs === undefined) return;
    if (this.consumedCount === 0) return; // No consumed injection — nothing to correlate.
    this.emittedFirstAction = true;
    try {
      Logger.runtimeEvent('INFO', `[${this.context.sessionKey}] injection_first_action kind=${this.firstActionKind} ms=${this.firstActionMs}`, {
        type: 'injection_first_action_ms',
        payload: {
          session_key: this.context.sessionKey,
          turn: this.context.turnNumber,
          kind: this.firstActionKind,
          first_action_ms: this.firstActionMs,
          consumed_count: this.consumedCount,
        },
      });
    } catch {
      // Fire-and-forget: telemetry must never break a turn.
    }
  }
}

export interface AgentTurnServices {
  aiService: AIService;
  memoryBranch?: {
    enabled: boolean;
    modelSource: 'inherit' | 'catalog' | 'custom';
    aiService: AIService;
    budget?: MemoryBranchBudget;
  };
  /** Device-bound CatsLog read capability, scoped to the memory branch. */
  catslogMemory?: CatsLogMemoryBackend;
  toolManager: ToolManager;
  skillManager: SkillManager;
  turnSkillSnapshotStore?: TurnSkillSnapshotStore;
}

export interface AgentTurnCallbacks {
  onText?: (text: string) => void;
  onAssistantText?: (text: string) => void | Promise<void>;
  onThinking?: (thinking: string) => void;
  onToolStart?: (name: string, toolUseId: string, input: any) => void;
  onToolEnd?: (name: string, toolUseId: string, result: string) => void;
  onToolDisplay?: (name: string, content: string) => void;
  onRetry?: (attempt: number, maxRetries: number, info?: StreamRetryInfo) => void | Promise<void>;
  confirmToolExecution?: (request: ToolExecutionConfirmationRequest) => Promise<ToolExecutionConfirmationResult>;
}

export interface RunAgentTurnParams {
  input: string | ContentBlock[];
  messages: Message[];
  runtimeFeedback: string[];
  runtimeObservationSource?: string;
  suppressFinalResponse?: boolean;
  callbacks?: AgentTurnCallbacks;
  channel?: ChannelCallbacks;
  sessionRoute?: SessionRoute;
  executionScope?: ExecutionScope;
  artifactContextRef?: string;
  artifactTaskRef?: string;
  skillConnectorGrants?: SkillConnectorGrant[];
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
  maxPromptTokens?: number;
  checkpointCompactionCoordinator?: CheckpointCompactionCoordinator;
  persistCheckpoint?: (messages: Message[]) => void | Promise<void>;
}

interface MemoryBranchSlot {
  queue: InMemorySyntheticObservationQueue;
  handle: MemorySidecarBranchHandle;
  originTurn: number;
  done: boolean;
}

/**
 * Runs one user turn: durable input -> transient context -> model/tool loop -> state/log sync.
 */
export class AgentTurnController {
  private turnSequence = 0;
  private memoryBranchCarryover: MemoryBranchSlot | null = null;

  constructor(private readonly options: AgentTurnControllerOptions) {}

  async run(params: RunAgentTurnParams): Promise<RunAgentTurnResult> {
    const turnNumber = ++this.turnSequence;
    const turnStartedAt = Date.now();
    const injectionTiming = new TurnInjectionTiming({
      sessionKey: this.options.sessionKey,
      turnNumber,
      turnStartedAt,
    });
    const episodeId = this.createEpisodeId(turnNumber);
    const previousCarryoverMemoryBranch = this.memoryBranchCarryover;
    const branchAgentsEnabled = this.isMemoryBranchEnabled();
    const carryoverMemoryBranch = branchAgentsEnabled ? previousCarryoverMemoryBranch : null;
    this.memoryBranchCarryover = null;
    if (!branchAgentsEnabled) {
      this.expireMemoryBranch(previousCarryoverMemoryBranch, 'branch_agents_disabled');
    }

    const turnSkills = await this.prepareTurnSkills();
    try {
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
        skillRuntime: turnSkills.skillRuntime,
        planRuntime: this.options.planRuntime,
      });

      const currentMemoryBranch = this.startMemorySidecarIfEnabled({
        turnNumber,
        input: params.input,
        messages: params.messages,
        abortSignal: params.abortSignal,
      });

      // Observations drained here are injected synchronously by the runner
      // right after the provider call, so this list is exactly the set of
      // delivery:context payloads this turn consumed (injection seam).
      const consumedObservations: SyntheticObservation[] = [];

      const runner = this.createRunner({
        channel: params.channel,
        executionScope: params.executionScope,
        artifactContextRef: params.artifactContextRef,
        artifactTaskRef: params.artifactTaskRef,
        skillConnectorGrants: params.skillConnectorGrants,
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
        syntheticObservationProvider: () => {
          const drained = this.drainMemoryObservations(
            carryoverMemoryBranch,
            currentMemoryBranch,
          );
          if (drained.length > 0) {
            consumedObservations.push(...drained);
            injectionTiming.recordConsumed(drained);
          }
          return drained;
        },
        abortSignal: params.abortSignal,
        suppressFinalResponse: params.suppressFinalResponse,
        shouldContinue: params.shouldContinue,
        skillManager: turnSkills.skillManager,
        turnSkillSnapshot: turnSkills.snapshotLease,
      });

      let result;
      try {
        result = await runner.run(turnContext.messages, this.toRunnerCallbacks(params.callbacks, injectionTiming));
        this.markEpisodeMessages(result.newMessages, episodeId);
        // Text-only first action: the runner resolves when the final
        // assistant text is complete. When any tool dispatched earlier, the
        // tool dispatch already won as the turn's first action and this call
        // is a no-op.
        if (result.response && result.response.trim().length > 0) {
          injectionTiming.recordFirstAction('text');
        }
        // The reply for this turn is final: report which injected refs it
        // actually cited. Match against the whole assistant output of the
        // turn (final text + interim assistant text + tool_call arguments),
        // not just the visible reply — e.g. reading a KB document by path is
        // a citation even when the reply never prints the ref literally.
        // Fire-and-forget — telemetry must never break a turn.
        this.dispatchBranchCitationTelemetry(consumedObservations, result.newMessages, result.response);
      } catch (error: any) {
        const partialMessages = this.options.turnContextBuilder.removeTransientMessages(turnContext.messages);
        this.replaceBase64Images(partialMessages);
        if (partialMessages.length > 0) {
          (error as AgentTurnRunError).partialMessages = partialMessages;
        }
        throw error;
      } finally {
        this.expireMemoryBranch(carryoverMemoryBranch, 'carryover_ttl_expired');
        if (result && currentMemoryBranch && this.shouldCarryMemoryBranch(currentMemoryBranch)) {
          this.memoryBranchCarryover = currentMemoryBranch;
        } else {
          this.expireMemoryBranch(currentMemoryBranch, result ? 'current_branch_consumed' : 'turn_failed');
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

      const finalResponseVisible = result.finalResponseVisible && params.suppressFinalResponse !== true;
      if (result.finalResponseVisible && params.suppressFinalResponse === true) {
        Logger.info(`[${this.options.sessionKey}] runtime observation final response suppressed: ${params.runtimeObservationSource || 'unknown'}`);
      }

      if (finalResponseVisible) {
        this.recordPetTurnCompletion('message_completed');
        this.recordPetTurnCompletion('task_completed');
      }

      return {
        text: finalResponseVisible ? (result.response || EMPTY_FINAL_RESPONSE_MESSAGE) : '',
        visibleToUser: finalResponseVisible,
        newMessages: result.newMessages,
        messages: nextMessages,
      };
    } finally {
      if (turnSkills.snapshotLease) {
        try {
          await turnSkills.snapshotLease.release();
        } catch (error: any) {
          Logger.warning(`[${this.options.sessionKey}] Turn Skill 快照租约释放失败: ${error.message}`);
        }
      }
    }
  }

  private async prepareTurnSkills(): Promise<{
    skillManager: SkillManager;
    skillRuntime: SessionSkillRuntime;
    snapshotLease?: TurnSkillSnapshotLease;
  }> {
    const store = this.options.services.turnSkillSnapshotStore;
    if (!store) {
      return {
        skillManager: this.options.services.skillManager,
        skillRuntime: this.options.skillRuntime,
      };
    }

    let snapshotLease: TurnSkillSnapshotLease | undefined;
    try {
      snapshotLease = await store.acquire();
      const skillManager = new SkillManager(snapshotLease.snapshot.rootPath);
      await skillManager.loadSkills();
      Logger.info(
        `[${this.options.sessionKey}] Turn Skill 快照已绑定: ${snapshotLease.snapshot.revision.slice(0, 12)}`,
      );
      return {
        skillManager,
        skillRuntime: new SessionSkillRuntime(skillManager, this.options.sessionKey),
        snapshotLease,
      };
    } catch (error: any) {
      if (snapshotLease) {
        try {
          await snapshotLease.release();
        } catch (releaseError: any) {
          Logger.warning(`[${this.options.sessionKey}] 无效 Turn Skill 快照租约释放失败: ${releaseError.message}`);
        }
      }
      // Preserve all existing runtime capabilities if snapshot preparation is
      // unavailable. Successful snapshot turns remain revision-stable; this
      // exceptional path deliberately matches the pre-snapshot behaviour.
      Logger.warning(`[${this.options.sessionKey}] Turn Skill 快照准备失败，继续使用兼容路径: ${error.message}`);
      return {
        skillManager: this.options.services.skillManager,
        skillRuntime: this.options.skillRuntime,
      };
    }
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
    artifactContextRef?: string;
    artifactTaskRef?: string;
    skillConnectorGrants?: SkillConnectorGrant[];
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
    abortSignal?: AbortSignal;
    suppressFinalResponse?: boolean;
    shouldContinue: () => boolean;
    skillManager: SkillManager;
    turnSkillSnapshot?: TurnSkillSnapshotLease;
  }): ConversationRunner {
    const surface = resolveSessionSurface(this.options.sessionKey, this.options.sessionType);
    return new ConversationRunner(
      this.options.services.aiService,
      this.options.services.toolManager,
      {
        shouldContinue: options.shouldContinue,
        pendingUserInputProvider: options.pendingUserInputProvider,
        syntheticObservationProvider: options.syntheticObservationProvider,
        episodeId: options.episodeId,
        maxContextTokens: this.options.maxPromptTokens,
        checkpointCompactionCoordinator: this.options.checkpointCompactionCoordinator,
        onCompactionCheckpoint: this.options.persistCheckpoint,
        suppressFinalResponse: options.suppressFinalResponse,
        toolExecutionContext: {
          sessionId: this.options.sessionKey,
          surface,
          permissionProfile: options.confirmToolExecution ? 'strict' : undefined,
          workspaceRoot: this.options.workspaceRoot,
          workingDirectory: this.options.getCurrentDirectory(),
          getCurrentDirectory: this.options.getCurrentDirectory,
          updateCurrentDirectory: this.options.updateCurrentDirectory,
          planRuntime: this.options.planRuntime,
          runtimeServices: {
            aiService: this.options.services.aiService,
            skillManager: options.skillManager,
          },
          turnSkillSnapshot: options.turnSkillSnapshot,
          abortSignal: options.abortSignal,
          channel: options.channel,
          executionScope: options.executionScope,
          artifactContextRef: options.artifactContextRef,
          artifactTaskRef: options.artifactTaskRef,
          skillConnectorGrants: options.skillConnectorGrants,
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
    if (!this.isMemoryBranchEnabled()) {
      return null;
    }
    const memoryBranchAiService = this.options.services.memoryBranch?.aiService ?? this.options.services.aiService;
    if (!(memoryBranchAiService instanceof AIService) || !memoryBranchAiService.isToolCallingSupported()) {
      // Fail closed, visibly: assess_memory_need / finish_memory_search are
      // the branch's only tool surfaces, so a model without tool calling
      // must not start the branch. The warn names the modelSource so the
      // misconfiguration (override or inherited primary) is fixable in the
      // Dashboard instead of silently producing "memory never runs".
      Logger.warning(
        `[${this.options.sessionKey}] memory branch skipped: branch model cannot do tool calling`
        + ` (modelSource=${this.options.services.memoryBranch?.modelSource ?? 'inherit'})`,
      );
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
      aiService: this.options.services.memoryBranch?.aiService ?? this.options.services.aiService,
      queue: options.queue,
      signal: options.abortSignal,
      catslogMemory: this.options.services.catslogMemory,
      ...this.options.services.memoryBranch?.budget,
    });
  }

  private isMemoryBranchEnabled(): boolean {
    return this.options.services.memoryBranch?.enabled ?? true;
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

  private static readonly BRANCH_CITATIONS_TIMEOUT_MS = 5_000;

  /**
   * Downstream citation reporting (ADR 0019 telemetry): substring-match the
   * turn's final reply against the injected ref strings, then POST the cited
   * server pool refs per /branch request_id. 404/unreachable/capability
   * errors degrade silently; KB-cited documents are recorded locally only,
   * since the server column accepts ref_-prefixed pool refs exclusively.
   *
   * Additionally, every turn that consumed injections emits a sanitized
   * local-only `branch_citation_usage` runtime event (per-lane injected vs
   * cited counts, request ids, carryover flag) so lane-level usefulness can
   * be measured offline for session/knowledge refs that can never be
   * reported to the server. No content, no ref strings.
   */
  private dispatchBranchCitationTelemetry(
    consumedObservations: readonly SyntheticObservation[],
    newMessages: readonly Message[] | undefined,
    replyText: string | undefined,
  ): void {
    try {
      const corpus = collectAssistantCitationText(newMessages, replyText);
      const { reports, knowledgeRefs } = matchBranchCitations(consumedObservations, corpus);
      for (const report of reports) {
        void this.reportBranchCitations(report);
      }
      if (knowledgeRefs.length > 0) {
        Logger.runtimeEvent(
          'INFO',
          `[${this.options.sessionKey}] branch injection cited ${knowledgeRefs.length} local knowledge document(s)`,
          {
            type: 'branch_knowledge_citations',
            payload: {
              refs: knowledgeRefs,
            },
          },
        );
      }
      const usage = collectBranchCitationUsage(consumedObservations, corpus);
      if (usage) {
        const injectedTotal = usage.injectedByLane.remote_pool + usage.injectedByLane.session + usage.injectedByLane.knowledge;
        const citedTotal = usage.citedByLane.remote_pool + usage.citedByLane.session + usage.citedByLane.knowledge;
        Logger.runtimeEvent(
          'INFO',
          `[${this.options.sessionKey}] branch citation usage: injected ${injectedTotal}, cited ${citedTotal}, carryover=${usage.carryover}`,
          {
            type: 'branch_citation_usage',
            payload: {
              requestIds: usage.requestIds,
              injectedByLane: usage.injectedByLane,
              citedByLane: usage.citedByLane,
              carryover: usage.carryover,
            },
          },
        );
      }
    } catch {
      // Telemetry must never break a turn.
    }
  }

  private async reportBranchCitations(report: BranchCitationReport): Promise<void> {
    const backend = this.options.services.catslogMemory;
    if (!backend?.reportBranchCitations) return;
    try {
      await backend.reportBranchCitations(
        { requestId: report.requestId, refs: report.refs },
        AbortSignal.timeout(AgentTurnController.BRANCH_CITATIONS_TIMEOUT_MS),
      );
      Logger.runtimeEvent(
        'INFO',
        `[${this.options.sessionKey}] branch citations reported: ${report.refs.length} ref(s)`,
        {
          type: 'branch_citations_reported',
          payload: {
            request_id: report.requestId,
            refs: report.refs.length,
          },
        },
      );
    } catch {
      // Degrade silently: the endpoint may not be shipped yet (404), the
      // device may be offline, or the capability may have expired.
    }
  }

  private toRunnerCallbacks(callbacks?: AgentTurnCallbacks, injectionTiming?: TurnInjectionTiming): RunnerCallbacks {
    const wrapped: RunnerCallbacks = {
      onText: callbacks?.onText,
      onAssistantText: callbacks?.onAssistantText,
      onThinking: callbacks?.onThinking,
      onToolStart: callbacks?.onToolStart,
      onToolEnd: callbacks?.onToolEnd,
      onToolDisplay: callbacks?.onToolDisplay,
      onRetry: callbacks?.onRetry,
    };
    if (injectionTiming) {
      const innerToolStart = wrapped.onToolStart;
      wrapped.onToolStart = (name, toolUseId, input) => {
        // First assistant tool_call dispatched counts as the turn's first
        // action. Assistant text preceding tool calls is tool-prelude and
        // deliberately not counted as a first action here.
        injectionTiming.recordFirstAction('tool_call');
        innerToolStart?.(name, toolUseId, input);
      };
    }
    return wrapped;
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
