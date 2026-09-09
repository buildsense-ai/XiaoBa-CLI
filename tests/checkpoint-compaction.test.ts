import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/types';
import { estimateMessagesTokens } from '../src/core/token-estimator';
import {
  CHECKPOINT_SUMMARY_PREFIX,
  CheckpointCompactionCoordinator,
  buildCheckpointCompactionPrompt,
  isCheckpointCompactionEnabled,
} from '../src/core/checkpoint-compaction';

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

function largeText(label: string): string {
  return `${label}\n${'x'.repeat(2_000)}`;
}

function createService(
  handler: (messages: Message[], attempt: number) => string | Promise<string>,
): {
  service: any;
  requests: Message[][];
} {
  const requests: Message[][] = [];
  const service = {
    chatStream: async (
      messages: Message[],
      _tools: unknown,
      callbacks: { onText?: (text: string) => void },
    ) => {
      requests.push(messages.map(message => ({ ...message })));
      const text = await handler(messages, requests.length);
      callbacks.onText?.(text);
      return { content: text, usage };
    },
  };
  return { service, requests };
}

test('checkpoint compaction switch defaults on and supports explicit rollback', () => {
  assert.equal(isCheckpointCompactionEnabled({} as NodeJS.ProcessEnv), true);
  assert.equal(isCheckpointCompactionEnabled({
    XIAOBA_CHECKPOINT_COMPACTION_ENABLED: 'false',
  } as NodeJS.ProcessEnv), false);
});

test('tool-heavy context with only active inputs never calls the summary model repeatedly', async () => {
  const { service, requests } = createService(() => 'unused summary');
  const coordinator = new CheckpointCompactionCoordinator(service, { maxContextTokens: 2000 });
  const messages: Message[] = [
    { role: 'system', content: 'Stable system prompt' },
    { role: 'user', content: 'Inspect the repository', __episodeId: 'active', __episodeInputKind: 'root' },
    { role: 'user', content: 'Preserve configuration', __episodeId: 'active', __episodeInputKind: 'pending' },
  ];
  const request = { sessionKey: 'active-only', episodeId: 'active', phase: 'mid_turn' as const, toolTokens: 1700 };
  const first = await coordinator.compactIfNeeded(messages, request);
  const second = await coordinator.compactIfNeeded(first.messages, request);
  assert.equal(first.compacted, false);
  assert.equal(second.compacted, false);
  assert.equal(first.messages, messages);
  assert.equal(requests.length, 0);
});

