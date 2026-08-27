export type AgentRunStatus =
  | 'queued'
  | 'active'
  | 'waiting_for_input'
  | 'blocked'
  | 'completed'
  | 'cancelled';

export interface AgentRunTriggerRef {
  source: string;
  id: string;
  idempotencyKey?: string;
  actor?: string;
  summary?: string;
}

export interface AgentRunGoalResolution {
  source: 'explicit' | 'ai_generated' | 'profile_fallback';
  profileId: string;
  runType: string;
  completionCriteria: string[];
  generatedAt: string;
  generator?: string;
  fallbackReason?: string;
}

export interface AgentRunGoalCheck {
  checkedAt: string;
  complete: boolean;
  capabilitiesExhausted: boolean;
  summary: string;
  nextAction?: string;
  blocker?: string;
  stopCondition?: string;
  nextWakeAt?: string;
}

export interface AgentRunEvent {
  eventId?: string;
  type: string;
  summary: string;
  createdAt: string;
}

export interface AgentRunArtifactRef {
  artifactId: string;
  kind: string;
  label: string;
  ref: string;
  createdAt: string;
}

export interface AgentRunSubjectRef {
  kind: string;
  id: string;
  ref?: string;
  label?: string;
}

export interface AgentRunRecord {
  runId: string;
  runType: string;
  triggerRef: AgentRunTriggerRef;
  sessionKey: string;
  initialGoal: string;
  /** Immutable audit metadata describing how initialGoal was paired with the Trigger. */
  goalResolution?: AgentRunGoalResolution;
  status: AgentRunStatus;
  parentRunId?: string;
  branchPurpose?: string;
  createdAt: string;
  updatedAt: string;
  lastWakeAt?: string;
  nextWakeAt?: string;
  blocker?: string;
  lastGoalCheck?: AgentRunGoalCheck;
  events: AgentRunEvent[];
  artifacts: AgentRunArtifactRef[];
  subjects: AgentRunSubjectRef[];
}

export interface AgentRunGoalCheckProjection {
  checkedAt: string;
  complete: boolean;
  capabilitiesExhausted: boolean;
  hasNextAction: boolean;
  hasBlocker: boolean;
  hasStopCondition: boolean;
}

export interface AgentRunEventProjection {
  eventId?: string;
  type: string;
  summary: string;
  createdAt: string;
}

export interface AgentRunArtifactProjection {
  artifactId: string;
  kind: string;
  label: string;
  createdAt: string;
}

export interface AgentRunSubjectProjection {
  kind: string;
  id: string;
  label?: string;
}

export interface AgentRunPublicProjection {
  runId: string;
  runType: string;
  status: AgentRunStatus;
  initialGoal: string;
  trigger: {
    source: string;
    id: string;
    summary?: string;
  };
  parentRunId?: string;
  branchPurpose?: string;
  createdAt: string;
  updatedAt: string;
  lastWakeAt?: string;
  nextWakeAt?: string;
  blocked: boolean;
  lastGoalCheck?: AgentRunGoalCheckProjection;
  events: AgentRunEventProjection[];
  artifacts: AgentRunArtifactProjection[];
  subjects: AgentRunSubjectProjection[];
}

export type TriggerRef = AgentRunTriggerRef;
export type GoalCheck = AgentRunGoalCheck;
export type Event = AgentRunEvent;
export type ArtifactRef = AgentRunArtifactRef;
export type SubjectRef = AgentRunSubjectRef;
