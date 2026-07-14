import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripAssistantArtifactsFromMessages,
  stripAssistantTranscriptArtifacts,
} from '../src/utils/transcript-artifacts';
import type { Message } from '../src/types';

test('preserves ordinary assistant text mentioning legacy mode-related terms', () => {
  const text = [
    '我检查了 prompt_mode 的兼容代码，当前实现正常。',
    '',
    'async-task.ts 已经写好并通过测试。',
    '',
    'coding-agent adapter 是外部代理适配器，不是 prompt 模式。',
  ].join('\n');

  assert.equal(stripAssistantTranscriptArtifacts(text), text);
});

test('preserves assistant messages mentioning legacy mode-related terms before model context', () => {
  const messages: Message[] = [
    {
      role: 'assistant',
      content: [
        '我检查了 prompt_mode 的兼容代码，当前实现正常。',
        '',
        'async-task.ts 已经写好并通过测试。',
        '',
        'coding-agent adapter 是外部代理适配器，不是 prompt 模式。',
      ].join('\n'),
    },
  ];

  const cleaned = stripAssistantArtifactsFromMessages(messages);

  assert.deepEqual(cleaned, messages);
});
