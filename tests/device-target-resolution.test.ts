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

test('an unresolved target remains blocked without poisoning other explicitly targeted devices', () => {
  const { ctx, count } = fixture();
  const first = resolveExecutionRoute(ctx, read('隔离设备B（David服务器）'));
  assert.ok(!first.ok && first.errorCode === 'TARGET_NOT_FOUND');
  assert.doesNotMatch(first.message, /belongs to|其他账号|Omit target to run/);
  const repeated = resolveExecutionRoute(ctx, read('隔离设备B（David服务器）'));
  assert.ok(!repeated.ok && repeated.errorCode === 'TARGET_RESOLUTION_BLOCKED');
  assert.equal(resolveExecutionRoute(ctx, read('Eason')).ok, true);
  assert.equal(resolveExecutionRoute(ctx, read('test-other')).ok, true);
  assert.equal(resolveExecutionRoute(ctx, read()).ok, true);
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
    const next = resolveExecutionRoute(ctx, read('Eason'));
    assert.ok(!next.ok && next.errorCode === 'TARGET_RESOLUTION_BLOCKED');
    assert.equal(resolveExecutionRoute(ctx, read()).ok, true);
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

test('a different failed device does not block a previously resolved authorized target', async () => {
  const { ctx, count } = fixture();
  const ready = resolveExecutionRoute(ctx, read('Eason'));
  assert.equal(ready.ok, true);
  resolveExecutionRoute(ctx, read('missing B'));
  const result = await executeRouteIfRemote(ctx, ready, 'read_file', 'read_file', { file_path: 'identity.txt' });
  assert.equal(result?.ok, true);
  assert.equal(count(), 1);
});

test('a previously resolved request cannot dispatch after that same device fails', async () => {
  const { ctx, count } = fixture();
  const ready = resolveExecutionRoute(ctx, read('windows-a'));
  assert.equal(ready.ok, true);
  ctx.targetRoutes!.routes[0].status = 'unavailable';
  const failed = resolveExecutionRoute(ctx, read('Eason'));
  assert.ok(!failed.ok && failed.errorCode === 'TARGET_UNAVAILABLE');
  const result = await executeRouteIfRemote(ctx, ready, 'read_file', 'read_file', { file_path: 'identity.txt' });
  assert.equal(result?.errorCode, 'TARGET_RESOLUTION_BLOCKED');
  assert.equal(count(), 0);
});

test('manager blocks the failed target before shortcuts, but permits another target and local Skill work', async () => {
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
    const args = name === 'text_only_fixture' ? {} : { target: 'missing B', targetResolutionState: {} };
    const result = await manager.executeTool({
      id: name, type: 'function', function: { name, arguments: JSON.stringify(args) },
    }, [], ctx);
    if (name === 'text_only_fixture') assert.equal(result.ok, true);
    else assert.equal(result.errorCode, 'TARGET_RESOLUTION_BLOCKED');
  }
  assert.equal(executed, 1);
  const other = await manager.executeTool({ id: 'other', type: 'function', function: { name: 'read_file', arguments: '{"target":"Eason"}' } }, [], ctx);
  assert.equal(other.ok, true);
  assert.equal(executed, 2);
  for (const name of ['read_file', 'execute_shell', 'send_file']) {
    const local = await manager.executeTool({ id: `local-${name}`, type: 'function', function: { name, arguments: '{}' } }, [], ctx);
    assert.equal(local.ok, true, name);
  }
  assert.equal(executed, 5);
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
    [call('same', { file_path: 'package.json', target: 'missing B', targetResolutionState: {} })],
    [call('other', { file_path: 'identity.txt', target: 'Eason' })],
    [],
    [call('fresh', { file_path: 'identity.txt', target: 'Eason' })],
    [],
  ];
  const ai = { chat: async () => ({ content: 'test', toolCalls: responses.shift()!, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }) };
  const runner = new ConversationRunner(ai as any, executor, { stream: false, toolExecutionContext: ctx });
  await runner.run([{ role: 'user', content: 'Read on missing B' }]);
  assert.deepEqual(results.map(r => r.errorCode), ['TARGET_NOT_FOUND', 'TARGET_RESOLUTION_BLOCKED', undefined]);
  assert.equal(count(), 1);
  await runner.run([{ role: 'user', content: 'I now want Eason' }]);
  assert.equal(results.at(-1)?.ok, true);
  assert.equal(count(), 2);
});

test('delegated runner inherits target-specific failures without blocking another authorized device', async () => {
  const { ctx, count } = fixture();
  resolveExecutionRoute(ctx, read('missing B'));
  const manager = new ToolManager(process.cwd(), {}, { enabledToolNames: ['read_file'] });
  const responses = [[call('child-failed', { file_path: 'identity.txt', target: 'missing B' })],
    [call('child-ready', { file_path: 'identity.txt', target: 'Eason' })], []];
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
  assert.equal(results[1].ok, true);
  assert.equal(count(), 1);
});

test('prompt and target schema separate unknown-device intent from legitimate local Skill work', () => {
  const text = buildRuntimeContextText(fixture().ctx.targetRoutes, '/test/attachments');
  assert.match(text, /默认目标/);
  assert.match(text, /该设备可以不同于默认选择，但必须有自己的本轮授权/);
  assert.match(text, /不得猜测\/改写 Linux 与 Windows 路径/);
  assert.match(text, /正常 Skill、附件处理/);
  assert.match(targetParameterDescription().description, /must never fall back to another computer/);
});
