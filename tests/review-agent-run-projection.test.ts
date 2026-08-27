import { describe, test } from 'node:test';
import * as assert from 'node:assert';

import { projectReviewAsAgentRun } from '../src/review/review-agent-run-projection';
import type { ReviewRunRecord } from '../src/review/review-runtime-types';

function fixture(status: ReviewRunRecord['status'] = 'active'): ReviewRunRecord {
  return {
    runId: 'review-F-1-run',
    findingId: 'F-1',
    sessionKey: 'review:F-1',
    goal: 'Decide whether F-1 is an Issue or should close',
    envelopePath: '/private/evidence/F-1',
    status,
    reviewState: status === 'complete_issue' ? 'COMPLETE_ISSUE' : 'INCOMPLETE',
    createdAt: '2026-07-28T08:00:00.000Z',
    updatedAt: '2026-07-28T08:05:00.000Z',
    blocker: 'raw private failure',
    lastGoalCheck: {
      checkedAt: '2026-07-28T08:04:00.000Z',
      complete: false,
      capabilitiesExhausted: false,
      summary: 'More evidence is needed',
      nextAction: 'Run a bounded reproduction',
      stopCondition: 'Reproduction succeeds or fails deterministically',
    },
    tasks: {},
    events: [{
      eventId: 'event-1', runId: 'review-F-1-run', findingId: 'F-1', type: 'goal_checked',
      at: '2026-07-28T08:04:00.000Z', actor: 'reviewer', summary: 'Goal checked',
    }],
  };
}

describe('projectReviewAsAgentRun', () => {
  test('maps Review into the generic safe Board shape', () => {
    const projection = projectReviewAsAgentRun(fixture('awaiting_approval'));
    assert.equal(projection.runType, 'finding_review');
    assert.equal(projection.status, 'waiting_for_input');
    assert.deepEqual(projection.subjects, [{ kind: 'finding', id: 'F-1', label: 'INCOMPLETE' }]);
    assert.equal(projection.lastGoalCheck?.hasNextAction, true);
    const raw = JSON.stringify(projection);
    assert.doesNotMatch(raw, /review:F-1/);
    assert.doesNotMatch(raw, /private\/evidence/);
    assert.doesNotMatch(raw, /raw private failure/);
    assert.doesNotMatch(raw, /actor/);
  });

  test('maps both Review terminal outcomes to completed', () => {
    assert.equal(projectReviewAsAgentRun(fixture('complete_issue')).status, 'completed');
    assert.equal(projectReviewAsAgentRun(fixture('complete_close')).status, 'completed');
    assert.equal(projectReviewAsAgentRun(fixture('blocked')).status, 'blocked');
  });
});
