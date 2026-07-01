import test from 'node:test';
import assert from 'node:assert/strict';
import { PromptModeTool } from '../src/tools/prompt-mode-tool';
import { ToolManager } from '../src/tools/tool-manager';

test('prompt_mode tool loads full prompt mode instructions on demand', async () => {
  const tool = new PromptModeTool();

  const result = await tool.execute({ mode: 'coding-agent' }, {
    workingDirectory: process.cwd(),
    conversationHistory: [],
  });

  assert.equal(result.ok, true);
  assert.match(String(result.content), /previously active prompt mode/);
  assert.match(String(result.content), /\[mode:coding-agent\]/);
  assert.match(String(result.content), /工程协作模式/);
});

test('prompt_mode tool loads plain-chat instructions on demand', async () => {
  const tool = new PromptModeTool();

  const result = await tool.execute({ mode: 'plain-chat' }, {
    workingDirectory: process.cwd(),
    conversationHistory: [],
  });

  assert.equal(result.ok, true);
  assert.match(String(result.content), /\[mode:plain-chat\]/);
  assert.match(String(result.content), /普通对话模式/);
  assert.match(String(result.content), /角色扮演/);
});

test('prompt_mode is not exposed as a default runtime tool', () => {
  const manager = new ToolManager(process.cwd());

  assert.equal(manager.getToolDefinitions().some(tool => tool.name === 'prompt_mode'), false);
});

test('prompt_mode can clear an async active mode through runtime context', async () => {
  const tool = new PromptModeTool();
  let clearReason = '';

  const result = await tool.execute({ mode: 'clear' }, {
    workingDirectory: process.cwd(),
    conversationHistory: [],
    promptModeRuntime: {
      getActiveMode: () => ({ mode: 'coding-agent' }),
      clear: (reason?: string) => {
        clearReason = reason || '';
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(clearReason, 'prompt_mode_tool_clear');
  assert.match(String(result.content), /Cleared active prompt mode "coding-agent"/);
});

test('prompt_mode does not reload the already active fixed mode', async () => {
  const tool = new PromptModeTool();

  const result = await tool.execute({ mode: 'coding-agent' }, {
    workingDirectory: process.cwd(),
    conversationHistory: [
      { role: 'system', content: 'base\n[mode:coding-agent]\nfixed coding instructions' },
      { role: 'user', content: '继续' },
    ],
  });

  assert.equal(result.ok, true);
  assert.match(String(result.content), /already active/);
  assert.doesNotMatch(String(result.content), /\n\[mode:coding-agent\]/);
});

test('prompt_mode rejects a different mode when a fixed mode is active', async () => {
  const tool = new PromptModeTool();

  const result = await tool.execute({ mode: 'office' }, {
    workingDirectory: process.cwd(),
    conversationHistory: [
      { role: 'system', content: 'base\n[mode:coding-agent]\nfixed coding instructions' },
      { role: 'user', content: '帮我整理 PPT' },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'PERMISSION_DENIED');
  assert.match(String(result.message), /fixed prompt mode "coding-agent"/);
});
