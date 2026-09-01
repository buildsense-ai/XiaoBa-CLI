import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/types';
import {
  CheckpointCandidate,
  createCheckpointSnapshot,
  hasCompleteToolExchanges,
} from '../src/core/checkpoint-candidate';

function user(content: string): Message {
  return { role: 'user', content };
}

test('snapshot is an immutable copy of the parent boundary', () => {
  const messages = [user('root'), user('before branch')];
  const snapshot = createCheckpointSnapshot(messages, { revision: 4, episodeId: 'episode-1', startedAt: 10 });

  messages.push(user('after branch'));
  messages[0].content = 'mutated parent';

  assert.equal(snapshot.boundaryMessageCount, 2);
  assert.equal(snapshot.messages[0].content, 'root');
  assert.equal(snapshot.messages.length, 2);
  assert.equal(snapshot.startedAt, 10);
});

test('snapshot freezes nested message structures', () => {
  const messages: Message[] = [{
    role: 'user',
    content: [{
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'abc' },
    }],
  }];
  const snapshot = createCheckpointSnapshot(messages, { revision: 1 });

  (snapshot.messages[0].content as any)[0].source.data = 'changed';
  assert.equal((snapshot.messages[0].content as any)[0].source.data, 'abc');
});

test('snapshot isolates provider replay and remote watermark metadata', () => {
  const providerBlock: Record<string, unknown> = { type: 'reasoning', nested: { value: 'original' } };
  const messages: Message[] = [{
    role: 'assistant',
    content: 'result',
    providerContent: [providerBlock as any],
    providerState: {
      schema: 'xiaoba.provider_state.v1',
      apiType: 'openai-responses',
      model: 'test',
      endpointFingerprint: 'endpoint',
    },
    __remoteContextWatermarks: { cloud: 7 },
  }];
  const snapshot = createCheckpointSnapshot(messages, { revision: 1 });

  (providerBlock.nested as any).value = 'changed';
  messages[0].__remoteContextWatermarks!.cloud = 9;

  assert.equal(((snapshot.messages[0].providerContent![0] as any).nested as any).value, 'original');
  assert.equal(snapshot.messages[0].__remoteContextWatermarks!.cloud, 7);
});

test('candidate generates through the coordinator without mutating the snapshot', async () => {
  const source = [user('root')];
  const candidate = new CheckpointCandidate('candidate-generate', createCheckpointSnapshot(source, {
    revision: 1,
    episodeId: 'episode-1',
  }));
  let requestMessages: Message[] | undefined;
  const coordinator = {
    compactIfNeeded: async (messages: Message[], request: any) => {
      requestMessages = messages;
      assert.equal(request.phase, 'mid_turn');
      messages.push(user('coordinator-local-copy'));
      return { messages: [user('summary')], compacted: true };
    },
  } as any;

  assert.equal(await candidate.generate(coordinator, {
    sessionKey: 'candidate-session',
    phase: 'mid_turn',
  }), true);
  assert.equal(candidate.status, 'ready');
  assert.deepEqual(candidate.result?.map(message => message.content), ['summary']);
  assert.deepEqual(requestMessages?.map(message => message.content), ['root', 'coordinator-local-copy']);
  assert.deepEqual(candidate.snapshot.messages.map(message => message.content), ['root']);
});

test('candidate retries transient generation failures within one logical budget', async () => {
  const candidate = new CheckpointCandidate('candidate-retry', createCheckpointSnapshot([user('root')], {
    revision: 1,
  }));
  let attempts = 0;
  const coordinator = {
    compactIfNeeded: async () => {
      attempts++;
      if (attempts < 3) {
        const error: any = new Error('service unavailable');
        error.status = 503;
        throw error;
      }
      return { messages: [user('summary')], compacted: true };
    },
  } as any;

  assert.equal(await candidate.generate(coordinator, {
    sessionKey: 'candidate-session',
    phase: 'mid_turn',
  }), true);
  assert.equal(attempts, 3);
  assert.equal(candidate.status, 'ready');
});

test('candidate shares one provider request budget across logical attempts', async () => {
  const candidate = new CheckpointCandidate('candidate-request-budget', createCheckpointSnapshot([user('root')], {
    revision: 1,
  }));
  const budget = { maxRequests: 18, usedRequests: 0 };
  const observedBudgets: unknown[] = [];
  let attempts = 0;
  const coordinator = {
    compactIfNeeded: async (messages: Message[], request: any) => {
      observedBudgets.push(request.providerRequestBudget);
      request.providerRequestBudget.usedRequests++;
      attempts++;
      return attempts === 1
        ? { messages, compacted: false, error: new Error('temporary network failure') }
        : { messages: [user('summary')], compacted: true };
    },
  } as any;

  assert.equal(await candidate.generate(coordinator, {
    sessionKey: 'candidate-session',
    phase: 'mid_turn',
    providerRequestBudget: budget,
  }), true);
  assert.equal(attempts, 2);
  assert.equal(observedBudgets[0], budget);
  assert.equal(observedBudgets[1], budget);
  assert.deepEqual(candidate.providerRequestBudget, { maxRequests: 18, usedRequests: 2 });
});

