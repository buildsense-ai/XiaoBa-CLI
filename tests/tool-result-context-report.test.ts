import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatToolResultContextReport,
  resolveToolResultContextReportOptions,
  summarizeToolResultContext,
} from '../src/core/tool-result-context-report';
import { Message } from '../src/types';

function tool(name: string, content: string, id: string): Message {
  return {
    role: 'tool',
    name,
    tool_call_id: id,
    content,
  };
}

test('summarizes tool result context by tool name and largest messages', () => {
  const messages: Message[] = [
    { role: 'system', content: 'system prompt' },
    tool('read_file', 'r'.repeat(100), 'read_1'),
    tool('execute_shell', 's'.repeat(300), 'shell_1'),
    tool('Bash', 'b'.repeat(250), 'shell_2'),
    tool('grep', 'g'.repeat(20), 'grep_1'),
    { role: 'user', content: 'continue' },
  ];

  const summary = summarizeToolResultContext(messages, {
    topTools: 3,
    topMessages: 2,
  });

  assert.equal(summary.tool_result_count, 4);
  assert.equal(summary.total_chars, 670);
  assert.equal(summary.by_tool[0].name, 'execute_shell');
  assert.equal(summary.by_tool[0].count, 2);
  assert.equal(summary.by_tool[0].chars, 550);
  assert.equal(summary.by_tool[1].name, 'read_file');
  assert.deepEqual(summary.largest_messages.map(item => item.index), [2, 3]);
});

test('formats before and after tool result context savings', () => {
  const before = summarizeToolResultContext([
    tool('execute_shell', 'x'.repeat(1000), 'shell_1'),
    tool('read_file', 'y'.repeat(500), 'read_1'),
  ]);
  const after = summarizeToolResultContext([
    tool('execute_shell', '[truncated_execute_shell]\nsummary', 'shell_1'),
    tool('read_file', 'y'.repeat(500), 'read_1'),
  ]);

  const lines = formatToolResultContextReport(before, after);

  assert.equal(lines.length, 3);
  assert.match(lines[0], /tool_result context: before=2 results\/1500 chars/);
  assert.match(lines[0], /saved=\d+ chars\/\d+ tokens_est/);
  assert.match(lines[1], /execute_shell count=1 chars=1000/);
  assert.match(lines[2], /#0 execute_shell chars=1000/);
});

test('environment options can disable context report and set top counts', () => {
  const env = {
    XIAOBA_TOOL_RESULT_CONTEXT_REPORT: '0',
    XIAOBA_TOOL_RESULT_CONTEXT_REPORT_TOP_TOOLS: '7',
    XIAOBA_TOOL_RESULT_CONTEXT_REPORT_TOP_MESSAGES: '9',
  } as NodeJS.ProcessEnv;

  const options = resolveToolResultContextReportOptions(env);

  assert.equal(options.enabled, false);
  assert.equal(options.topTools, 7);
  assert.equal(options.topMessages, 9);
});
