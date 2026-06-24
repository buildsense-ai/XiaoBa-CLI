import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCurrentRunToolResultFoldingOptions,
  selectProtectedCurrentRunToolResultIndexes,
} from '../src/core/current-run-tool-result-folding';
import { Message } from '../src/types';

function tool(name: string, content: string, id: string): Message {
  return {
    role: 'tool',
    name,
    tool_call_id: id,
    content,
  };
}

test('selects the most recent current-run foldable tool results for protection', () => {
  const messages: Message[] = [
    { role: 'user', content: 'inspect project' },
    tool('read_file', 'old read', 'read_1'),
    tool('grep', 'small grep', 'grep_1'),
    tool('execute_shell', 'old shell', 'shell_1'),
    tool('Bash', 'recent shell', 'shell_2'),
    tool('read_file', 'recent read', 'read_2'),
  ];

  const protectedIndexes = selectProtectedCurrentRunToolResultIndexes(messages, {
    enabled: true,
    keepRecentToolResults: 2,
  });

  assert.deepEqual(Array.from(protectedIndexes), [4, 5]);
});

test('ignores historical tool results before the latest real user', () => {
  const messages: Message[] = [
    { role: 'user', content: 'old request' },
    tool('read_file', 'historical read', 'read_old'),
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'new request' },
    tool('execute_shell', 'current shell', 'shell_current'),
  ];

  const protectedIndexes = selectProtectedCurrentRunToolResultIndexes(messages, {
    enabled: true,
    keepRecentToolResults: 3,
  });

  assert.deepEqual(Array.from(protectedIndexes), [4]);
});

test('environment options can disable current-run folding and set keep window', () => {
  const env = {
    XIAOBA_CURRENT_RUN_TOOL_RESULT_FOLDING: '0',
    XIAOBA_CURRENT_RUN_TOOL_RESULT_FOLD_KEEP_RECENT: '5',
  } as NodeJS.ProcessEnv;

  const options = resolveCurrentRunToolResultFoldingOptions(env);

  assert.equal(options.enabled, false);
  assert.equal(options.keepRecentToolResults, 5);
});
