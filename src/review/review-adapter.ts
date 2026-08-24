import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { AgentServices, AgentSession } from '../core/agent-session';
import { MessageSessionManager } from '../core/message-session-manager';
import { SubAgentManager } from '../core/sub-agent-manager';
import { AgentRunGoalResolver, createAIServiceGoalDrafter } from '../core/agent-run-goal-resolver';
import { withExclusiveFileLockAsync } from '../core/file-lock';
import { FINDING_REVIEW_GOAL_PROFILE } from '../core/agent-run-goal-profiles';
import type { SubAgentInfo } from '../core/sub-agent-session';
import { createAdapterRuntime } from '../runtime/adapter-runtime';
import type { RuntimeSurface } from '../runtime/runtime-profile';
import { ReviewEnvelopeGateway } from './review-envelope-gateway';
import { ReviewRunStore } from './review-run-store';
import { ReviewRuntimeTool, type ReviewRuntimeToolController } from './review-runtime-tool';
import {
  type ReviewGoalCheck,
  type ReviewHeartbeatResult,
  type ReviewRunEvent,
  type ReviewRunProjection,
  type ReviewRunRecord,
  type ReviewRunStatus,
  type ReviewTaskRecord,
  type ReviewTaskSpec,
} from './review-runtime-types';

interface ReviewSessionHost {
  getOrCreate(sessionKey: string): AgentSession;
  destroy?(): Promise<void>;
}

interface ReviewSubAgentHost {
  registerPlatformCallbacks: SubAgentManager['registerPlatformCallbacks'];
  spawn: SubAgentManager['spawn'];
  getInfo: SubAgentManager['getInfo'];
}

export interface ReviewAdapterOptions {
  workspace: string;
  storePath: string;
  skillDirectory: string;
  workingDirectory: string;
  sessionHost: ReviewSessionHost;
  subAgentHost: ReviewSubAgentHost;
  services: AgentServices;
  goalResolver?: AgentRunGoalResolver;
  now?: () => Date;
  idFactory?: () => string;
}

export interface CreateReviewAdapterOptions {
  workspace: string;
  storePath?: string;
  skillDirectory?: string;
  workingDirectory?: string;
  surface?: RuntimeSurface;
  sessionTTL?: number;
}

export interface TriggerFindingInput {
  findingId: string;
  envelopePath: string;
  goal?: string;
  actor: string;
  wake?: boolean;
}

const TERMINAL_STATUSES = new Set<ReviewRunStatus>(['complete_issue', 'complete_close', 'cancelled']);
const DEFAULT_IDLE_WAKE_DELAY_MS = 24 * 60 * 60 * 1000;
const FAILED_WAKE_RETRY_DELAY_MS = 60 * 60 * 1000;
const UNFINISHED_TASK_STATUSES = new Set<ReviewTaskRecord['status']>([
  'proposed', 'approved', 'running', 'waiting_for_input', 'result_pending_commit', 'interrupted',
]);

export class ReviewAdapter implements ReviewRuntimeToolController {
  readonly store: ReviewRunStore;
  readonly envelopeGateway: ReviewEnvelopeGateway;
  private readonly activeWakes = new Map<string, Promise<ReviewRunRecord>>();
  private readonly activeTriggerCreates = new Map<string, Promise<ReviewRunRecord>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatInFlight: Promise<void> | undefined;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly goalResolver: AgentRunGoalResolver;

  constructor(private readonly options: ReviewAdapterOptions) {
    this.store = new ReviewRunStore(options.storePath);
    this.envelopeGateway = new ReviewEnvelopeGateway({
      workspace: options.workspace,
      skillDirectory: options.skillDirectory,
    });
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.goalResolver = options.goalResolver ?? new AgentRunGoalResolver({ now: this.now });
  }

  static async create(options: CreateReviewAdapterOptions): Promise<ReviewAdapter> {
    const workingDirectory = path.resolve(options.workingDirectory || process.cwd());
    const workspace = path.resolve(options.workspace);
    const skillDirectory = path.resolve(options.skillDirectory
      || path.join(workingDirectory, 'skills', 'build-evidence-envelope-review'));
    const runtime = createAdapterRuntime({
      surface: options.surface ?? 'agent',
      sessionTTL: options.sessionTTL ?? 24 * 60 * 60 * 1000,
      workingDirectory,
      promptSnapshotMode: 'mutable-identity',
      skillLoadMode: 'fail-fast',
    });
    const sessionHost = new MessageSessionManager(
      runtime.services,
      'review',
      runtime.sessionManagerOptions,
    );
    const adapter = new ReviewAdapter({
      workspace,
      storePath: path.resolve(options.storePath || path.join(workspace, 'review-runs.json')),
      skillDirectory,
      workingDirectory,
      sessionHost,
      subAgentHost: SubAgentManager.getInstance(),
      services: runtime.services,
      goalResolver: new AgentRunGoalResolver({
        drafter: createAIServiceGoalDrafter(runtime.services.aiService),
      }),
    });
    runtime.services.toolManager.registerTool(new ReviewRuntimeTool(adapter));
    await runtime.loadSkills();
    return adapter;
  }

