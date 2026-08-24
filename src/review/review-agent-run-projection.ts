import type { AgentRunPublicProjection, AgentRunStatus } from '../core/agent-run-types';
import type { ReviewRunRecord, ReviewRunStatus } from './review-runtime-types';

export function projectReviewAsAgentRun(run: ReviewRunRecord): AgentRunPublicProjection {
  const status = mapReviewStatus(run.status);
  return {
    runId: run.runId,
    runType: 'finding_review',
    status,
    initialGoal: run.goal,
    trigger: {
      source: 'finding',
      id: run.findingId,
      summary: `Review Finding ${run.findingId}`,
    },
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.lastWakeAt ? { lastWakeAt: run.lastWakeAt } : {}),
    ...(run.nextWakeAt ? { nextWakeAt: run.nextWakeAt } : {}),
    blocked: status === 'blocked',
    ...(run.lastGoalCheck ? {
      lastGoalCheck: {
        checkedAt: run.lastGoalCheck.checkedAt,
        complete: run.lastGoalCheck.complete,
        capabilitiesExhausted: run.lastGoalCheck.capabilitiesExhausted,
        hasNextAction: Boolean(run.lastGoalCheck.nextAction),
        hasBlocker: Boolean(run.lastGoalCheck.blocker),
        hasStopCondition: Boolean(run.lastGoalCheck.stopCondition),
      },
    } : {}),
    events: run.events.slice(-20).map(event => ({
      eventId: event.eventId,
      type: event.type,
      summary: event.summary,
      createdAt: event.at,
    })),
    artifacts: [],
    subjects: [{ kind: 'finding', id: run.findingId, label: run.reviewState }],
  };
}

export function mapReviewStatus(status: ReviewRunStatus): AgentRunStatus {
  if (status === 'active') return 'active';
  if (status === 'awaiting_approval' || status === 'waiting_for_input') return 'waiting_for_input';
  if (status === 'blocked') return 'blocked';
  if (status === 'cancelled') return 'cancelled';
  return 'completed';
}
