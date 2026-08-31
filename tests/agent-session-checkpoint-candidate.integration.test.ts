import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AgentSession } from '../src/core/agent-session';
import type { Message } from '../src/types';
import { CheckpointCompactionCoordinator } from '../src/core/checkpoint-compaction';

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
const OWNED_SESSION_KEYS = [
  'user:legacy-persist',
  'user:candidate-persist-race',
  'user:candidate-integration',
  'user:candidate-episode-end',
  'user:candidate-preempt-integration',
  'user:candidate-fallback-integration',
  'user:candidate-early-failure-fallback',
  'user:candidate-persist-failure-fallback',
  'user:candidate-budget-blocked',
  'user:candidate-parent-destroyed',
  'user:candidate-interrupted',
  'user:candidate-cleanup',
  'user:candidate-authentication',
  'user:candidate-exact-trigger',
];

before(cleanOwnedSessionArtifacts);
after(cleanOwnedSessionArtifacts);

test('legacy compaction persists its replacement context', async () => {
  await withCheckpointMode(false, async () => {
    const session = createInitializedSession('user:legacy-persist', {
      async chatStream() {
        return { content: 'legacy answer', toolCalls: [], usage };
      },
    });
    const original = { role: 'user', content: 'old history' } as Message;
    const compacted = { role: 'user', content: 'legacy summary' } as Message;
    (session as any).messages.push(original);
    (session as any).contextWindowManager.compactIfNeeded = async () => ({
      messages: [compacted],
      compacted: true,
    });
    const persisted: Message[][] = [];
    (session as any).lifecycleManager.saveContext = (messages: Message[]) => {
      persisted.push(messages.map(message => ({ ...message })));
      return true;
    };

    await session.handleMessage('continue');

    assert.ok(persisted.some(messages => messages.some(message => message.content === 'legacy summary')));
    assert.ok((session as any).messages.some((message: Message) => message.content === 'legacy summary'));
  });
});

test('disabling candidates falls back to legacy synchronous compaction', async () => {
  const previousCandidates = process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
  const previousCheckpoint = process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED;
  process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = 'false';
  process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED = 'true';
  try {
    const session = createInitializedSession('user:candidate-fallback', {
      async chatStream() {
        return { content: 'answer', toolCalls: [], usage };
      },
    });
    (session as any).messages.push({ role: 'user', content: 'history root' });
    let legacyCalls = 0;
    let checkpointCalls = 0;
    (session as any).contextWindowManager.compactIfNeeded = async (messages: Message[]) => {
      legacyCalls++;
      return { messages, compacted: false };
    };
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = async () => {
      checkpointCalls++;
      return noCompaction();
    };

    await session.handleMessage('fallback');

    assert.equal(legacyCalls, 1);
    assert.equal(checkpointCalls, 0);
  } finally {
    if (previousCandidates === undefined) delete process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = previousCandidates;
    if (previousCheckpoint === undefined) delete process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED = previousCheckpoint;
  }
});

test('candidate trigger uses exact token usage instead of rounded percentage', async () => {
  await withCandidateMode(async () => {
    const session = createInitializedSession('user:candidate-exact-trigger', {
      async chatStream() { return { content: 'unused', toolCalls: [], usage }; },
    });
    (session as any).messages.push({ role: 'user', content: 'history root' });
    let usedTokens = 749;
    (session as any).getContextUsageInfo = () => ({
      usedTokens,
      toolTokens: 0,
      maxTokens: 1000,
      // 74.9% rounds to 75, which must not start a summary.
      usagePercent: 75,
    });
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => ({
      compacted: true,
      messages: [{ role: 'user', content: 'candidate summary' }],
    });

    (session as any).startCheckpointCandidateIfEligible(
      (session as any).lifecycleGeneration,
      (session as any).messages,
      'pre_turn',
    );
    assert.equal((session as any).checkpointCandidate, null);

    usedTokens = 750;
    (session as any).startCheckpointCandidateIfEligible(
      (session as any).lifecycleGeneration,
      (session as any).messages,
      'pre_turn',
    );
    assert.equal((session as any).checkpointCandidate, null);

    usedTokens = 751;
    (session as any).startCheckpointCandidateIfEligible(
      (session as any).lifecycleGeneration,
      (session as any).messages,
      'pre_turn',
    );
    assert.ok((session as any).checkpointCandidate);
    await (session as any).checkpointCandidatePromise;
    assert.equal((session as any).checkpointCandidate.status, 'ready');
    (session as any).cancelCheckpointCandidate();
  });
});

