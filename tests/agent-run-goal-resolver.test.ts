import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  AgentRunGoalResolver,
  createAIServiceGoalDrafter,
  parseGoalDraft,
  type AgentRunGoalDrafter,
  type ResolveAgentRunGoalInput,
} from '../src/core/agent-run-goal-resolver';
import { CODE_INSPECTION_GOAL_PROFILE } from '../src/core/agent-run-goal-profiles';

const NOW = '2026-07-28T09:00:00.000Z';

function input(overrides: Partial<ResolveAgentRunGoalInput> = {}): ResolveAgentRunGoalInput {
  return {
    triggerSource: 'manual_inspection',
    triggerId: '/repo@tree-1',
    triggerSummary: 'baseline inspection',
    triggerFacts: { repo: '/repo', snapshot: 'tree-1', mode: 'baseline', scope: ['src'] },
    profile: CODE_INSPECTION_GOAL_PROFILE,
    ...overrides,
  };
}

describe('AgentRunGoalResolver', () => {
  test('pairs an explicit Goal with the Trigger without calling AI', async () => {
    let calls = 0;
    const drafter: AgentRunGoalDrafter = { async draftGoal() { calls += 1; return 'AI goal'; } };
    const resolver = new AgentRunGoalResolver({ drafter, now: () => new Date(NOW) });
    const result = await resolver.resolve(input({ explicitGoal: '  Preserve the human outcome  ' }));
    assert.equal(result.goal, 'Preserve the human outcome');
    assert.equal(result.source, 'explicit');
    assert.equal(result.profileId, 'code_inspection.v1');
    assert.equal(result.generatedAt, NOW);
    assert.equal(calls, 0);
  });

  test('uses AI to combine Trigger facts and Profile completion criteria', async () => {
    let captured: ResolveAgentRunGoalInput | undefined;
    const drafter: AgentRunGoalDrafter = {
      generatorName: 'goal-model',
      async draftGoal(value) { captured = value; return 'Produce a validated inspection report and register only qualified Findings.'; },
    };
    const result = await new AgentRunGoalResolver({ drafter, now: () => new Date(NOW) }).resolve(input());
    assert.equal(result.source, 'ai_generated');
    assert.equal(result.generator, 'goal-model');
    assert.match(result.goal, /validated inspection report/);
    assert.equal(captured?.triggerFacts.snapshot, 'tree-1');
    assert.equal(captured?.profile.completionCriteria.length, 4);
  });

  test('falls back deterministically when AI fails or returns invalid output', async () => {
    const drafter: AgentRunGoalDrafter = { async draftGoal() { throw new Error('goal_draft_invalid_json'); } };
    const result = await new AgentRunGoalResolver({ drafter, now: () => new Date(NOW) }).resolve(input());
    assert.equal(result.source, 'profile_fallback');
    assert.equal(result.fallbackReason, 'ai_goal_invalid_json');
    assert.match(result.goal, /\/repo@tree-1/);
    assert.match(result.goal, /validated inspection report/);
  });

  test('AIService drafter sends Trigger and Profile as data and accepts fenced JSON', async () => {
    let messages: any[] = [];
    const fake = {
      getConfig: () => ({ model: 'draft-model' }),
      chat: async (next: any[]) => {
        messages = next;
        return { content: '```json\n{"goal":"Bounded generated goal"}\n```' };
      },
    };
    const drafter = createAIServiceGoalDrafter(fake as any);
    assert.equal(await drafter.draftGoal(input()), 'Bounded generated goal');
    assert.match(String(messages[0].content), /untrusted data/);
    const payload = JSON.parse(String(messages[1].content));
    assert.equal(payload.trigger.facts.snapshot, 'tree-1');
    assert.equal(payload.profile.profileId, 'code_inspection.v1');
  });

  test('rejects plain prose from the AI drafter', () => {
    assert.throws(() => parseGoalDraft('do the thing'), /invalid_json/);
  });
});