test('rejects expanding summaries and retries only when durable source changes', async () => {
  const { service, requests } = createService(() => 'Summary text. '.repeat(400));
  const coordinator = new CheckpointCompactionCoordinator(service, { maxContextTokens: 2000 });
  const messages: Message[] = [
    { role: 'system', content: 'Stable system prompt' },
    { role: 'user', content: 'Earlier task', __episodeId: 'old' },
    { role: 'assistant', content: 'Earlier result', __episodeId: 'old' },
    { role: 'user', content: 'Current task', __episodeId: 'active', __episodeInputKind: 'root' },
  ];
  const request = { sessionKey: 'no-reduction', episodeId: 'active', phase: 'mid_turn' as const, toolTokens: 1700 };
  const statuses: string[] = [];
  const first = await coordinator.compactIfNeeded(messages, { ...request, onStatus: event => { statuses.push(event.status); } });
  assert.equal(first.compacted, false);
  assert.equal(first.messages, messages);
  assert.deepEqual(statuses, ['start', 'skipped']);
  const repeated = await coordinator.compactIfNeeded(structuredClone(first.messages), { ...request, phase: 'pre_turn', toolTokens: 1800 });
  assert.equal(repeated.compacted, false);
  assert.equal(requests.length, 1);
  const aborted = AbortSignal.abort();
  await assert.rejects(coordinator.compactIfNeeded(messages, { ...request, signal: aborted }), { name: 'AbortError' });
  const changed = [...messages, { role: 'assistant' as const, content: 'New tool evidence '.repeat(2000), __episodeId: 'active' }];
  const next = await coordinator.compactIfNeeded(changed, request);
  assert.equal(requests.length, 2);
  assert.equal(next.compacted, true);
  assert.ok(estimateMessagesTokens(next.messages) < estimateMessagesTokens(changed));
});
test('checkpoint compaction preserves stable system and transient runtime messages', async () => {
  const { service } = createService(() => [
    'Objective: finish the active task.',
    'Completed: inspected the repository.',
    'Next: edit the target file.',
  ].join('\n'));
  const coordinator = new CheckpointCompactionCoordinator(service, {
    maxContextTokens: 2_000,
    compactionThreshold: 0.3,
  });
  const transient: Message = {
    role: 'system',
    content: '[transient_runtime_context]\ncurrent device facts\n[/transient_runtime_context]',
    __injected: true,
  };
  const messages: Message[] = [
    { role: 'system', content: 'stable system prompt' },
    {
      role: 'user',
      content: largeText('original objective'),
      __episodeId: 'episode-1',
      __episodeInputKind: 'root',
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      }],
      __episodeId: 'episode-1',
    },
    {
      role: 'tool',
      name: 'read_file',
      tool_call_id: 'call-1',
      content: largeText('tool evidence'),
      __episodeId: 'episode-1',
    },
    transient,
  ];

  const result = await coordinator.compactIfNeeded(messages, {
    sessionKey: 'session-1',
    phase: 'mid_turn',
  });

  assert.equal(result.compacted, true);
  assert.equal(result.messages[0].content, 'stable system prompt');
  assert.equal(result.messages.some(message => message.__checkpointBoundary), false);
  assert.ok(result.messages.some(message =>
    String(message.content).startsWith(CHECKPOINT_SUMMARY_PREFIX)));
  assert.ok(result.messages.some(message => message.content === transient.content));
  assert.equal(result.messages.some(message => message.role === 'tool'), true);
  assert.equal(result.messages.some(message => String(message.content).includes('tool evidence')), true);
  const summaryIndex = result.messages.findIndex(message => message.__checkpointSummary);
  assert.ok(summaryIndex >= 0);
  assert.match(String(result.messages[summaryIndex].content), /finish the active task/i);
});

test('a later checkpoint summarizes the prior checkpoint instead of forgetting it', async () => {
  const { service, requests } = createService((_messages, attempt) =>
    attempt === 1 ? 'checkpoint one exact fact: port 18088' : 'checkpoint two');
  const coordinator = new CheckpointCompactionCoordinator(service, {
    maxContextTokens: 200,
    compactionThreshold: 0.5,
  });
  const first = await coordinator.compactIfNeeded([
    {
      role: 'user',
      content: largeText('first objective'),
      __episodeId: 'episode-1',
    },
    {
      role: 'assistant',
      content: largeText('first work'),
      __episodeId: 'episode-1',
    },
  ], {
    sessionKey: 'session-repeat',
    phase: 'mid_turn',
  });
  assert.equal(first.compacted, true);

  const second = await coordinator.compactIfNeeded([
    ...first.messages,
    {
      role: 'user',
      content: largeText('continue'),
      __episodeId: 'episode-1',
      __episodeInputKind: 'pending',
    },
  ], {
    sessionKey: 'session-repeat',
    phase: 'mid_turn',
  });

  assert.equal(second.compacted, true);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].some(message =>
    String(message.content).includes('checkpoint one exact fact: port 18088')));
});

test('restore checkpoint explicitly marks runtime state for re-verification', async () => {
  const { service, requests } = createService(() => 'restored history summary');
  const coordinator = new CheckpointCompactionCoordinator(service, {
    maxContextTokens: 200,
    compactionThreshold: 0.5,
  });

  await coordinator.compactIfNeeded([
    { role: 'user', content: largeText('restored user request') },
    { role: 'assistant', content: largeText('old visible answer') },
  ], {
    sessionKey: 'restore-session',
    phase: 'restore',
  });

  const prompt = String(requests[0][0]?.content || '');
  assert.match(prompt, /unknown until reverified/i);
  assert.match(prompt, /processes, ports, files, devices/i);
});