test('candidate persistence keeps memory aligned with the persisted projection', async () => {
  await withCandidateMode(async () => {
    const session = createInitializedSession('user:candidate-persist-race', {
      async chatStream() {
        return { content: 'answer', toolCalls: [], usage };
      },
    });
    (session as any).messages.push({ role: 'user', content: 'history root' });
    (session as any).getContextUsageInfo = (messages: Message[]) => {
      const compacted = messages.some(message => message.content === 'candidate summary');
      const currentPercent = compacted ? 20 : 76;
      return {
        usedTokens: currentPercent,
        toolTokens: 0,
        maxTokens: 100,
        usagePercent: currentPercent,
      };
    };
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = noCompaction;
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => ({
      compacted: true,
      messages: [{ role: 'user', content: 'candidate summary' }],
    });
    const persisted: Message[][] = [];
    (session as any).lifecycleManager.saveContext = (messages: Message[]) => {
      persisted.push(messages.map(message => ({ ...message })));
      return true;
    };

    await session.handleMessage('start candidate');

    assert.ok(persisted.some(messages => messages.some(message => message.content === 'candidate summary')));
    assert.ok((session as any).messages.some((message: Message) => message.content === 'candidate summary'));
    assert.ok((session as any).messages.some((message: Message) => message.content === 'start candidate'));
    assert.equal((session as any).checkpointCandidate, null);
  });
});

test('three consecutive checkpoints retain state from the previous checkpoint', async () => {
  const summaries = [
    'Completed: inspected repository. Active: edit file. Next: run tests. Constraint: do not restart server.',
    'Completed: edited file. Active: run tests. Next: fix failures. Constraint: do not restart server.',
    'Completed: tests pass. Active: report result. Next: none. Constraint: do not restart server.',
  ];
  const requests: Message[][] = [];
  const service = {
    chatStream: async (messages: Message[], _tools: unknown, callbacks: any) => {
      requests.push(messages.map(message => ({ ...message })));
      const summary = summaries[requests.length - 1];
      callbacks.onText?.(summary);
      return { content: summary, usage };
    },
  };
  const coordinator = new CheckpointCompactionCoordinator(service, {
    maxContextTokens: 200,
    compactionThreshold: 0.5,
  });
  let messages: Message[] = [
    { role: 'user', content: 'ROOT objective: inspect repository. Constraint: do not restart server.', __episodeId: 'episode-1', __episodeInputKind: 'root' },
    { role: 'assistant', content: 'old work ' + 'x'.repeat(2000), __episodeId: 'episode-1' },
  ];
  for (let index = 0; index < 3; index++) {
    const result = await coordinator.compactIfNeeded(messages, {
      sessionKey: 'three-checkpoints',
      phase: 'mid_turn',
      episodeId: 'episode-1',
    });
    assert.equal(result.compacted, true);
    messages = [...result.messages, { role: 'user', content: `follow-up ${index}`, __episodeId: 'episode-1', __episodeInputKind: 'pending' }];
  }

  assert.match(String(requests[1].map(message => message.content).join('\n')), /Completed: inspected repository/);
  assert.match(String(requests[2].map(message => message.content).join('\n')), /Completed: edited file/);
  assert.match(String(requests[2].map(message => message.content).join('\n')), /do not restart server/);
});