  async triggerFinding(input: TriggerFindingInput): Promise<ReviewRunRecord> {
    const findingId = requireText(input.findingId, 'findingId');
    const envelopePath = this.envelopeGateway.resolveEnvelopePath(input.envelopePath);
    const snapshot = this.envelopeGateway.readSnapshot(envelopePath);
    if (snapshot.findingId !== findingId) {
      throw new Error(`Envelope belongs to ${snapshot.findingId}, not ${findingId}`);
    }
    const run = await this.getOrCreateFindingRun(input, findingId, envelopePath);
    if (path.resolve(run.envelopePath) !== envelopePath) {
      throw new Error(`Finding ${findingId} is already bound to a different Envelope`);
    }
    this.bindSession(run);
    if (input.wake !== false && !TERMINAL_STATUSES.has(run.status)) {
      return this.wakeRun(run.runId, 'manual_trigger', input.actor);
    }
    return this.requireRun(run.runId);
  }

  private async getOrCreateFindingRun(
    input: TriggerFindingInput,
    findingId: string,
    envelopePath: string,
  ): Promise<ReviewRunRecord> {
    const inFlight = this.activeTriggerCreates.get(findingId);
    if (inFlight) return inFlight;
    const lockHash = createHash('sha256').update(`finding\0${findingId}`).digest('hex');
    const operation = withExclusiveFileLockAsync(
      `${this.options.storePath}.trigger-${lockHash}.lock`,
      async () => {
        this.store.refresh();
        return this.createFindingRun(input, findingId, envelopePath);
      },
    );
    this.activeTriggerCreates.set(findingId, operation);
    try {
      return await operation;
    } finally {
      if (this.activeTriggerCreates.get(findingId) === operation) {
        this.activeTriggerCreates.delete(findingId);
      }
    }
  }

  private async createFindingRun(
    input: TriggerFindingInput,
    findingId: string,
    envelopePath: string,
  ): Promise<ReviewRunRecord> {
    let run = this.store.findByFindingId(findingId);
    if (!run) {
      const snapshot = this.envelopeGateway.readSnapshot(envelopePath);
      const now = this.timestamp();
      const runId = `review-${findingId}-${this.idFactory()}`;
      const goalResolution = await this.goalResolver.resolve({
        triggerSource: 'finding',
        triggerId: findingId,
        triggerSummary: `Review Finding ${findingId}`,
        triggerFacts: { findingId, reviewState: snapshot.reviewState },
        profile: FINDING_REVIEW_GOAL_PROFILE,
        explicitGoal: input.goal,
      });
      // No await follows this check. The per-Finding flight prevents duplicate
      // draft work in this adapter while preserving an existing persisted Run.
      run = this.store.findByFindingId(findingId);
      if (!run) {
        run = this.store.create({
          runId,
          findingId,
          sessionKey: `review:${findingId}`,
          goal: goalResolution.goal,
          goalResolution: {
            source: goalResolution.source,
            profileId: goalResolution.profileId,
            runType: goalResolution.runType,
            completionCriteria: goalResolution.completionCriteria,
            generatedAt: goalResolution.generatedAt,
            ...(goalResolution.generator ? { generator: goalResolution.generator } : {}),
            ...(goalResolution.fallbackReason ? { fallbackReason: goalResolution.fallbackReason } : {}),
          },
          envelopePath,
          status: statusForReviewState(snapshot.reviewState),
          reviewState: snapshot.reviewState,
          createdAt: now,
          updatedAt: now,
          tasks: {},
          events: [{
            eventId: this.idFactory(), runId, findingId, type: 'run_created', at: now,
            actor: input.actor,
            summary: `Review Run created for ${findingId}; Initial Goal resolved by ${goalResolution.source} using ${goalResolution.profileId}`,
          }],
        });
      }
    }
    return this.requireRun(run.runId);
  }

  startHeartbeat(intervalMs = 60_000, actor = 'review-heartbeat'): void {
    if (!Number.isFinite(intervalMs) || intervalMs < 1_000) {
      throw new Error('Review heartbeat interval must be at least 1000ms');
    }
    if (this.heartbeatTimer) return;
    const pulse = () => {
      if (this.heartbeatInFlight) return this.heartbeatInFlight;
      const inFlight = this.heartbeat(actor)
        .then(() => undefined)
        .catch(() => {
          // A failed pulse must not terminate the long-running heartbeat loop.
        })
        .finally(() => {
          if (this.heartbeatInFlight === inFlight) this.heartbeatInFlight = undefined;
        });
      this.heartbeatInFlight = inFlight;
      return inFlight;
    };
    void pulse();
    this.heartbeatTimer = setInterval(() => void pulse(), intervalMs);
  }

  stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  async heartbeat(actor = 'review-heartbeat'): Promise<ReviewHeartbeatResult> {
    const result: ReviewHeartbeatResult = { discovered: [], woken: [], skipped: [] };
    for (const envelopePath of this.envelopeGateway.listFindingEnvelopes()) {
      let snapshot;
      try {
        snapshot = this.envelopeGateway.readSnapshot(envelopePath);
      } catch (error: any) {
        result.skipped.push({ findingId: path.basename(envelopePath), reason: String(error?.message || error) });
        continue;
      }
      let run = this.store.findByFindingId(snapshot.findingId);
      if (!run) {
        run = await this.triggerFinding({
          findingId: snapshot.findingId,
          envelopePath,
          actor,
          wake: false,
        });
        result.discovered.push(snapshot.findingId);
      }
      await this.recoverRun(run.runId, actor);
      run = this.requireRun(run.runId);
      const reason = this.wakeEligibility(run);
      if (reason !== 'eligible') {
        result.skipped.push({ findingId: run.findingId, reason });
        continue;
      }
      await this.wakeRun(run.runId, 'heartbeat', actor);
      result.woken.push(run.findingId);
    }
    return result;
  }

  async wakeRun(runId: string, reason: string, actor: string): Promise<ReviewRunRecord> {
    const existing = this.activeWakes.get(runId);
    if (existing) return existing;
    const operation = this.wakeRunSingleFlight(runId, reason, actor);
    this.activeWakes.set(runId, operation);
    try {
      return await operation;
    } finally {
      if (this.activeWakes.get(runId) === operation) this.activeWakes.delete(runId);
    }
  }

  private async wakeRunSingleFlight(runId: string, reason: string, actor: string): Promise<ReviewRunRecord> {
    const lockHash = createHash('sha256').update(`review_wake\0${runId}`).digest('hex');
    return withExclusiveFileLockAsync(
      `${this.options.storePath}.wake-${lockHash}.lock`,
      async ({ contended }) => {
        this.store.refresh();
        const current = this.requireRun(runId);
        // Only a caller that actually waited behind another wake is a duplicate.
        // Goal Checks, task reconciliation, and other Run updates must not make
        // an otherwise uncontended wake disappear.
        if (contended) return current;
        return this.performWakeRun(runId, reason, actor);
      },
    );
  }

  private async performWakeRun(runId: string, reason: string, actor: string): Promise<ReviewRunRecord> {
    try {
      await this.recoverRun(runId, actor);
      let run = this.requireRun(runId);
      if (TERMINAL_STATUSES.has(run.status)) return run;
      const eligibility = this.wakeEligibility(run);
      if (eligibility !== 'eligible' && reason !== 'manual_trigger') return run;

      const priorGoalCheck = run.lastGoalCheck?.checkedAt;
      run = this.store.update(runId, mutable => {
        mutable.status = 'active';
        mutable.blocker = undefined;
        mutable.lastWakeAt = this.timestamp();
        mutable.wakeReason = reason;
        this.appendEvent(mutable, 'run_woken', actor, `Run woken: ${reason}`);
      });
      const session = this.bindSession(run);
      await session.handleRuntimeObservation(this.buildWakeMessage(run), {
        source: 'review_trigger',
        suppressFinalResponse: true,
      });
      const after = this.requireRun(runId);
      if (after.lastGoalCheck?.checkedAt === priorGoalCheck && !TERMINAL_STATUSES.has(after.status)) {
        return this.store.update(runId, mutable => {
          mutable.status = 'blocked';
          mutable.blocker = 'goal_check_missing';
          mutable.nextWakeAt = new Date(this.now().getTime() + FAILED_WAKE_RETRY_DELAY_MS).toISOString();
          this.appendEvent(mutable, 'run_blocked', 'review-adapter', 'Reviewer turn ended without a persisted Goal Check');
        });
      }
      return after;
    } catch (error: any) {
      return this.store.update(runId, mutable => {
        mutable.status = 'blocked';
        mutable.blocker = `wake_failed: ${String(error?.message || error).slice(0, 400)}`;
        mutable.nextWakeAt = new Date(this.now().getTime() + FAILED_WAKE_RETRY_DELAY_MS).toISOString();
        this.appendEvent(mutable, 'run_blocked', 'review-adapter', 'Review wake failed');
      });
    }
  }