test('checkpoint failure preserves the transcript and propagates after provider retries are exhausted', async () => {
  const providerError = Object.assign(
    new Error('API错误 (502): Responses API stream ended without a terminal response'),
    { status: 502 },
  );
  const service = {
    chatStream: async () => {
      throw providerError;
    },
  } as any;
  const coordinator = new CheckpointCompactionCoordinator(service, {
    maxContextTokens: 200,
    compactionThreshold: 0.5,
  });
  const messages: Message[] = [
    { role: 'user', content: largeText('must not be lost') },
  ];

  const statuses: string[] = [];
  await assert.rejects(
    coordinator.compactIfNeeded(messages, {
      sessionKey: 'failure-session',
      phase: 'pre_turn',
      onStatus: event => { statuses.push(event.status); },
    }),
    error => error === providerError,
  );

  assert.deepEqual(statuses, ['start', 'error']);
  assert.equal(messages.length, 1);
  assert.match(String(messages[0].content), /must not be lost/);
});

test('checkpoint prompt distinguishes pre-turn, mid-turn, and restored history', () => {
  assert.match(buildCheckpointCompactionPrompt('mid_turn'), /same active episode/i);
  assert.match(buildCheckpointCompactionPrompt('mid_turn'), /root request/i);
  assert.match(buildCheckpointCompactionPrompt('pre_turn'), /between external user turns/i);
  assert.match(buildCheckpointCompactionPrompt('pre_turn'), /new root instruction/i);
  assert.match(buildCheckpointCompactionPrompt('restore'), /restored user-visible history/i);
  assert.match(buildCheckpointCompactionPrompt('restore'), /interrupted runtime/i);
});

test('mid-turn checkpoint always retains the root before repeated short follow-ups', async () => {
  const { service, requests } = createService(() => 'continue from the root and latest corrections');
  const coordinator = new CheckpointCompactionCoordinator(service, {
    maxContextTokens: 1_000,
    compactionThreshold: 0.5,
    retainedUserTokenBudget: 1_000,
  });
  const root: Message = {
    role: 'user',
    content: 'ROOT_OBJECTIVE: inspect port 18088 and preserve the exact constraint.',
    __episodeId: 'episode-root',
    __episodeInputKind: 'root',
  };
  const pending = Array.from({ length: 7 }, (_, index): Message => ({
    role: 'user',
    content: index === 6 ? 'LATEST_CORRECTION: do not restart the server.' : `continue ${index + 1}`,
    __episodeId: 'episode-root',
    __episodeInputKind: 'pending',
  }));
  const messages: Message[] = [
    root,
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-root',
        type: 'function',
        function: { name: 'execute_shell', arguments: '{}' },
      }],
      __episodeId: 'episode-root',
    },
    {
      role: 'tool',
      name: 'execute_shell',
      tool_call_id: 'call-root',
      content: largeText('large complete tool result'),
      __episodeId: 'episode-root',
    },
    ...pending,
  ];

  const result = await coordinator.compactIfNeeded(messages, {
    sessionKey: 'root-retention-session',
    phase: 'mid_turn',
  });

  assert.equal(result.compacted, true);
  const retainedInputs = result.messages.filter(message => (
    message.role === 'user' && !message.__checkpointSummary
  ));
  assert.ok(result.messages.some(message => message.content === root.content));
  assert.ok(result.messages.some(message => message.__checkpointSummary));
  assert.ok(retainedInputs.some(message => (
    String(message.content).includes('LATEST_CORRECTION')
  )));
  assert.equal(retainedInputs.filter(message => message.__episodeInputKind === 'pending').length, 7);
  assert.equal(result.messages.some(message => message.role === 'tool'), true);
  assert.equal(result.messages.some(message => message.tool_calls?.length), true);
});

