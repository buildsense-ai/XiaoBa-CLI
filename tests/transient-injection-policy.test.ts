import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeTransientIntent,
  resolveProviderTransientPolicy,
  resolveTurnContextTransientPolicy,
} from '../src/core/transient-injection-policy';
import type { Message } from '../src/types';
import type { ToolDefinition } from '../src/types/tool';

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

const defaultTools = [
  tool('read_file'),
  tool('grep'),
  tool('execute_shell'),
  tool('skill'),
  tool('update_plan'),
  tool('spawn_subagent'),
];

test('plain chat does not request transient mode, skills, cwd, tool guidance, or runner hint', () => {
  const messages: Message[] = [{ role: 'user', content: '早，今天状态怎么样？' }];

  const turnPolicy = resolveTurnContextTransientPolicy(messages);
  const providerPolicy = resolveProviderTransientPolicy({
    messages,
    tools: defaultTools,
    turn: 1,
    executedToolCalls: 0,
    currentDirectory: 'C:\\work\\project',
    surface: 'catscompany',
  });

  assert.equal(turnPolicy.intent.kind, 'plain-chat');
  assert.equal(turnPolicy.injectSkillsList, false);
  assert.equal(providerPolicy.injectEnvironment, false);
  assert.equal(providerPolicy.injectToolGuidance, false);
  assert.equal(providerPolicy.injectRunnerHint, false);
});

test('coding work requests get workspace and tool guidance plus a narrow coding skill list', () => {
  const messages: Message[] = [
    { role: 'user', content: '这个项目 npm run build 报错，帮我定位原因' },
  ];

  const turnPolicy = resolveTurnContextTransientPolicy(messages);
  const providerPolicy = resolveProviderTransientPolicy({
    messages,
    tools: defaultTools,
    turn: 1,
    executedToolCalls: 0,
    currentDirectory: 'C:\\work\\project',
    surface: 'cli',
  });

  assert.equal(turnPolicy.intent.kind, 'workspace');
  assert.equal(turnPolicy.injectSkillsList, true);
  assert.deepEqual(turnPolicy.skillNames, ['coding-context']);
  assert.equal(providerPolicy.injectEnvironment, true);
  assert.equal(providerPolicy.injectToolGuidance, true);
});

test('fixed system mode suppresses duplicate auto mode hints but keeps coding tool context', () => {
  const messages: Message[] = [
    { role: 'system', content: '[mode:coding-agent]\nbase coding prompt' },
    { role: 'user', content: '修一下 src/api/user.ts 的测试失败' },
  ];

  const turnPolicy = resolveTurnContextTransientPolicy(messages);
  const providerPolicy = resolveProviderTransientPolicy({
    messages,
    tools: defaultTools,
    turn: 1,
    executedToolCalls: 0,
    currentDirectory: 'C:\\work\\project',
    surface: 'cli',
  });

  assert.equal(turnPolicy.intent.fixedMode, 'coding-agent');
  assert.equal(turnPolicy.injectSkillsList, true);
  assert.equal(providerPolicy.injectEnvironment, true);
  assert.equal(providerPolicy.injectToolGuidance, true);
});

test('tool loops keep cwd and tool guidance even when the latest user text is terse', () => {
  const messages: Message[] = [
    { role: 'user', content: '继续' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_read',
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      }],
    },
    { role: 'tool', name: 'read_file', tool_call_id: 'call_read', content: 'file contents' },
  ];

  const intent = analyzeTransientIntent(messages);
  const providerPolicy = resolveProviderTransientPolicy({
    messages,
    tools: defaultTools,
    turn: 2,
    executedToolCalls: 1,
    currentDirectory: 'C:\\work\\project',
    surface: 'cli',
  });

  assert.equal(intent.workspaceRelevant, true);
  assert.equal(providerPolicy.injectEnvironment, true);
  assert.equal(providerPolicy.injectToolGuidance, true);
});

test('complex work can request a runner hint when no more specific orchestration hint exists', () => {
  const messages: Message[] = [
    { role: 'user', content: '完整全面优化这个项目的提示词和工具调用策略，做完后给我结论' },
  ];

  const providerPolicy = resolveProviderTransientPolicy({
    messages,
    tools: defaultTools,
    turn: 1,
    executedToolCalls: 0,
    currentDirectory: 'C:\\work\\project',
    surface: 'cli',
    orchestrationHintCount: 0,
  });

  assert.equal(providerPolicy.injectRunnerHint, true);
});