  async proposeTask(runId: string, sessionKey: string | undefined, spec: ReviewTaskSpec): Promise<ReviewTaskRecord> {
    this.assertSession(runId, sessionKey);
    validateTaskSpec(spec);
    const idempotencyKey = spec.idempotencyKey?.trim() || deriveTaskIdempotencyKey(spec);
    const taskId = `task-${this.idFactory()}`;
    let selectedTaskId = taskId;
    this.store.update(runId, run => {
      const duplicate = Object.values(run.tasks).find(task => task.idempotencyKey === idempotencyKey);
      if (duplicate) {
        selectedTaskId = duplicate.taskId;
        return;
      }
      if (TERMINAL_STATUSES.has(run.status)) throw new Error('Cannot add a Task to a terminal Review Run');
      const created: ReviewTaskRecord = {
        ...spec,
        idempotencyKey,
        allowedTools: spec.allowedTools ? [...spec.allowedTools] : undefined,
        taskId,
        runId,
        status: 'proposed',
        proposedAt: this.timestamp(),
        proposedBy: sessionKey || 'reviewer',
      };
      run.tasks[taskId] = created;
      run.status = 'awaiting_approval';
      this.appendEvent(run, 'task_proposed', created.proposedBy, created.title, taskId);
    });
    if (selectedTaskId !== taskId) return this.requireTask(runId, selectedTaskId);
    if (!spec.approvalRequired && spec.risk === 'low') {
      await this.approveTask(runId, taskId, 'review-policy', 'Auto-approved low-risk Task');
    }
    return this.requireTask(runId, taskId);
  }

  async approveTask(runId: string, taskId: string, actor: string, note?: string): Promise<ReviewTaskRecord> {
    this.store.update(runId, run => {
      const task = requireTask(run, taskId);
      if (task.status !== 'proposed' && task.status !== 'interrupted') {
        throw new Error(`Task ${taskId} cannot be approved from ${task.status}`);
      }
      const wasInterrupted = task.status === 'interrupted';
      task.status = 'approved';
      task.approvedAt = this.timestamp();
      task.approvedBy = requireText(actor, 'actor');
      task.approvalNote = note?.trim();
      task.recoveryNote = wasInterrupted ? note?.trim() : task.recoveryNote;
      this.appendEvent(run, 'task_approved', actor, note?.trim() || 'Task approved', taskId);
    });
    return this.dispatchTask(runId, taskId);
  }

  rejectTask(runId: string, taskId: string, actor: string, note: string): ReviewTaskRecord {
    this.store.update(runId, run => {
      const task = requireTask(run, taskId);
      if (task.status !== 'proposed' && task.status !== 'interrupted') {
        throw new Error(`Task ${taskId} cannot be rejected from ${task.status}`);
      }
      task.status = 'cancelled';
      task.failureReason = requireText(note, 'note');
      task.finishedAt = this.timestamp();
      this.appendEvent(run, 'task_rejected', actor, note, taskId);
      run.status = this.deriveRunStatus(run);
    });
    return this.requireTask(runId, taskId);
  }

  /**
   * Accept a human's natural-language reply in the stable Review Session.
   *
   * This is intentionally deterministic rather than model-decided: an Agent
   * must never turn its own prose into approval. Platform and CLI adapters may
   * call this only for an authenticated human message already routed to the
   * exact `review:<findingId>` Session.
   */
  async handleHumanSessionReply(sessionKey: string, message: string, actor: string): Promise<ReviewTaskRecord> {
    const run = this.store.list().find(item => item.sessionKey === sessionKey);
    if (!run) throw new Error(`Unknown Review Session: ${sessionKey}`);
    const approval = parseHumanApprovalReply(run, requireText(message, 'message'));
    const human = requireText(actor, 'actor');
    if (approval.decision === 'approve') {
      return this.approveTask(run.runId, approval.taskId, human, approval.note);
    }
    return this.rejectTask(run.runId, approval.taskId, human, requireText(approval.note, 'rejection reason'));
  }

  async recordGoalCheck(runId: string, sessionKey: string | undefined, check: ReviewGoalCheck): Promise<ReviewRunRecord> {
    this.assertSession(runId, sessionKey);
    if (!check.summary.trim()) throw new Error('Goal Check summary is required');
    if (!check.complete && !check.nextAction && !check.blocker) {
      throw new Error('Incomplete Goal Check needs nextAction or blocker');
    }
    if (!check.complete && !check.stopCondition) {
      throw new Error('Incomplete Goal Check needs a stopCondition');
    }
    if (check.nextWakeAt && !Number.isFinite(Date.parse(check.nextWakeAt))) {
      throw new Error('Goal Check nextWakeAt must be an ISO-8601 timestamp');
    }
    const current = this.requireRun(runId);
    const snapshot = this.envelopeGateway.readSnapshot(current.envelopePath);
    if (check.complete && snapshot.reviewState === 'INCOMPLETE') {
      throw new Error('Goal cannot be complete while the Envelope is INCOMPLETE');
    }
    if (check.complete && Object.values(current.tasks).some(task => UNFINISHED_TASK_STATUSES.has(task.status))) {
      throw new Error('Goal cannot be complete while Review Tasks are unfinished');
    }
    const checkedAt = this.timestamp();
    const hasUnfinishedTask = Object.values(current.tasks).some(task => UNFINISHED_TASK_STATUSES.has(task.status));
    const nextWakeAt = check.complete
      ? undefined
      : check.nextWakeAt
        ? new Date(check.nextWakeAt).toISOString()
        : hasUnfinishedTask
          ? undefined
          : new Date(Date.parse(checkedAt) + DEFAULT_IDLE_WAKE_DELAY_MS).toISOString();
    return this.store.update(runId, run => {
      run.lastGoalCheck = { ...check, checkedAt, nextWakeAt };
      run.nextWakeAt = nextWakeAt;
      run.reviewState = snapshot.reviewState;
      run.status = check.complete ? statusForReviewState(snapshot.reviewState) : this.deriveRunStatus(run, check.blocker);
      run.blocker = check.blocker;
      this.appendEvent(run, 'goal_checked', sessionKey || 'reviewer', check.summary);
      if (TERMINAL_STATUSES.has(run.status)) {
        this.appendEvent(run, 'run_decided', sessionKey || 'reviewer', snapshot.reviewState);
      }
    });
  }

