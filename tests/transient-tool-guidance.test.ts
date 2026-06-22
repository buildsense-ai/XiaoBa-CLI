import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSIENT_TOOL_GUIDANCE_PREFIX,
  buildTransientToolGuidance,
} from '../src/core/transient-tool-guidance';
import { TRANSIENT_RUNNER_HINT_PREFIX } from '../src/core/runner-orchestration-policy';
import { ConversationRunner } from '../src/core/conversation-runner';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import type { Message } from '../src/types';
import type { ToolDefinition, ToolExecutor } from '../src/types/tool';

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    parameters: {
      type: 'object',
      properties: {},
    },
  };
}

test('transient tool guidance is omitted when no tools are enabled', () => {
  assert.equal(buildTransientToolGuidance([]), null);
});

test('transient tool guidance summarizes enabled tool groups without schema detail', () => {
  const message = buildTransientToolGuidance([
    tool('read_file'),
    tool('edit_file'),
    tool('execute_shell'),
    tool('spawn_subagent'),
    tool('custom_tool'),
  ]);

  assert.ok(message);
  assert.equal(message.role, 'user');
  assert.equal(message.__injected, true);
  assert.equal(typeof message.content, 'string');
  assert.equal(message.content.startsWith(TRANSIENT_TOOL_GUIDANCE_PREFIX), true);
  assert.match(message.content, /files\(read_file, edit_file\)/);
  assert.match(message.content, /shell\(execute_shell\)/);
  assert.match(message.content, /subagents\(spawn_subagent\)/);
  assert.match(message.content, /other\(custom_tool\)/);
  assert.doesNotMatch(message.content, /send_text/);
  assert.doesNotMatch(message.content, /description/);
});

test('conversation runner injects transient tool guidance into provider input only', async () => {
  const tools = [tool('read_file'), tool('execute_shell')];
  const executor: ToolExecutor = {
    getToolDefinitions: () => tools,
    executeTool: async () => ({ content: 'unused', role: 'tool', name: 'unused', tool_call_id: 'unused' }),
  };
  let capturedMessages: Message[] = [];
  let capturedTools: ToolDefinition[] = [];
  const aiService = {
    async chat(messages: Message[], providerTools: ToolDefinition[]) {
      capturedMessages = messages;
      capturedTools = providerTools;
      return { content: 'done' };
    },
  };
  const runner = new ConversationRunner(aiService as any, executor, {
    stream: false,
    enableCompression: false,
  });

  const result = await runner.run([{ role: 'user', content: 'inspect this project build failure' }]);

  const guidance = capturedMessages.find(message =>
    typeof message.content === 'string'
    && message.content.startsWith(TRANSIENT_TOOL_GUIDANCE_PREFIX)
  );
  assert.ok(guidance);
  assert.equal(guidance.role, 'user');
  assert.equal(guidance.__injected, true);
  assert.deepEqual(capturedTools.map(providerTool => providerTool.name), ['read_file', 'execute_shell']);
  assert.equal(result.response, 'done');
  assert.equal(result.messages.some(message =>
    typeof message.content === 'string'
    && message.content.startsWith(TRANSIENT_TOOL_GUIDANCE_PREFIX)
  ), false);
});

test('conversation runner omits generic runner hints for plain chat turns', async () => {
  const executor: ToolExecutor = {
    getToolDefinitions: () => [tool('update_plan'), tool('spawn_subagent')],
    executeTool: async () => ({ content: 'unused', role: 'tool', name: 'unused', tool_call_id: 'unused' }),
  };
  const requests: Message[][] = [];
  const aiService = {
    async chat(messages: Message[]) {
      requests.push(messages.map(message => ({ ...message })));
      return { content: requests.length === 1 ? 'first reply' : 'final reply' };
    },
  };
  let pendingUsed = false;
  const runner = new ConversationRunner(aiService as any, executor, {
    stream: false,
    enableCompression: false,
    pendingUserInputProvider: () => {
      if (pendingUsed) return null;
      pendingUsed = true;
      return 'follow up';
    },
  });

  const result = await runner.run([{ role: 'user', content: 'first question' }]);

  assert.equal(requests.length, 2);
  for (const request of requests) {
    const runnerHints = request.filter(message =>
      typeof message.content === 'string'
      && message.content.startsWith(TRANSIENT_RUNNER_HINT_PREFIX)
    );
    assert.equal(runnerHints.length, 0);
  }
  assert.equal(result.response, 'final reply');
  assert.equal(result.messages.some(message =>
    typeof message.content === 'string'
    && message.content.startsWith(TRANSIENT_RUNNER_HINT_PREFIX)
  ), false);
});

test('turn context cleanup removes transient tool guidance if it appears in durable messages', () => {
  const builder = new TurnContextBuilder();
  const durable = builder.removeTransientMessages([
    { role: 'system', content: 'base' },
    {
      role: 'user',
      content: `${TRANSIENT_TOOL_GUIDANCE_PREFIX}\nRuntime context only.`,
      __injected: true,
    },
    { role: 'user', content: 'real question' },
  ]);

  assert.deepEqual(durable.map(message => message.content), ['base', 'real question']);
});