test('handleMessage commits a candidate at episode end with suffix intact', async () => {
  await withCandidateMode(async () => {
    const modelRequests: Message[][] = [];
    let responseNumber = 0;
    const session = createInitializedSession('user:candidate-integration', {
      async chatStream(messages: Message[]) {
        modelRequests.push(messages.map(message => ({ ...message })));
        return { content: `answer-${++responseNumber}`, toolCalls: [], usage };
      },
    });
    (session as any).messages.push({ role: 'user', content: 'history root', __episodeId: 'history' });
    (session as any).getContextUsageInfo = (messages: Message[]) => {
      const compacted = messages.some(message => message.content === 'candidate summary');
      return {
        usedTokens: compacted ? 20 : 76,
        toolTokens: 0,
        maxTokens: 100,
        usagePercent: compacted ? 20 : 76,
      };
    };
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = noCompaction;
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => ({
      compacted: true,
      messages: [{ role: 'user', content: 'candidate summary', __episodeId: 'history' }],
    });
    const persisted: Message[][] = [];
    (session as any).lifecycleManager.saveContext = (messages: Message[]) => {
      persisted.push(messages.map(message => ({ ...message })));
      return true;
    };

    const first = await session.handleMessage('first suffix input');
    const second = await session.handleMessage('second input');

    assert.equal(first.text, 'answer-1');
    assert.equal(second.text, 'answer-2');
    assert.ok(modelRequests[1].some(message => message.content === 'candidate summary'));
    assert.ok(modelRequests[1].some(message => message.content === 'first suffix input'));
    assert.ok(modelRequests[1].some(message => message.content === 'answer-1'));
    assert.ok(persisted.some(messages =>
      messages.some(message => message.content === 'candidate summary')
      && messages.some(message => message.content === 'first suffix input')));
    assert.equal((session as any).checkpointCandidate, null);
  });
});

test('episode end commits a candidate that became ready during the model request', async () => {
  await withCandidateMode(async () => {
    let session!: AgentSession;
    const modelRequests: Message[][] = [];
    session = createInitializedSession('user:candidate-episode-end', {
      async chatStream(messages: Message[]) {
        modelRequests.push(messages.map(message => ({ ...message })));
        const candidate = (session as any).checkpointCandidate;
        if (candidate?.status === 'running') {
          candidate.complete([{ role: 'user', content: 'episode-end summary' }]);
        }
        return { content: 'answer', toolCalls: [], usage };
      },
    });
    (session as any).messages.push({ role: 'user', content: 'history root' });
    (session as any).getContextUsageInfo = (messages: Message[]) => {
      const compacted = messages.some(message => message.content === 'candidate summary');
      const currentPercent = compacted ? 20 : 76;
      return {
        usedTokens: currentPercent,
        toolTokens: 0,
        maxTokens: 100,
        usagePercent: currentPercent,
      };
    };
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = noCompaction;
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => new Promise(() => {});
    const persisted: Message[][] = [];
    (session as any).lifecycleManager.saveContext = (messages: Message[]) => {
      persisted.push(messages.map(message => ({ ...message })));
      return true;
    };

    await session.handleMessage('finish this episode');

    assert.equal(modelRequests.length, 1);
    assert.ok((session as any).messages.some((message: Message) => message.content === 'episode-end summary'));
    assert.ok((session as any).messages.some((message: Message) => message.content === 'finish this episode'));
    assert.ok((session as any).messages.some((message: Message) => message.content === 'answer'));
    assert.ok(persisted.some(messages => messages.some(message => message.content === 'episode-end summary')));
    assert.equal((session as any).checkpointCandidate, null);
  });
});

test('handleMessage waits for a running candidate only above 85 percent', async () => {
  await withCandidateMode(async () => {
    let usagePercent = 76;
    let releaseCandidate!: () => void;
    const candidateGate = new Promise<void>(resolve => { releaseCandidate = resolve; });
    const session = createInitializedSession('user:candidate-preempt-integration', {
      async chatStream() {
        return { content: 'main answer', toolCalls: [], usage };
      },
    });
    (session as any).messages.push({ role: 'user', content: 'history root' });
    (session as any).getContextUsageInfo = (messages: Message[]) => {
      const compacted = messages.some(message => message.content === 'late candidate summary');
      const currentPercent = compacted ? 20 : usagePercent;
      return {
        usedTokens: currentPercent,
        toolTokens: 0,
        maxTokens: 100,
        usagePercent: currentPercent,
      };
    };
    let serialCalls = 0;
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = async (messages: Message[]) => {
      serialCalls++;
      return noCompaction(messages);
    };
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => {
      await candidateGate;
      return { compacted: true, messages: [{ role: 'user', content: 'late candidate summary' }] };
    };

    await session.handleMessage('start candidate');
    const candidate = (session as any).checkpointCandidate;
    assert.equal(candidate.status, 'running');
    serialCalls = 0;

    usagePercent = 86;
    const highWaterTurn = session.handleMessage('trigger high water');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((session as any).checkpointCandidate, candidate);
    assert.equal(candidate.status, 'running');
    assert.equal(serialCalls, 0);

    releaseCandidate();
    await highWaterTurn;

    assert.equal(candidate.status, 'committed');
    assert.equal((session as any).checkpointCandidate, null);
    assert.equal(serialCalls, 1);
    assert.ok((session as any).messages.some((message: Message) => message.content === 'late candidate summary'));
  });
});