test('candidate accumulates attributable summary usage across logical attempts', async () => {
  const candidate = new CheckpointCandidate('candidate-usage', createCheckpointSnapshot([user('root')], {
    revision: 1,
  }));
  let attempts = 0;
  const coordinator = {
    compactIfNeeded: async (messages: Message[]) => {
      attempts++;
      const summaryUsage = {
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
        cachedReadTokens: 3,
        cachedWriteTokens: 1,
      };
      return attempts === 1
        ? { messages, compacted: false, summaryUsage, summaryAttempts: 1 }
        : { messages: [user('summary')], compacted: true, summaryUsage, summaryAttempts: 1 };
    },
  } as any;

  assert.equal(await candidate.generate(coordinator, {
    sessionKey: 'candidate-session',
    phase: 'mid_turn',
  }), true);
  assert.equal(candidate.summaryAttempts, 2);
  assert.deepEqual(candidate.summaryUsage, {
    promptTokens: 20,
    completionTokens: 4,
    totalTokens: 24,
    cachedReadTokens: 6,
    cachedWriteTokens: 2,
  });
});

test('candidate records the first trigger-to-stop boundary only once', () => {
  const candidate = new CheckpointCandidate('candidate-stop-time', createCheckpointSnapshot([user('root')], {
    revision: 1,
    startedAt: 100,
  }));

  candidate.markStopReached(160);
  candidate.markStopReached(220);

  assert.equal(candidate.stopReachedAt, 160);
});

test('candidate does not retry coordinator-reported authentication failures', async () => {
  const candidate = new CheckpointCandidate('candidate-auth-result', createCheckpointSnapshot([user('root')], {
    revision: 1,
  }));
  let attempts = 0;
  const coordinator = {
    compactIfNeeded: async (messages: Message[]) => {
      attempts++;
      const error: any = new Error('unauthorized');
      error.status = 403;
      return { messages, compacted: false, error };
    },
  } as any;

  assert.equal(await candidate.generate(coordinator, {
    sessionKey: 'candidate-session',
    phase: 'mid_turn',
  }), false);
  assert.equal(attempts, 1);
  assert.equal(candidate.status, 'failed');
  assert.equal(candidate.failureReason, 'authentication');
});

test('candidate does not retry authentication failures', async () => {
  const candidate = new CheckpointCandidate('candidate-auth', createCheckpointSnapshot([user('root')], {
    revision: 1,
  }));
  let attempts = 0;
  const coordinator = {
    compactIfNeeded: async () => {
      attempts++;
      const error: any = new Error('unauthorized');
      error.status = 401;
      throw error;
    },
  } as any;

  assert.equal(await candidate.generate(coordinator, {
    sessionKey: 'candidate-session',
    phase: 'mid_turn',
  }), false);
  assert.equal(attempts, 1);
  assert.equal(candidate.status, 'failed');
});

test('candidate generation failure enters failed state', async () => {
  const candidate = new CheckpointCandidate('candidate-failed', createCheckpointSnapshot([user('root')], {
    revision: 1,
  }));
  const coordinator = {
    compactIfNeeded: async () => { throw new Error('provider unavailable'); },
  } as any;

  assert.equal(await candidate.generate(coordinator, {
    sessionKey: 'candidate-session',
    phase: 'mid_turn',
  }), false);
  assert.equal(candidate.status, 'failed');
});

test('tool exchange validation rejects incomplete and orphan results', () => {
  const call: Message = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }],
  };
  const result: Message = { role: 'tool', content: 'done', tool_call_id: 'call-1' };

  assert.equal(hasCompleteToolExchanges([call]), false);
  assert.equal(hasCompleteToolExchanges([result]), false);
  assert.equal(hasCompleteToolExchanges([call, result]), true);
});

test('tool exchange validation accepts parallel calls split across the snapshot suffix', () => {
  const calls: Message = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } },
      { id: 'call-2', type: 'function', function: { name: 'glob', arguments: '{}' } },
    ],
  };
  const firstResult: Message = { role: 'tool', content: 'read done', tool_call_id: 'call-1' };
  const secondResult: Message = { role: 'tool', content: 'glob done', tool_call_id: 'call-2' };
  const candidate = new CheckpointCandidate('parallel-tools', createCheckpointSnapshot(
    [user('root'), calls],
    { revision: 1 },
  ));
  candidate.complete([user('summary with pending tool boundary'), calls]);

  const prepared = candidate.prepareCommit(
    [user('root'), calls, firstResult, secondResult],
    1,
  );

  assert.ok(prepared.messages);
  assert.equal(hasCompleteToolExchanges(prepared.messages!), true);
});

