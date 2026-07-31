import test from 'node:test';
import assert from 'node:assert/strict';
import { Message } from '../src/types';
import { stabilizeToolResultsForHistory } from '../src/core/stable-tool-result-history';
import { foldHistoricalReadFileMessages, TRUNCATED_READ_FILE_PREFIX } from '../src/core/read-file-message-folder';

function makeToolCall(id: string, name: string): Message {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: { name, arguments: '{}' },
    }],
  };
}

const readOptions = {
  enabled: true,
  thresholdTokens: 100,
  maxPreviewLines: 2,
  maxSymbolLines: 2,
  keepRecentHistoricalReads: 0,
  foldCurrentRun: false,
};

const shellOptions = {
  enabled: true,
  thresholdTokens: 100,
  maxHeadLines: 2,
  maxTailLines: 2,
  maxKeyLines: 2,
  keepRecentHistoricalShells: 0,
  foldCurrentRun: false,
};

test('stabilizes a tool result once and keeps the persisted prefix byte-identical', () => {
  const raw = ['File: /repo/a.ts', 'Path: /repo/a.ts', '', '1→ const value = 1;\n'.repeat(300)].join('\n');
  const toolResult: Message = {
    role: 'tool',
    name: 'read_file',
    tool_call_id: 'read_1',
    content: raw,
  };
  const messages: Message[] = [
    { role: 'user', content: 'inspect it' },
    makeToolCall('read_1', 'read_file'),
    toolResult,
    { role: 'assistant', content: 'done' },
  ];
  const newMessages = messages.slice(1);

  const first = stabilizeToolResultsForHistory(messages, newMessages, readOptions, shellOptions);
  const stableContent = String(messages[2].content);

  assert.equal(first.readFileFoldedCount, 1);
  assert.equal(messages[2].__toolResultStable, true);
  assert.equal(newMessages[1].__toolResultStable, true);
  assert.ok(stableContent.startsWith(TRUNCATED_READ_FILE_PREFIX));
  assert.equal(newMessages[1].content, stableContent);

  messages.push({ role: 'user', content: 'continue' });
  const second = stabilizeToolResultsForHistory(messages, [], {
    ...readOptions,
    thresholdTokens: 1,
    maxPreviewLines: 1,
    maxSymbolLines: 1,
  }, shellOptions);
  const adaptiveAttempt = foldHistoricalReadFileMessages(messages, {
    ...readOptions,
    thresholdTokens: 1,
    maxPreviewLines: 1,
    maxSymbolLines: 1,
  });

  assert.equal(second.readFileFoldedCount, 0);
  assert.equal(adaptiveAttempt.stats.folded_count, 0);
  assert.equal(messages[2].content, stableContent);
  assert.equal(adaptiveAttempt.messages[2].content, stableContent);
});

test('small supported results are also frozen instead of being rewritten by a later lower threshold', () => {
  const messages: Message[] = [
    { role: 'user', content: 'inspect it' },
    makeToolCall('read_small', 'read_file'),
    { role: 'tool', name: 'read_file', tool_call_id: 'read_small', content: 'short output' },
  ];

  stabilizeToolResultsForHistory(messages, [], readOptions, shellOptions);
  const original = messages[2].content;
  messages.push({ role: 'user', content: 'continue' });
  const later = foldHistoricalReadFileMessages(messages, {
    ...readOptions,
    thresholdTokens: 1,
  });

  assert.equal(messages[2].__toolResultStable, true);
  assert.equal(later.stats.folded_count, 0);
  assert.equal(later.messages[2].content, original);
});