  async commitTask(
    runId: string,
    sessionKey: string | undefined,
    taskId: string,
    evidenceIds: string[],
  ): Promise<ReviewTaskRecord> {
    this.assertSession(runId, sessionKey);
    const before = this.requireRun(runId);
    const task = requireTask(before, taskId);
    if (task.status !== 'result_pending_commit') {
      throw new Error(`Task ${taskId} cannot be committed from ${task.status}`);
    }
    const validation = this.envelopeGateway.validate(before.envelopePath, before.findingId);
    const otherUnfinished = Object.values(before.tasks)
      .filter(item => item.taskId !== taskId && UNFINISHED_TASK_STATUSES.has(item.status));
    if (validation.snapshot.reviewState !== 'INCOMPLETE' && otherUnfinished.length > 0) {
      throw new Error('Terminal Envelope cannot be committed while other Tasks are unfinished');
    }
    this.envelopeGateway.sync(before.findingId);
    this.store.update(runId, run => {
      const mutableTask = requireTask(run, taskId);
      mutableTask.status = 'committed';
      mutableTask.committedAt = this.timestamp();
      mutableTask.committedEvidenceIds = [...new Set(evidenceIds.map(value => value.trim()).filter(Boolean))];
      run.reviewState = validation.snapshot.reviewState;
      run.status = statusForReviewState(validation.snapshot.reviewState);
      run.blocker = undefined;
      this.appendEvent(run, 'task_committed', sessionKey || 'reviewer', `Task committed; ${validation.snapshot.reviewState}`, taskId);
      if (TERMINAL_STATUSES.has(run.status)) {
        this.appendEvent(run, 'run_decided', sessionKey || 'reviewer', validation.snapshot.reviewState);
      }
    });
    return this.requireTask(runId, taskId);
  }

  async recoverAll(actor = 'review-recovery'): Promise<ReviewRunRecord[]> {
    const recovered: ReviewRunRecord[] = [];
    for (const run of this.store.list()) {
      if (TERMINAL_STATUSES.has(run.status)) continue;
      recovered.push(await this.recoverRun(run.runId, actor));
    }
    return recovered;
  }

  async recoverRun(runId: string, actor = 'review-recovery'): Promise<ReviewRunRecord> {
    let changed = false;
    const run = this.store.update(runId, mutable => {
      for (const task of Object.values(mutable.tasks)) {
        if (!task.subAgentId || (task.status !== 'running' && task.status !== 'waiting_for_input')) continue;
        const info = this.options.subAgentHost.getInfo(task.subAgentId);
        if (!info) {
          task.status = 'interrupted';
          task.recoveryNote = 'Runtime restarted or lost the in-memory SubAgent; explicit re-approval is required before retry.';
          mutable.status = 'awaiting_approval';
          this.appendEvent(mutable, 'task_interrupted', actor, task.recoveryNote, task.taskId);
          changed = true;
        } else {
          changed = this.applySubAgentInfo(mutable, task, info, actor) || changed;
        }
      }
      if (changed) mutable.status = this.deriveRunStatus(mutable);
    });
    return run;
  }

  getProjection(runId: string): ReviewRunProjection {
    const run = this.requireRun(runId);
    const taskCounts: ReviewRunProjection['taskCounts'] = {};
    const tasks = Object.values(run.tasks)
      .sort((a, b) => a.proposedAt.localeCompare(b.proposedAt))
      .map(task => {
        taskCounts[task.status] = (taskCounts[task.status] || 0) + 1;
        return {
          taskId: task.taskId,
          status: task.status,
          risk: task.risk,
          approvalRequired: task.approvalRequired,
          proposedAt: task.proposedAt,
          approvedAt: task.approvedAt,
          startedAt: task.startedAt,
          finishedAt: task.finishedAt,
          committedAt: task.committedAt,
          errorCode: task.status === 'failed'
            ? 'TASK_FAILED' as const
            : task.status === 'interrupted'
              ? 'TASK_INTERRUPTED' as const
              : undefined,
        };
      });
    return {
      runId: run.runId,
      findingId: run.findingId,
      status: run.status,
      reviewState: run.reviewState,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      lastWakeAt: run.lastWakeAt,
      nextWakeAt: run.nextWakeAt,
      blockerCode: run.blocker === 'goal_check_missing'
        ? 'GOAL_CHECK_MISSING'
        : run.blocker
          ? 'RUN_BLOCKED'
          : undefined,
      goalCheck: run.lastGoalCheck ? {
        checkedAt: run.lastGoalCheck.checkedAt,
        complete: run.lastGoalCheck.complete,
        capabilitiesExhausted: run.lastGoalCheck.capabilitiesExhausted,
        hasNextAction: Boolean(run.lastGoalCheck.nextAction),
        hasBlocker: Boolean(run.lastGoalCheck.blocker),
        hasStopCondition: Boolean(run.lastGoalCheck.stopCondition),
      } : undefined,
      taskCounts,
      tasks,
      recentEvents: run.events.slice(-20).map(event => ({
        eventId: event.eventId,
        type: event.type,
        at: event.at,
        taskId: event.taskId,
      })),
    };
  }