test('candidate failure above 85 percent falls back once with the latest transcript', async () => {
  await withCandidateMode(async () => {
    let usagePercent = 76;
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
    const session = createInitializedSession('user:candidate-fallback-integration', {
      async chatStream() {
        return { content: 'main answer', toolCalls: [], usage };
      },
    });
    (session as any).messages.push({ role: 'user', content: 'history root' });
    (session as any).getContextUsageInfo = (messages: Message[]) => {
      const compacted = messages.some(message => message.content === 'serial fallback summary');
      const currentPercent = compacted ? 20 : usagePercent;
      return { usedTokens: currentPercent, toolTokens: 0, maxTokens: 100, usagePercent: currentPercent };
    };
    const fallbackInputs: Message[][] = [];
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = noCompaction;
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async (messages: Message[], request: any) => {
      if (String(request.metricsContext?.candidateId || '').includes(':serial:')) {
        fallbackInputs.push(messages.map(message => ({ ...message })));
        return {
          messages: [{ role: 'user', content: 'serial fallback summary' }],
          compacted: true,
          usedTokens: 85,
          toolTokens: 0,
          maxTokens: 100,
          usagePercent: 85,
        };
      }
      await failureGate;
      throw new Error('candidate failed');
    };

    await session.handleMessage('start candidate');
    usagePercent = 86;
    const highWaterTurn = session.handleMessage('latest suffix');
    await new Promise(resolve => setImmediate(resolve));
    releaseFailure();
    await highWaterTurn;

    assert.equal(fallbackInputs.length, 1);
    assert.ok(fallbackInputs[0].some(message => message.content === 'start candidate'));
    assert.ok(fallbackInputs[0].some(message => message.content === 'main answer'));
    assert.ok((session as any).messages.some((message: Message) => message.content === 'serial fallback summary'));
    assert.equal((session as any).checkpointCandidate, null);
  });
});

test('candidate failure before 85 percent retries one serial fallback above the stop point', async () => {
  await withCandidateMode(async () => {
    let usagePercent = 76;
    const session = createInitializedSession('user:candidate-early-failure-fallback', {
      async chatStream() { return { content: 'main answer', toolCalls: [], usage }; },
    });
    (session as any).messages.push({ role: 'user', content: 'history root' });
    (session as any).getContextUsageInfo = (messages: Message[]) => ({
      usedTokens: messages.some(message => message.content === 'serial fallback summary') ? 20 : usagePercent,
      toolTokens: 0,
      maxTokens: 100,
      usagePercent: messages.some(message => message.content === 'serial fallback summary') ? 20 : usagePercent,
    });
    let fallbackCalls = 0;
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = noCompaction;
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async (_messages: Message[], request: any) => {
      if (String(request.metricsContext?.candidateId || '').includes(':serial:')) {
        fallbackCalls++;
        if (fallbackCalls < 3) {
          const error: any = new Error('Responses API stream ended without a terminal response');
          error.status = 502;
          throw error;
        }
        return {
          messages: [{ role: 'user', content: 'serial fallback summary' }],
          compacted: true,
          usedTokens: 20,
          toolTokens: 0,
          maxTokens: 100,
          usagePercent: 20,
        };
      }
      throw new Error('candidate failed early');
    };

    await session.handleMessage('start candidate');
    usagePercent = 86;
    const result = await session.handleMessage('reach stop point');

    assert.equal(result.taskOutcome, 'completed');
    assert.equal(fallbackCalls, 3);
    assert.ok((session as any).messages.some((message: Message) => message.content === 'serial fallback summary'));
  });
});

