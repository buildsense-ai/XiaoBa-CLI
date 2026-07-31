import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/types';
import {
  CHECKPOINT_COMPACTION_BOUNDARY_PREFIX,
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

test('checkpoint compaction preserves stable system and transient runtime messages', async () => {
  const { service } = createService(() => [
    'Objective: finish the active task.',
    'Completed: inspected the repository.',
    'Next: edit the target file.',
  ].join('\n'));
  const coordinator = new CheckpointCompactionCoordinator(service, {
    maxContextTokens: 200,
    compactionThreshold: 0.5,
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
  assert.ok(result.messages.some(message =>
    String(message.content).startsWith(CHECKPOINT_COMPACTION_BOUNDARY_PREFIX)));
  assert.ok(result.messages.some(message =>
    String(message.content).startsWith(CHECKPOINT_SUMMARY_PREFIX)));
  assert.ok(result.messages.some(message => message.content === transient.content));
  assert.equal(result.messages.some(message => message.role === 'tool'), false);
  assert.equal(
    result.messages.some(message => String(message.content).includes('tool evidence')),
    false,
  );
  const summaryIndex = result.messages.findIndex(message => message.__checkpointSummary);
  const retainedUserIndex = result.messages.findIndex(message =>
    message.role === 'user' && String(message.content).includes('original objective'));
  assert.ok(summaryIndex >= 0 && retainedUserIndex > summaryIndex);
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

test('checkpoint failure preserves the original transcript for emergency fallback', async () => {
  const service = {
    chatStream: async () => {
      throw new Error('provider unavailable');
    },
  } as any;
  const coordinator = new CheckpointCompactionCoordinator(service, {
    maxContextTokens: 200,
    compactionThreshold: 0.5,
  });
  const messages: Message[] = [
    { role: 'user', content: largeText('must not be lost') },
  ];

  const result = await coordinator.compactIfNeeded(messages, {
    sessionKey: 'failure-session',
    phase: 'pre_turn',
  });

  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
  assert.equal(result.messages[0].content, messages[0].content);
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
  const { service } = createService(() => 'continue from the root and latest corrections');
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
  assert.equal(retainedInputs[0]?.content, root.content);
  assert.ok(retainedInputs.some(message => (
    String(message.content).includes('LATEST_CORRECTION')
  )));
  assert.equal(retainedInputs.filter(message => message.__episodeInputKind === 'pending').length, 7);
  assert.equal(result.messages.some(message => message.role === 'tool'), false);
  assert.equal(result.messages.some(message => message.tool_calls?.length), false);
});

test('oversized episode root becomes explicit bounded evidence instead of disappearing', async () => {
  const { service } = createService(() => 'summary includes the complete oversized objective');
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
  const retainedRoot = result.messages.find(message => (
    message.__episodeInputKind === 'root' && !message.__checkpointSummary
  ));
  assert.ok(retainedRoot);
  assert.match(String(retainedRoot.content), /\[checkpoint_user_input_evidence\]/);
  assert.match(String(retainedRoot.content), /sha256: [a-f0-9]{64}/);
  assert.match(String(retainedRoot.content), /ROOT_HEAD/);
  assert.match(String(retainedRoot.content), /ROOT_TAIL/);
  assert.ok(estimateRetainedTextLength(retainedRoot) < oversizedRoot.length);
});

test('checkpoint summary bounds a giant tool result without mutating durable evidence', async () => {
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
  const summaryToolMessage = requests[0].find(message => message.role === 'tool');
  assert.ok(summaryToolMessage);
  assert.match(String(summaryToolMessage.content), /\[checkpoint_tool_evidence\]/);
  assert.match(String(summaryToolMessage.content), /tool_call_id: call-giant/);
  assert.match(String(summaryToolMessage.content), /HEAD_MARKER/);
  assert.match(String(summaryToolMessage.content), /TAIL_MARKER/);
  assert.ok(String(summaryToolMessage.content).length < rawToolResult.length);
  assert.equal(toolMessage.content, rawToolResult);
  assert.equal(messages[1].content, rawToolResult);
});

function estimateRetainedTextLength(message: Message): number {
  return typeof message.content === 'string'
    ? message.content.length
    : JSON.stringify(message.content).length;
}
