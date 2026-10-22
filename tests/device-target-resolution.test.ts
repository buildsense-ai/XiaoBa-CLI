import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTargetRoutes } from '../src/catscompany/runtime-context';
import { buildRuntimeContextText } from '../src/core/runtime-context-builder';
import { ConversationRunner } from '../src/core/conversation-runner';
import { resolveExecutionRoute, executeRouteIfRemote, targetParameterDescription } from '../src/tools/execution-router';
import { ToolManager } from '../src/tools/tool-manager';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../src/types/tool';
import { scopedDeviceContext } from './helpers/scoped-device-context';

function fixture() {
  let dispatches = 0;
  const ctx: ToolExecutionContext = {
    workingDirectory: process.cwd(), conversationHistory: [], surface: 'catscompany',
    ...scopedDeviceContext('usr3', 'windows-a', ['read_file', 'write_file', 'execute_shell']),
    targetResolutionState: {},
    targetRoutes: buildTargetRoutes([{
      userId: 'usr3', ownerUserId: 'usr3', userName: 'test-other',
      deviceId: 'windows-a', label: 'Eason', os: 'windows', status: 'ready',
    }]),
    thinToolRpc: { executeTool: async () => { dispatches++; return { ok: true, content: 'test marker' }; } },
  };
  return { ctx, count: () => dispatches };
}
const read = (target?: string) => ({ toolName: 'read_file', operation: 'read_file' as const, target });

test('unresolved named device blocks omitted target, agent host, other devices and writes in the same run', () => {
  const { ctx, count } = fixture();
  const first = resolveExecutionRoute(ctx, read('隔离设备B（David服务器）'));
  assert.ok(!first.ok && first.errorCode === 'TARGET_NOT_FOUND');
  assert.doesNotMatch(first.message, /belongs to|其他账号|Omit target to run/);
  for (const target of [undefined, 'agent_self', 'Eason', 'test-other', 'windows-a']) {
    const copiedContext = { ...ctx };
    const next = resolveExecutionRoute(copiedContext, read(target));
    assert.ok(!next.ok && next.errorCode === 'TARGET_RESOLUTION_BLOCKED');
    const write = resolveExecutionRoute(copiedContext, { toolName: 'write_file', operation: 'write_file', target });
    assert.ok(!write.ok && write.errorCode === 'TARGET_RESOLUTION_BLOCKED');
  }
  assert.equal(count(), 0);
});

test('missing device directory and offline/ambiguous targets do not invite a host fallback', () => {
  for (const scenario of ['missing', 'offline', 'ambiguous'] as const) {
    const { ctx } = fixture();
    if (scenario === 'missing') ctx.targetRoutes = undefined;
    else {
      const a = ctx.targetRoutes!.routes[0];
      ctx.targetRoutes = buildTargetRoutes(scenario === 'offline'
        ? [{ ...a, status: 'unavailable' }]
        : [a, { ...a, deviceId: 'windows-duplicate' }]);
    }
    const first = resolveExecutionRoute(ctx, read('Eason'));
    assert.equal(first.ok, false);
    if (!first.ok) assert.doesNotMatch(first.message, /Omit target to run|Use target="agent_self"/);
    const next = resolveExecutionRoute(ctx, read());
    assert.ok(!next.ok && next.errorCode === 'TARGET_RESOLUTION_BLOCKED');
  }
});

test('fresh user run, CLI, and actual RPC receiver retain their normal execution semantics', () => {
  const { ctx } = fixture();
  resolveExecutionRoute(ctx, read('missing B'));
  const fresh = { ...ctx, targetResolutionState: {} };
  for (const target of [undefined, 'agent_self', 'Eason']) assert.equal(resolveExecutionRoute(fresh, read(target)).ok, true);
  assert.equal(resolveExecutionRoute({ ...ctx, surface: 'cli' }, read()).ok, true);
  assert.equal(resolveExecutionRoute({ ...ctx, deviceRpcReceiver: true }, read()).ok, true);
});

test('previously resolved remote request cannot dispatch after target failure', async () => {
  const { ctx, count } = fixture();
  const ready = resolveExecutionRoute(ctx, read('Eason'));
  assert.equal(ready.ok, true);
  resolveExecutionRoute(ctx, read('missing B'));
  const result = await executeRouteIfRemote(ctx, ready, 'read_file', 'read_file', { file_path: 'identity.txt' });
  assert.ok(result && !result.ok && result.errorCode === 'TARGET_RESOLUTION_BLOCKED');
  assert.equal(count(), 0);
});