test('tool exchange validation rejects a partially completed parallel suffix', () => {
  const calls: Message = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } },
      { id: 'call-2', type: 'function', function: { name: 'glob', arguments: '{}' } },
    ],
  };
  assert.equal(hasCompleteToolExchanges([
    calls,
    { role: 'tool', content: 'read done', tool_call_id: 'call-1' },
  ]), false);
});

test('tool exchange validation accepts multiple completed exchanges across assistant turns', () => {
  assert.equal(hasCompleteToolExchanges([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }],
    },
    { role: 'tool', content: 'read done', tool_call_id: 'call-1' },
    { role: 'assistant', content: 'first exchange handled' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'glob', arguments: '{}' } }],
    },
    { role: 'tool', content: 'glob done', tool_call_id: 'call-2' },
    { role: 'assistant', content: 'all exchanges handled' },
  ]), true);
});

test('tool exchange validation rejects a later incomplete exchange after a completed one', () => {
  assert.equal(hasCompleteToolExchanges([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }],
    },
    { role: 'tool', content: 'read done', tool_call_id: 'call-1' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'glob', arguments: '{}' } }],
    },
  ]), false);
});

test('tool exchange validation rejects duplicate call ids and late orphan results', () => {
  const firstCall: Message = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }],
  };
  const duplicateCall: Message = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'glob', arguments: '{}' } }],
  };
  const result: Message = { role: 'tool', content: 'done', tool_call_id: 'call-1' };

  assert.equal(hasCompleteToolExchanges([firstCall, duplicateCall, result]), false);
  assert.equal(hasCompleteToolExchanges([firstCall, result, result]), false);
});

test('ready candidate commits when revision and boundary still match', () => {
  const messages = [user('root'), user('before branch')];
  const candidate = new CheckpointCandidate(
    'candidate-1',
    createCheckpointSnapshot(messages, { revision: 4, episodeId: 'episode-1' }),
  );
  assert.equal(candidate.complete([user('summary')]), true);

  const result = candidate.tryCommit(
    [...messages, user('after branch')],
    4,
    'episode-1',
  );

  assert.equal(result.status, 'committed');
  assert.deepEqual(result.messages?.map(message => message.content), ['summary', 'after branch']);
});

test('candidate remains ready until a prepared commit is confirmed', () => {
  const messages = [user('root')];
  const candidate = new CheckpointCandidate('candidate-prepare', createCheckpointSnapshot(messages, {
    revision: 1,
  }));
  candidate.complete([user('summary')]);

  const prepared = candidate.prepareCommit(messages, 1);

  assert.deepEqual(prepared.messages?.map(message => message.content), ['summary']);
  assert.equal(candidate.status, 'ready');
  assert.equal(candidate.confirmCommit(), true);
  assert.equal(candidate.status, 'committed');
});

test('candidate becomes stale when parent revision changes', () => {
  const messages = [user('root')];
  const candidate = new CheckpointCandidate('candidate-2', createCheckpointSnapshot(messages, {
    revision: 1,
    episodeId: 'episode-1',
  }));
  candidate.complete([user('summary')]);

  const result = candidate.tryCommit([...messages, user('new message')], 2, 'episode-1');

  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'revision_mismatch');
});

test('candidate becomes stale when snapshot prefix changes', () => {
  const candidate = new CheckpointCandidate('candidate-3', createCheckpointSnapshot(
    [user('root'), user('stable')],
    { revision: 1, episodeId: 'episode-1' },
  ));
  candidate.complete([user('summary')]);

  const result = candidate.tryCommit([user('root'), user('changed')], 1, 'episode-1');

  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'boundary_mismatch');
});

test('cancelled candidate cannot commit a late result', () => {
  const candidate = new CheckpointCandidate('candidate-4', createCheckpointSnapshot(
    [user('root')],
    { revision: 1, episodeId: 'episode-1' },
  ));
  assert.equal(candidate.cancel(), true);
  assert.equal(candidate.complete([user('late summary')]), false);

  const result = candidate.tryCommit([user('root')], 1, 'episode-1');

  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'cancelled');
});

test('episode changes invalidate an otherwise matching revision', () => {
  const messages = [user('root')];
  const candidate = new CheckpointCandidate('candidate-5', createCheckpointSnapshot(messages, {
    revision: 7,
    episodeId: 'episode-1',
  }));
  candidate.complete([user('summary')]);

  const result = candidate.tryCommit(messages, 7, 'episode-2');

  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'episode_mismatch');
});