test('candidate persistence failure still falls back at the stop point', async () => {
  await withCandidateMode(async () => {
    let usagePercent = 76;
    const session = createInitializedSession('user:candidate-persist-failure-fallback', {
      async chatStream() { return { content: 'main answer', toolCalls: [], usage }; },
    });
    (session as any).messages.push({ role: 'user', content: 'history root' });
    (session as any).getContextUsageInfo = (messages: Message[]) => ({
      usedTokens: messages.some(message => message.content === 'serial fallback summary') ? 20 : usagePercent,
      toolTokens: 0,
      maxTokens: 100,
      usagePercent: messages.some(message => message.content === 'serial fallback summary') ? 20 : usagePercent,
    });
    let fallbackCalls = 0;
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async (_messages: Message[], request: any) => {
      const serial = String(request.metricsContext?.candidateId || '').includes(':serial:');
      if (serial) fallbackCalls++;
      return {
        messages: [{ role: 'user', content: serial ? 'serial fallback summary' : 'candidate summary' }],
        compacted: true,
      };
    };
    (session as any).persistCheckpoint = (messages: Message[]) => !messages.some(message => message.content === 'candidate summary');
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = noCompaction;

    await session.handleMessage('start candidate');
    usagePercent = 86;
    const result = await session.handleMessage('reach stop point');

    assert.equal(result.taskOutcome, 'completed');
    assert.equal(fallbackCalls, 1);
    assert.ok((session as any).messages.some((message: Message) => message.content === 'serial fallback summary'));
  });
});

test('oversized candidate and fallback fail closed before the next model request', async () => {
  await withCandidateMode(async () => {
    let mainModelCalls = 0;
    const session = createInitializedSession('user:candidate-budget-blocked', {
      async chatStream() {
        mainModelCalls++;
        return { content: 'must not run', toolCalls: [], usage };
      },
    });
    (session as any).messages.push({ role: 'user', content: 'history root' });
    (session as any).getContextUsageInfo = () => ({
      usedTokens: 86,
      toolTokens: 0,
      maxTokens: 100,
      usagePercent: 86,
    });
    const candidate = new (await import('../src/core/checkpoint-candidate')).CheckpointCandidate(
      'oversized-ready',
      (await import('../src/core/checkpoint-candidate')).createCheckpointSnapshot(
        (session as any).messages,
        { revision: 0 },
      ),
    );
    candidate.complete([{ role: 'user', content: 'oversized candidate summary' }]);
    (session as any).checkpointCandidate = candidate;
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = async (messages: Message[]) => ({
      messages,
      compacted: false,
      usedTokens: 86,
      toolTokens: 0,
      maxTokens: 100,
      usagePercent: 86,
    });

    const result = await session.handleMessage('blocked input');

    assert.equal(result.taskOutcome, 'failed');
    assert.match(result.text, /会话已冻结/);
    const blockedRetry = await session.handleMessage('must remain blocked');
    assert.equal(blockedRetry.taskOutcome, 'failed');
    assert.match(blockedRetry.text, /会话已冻结/);
    assert.equal(mainModelCalls, 0);
    assert.equal((session as any).messages.some((message: Message) => message.content === 'oversized candidate summary'), false);
  });
});

test('interrupt discards a candidate result that returns late', async () => {
  await withCandidateMode(async () => {
    let releaseCandidate!: () => void;
    const candidateGate = new Promise<void>(resolve => { releaseCandidate = resolve; });
    const session = createInitializedSession('user:candidate-interrupted', {
      async chatStream() { return { content: 'main answer', toolCalls: [], usage }; },
    });
    (session as any).messages.push({ role: 'user', content: 'history root' });
    (session as any).getContextUsageInfo = () => ({ usedTokens: 76, toolTokens: 0, maxTokens: 100, usagePercent: 76 });
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = noCompaction;
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => {
      await candidateGate;
      return { compacted: true, messages: [{ role: 'user', content: 'late interrupted summary' }] };
    };

    await session.handleMessage('start candidate');
    const candidate = (session as any).checkpointCandidate;
    assert.equal(candidate.status, 'running');

    session.requestInterrupt();
    assert.equal(candidate.status, 'cancelled');
    assert.equal((session as any).checkpointCandidate, null);
    releaseCandidate();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(candidate.result, undefined);
    assert.equal((session as any).messages.some((message: Message) => message.content === 'late interrupted summary'), false);
  });
});