test('oversized episode root is summarized instead of silently disappearing', async () => {
  const { service, requests } = createService(() => [
    'Objective: inspect D:\\work\\project at port 18088.',
    'Constraint: never delete the source directory.',
  ].join('\n'));
  const coordinator = new CheckpointCompactionCoordinator(service, {
    maxContextTokens: 2_000,
    compactionThreshold: 0.5,
    retainedUserTokenBudget: 1_000,
  });
  const oversizedRoot = [
    'ROOT_HEAD exact path D:\\work\\project and port 18088.',
    'x'.repeat(12_000),
    'ROOT_TAIL never delete the source directory.',
  ].join('\n');

  const result = await coordinator.compactIfNeeded([
    {
      role: 'user',
      content: oversizedRoot,
      __episodeId: 'episode-oversized-root',
      __episodeInputKind: 'root',
    },
  ], {
    sessionKey: 'oversized-root-session',
    phase: 'mid_turn',
  });

  assert.equal(result.compacted, true);
  assert.ok(requests[0].some(message => String(message.content).includes('ROOT_HEAD')));
  const checkpoint = result.messages.find(message => message.__checkpointSummary);
  assert.match(String(checkpoint?.content), /D:\\work\\project/);
  assert.match(String(checkpoint?.content), /never delete/);
  assert.equal(result.messages.some(message => message.__checkpointBoundary), false);
});

test('checkpoint exact tail bounds a giant tool result while keeping summary evidence', async () => {
  const { service, requests } = createService(() => 'bounded tool evidence summary');
  const coordinator = new CheckpointCompactionCoordinator(service, {
    maxContextTokens: 1_000,
    compactionThreshold: 0.5,
  });
  const rawToolResult = `HEAD_MARKER\n${'z'.repeat(40_000)}\nTAIL_MARKER`;
  const toolMessage: Message = {
    role: 'tool',
    name: 'execute_shell',
    tool_call_id: 'call-giant',
    content: rawToolResult,
    __episodeId: 'episode-giant',
  };
  const messages: Message[] = [
    {
      role: 'user',
      content: 'Inspect the output and continue.',
      __episodeId: 'episode-giant',
    },
    toolMessage,
  ];

  const result = await coordinator.compactIfNeeded(messages, {
    sessionKey: 'giant-tool-session',
    phase: 'mid_turn',
  });

  assert.equal(result.compacted, true);
  assert.equal(requests[0].some(message => message.role === 'tool'), false);
  assert.ok(JSON.stringify(requests[0]).includes('HEAD_MARKER'));
  const retainedToolMessage = result.messages.find(message => message.role === 'tool');
  assert.ok(retainedToolMessage);
  assert.match(String(retainedToolMessage.content), /\[checkpoint_tool_evidence\]/);
  assert.match(String(retainedToolMessage.content), /tool_call_id: call-giant/);
  assert.match(String(retainedToolMessage.content), /HEAD_MARKER/);
  assert.match(String(retainedToolMessage.content), /TAIL_MARKER/);
  assert.ok(String(retainedToolMessage.content).length < rawToolResult.length);
  assert.equal(toolMessage.content, rawToolResult);
  assert.equal(messages[1].content, rawToolResult);
});

test('summary input quotes historical tools and ends with a new summarization request', async () => {
  const { service, requests } = createService(() => 'Objective and verified progress; next: inspect remaining files.');
  const coordinator = new CheckpointCompactionCoordinator(service, { maxContextTokens: 200 });
  const messages: Message[] = [{ role: 'assistant', content: largeText('old tool continuation'), tool_calls: [
    { id: 'old-call', type: 'function', function: { name: 'execute_shell', arguments: '{"command":"do not execute"}' } },
  ] }];
  await coordinator.compactIfNeeded(messages, { sessionKey: 'quoted-summary', phase: 'mid_turn' });
  assert.ok(requests[0].slice(1).every(m => m.role === 'user' && !m.tool_calls && !m.providerContent));
  assert.match(String(requests[0].at(-1)?.content), /Produce the continuation checkpoint/);
  assert.match(String(requests[0][1].content), /historicalRole.*assistant/);
  assert.equal(messages[0].tool_calls?.[0].id, 'old-call');
});