  async destroy(): Promise<void> {
    this.stopHeartbeat();
    await this.heartbeatInFlight;
    await this.options.sessionHost.destroy?.();
  }

  private async dispatchTask(runId: string, taskId: string): Promise<ReviewTaskRecord> {
    let run = this.requireRun(runId);
    let task = requireTask(run, taskId);
    if (task.status !== 'approved') throw new Error(`Task ${taskId} is not approved`);
    this.bindSession(run);
    let spawned: Awaited<ReturnType<ReviewSubAgentHost['spawn']>>;
    try {
      spawned = await this.options.subAgentHost.spawn(
        run.sessionKey,
        {
          skillName: task.skillName,
          agentType: task.agentType || 'worker',
          toolScope: task.toolScope || 'read_only',
          allowedTools: task.allowedTools,
          maxTurns: task.maxTurns,
          taskDescription: task.title,
          userMessage: this.buildTaskMessage(run, task),
          subAgentPrompt: [
            'You are executing one evidence-acquisition Task for a Finding review.',
            'Stay inside the stated safety boundary. Preserve provenance and evidence limits.',
            'Do not edit the authoritative Evidence Envelope; return candidate artifacts and a concise result summary to the parent Reviewer.',
          ].join(' '),
        },
        this.options.workingDirectory,
        this.options.services.aiService,
        this.options.services.skillManager,
      );
    } catch (error: any) {
      this.markDispatchInterrupted(runId, taskId, String(error?.message || error));
      return this.requireTask(runId, taskId);
    }
    if ('error' in spawned) {
      this.markDispatchInterrupted(runId, taskId, spawned.error);
      return this.requireTask(runId, taskId);
    }
    this.store.update(runId, mutable => {
      const mutableTask = requireTask(mutable, taskId);
      mutableTask.status = spawned.status === 'waiting_for_input' ? 'waiting_for_input' : 'running';
      mutableTask.subAgentId = spawned.id;
      mutableTask.startedAt = this.timestamp();
      mutable.status = mutableTask.status === 'waiting_for_input' ? 'waiting_for_input' : 'active';
      this.appendEvent(mutable, 'task_dispatched', 'review-adapter', `Dispatched to ${spawned.id}`, taskId);
    });
    return this.requireTask(runId, taskId);
  }

  private markDispatchInterrupted(runId: string, taskId: string, reason: string): void {
    this.store.update(runId, mutable => {
      const task = requireTask(mutable, taskId);
      task.status = 'interrupted';
      task.recoveryNote = 'SubAgent dispatch did not start; explicit approval is required before retry.';
      task.failureReason = reason.slice(0, 800);
      mutable.status = 'awaiting_approval';
      this.appendEvent(mutable, 'task_interrupted', 'review-adapter', task.recoveryNote, taskId);
    });
  }

  private bindSession(run: ReviewRunRecord): AgentSession {
    const session = this.options.sessionHost.getOrCreate(run.sessionKey);
    this.options.subAgentHost.registerPlatformCallbacks(run.sessionKey, {
      injectMessage: async text => {
        await this.recoverRun(run.runId, 'subagent-result');
        const current = this.requireRun(run.runId);
        if (TERMINAL_STATUSES.has(current.status)) return;
        const priorGoalCheck = current.lastGoalCheck?.checkedAt;
        await session.handleRuntimeObservation([
          '[Review SubAgent Result]',
          `Run ID: ${run.runId}`,
          `Finding ID: ${run.findingId}`,
          text,
        ].join('\n'), {
          source: 'review_subagent_result',
          suppressFinalResponse: true,
        });
        const after = this.requireRun(run.runId);
        if (after.lastGoalCheck?.checkedAt === priorGoalCheck && !TERMINAL_STATUSES.has(after.status)) {
          this.store.update(run.runId, mutable => {
            mutable.status = 'blocked';
            mutable.blocker = 'goal_check_missing';
            this.appendEvent(mutable, 'run_blocked', 'review-adapter', 'Result turn ended without a persisted Goal Check');
          });
        }
      },
      onSubAgentEvent: (_event, info) => {
        if (!info) return;
        this.reconcileSubAgentInfo(run.runId, info);
      },
    });
    return session;
  }

