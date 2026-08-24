import type { SubAgentToolScope, SubAgentType } from '../core/sub-agent-session';
import type { AgentRunGoalResolution } from '../core/agent-run-types';

export const REVIEW_RUN_STORE_SCHEMA_VERSION = 1 as const;

export type ReviewDecisionState = 'INCOMPLETE' | 'COMPLETE_ISSUE' | 'COMPLETE_CLOSE';
export type ReviewRunStatus =
  | 'active'
  | 'awaiting_approval'
  | 'waiting_for_input'
  | 'blocked'
  | 'complete_issue'
  | 'complete_close'
  | 'cancelled';
export type ReviewTaskStatus =
  | 'proposed'
  | 'approved'
  | 'running'
  | 'waiting_for_input'
  | 'result_pending_commit'
  | 'committed'
  | 'interrupted'
  | 'failed'
  | 'cancelled';
export type ReviewTaskRisk = 'low' | 'medium' | 'high';
export type ReviewEventType =
  | 'run_created'
  | 'run_woken'
  | 'goal_checked'
  | 'task_proposed'
  | 'task_approved'
  | 'task_rejected'
  | 'task_dispatched'
  | 'task_result_ready'
  | 'task_committed'
  | 'task_interrupted'
  | 'task_failed'
  | 'run_blocked'
  | 'run_decided';

export interface ReviewGoalCheck {
  checkedAt: string;
  complete: boolean;
  capabilitiesExhausted: boolean;
  summary: string;
  nextAction?: string;
  blocker?: string;
  stopCondition?: string;
  nextWakeAt?: string;
}

export interface ReviewTaskSpec {
  title: string;
  objective: string;
  expectedArtifact: string;
  stopCondition: string;
  safetyBoundary: string;
  risk: ReviewTaskRisk;
  approvalRequired: boolean;
  agentType?: SubAgentType;
  skillName?: string;
  toolScope?: SubAgentToolScope;
  allowedTools?: string[];
  maxTurns?: number;
  idempotencyKey?: string;
}

export interface ReviewTaskRecord extends ReviewTaskSpec {
  taskId: string;
  runId: string;
  status: ReviewTaskStatus;
  proposedAt: string;
  proposedBy: string;
  approvedAt?: string;
  approvedBy?: string;
  approvalNote?: string;
  subAgentId?: string;
  startedAt?: string;
  finishedAt?: string;
  resultSummary?: string;
  outputFiles?: string[];
  committedAt?: string;
  committedEvidenceIds?: string[];
  failureReason?: string;
  recoveryNote?: string;
}

export interface ReviewRunEvent {
  eventId: string;
  runId: string;
  findingId: string;
  type: ReviewEventType;
  at: string;
  actor: string;
  summary: string;
  taskId?: string;
}

export interface ReviewRunRecord {
  runId: string;
  findingId: string;
  sessionKey: string;
  goal: string;
  goalResolution?: AgentRunGoalResolution;
  envelopePath: string;
  status: ReviewRunStatus;
  reviewState: ReviewDecisionState;
  createdAt: string;
  updatedAt: string;
  lastWakeAt?: string;
  nextWakeAt?: string;
  wakeReason?: string;
  lastGoalCheck?: ReviewGoalCheck;
  blocker?: string;
  tasks: Record<string, ReviewTaskRecord>;
  events: ReviewRunEvent[];
}

export interface ReviewRunStoreState {
  schemaVersion: typeof REVIEW_RUN_STORE_SCHEMA_VERSION;
  runs: Record<string, ReviewRunRecord>;
  findingToRun: Record<string, string>;
  stateCorrupt?: boolean;
}

export interface ReviewRunProjection {
  runId: string;
  findingId: string;
  status: ReviewRunStatus;
  reviewState: ReviewDecisionState;
  createdAt: string;
  updatedAt: string;
  lastWakeAt?: string;
  nextWakeAt?: string;
  blockerCode?: 'GOAL_CHECK_MISSING' | 'RUN_BLOCKED';
  goalCheck?: Pick<ReviewGoalCheck, 'checkedAt' | 'complete' | 'capabilitiesExhausted'> & {
    hasNextAction: boolean;
    hasBlocker: boolean;
    hasStopCondition: boolean;
  };
  taskCounts: Partial<Record<ReviewTaskStatus, number>>;
  tasks: Array<Pick<ReviewTaskRecord,
    'taskId' | 'status' | 'risk' | 'approvalRequired' | 'proposedAt' |
    'approvedAt' | 'startedAt' | 'finishedAt' | 'committedAt'
  > & { errorCode?: 'TASK_FAILED' | 'TASK_INTERRUPTED' }> ;
  recentEvents: Array<Pick<ReviewRunEvent, 'eventId' | 'type' | 'at' | 'taskId'>>;
}

export interface ReviewHeartbeatResult {
  discovered: string[];
  woken: string[];
  skipped: Array<{ findingId: string; reason: string }>;
}
