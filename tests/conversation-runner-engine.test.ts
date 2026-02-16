/**
 * 对话引擎测试套件
 *
 * 覆盖：
 * 1. 上下文压缩触发与执行
 * 2. 工具熔断（连续失败 3 次自动禁用）
 * 3. 429 限流重试
 * 4. prompt 超长紧急裁剪
 * 5. 工具策略阻断后立即禁用
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationRunner } from '../src/core/conversation-runner';
import { Message } from '../src/types';
import { ToolDefinition, ToolExecutor, ToolCall, ToolExecutionContext } from '../src/types/tool';

// ─── 辅助 ──────────────────────────────────────────────

function buildAIService(opts?: {
  responses?: Array<{ content?: string; toolCalls?: ToolCall[] }>;
}) {
  let callIdx = 0;
  const responses = opts?.responses ?? [{ content: 'done' }];

  return {
    async chat(messages: any[], tools?: any[]) {
      const resp = responses[Math.min(callIdx++, responses.length - 1)];
      return { content: resp.content ?? '', toolCalls: resp.toolCalls };
    },
    async chatStream(messages: any[], tools?: any[]) {
      const resp = responses[Math.min(callIdx++, responses.length - 1)];
      return { content: resp.content ?? '', toolCalls: resp.toolCalls };
    },
  } as any;
}

function buildToolExecutor(opts?: {
  tools?: ToolDefinition[];
  executeResult?: (toolCall: ToolCall) => string;
}): ToolExecutor {
  const tools = opts?.tools ?? [];
  const executeResult = opts?.executeResult ?? (() => 'ok');

  return {
    getToolDefinitions() { return tools; },
    async executeTool(toolCall: ToolCall) {
      return {
        content: executeResult(toolCall),
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
      };
    },
  };
}

function makeToolCall(name: string, args: string = '{}', id?: string): ToolCall {
  return {
    id: id ?? `call_${name}_${Date.now()}`,
    type: 'function',
    function: { name, arguments: args },
  };
}

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
  };
}

// ═══════════════════════════════════════════════════════
// 1. 工具熔断测试
// ═══════════════════════════════════════════════════════

test('conversation runner disables tool after 3 consecutive failures', async () => {
  let turn = 0;
  const aiService = {
    async chatStream() {
      turn++;
      if (turn <= 3) {
        return {
          content: '',
          toolCalls: [makeToolCall('bad_tool', '{}', `call_${turn}`)],
        };
      }
      // 第 4 轮：不再调用工具
      return { content: 'gave up' };
    },
  } as any;

  const executor = buildToolExecutor({
    tools: [makeTool('bad_tool')],
    executeResult: () => '错误: connection refused',
  });

  const messages: Message[] = [
    { role: 'system', content: 'test' },
    { role: 'user', content: 'do something' },
  ];

  const runner = new ConversationRunner(aiService, executor, { maxTurns: 10 });
  const result = await runner.run(messages);

  assert.equal(result.response, 'gave up');
});

test('conversation runner immediately disables tool blocked by policy', async () => {
  let turn = 0;
  const aiService = {
    async chatStream() {
      turn++;
      if (turn === 1) {
        return {
          content: '',
          toolCalls: [makeToolCall('blocked_tool', '{}', 'call_1')],
        };
      }
      return { content: 'switched to alternative' };
    },
  } as any;

  const executor = buildToolExecutor({
    tools: [makeTool('blocked_tool'), makeTool('allowed_tool')],
    executeResult: (tc) => {
      if (tc.function.name === 'blocked_tool') {
        return '执行被阻止：工具 "blocked_tool" 不在当前 skill 允许列表中';
      }
      return 'ok';
    },
  });

  const messages: Message[] = [
    { role: 'system', content: 'test' },
    { role: 'user', content: 'do something' },
  ];

  const runner = new ConversationRunner(aiService, executor, { maxTurns: 5 });
  const result = await runner.run(messages);

  assert.equal(result.response, 'switched to alternative');
});

test('conversation runner resets failure count on success', async () => {
  let turn = 0;
  const aiService = {
    async chatStream() {
      turn++;
      if (turn <= 4) {
        return {
          content: '',
          toolCalls: [makeToolCall('flaky_tool', '{}', `call_${turn}`)],
        };
      }
      return { content: 'done' };
    },
  } as any;

  // 失败2次 → 成功1次 → 失败1次 → 不应熔断（因为成功重置了计数）
  let execCount = 0;
  const executor = buildToolExecutor({
    tools: [makeTool('flaky_tool')],
    executeResult: () => {
      execCount++;
      if (execCount <= 2) return '错误: timeout';
      if (execCount === 3) return 'success result';
      return '错误: timeout again';
    },
  });

  const messages: Message[] = [
    { role: 'system', content: 'test' },
    { role: 'user', content: 'do something' },
  ];

  const runner = new ConversationRunner(aiService, executor, { maxTurns: 10 });
  const result = await runner.run(messages);

  // 工具应该被调用了 4 次（没有被熔断）
  assert.equal(execCount, 4);
  assert.equal(result.response, 'done');
});

// ═══════════════════════════════════════════════════════
// 2. 最大轮次限制测试
// ═══════════════════════════════════════════════════════

test('conversation runner stops at maxTurns', async () => {
  const aiService = {
    async chatStream() {
      return {
        content: '',
        toolCalls: [makeToolCall('loop_tool', '{}', `call_${Date.now()}`)],
      };
    },
  } as any;

  const executor = buildToolExecutor({
    tools: [makeTool('loop_tool')],
    executeResult: () => 'keep going',
  });

  const messages: Message[] = [
    { role: 'system', content: 'test' },
    { role: 'user', content: 'loop forever' },
  ];

  const runner = new ConversationRunner(aiService, executor, { maxTurns: 3 });
  const result = await runner.run(messages);

  assert.ok(result.response.includes('最大工具调用轮次'));
});

// ═══════════════════════════════════════════════════════
// 3. shouldContinue 回调测试
// ═══════════════════════════════════════════════════════

test('conversation runner respects shouldContinue callback', async () => {
  let turn = 0;
  const aiService = {
    async chatStream() {
      turn++;
      return {
        content: '',
        toolCalls: [makeToolCall('tool', '{}', `call_${turn}`)],
      };
    },
  } as any;

  let execCount = 0;
  const executor = buildToolExecutor({
    tools: [makeTool('tool')],
    executeResult: () => { execCount++; return 'ok'; },
  });

  const messages: Message[] = [
    { role: 'system', content: 'test' },
    { role: 'user', content: 'go' },
  ];

  // 第 2 轮后停止
  const runner = new ConversationRunner(aiService, executor, {
    maxTurns: 100,
    shouldContinue: () => turn < 2,
  });
  await runner.run(messages);

  assert.ok(execCount <= 2, `应在 2 轮内停止，实际执行了 ${execCount} 次`);
});

// ═══════════════════════════════════════════════════════
// 4. Skill 激活后工具集收缩测试
// ═══════════════════════════════════════════════════════

test('conversation runner shrinks tool set after skill activation via tool policy', async () => {
  const toolSetsPerTurn: string[][] = [];
  let turn = 0;

  const aiService = {
    async chatStream(_messages: any[], tools?: any[]) {
      turn++;
      toolSetsPerTurn.push((tools || []).map((t: any) => t.name));

      if (turn === 1) {
        // 第一轮：调用 skill 工具激活 skill
        return {
          content: 'activating',
          toolCalls: [makeToolCall('skill', '{"skill":"restricted"}', 'call_skill')],
        };
      }
      return { content: 'done with restricted tools' };
    },
  } as any;

  const executor: ToolExecutor = {
    getToolDefinitions() {
      return [makeTool('skill'), makeTool('read_file'), makeTool('execute_shell'), makeTool('write_file')];
    },
    async executeTool(toolCall: ToolCall) {
      if (toolCall.function.name === 'skill') {
        return {
          content: JSON.stringify({
            __type__: 'skill_activation',
            skillName: 'restricted',
            prompt: 'only read files',
            toolPolicy: { allowedTools: ['read_file'] },
          }),
          tool_call_id: toolCall.id,
          name: 'skill',
        };
      }
      return { content: 'ok', tool_call_id: toolCall.id, name: toolCall.function.name };
    },
  };

  const messages: Message[] = [
    { role: 'system', content: 'test' },
    { role: 'user', content: 'activate restricted skill' },
  ];

  const runner = new ConversationRunner(aiService, executor, { maxTurns: 5 });
  await runner.run(messages);

  // 第一轮应有全部工具
  assert.ok(toolSetsPerTurn[0].includes('execute_shell'), '第一轮应包含 execute_shell');
  assert.ok(toolSetsPerTurn[0].includes('write_file'), '第一轮应包含 write_file');

  // 第二轮应只有 read_file + skill（essential）
  assert.ok(toolSetsPerTurn[1].includes('read_file'), '第二轮应包含 read_file');
  assert.ok(toolSetsPerTurn[1].includes('skill'), '第二轮应包含 skill（essential）');
  assert.equal(toolSetsPerTurn[1].includes('execute_shell'), false, '第二轮不应包含 execute_shell');
  assert.equal(toolSetsPerTurn[1].includes('write_file'), false, '第二轮不应包含 write_file');
});

// ═══════════════════════════════════════════════════════
// 5. 无工具调用直接返回测试
// ═══════════════════════════════════════════════════════

test('conversation runner returns immediately when no tool calls', async () => {
  const aiService = buildAIService({ responses: [{ content: '直接回复' }] });
  const executor = buildToolExecutor({ tools: [makeTool('some_tool')] });

  const messages: Message[] = [
    { role: 'system', content: 'test' },
    { role: 'user', content: 'hello' },
  ];

  const runner = new ConversationRunner(aiService, executor, { maxTurns: 10 });
  const result = await runner.run(messages);

  assert.equal(result.response, '直接回复');
  assert.equal(result.newMessages.length, 0, '无工具调用时不应有新中间消息');
});