test('cleanup discards a candidate result that returns late', async () => {
  await withCandidateMode(async () => {
    let releaseCandidate!: () => void;
    const candidateGate = new Promise<void>(resolve => { releaseCandidate = resolve; });
    const session = createInitializedSession('user:candidate-cleanup', {
      async chatStream() { return { content: 'main answer', toolCalls: [], usage }; },
    });
    (session as any).messages.push({ role: 'user', content: 'history root' });
    (session as any).getContextUsageInfo = () => ({ usedTokens: 76, toolTokens: 0, maxTokens: 100, usagePercent: 76 });
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = noCompaction;
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => {
      await candidateGate;
      return { compacted: true, messages: [{ role: 'user', content: 'late cleanup summary' }] };
    };
    (session as any).lifecycleManager.persistAndClear = (messages: Message[]) => ({
      saved: true,
      savedCount: messages.length,
      messages: [],
    });

    await session.handleMessage('start candidate');
    const candidate = (session as any).checkpointCandidate;
    assert.equal(candidate.status, 'running');

    await session.cleanup();
    assert.equal(candidate.status, 'cancelled');
    assert.equal((session as any).checkpointCandidate, null);
    releaseCandidate();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(candidate.result, undefined);
    assert.equal((session as any).messages.some((message: Message) => message.content === 'late cleanup summary'), false);
  });
});

test('authentication failure blocks the session without serial fallback', async () => {
  await withCandidateMode(async () => {
    let usagePercent = 76;
    let releaseAuthentication!: () => void;
    const authenticationGate = new Promise<void>(resolve => { releaseAuthentication = resolve; });
    let candidateCalls = 0;
    let fallbackCalls = 0;
    let mainCalls = 0;
    const session = createInitializedSession('user:candidate-authentication', {
      async chatStream() {
        mainCalls++;
        return { content: 'main answer', toolCalls: [], usage };
      },
    });
    (session as any).messages.push({ role: 'user', content: 'history root' });
    (session as any).getContextUsageInfo = () => ({
      usedTokens: usagePercent,
      toolTokens: 0,
      maxTokens: 100,
      usagePercent,
    });
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = async (messages: Message[]) => {
      fallbackCalls++;
      return noCompaction(messages);
    };
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => {
      candidateCalls++;
      await authenticationGate;
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    };

    await session.handleMessage('start candidate');
    fallbackCalls = 0;
    usagePercent = 86;
    const blockedTurn = session.handleMessage('must not reach model');
    await new Promise(resolve => setImmediate(resolve));
    releaseAuthentication();
    const result = await blockedTurn;

    assert.equal(result.taskOutcome, 'failed');
    assert.match(result.text, /会话已冻结/);
    assert.equal(candidateCalls, 1);
    assert.equal(fallbackCalls, 0);
    assert.equal(mainCalls, 1);
    assert.equal((session as any).checkpointBlockedReason, 'checkpoint_authentication');
    const retry = await session.handleMessage('still blocked');
    assert.equal(retry.taskOutcome, 'failed');
    assert.equal(mainCalls, 1);
  });
});