  private reconcileSubAgentInfo(runId: string, info: SubAgentInfo): void {
    const run = this.store.get(runId);
    if (!run) return;
    const target = Object.values(run.tasks).find(task => task.subAgentId === info.id);
    if (!target) return;
    this.store.update(runId, mutable => {
      const task = requireTask(mutable, target.taskId);
      if (this.applySubAgentInfo(mutable, task, info, 'subagent-event')) {
        mutable.status = this.deriveRunStatus(mutable);
      }
    });
  }

  private applySubAgentInfo(
    run: ReviewRunRecord,
    task: ReviewTaskRecord,
    info: SubAgentInfo,
    actor: string,
  ): boolean {
    if (info.status === 'running' && task.status === 'running') return false;
    if (info.status === 'waiting_for_input') {
      if (task.status === 'waiting_for_input') return false;
      task.status = 'waiting_for_input';
      return true;
    }
    if (info.status === 'completed') {
      if (task.status === 'result_pending_commit' || task.status === 'committed') return false;
      task.status = 'result_pending_commit';
      task.finishedAt = info.completedAt ? new Date(info.completedAt).toISOString() : this.timestamp();
      task.resultSummary = info.resultSummary;
      task.outputFiles = [...info.outputFiles];
      this.appendEvent(run, 'task_result_ready', actor, 'SubAgent result awaits Envelope commit', task.taskId);
      return true;
    }
    if (info.status === 'failed') {
      if (task.status === 'failed') return false;
      task.status = 'failed';
      task.finishedAt = info.completedAt ? new Date(info.completedAt).toISOString() : this.timestamp();
      task.failureReason = info.resultSummary || 'SubAgent failed';
      this.appendEvent(run, 'task_failed', actor, task.failureReason, task.taskId);
      return true;
    }
    if (info.status === 'stopped') {
      if (task.status === 'interrupted') return false;
      task.status = 'interrupted';
      task.finishedAt = info.completedAt ? new Date(info.completedAt).toISOString() : this.timestamp();
      task.recoveryNote = 'SubAgent stopped; explicit approval is required before retry.';
      this.appendEvent(run, 'task_interrupted', actor, task.recoveryNote, task.taskId);
      return true;
    }
    return false;
  }

  private wakeEligibility(run: ReviewRunRecord): string {
    if (TERMINAL_STATUSES.has(run.status)) return 'terminal';
    if (Object.values(run.tasks).some(task => task.status === 'running')) return 'task_running';
    if (Object.values(run.tasks).some(task => task.status === 'waiting_for_input')) return 'waiting_for_input';
    if (Object.values(run.tasks).some(task => task.status === 'proposed' || task.status === 'interrupted')) return 'awaiting_approval';
    if (run.nextWakeAt && Date.parse(run.nextWakeAt) > this.now().getTime()) return 'not_due';
    return 'eligible';
  }

  private deriveRunStatus(run: ReviewRunRecord, blocker?: string): ReviewRunStatus {
    if (run.reviewState === 'COMPLETE_ISSUE') return 'complete_issue';
    if (run.reviewState === 'COMPLETE_CLOSE') return 'complete_close';
    const tasks = Object.values(run.tasks);
    if (tasks.some(task => task.status === 'proposed' || task.status === 'interrupted')) return 'awaiting_approval';
    if (tasks.some(task => task.status === 'waiting_for_input')) return 'waiting_for_input';
    if (blocker) return 'blocked';
    return 'active';
  }

  private assertSession(runId: string, sessionKey: string | undefined): void {
    const run = this.requireRun(runId);
    if (!sessionKey || sessionKey !== run.sessionKey) {
      throw new Error(`Review Run ${runId} is bound to Session ${run.sessionKey}`);
    }
  }

  private requireRun(runId: string): ReviewRunRecord {
    const run = this.store.get(runId);
    if (!run) throw new Error(`Unknown Review Run: ${runId}`);
    return run;
  }

  private requireTask(runId: string, taskId: string): ReviewTaskRecord {
    return requireTask(this.requireRun(runId), taskId);
  }

  private appendEvent(
    run: ReviewRunRecord,
    type: ReviewRunEvent['type'],
    actor: string,
    summary: string,
    taskId?: string,
  ): void {
    run.events.push({
      eventId: this.idFactory(),
      runId: run.runId,
      findingId: run.findingId,
      type,
      at: this.timestamp(),
      actor,
      summary: summary.slice(0, 800),
      taskId,
    });
    if (run.events.length > 500) run.events.splice(0, run.events.length - 500);
  }