test('manager rejects every file/device operation before tool-specific shortcuts, but permits a text response', async () => {
  const { ctx } = fixture();
  resolveExecutionRoute(ctx, read('missing B'));
  const manager = new ToolManager(process.cwd(), {}, { enabledToolNames: [] });
  let executed = 0;
  const names = ['read_file', 'write_file', 'edit_file', 'glob', 'grep',
    'resolve_common_directory', 'send_file', 'import_file', 'execute_shell', 'text_only_fixture'];
  for (const name of names) {
    manager.registerTool({
      definition: { name, description: 'No real I/O', parameters: { type: 'object', properties: {} } },
      execute: async () => { executed++; return { ok: true, content: 'fixture' }; },
    });
    const result = await manager.executeTool({
      id: name, type: 'function', function: { name, arguments: '{"targetResolutionState":{}}' },
    }, [], ctx);
    if (name === 'text_only_fixture') assert.equal(result.ok, true);
    else assert.equal(result.errorCode, 'TARGET_RESOLUTION_BLOCKED');
  }
  assert.equal(executed, 1);
});

function call(id: string, args: object): ToolCall {
  return { id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify(args) } };
}
test('real runner/tool-manager shares guard across model calls, ignores spoofed JSON state and resets on a new run', async () => {
  const { ctx, count } = fixture();
  delete ctx.targetResolutionState;
  const manager = new ToolManager(process.cwd(), {}, { enabledToolNames: ['read_file'] });
  const results: ToolResult[] = [];
  const executor = {
    getToolDefinitions: () => manager.getToolDefinitions(),
    executeTool: async (...args: Parameters<typeof manager.executeTool>) => {
      const result = await manager.executeTool(...args); results.push(result); return result;
    },
  };
  const responses = [
    [call('unknown', { file_path: 'identity.txt', target: 'missing B' })],
    [call('omit', { file_path: 'package.json', targetResolutionState: {} })],
    [call('other', { file_path: 'identity.txt', target: 'Eason' })],
    [],
    [call('fresh', { file_path: 'identity.txt', target: 'Eason' })],
    [],
  ];
  const ai = { chat: async () => ({ content: 'test', toolCalls: responses.shift()!, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }) };
  const runner = new ConversationRunner(ai as any, executor, { stream: false, toolExecutionContext: ctx });
  await runner.run([{ role: 'user', content: 'Read on missing B' }]);
  assert.deepEqual(results.map(r => r.errorCode), ['TARGET_NOT_FOUND', 'TARGET_RESOLUTION_BLOCKED', 'TARGET_RESOLUTION_BLOCKED']);
  assert.equal(count(), 0);
  await runner.run([{ role: 'user', content: 'I now want Eason' }]);
  assert.equal(results.at(-1)?.ok, true);
  assert.equal(count(), 1);
});

test('delegated runner inherits an existing failed-target guard rather than resetting it', async () => {
  const { ctx, count } = fixture();
  resolveExecutionRoute(ctx, read('missing B'));
  const manager = new ToolManager(process.cwd(), {}, { enabledToolNames: ['read_file'] });
  const responses = [[call('child', { file_path: 'identity.txt', target: 'Eason' })], []];
  const results: ToolResult[] = [];
  const ai = { chat: async () => ({ content: 'test', toolCalls: responses.shift()!, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }) };
  const runner = new ConversationRunner(ai as any, {
    getToolDefinitions: () => manager.getToolDefinitions(),
    executeTool: async (...args: Parameters<typeof manager.executeTool>) => {
      const result = await manager.executeTool(...args); results.push(result); return result;
    },
  }, { stream: false, toolExecutionContext: { ...ctx, sessionId: 'subagent:test' } });
  await runner.run([{ role: 'user', content: 'try elsewhere' }]);
  assert.equal(results[0].errorCode, 'TARGET_RESOLUTION_BLOCKED');
  assert.equal(count(), 0);
});

test('prompt and target schema separate unknown-device intent from legitimate local Skill work', () => {
  const text = buildRuntimeContextText(fixture().ctx.targetRoutes, '/test/attachments');
  assert.match(text, /目标不存在、不明确、不可用或与选择不一致时/);
  assert.match(text, /不得猜测\/改写 Linux 与 Windows 路径/);
  assert.match(text, /正常 Skill、附件处理/);
  assert.match(targetParameterDescription().description, /Never omit\/change target/);
});
