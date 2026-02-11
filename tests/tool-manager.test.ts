import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolManager } from '../src/tools/tool-manager';
import { ToolCall } from '../src/types/tool';

test('tool manager returns INVALID_TOOL_ARGUMENTS for malformed JSON', async () => {
  const manager = new ToolManager(process.cwd());

  const toolCall: ToolCall = {
    id: 'test-call-1',
    type: 'function',
    function: {
      name: 'read_file',
      arguments: '{not-json',
    },
  };

  const result = await manager.executeTool(toolCall, []);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
});

test('tool manager returns TOOL_NOT_FOUND for unknown tool', async () => {
  const manager = new ToolManager(process.cwd());

  const toolCall: ToolCall = {
    id: 'test-call-2',
    type: 'function',
    function: {
      name: 'not_exists_tool',
      arguments: '{}',
    },
  };

  const result = await manager.executeTool(toolCall, []);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'TOOL_NOT_FOUND');
});

test('tool manager blocks tool outside allowedToolNames', async () => {
  const manager = new ToolManager(process.cwd());

  const toolCall: ToolCall = {
    id: 'test-call-3',
    type: 'function',
    function: {
      name: 'read_file',
      arguments: JSON.stringify({ file_path: 'README.md' }),
    },
  };

  const result = await manager.executeTool(toolCall, [], {
    allowedToolNames: ['glob'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'TOOL_NOT_ALLOWED_BY_SKILL_POLICY');
});