  private buildWakeMessage(run: ReviewRunRecord): string {
    const taskSummary = Object.values(run.tasks).map(task => `${task.taskId}: ${task.status} — ${task.title}`).join('\n') || 'none';
    return [
      '[Review Runtime Wake]',
      `Run ID: ${run.runId}`,
      `Finding ID: ${run.findingId}`,
      `Goal: ${run.goal}`,
      run.goalResolution
        ? `Goal completion contract:\n${run.goalResolution.completionCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')}`
        : '',
      `Evidence Envelope: ${run.envelopePath}`,
      `Current reviewState: ${run.reviewState}`,
      'Load and follow build-evidence-envelope-review. Re-read the authoritative Envelope before deciding the next action.',
      'Choose the next action dynamically by evidence value; do not follow a fixed pipeline.',
      'Use review_runtime propose_task for specialist work. High-risk or approval-required Tasks must stop for human approval.',
      'Before this turn ends, always call review_runtime goal_check. If no Task remains active, set next_wake_at to the earliest justified retry; otherwise the Runtime defaults to a 24-hour idle backoff. A terminal claim is accepted only when the validated Envelope is COMPLETE_ISSUE or COMPLETE_CLOSE.',
      `Tasks:\n${taskSummary}`,
    ].join('\n');
  }

  private buildTaskMessage(run: ReviewRunRecord, task: ReviewTaskRecord): string {
    return [
      `Finding: ${run.findingId}`,
      `Review Goal: ${run.goal}`,
      `Task: ${task.title}`,
      `Objective: ${task.objective}`,
      `Expected artifact: ${task.expectedArtifact}`,
      `Safety boundary: ${task.safetyBoundary}`,
      `Stop condition: ${task.stopCondition}`,
      `Envelope context is read-only for this specialist: ${run.envelopePath}`,
      'Return provenance, limitations, output file paths, and a concise result. Do not claim the final Finding decision.',
    ].join('\n');
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

export async function createReviewAdapter(options: CreateReviewAdapterOptions): Promise<ReviewAdapter> {
  return ReviewAdapter.create(options);
}

function requireTask(run: ReviewRunRecord, taskId: string): ReviewTaskRecord {
  const task = run.tasks[taskId];
  if (!task) throw new Error(`Unknown Review Task: ${taskId}`);
  return task;
}

function parseHumanApprovalReply(
  run: ReviewRunRecord,
  message: string,
): { decision: 'approve' | 'reject'; taskId: string; note?: string } {
  const pending = Object.values(run.tasks)
    .filter(task => task.status === 'proposed' || task.status === 'interrupted');
  if (pending.length === 0) throw new Error('This Review Session has no Task awaiting approval');

  const normalized = message.trim();
  const decisionMatch = normalized.match(/^(批准|同意|approve|拒绝|驳回|reject)(?:\s+|[：:，,])?/i);
  if (!decisionMatch) {
    throw new Error('Reply must start with 批准/同意 or 拒绝/驳回');
  }
  const decision = /^(批准|同意|approve)$/i.test(decisionMatch[1]) ? 'approve' as const : 'reject' as const;
  let remainder = normalized.slice(decisionMatch[0].length).trim();
  let task = pending.find(candidate => remainder === candidate.taskId
    || remainder.startsWith(`${candidate.taskId} `)
    || remainder.startsWith(`${candidate.taskId}：`)
    || remainder.startsWith(`${candidate.taskId}:`));
  if (!task) {
    if (pending.length !== 1) throw new Error('Multiple Tasks await approval; include the exact Task ID');
    task = pending[0];
  } else {
    remainder = remainder.slice(task.taskId.length).replace(/^[\s：:,，]+/, '').trim();
  }
  const note = remainder || undefined;
  if (decision === 'reject' && !note) throw new Error('A rejection must include a reason');
  return { decision, taskId: task.taskId, note };
}

function requireText(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function validateTaskSpec(spec: ReviewTaskSpec): void {
  requireText(spec.title, 'title');
  requireText(spec.objective, 'objective');
  requireText(spec.expectedArtifact, 'expectedArtifact');
  requireText(spec.stopCondition, 'stopCondition');
  requireText(spec.safetyBoundary, 'safetyBoundary');
  if (!['low', 'medium', 'high'].includes(spec.risk)) throw new Error('Invalid Task risk');
  if (spec.risk !== 'low' && !spec.approvalRequired) {
    throw new Error('Medium/high-risk Tasks require human approval');
  }
}

function statusForReviewState(state: ReviewRunRecord['reviewState']): ReviewRunStatus {
  if (state === 'COMPLETE_ISSUE') return 'complete_issue';
  if (state === 'COMPLETE_CLOSE') return 'complete_close';
  return 'active';
}

function deriveTaskIdempotencyKey(spec: ReviewTaskSpec): string {
  const basis = [
    spec.title,
    spec.objective,
    spec.expectedArtifact,
    spec.stopCondition,
    spec.safetyBoundary,
    spec.risk,
    spec.agentType || 'worker',
    spec.skillName || '',
    spec.toolScope || 'read_only',
  ].map(value => value.trim().toLowerCase()).join('\n');
  return `task:${createHash('sha256').update(basis).digest('hex')}`;
}