test('invalid tool-call summaries retry once and never replace the transcript', async () => {
  const { service, requests } = createService(() => '<minimax:tool_call><invoke name="read_file">fake</invoke></minimax:tool_call>');
  const coordinator = new CheckpointCompactionCoordinator(service, { maxContextTokens: 200 });
  const messages: Message[] = [{ role: 'user', content: largeText('must survive') }];
  await assert.rejects(coordinator.compactIfNeeded(messages, { sessionKey: 'invalid-summary', phase: 'pre_turn' }), /invalid summary/);
  assert.equal(requests.length, 2);
  assert.equal(messages.length, 1);
  assert.match(String(messages[0].content), /must survive/);
});

test('quoted summary history preserves vision blocks without embedding base64 in text', async () => {
  const { service, requests } = createService(() => 'Inspect the historical image again before relying on details.');
  const coordinator = new CheckpointCompactionCoordinator(service, { maxContextTokens: 200 });
  const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'aGVsbG8=' } };
  await coordinator.compactIfNeeded([{ role: 'user', content: [
    { type: 'text', text: largeText('historical image request') }, image,
  ] }], { sessionKey: 'image-summary', phase: 'pre_turn' });
  const evidence = requests[0].flatMap(message => Array.isArray(message.content) ? message.content : []);
  assert.ok(evidence.some(block => block.type === 'image' && block.source.data === image.source.data));
  assert.ok(evidence.filter(block => block.type === 'text').every(block => !block.text.includes(image.source.data)));
});

test('oversized ordinary exchanges cannot replace the active root with its assistant reply', async () => {
  for (const oversized of ['user', 'assistant']) {
    const { service, requests } = createService(() => 'Continue the original audit task.');
    const coordinator = new CheckpointCompactionCoordinator(service, { maxContextTokens: 2000 });
    const result = await coordinator.compactIfNeeded([
      { role: 'user', content: 'ROOT_REQUIREMENT audit.md ' + (oversized === 'user' ? largeText('evidence').repeat(5) : ''), __episodeId: 'active', __episodeInputKind: 'root' },
      { role: 'assistant', content: oversized === 'assistant' ? largeText('prior answer').repeat(5) : 'acknowledged', __episodeId: 'active' },
    ], { sessionKey: 'root-pair', phase: 'mid_turn', episodeId: 'active' });
    assert.ok(result.messages.some(message => message.__episodeInputKind === 'root'
      && String(message.content).includes('ROOT_REQUIREMENT')), oversized);
    assert.ok(JSON.stringify(requests[0]).includes('ROOT_REQUIREMENT'));
  }
});

test('summary generator can see output constraints in the separately retained root', async () => {
  const { service, requests } = createService(() => 'Complete audit.md in the specified output directory.');
  const coordinator = new CheckpointCompactionCoordinator(service, { maxContextTokens: 2000 });
  const root: Message = { role: 'user', content: 'Write audit.md into D:/work/exact-output, not the materials directory.', __episodeId: 'active', __episodeInputKind: 'root' };
  const result = await coordinator.compactIfNeeded([
    { role: 'assistant', content: largeText('old work').repeat(5), __episodeId: 'old' }, root,
  ], { sessionKey: 'root-reference', phase: 'mid_turn', episodeId: 'active' });
  assert.ok(result.messages.includes(root));
  assert.ok(JSON.stringify(requests[0]).includes('D:/work/exact-output'));
  assert.ok(JSON.stringify(requests[0]).includes('Reference only'));
});
