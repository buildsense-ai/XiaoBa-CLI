import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSession } from '../src/core/agent-session';
import { hasCompleteToolExchanges } from '../src/core/checkpoint-candidate';
import type { Message } from '../src/types';

const usage = { promptTokens: 4, completionTokens: 2, totalTokens: 6 };

test('AgentSession commits one candidate after a later complete tool batch', async () => {
  const previous = process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
  process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = 'true';
  try {
    let session!: AgentSession;
    let modelCalls = 0;
    let candidateCreations = 0;
    let candidateCompacted = false;
    let secondToolStarted = false;
    let secondToolFinished = false;
    let releaseSecondTool!: () => void;
    let releaseCandidate!: () => void;
    const secondToolGate = new Promise<void>(resolve => { releaseSecondTool = resolve; });
    const candidateGate = new Promise<void>(resolve => { releaseCandidate = resolve; });
    const modelRequests: Message[][] = [];

    session = new AgentSession('user:cross-threshold-e2e', {
      aiService: {
        async chatStream(messages: Message[]) {
          modelCalls++;
          modelRequests.push(messages.map(message => structuredClone(message)));
          if (modelCalls === 1) {
            return {
              content: '',
              toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'inspect', arguments: '{"step":1}' } }],
              usage,
            };
          }
          if (modelCalls === 2) {
            return {
              content: '',
              toolCalls: [{ id: 'call-2', type: 'function', function: { name: 'inspect', arguments: '{"step":2}' } }],
              usage,
            };
          }
          return { content: '完成', toolCalls: [], usage };
        },
      },
      toolManager: {
        getToolDefinitions() { return [{ name: 'inspect', description: 'inspect', input_schema: { type: 'object' } }]; },
        async executeTool(toolCall: any) {
          if (toolCall.id === 'call-2') {
            secondToolStarted = true;
            await secondToolGate;
            secondToolFinished = true;
          }
          return {
            ok: true,
            role: 'tool',
            tool_call_id: toolCall.id,
            name: 'inspect',
            content: toolCall.id === 'call-1' ? 'first evidence' : 'second evidence',
          };
        },
        getWorkspaceRoot() { return process.cwd(); },
      },
      skillManager: {
        getSkill() { return undefined; }, getUserInvocableSkills() { return []; }, getAutoInvocableSkills() { return []; },
        findAutoInvocableSkillByText() { return undefined; }, loadSkills: async () => {},
      },
    } as any, 'catscompany');

    session.setSystemPromptProvider(() => 'system');
    (session as any).useCheckpointCompaction = true;
    (session as any).useCheckpointCandidates = true;
    (session as any).checkpointCandidateSuppressed = false;
    (session as any).checkpointCandidateFallbackRequired = false;
    (session as any).getContextUsageInfo = (messages: Message[]) => {
      if (messages.some(message => message.__checkpointSummary)) {
        return { usedTokens: 20, toolTokens: 0, maxTokens: 100, usagePercent: 20 };
      }
      const crossedTrigger = messages.some(message => message.role === 'tool' && message.tool_call_id === 'call-1');
      const percent = crossedTrigger ? 75 : 50;
      // The trigger uses exact used+tool tokens. Keep the message share below
      // the 85% stop point after the real request tool definitions are added.
      const usedTokens = crossedTrigger ? 45 : 25;
      const toolTokens = crossedTrigger ? 30 : 0;
      return { usedTokens, toolTokens, maxTokens: 100, usagePercent: percent };
    };
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = async (messages: Message[]) => ({ compacted: false, messages });
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => {
      await candidateGate;
      candidateCompacted = true;
      return {
        compacted: true,
        messages: [{ role: 'user', content: 'checkpoint summary', __checkpointSummary: true }],
      };
    };
    const originalStart = (session as any).startCheckpointCandidateIfEligible.bind(session);
    (session as any).startCheckpointCandidateIfEligible = (...args: any[]) => {
      const before = (session as any).checkpointCandidate;
      const result = originalStart(...args);
      if (!before && (session as any).checkpointCandidate) candidateCreations++;
      return result;
    };
    (session as any).persistCheckpoint = () => true;

    const turn = session.handleMessage('inspect the item');
    await waitFor(() => secondToolStarted);
    await waitFor(() => Boolean((session as any).checkpointCandidate));
    assert.equal(secondToolFinished, false);
    releaseCandidate();
    await waitFor(() => (session as any).checkpointCandidate?.status === 'ready');
    assert.equal(secondToolFinished, false);
    releaseSecondTool();

    const result = await turn;
    assert.equal(result.text, '完成');
    assert.equal(modelCalls, 3);
    assert.equal(candidateCreations, 1);
    assert.equal(candidateCompacted, true);
    assert.equal((session as any).checkpointCandidate, null);

    const resumedRequest = modelRequests[2];
    assert.ok(resumedRequest.some(message => message.__checkpointSummary));
    const callIndex = resumedRequest.findIndex(message => message.role === 'assistant'
      && message.tool_calls?.some(call => call.id === 'call-2'));
    assert.notEqual(callIndex, -1);
    assert.equal(resumedRequest[callIndex + 1]?.role, 'tool');
    assert.equal(resumedRequest[callIndex + 1]?.tool_call_id, 'call-2');
    assert.equal(resumedRequest[callIndex + 1]?.content, 'second evidence');
    assert.equal(hasCompleteToolExchanges(resumedRequest), true);

    const durable = (session as any).messages as Message[];
    assert.equal(hasCompleteToolExchanges(durable), true);
    assert.ok(durable.some(message => message.__checkpointSummary));
  } finally {
    if (previous === undefined) delete process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = previous;
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met in time');
}