test('cleared parent session discards a candidate result that returns after deletion', async () => {
  await withCandidateMode(async () => {
    let releaseCandidate!: () => void;
    const candidateGate = new Promise<void>(resolve => { releaseCandidate = resolve; });
    const session = createInitializedSession('user:candidate-parent-destroyed', {
      async chatStream() {
        return { content: 'main answer', toolCalls: [], usage };
      },
    });
    (session as any).messages.push({ role: 'user', content: 'history root' });
    (session as any).getContextUsageInfo = (messages: Message[]) => {
      const compacted = messages.some(message => message.content === 'candidate summary');
      const currentPercent = compacted ? 20 : 76;
      return {
        usedTokens: currentPercent,
        toolTokens: 0,
        maxTokens: 100,
        usagePercent: currentPercent,
      };
    };
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = noCompaction;
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => {
      await candidateGate;
      return { compacted: true, messages: [{ role: 'user', content: 'discarded candidate summary' }] };
    };
    let persistCalls = 0;
    (session as any).lifecycleManager.saveContext = () => {
      persistCalls++;
      return true;
    };

    await session.handleMessage('start candidate before parent deletion');
    const candidate = (session as any).checkpointCandidate;
    assert.equal(candidate.status, 'running');

    assert.equal(session.clear(), true);
    assert.equal((session as any).checkpointCandidate, null);
    assert.deepEqual((session as any).messages, []);
    const persistCallsAfterClear = persistCalls;

    releaseCandidate();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(candidate.status, 'cancelled');
    assert.equal(candidate.result, undefined);
    assert.equal((session as any).checkpointCandidate, null);
    assert.deepEqual((session as any).messages, []);
    assert.equal(persistCalls, persistCallsAfterClear);
  });
});

function cleanOwnedSessionArtifacts(): void {
  for (const key of OWNED_SESSION_KEYS) {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    fs.rmSync(path.join(process.cwd(), 'data', 'sessions', `${safeKey}.jsonl`), { force: true });
    fs.rmSync(path.join(process.cwd(), 'data', 'session-state', `${safeKey}.json`), { force: true });
  }
  const logsRoot = path.join(process.cwd(), 'logs', 'sessions', 'catscompany');
  if (!fs.existsSync(logsRoot)) return;
  const ownedNames = new Set(OWNED_SESSION_KEYS.map(key => (
    `catscompany_${key.replace(/[:<>"|?*]/g, '_')}.jsonl`
  )));
  for (const dateEntry of fs.readdirSync(logsRoot, { withFileTypes: true })) {
    if (!dateEntry.isDirectory()) continue;
    const dateDir = path.join(logsRoot, dateEntry.name);
    for (const filename of fs.readdirSync(dateDir)) {
      if (ownedNames.has(filename)) fs.rmSync(path.join(dateDir, filename), { force: true });
    }
  }
}

function createInitializedSession(key: string, aiService: any): AgentSession {
  const session = new AgentSession(key, buildMockServices(aiService), 'catscompany');
  const lifecycleManager = (session as any).lifecycleManager;
  lifecycleManager.saveContext = () => true;
  lifecycleManager.saveCurrentDirectory = () => {};
  lifecycleManager.clear = () => ({ initialized: false, lastActiveAt: Date.now(), persisted: true });
  (session as any).turnLogRecorder.recordTurn = () => {};
  (session as any).sessionTurnLogger.logPromptTrace = () => {};
  (session as any).sessionTurnLogger.logSubAgentEvent = () => {};
  (session as any).initialized = true;
  (session as any).messages = [{ role: 'system', content: 'system prompt' }];
  return session;
}

function buildMockServices(aiService: any): any {
  return {
    aiService,
    toolManager: {
      getToolDefinitions() { return []; },
      executeTool() { throw new Error('not expected'); },
      getWorkspaceRoot() { return process.cwd(); },
    },
    skillManager: {
      getSkill() { return undefined; },
      getUserInvocableSkills() { return []; },
      getAutoInvocableSkills() { return []; },
      findAutoInvocableSkillByText() { return undefined; },
      loadSkills: async () => {},
    },
  };
}

async function noCompaction(messages: Message[]): Promise<any> {
  return {
    messages,
    compacted: false,
    usedTokens: 60,
    toolTokens: 0,
    maxTokens: 100,
    usagePercent: 60,
  };
}

async function withCandidateMode(run: () => Promise<void>): Promise<void> {
  await withCheckpointMode(true, run);
}

async function withCheckpointMode(enabled: boolean, run: () => Promise<void>): Promise<void> {
  const previousCandidates = process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
  const previousCheckpoint = process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED;
  process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = 'true';
  process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED = enabled ? 'true' : 'false';
  try {
    await run();
  } finally {
    if (previousCandidates === undefined) delete process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = previousCandidates;
    if (previousCheckpoint === undefined) delete process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED = previousCheckpoint;
  }
}

async function waitFor(predicate: () => boolean, maxAttempts = 50): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met in time');
}
