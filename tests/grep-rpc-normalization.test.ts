import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolExecutionContext, ToolExecutionResult } from '../src/types/tool';
import {
  executeRemoteDeviceRpcTool,
  normalizeDeviceRpcToolResultForTransport,
  normalizeDeviceRpcToolResultPayload,
} from '../src/tools/device-rpc-tool';
import { executeRouteIfRemote, type ExecutionRoute } from '../src/tools/execution-router';

const gateway = { ok: true, mode: 'remote', targetDeviceId: 'device-test' } as const;
const thinRoute: ExecutionRoute = {
  ...gateway, target: 'other-user', label: 'test device', targetOwnerUserId: 'owner-test',
};
const success: ToolExecutionResult = { ok: true, content: 'fixture' };

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { workingDirectory: '/tmp', surface: 'catscompany', ...overrides };
}

test('SEARCH_TIMEOUT survives both wire normalization directions and is not automatically retried', () => {
  const local: ToolExecutionResult = { ok: false, errorCode: 'SEARCH_TIMEOUT', message: '搜索不完整', retryable: true };
  const sent = normalizeDeviceRpcToolResultForTransport(local, { toolName: 'grep' });
  const received = normalizeDeviceRpcToolResultPayload(sent, { toolName: 'grep' });
  assert.equal(sent.ok, false);
  assert.equal(received.ok, false);
  if (!sent.ok && !received.ok) {
    assert.equal(sent.errorCode, 'SEARCH_TIMEOUT');
    assert.equal(received.errorCode, 'SEARCH_TIMEOUT');
    assert.equal(received.retryable, false);
    assert.equal(sent.retryable, false);
  }
});

test('device grep dispatch uses local deadline plus bounded transport grace and preserves arguments', async () => {
  const requests: any[] = [];
  const ctx = context({ deviceRpc: { executeTool: async request => { requests.push(request); return success; } } });
  await executeRemoteDeviceRpcTool(ctx, gateway, 'grep', 'grep', { pattern: 'a|b', target: 'other-user', timeout_ms: 500 });
  assert.equal(requests[0].timeoutMs, 5_500);
  assert.deepEqual(requests[0].args, { pattern: 'a|b', timeout_ms: 500 });
  await executeRemoteDeviceRpcTool(ctx, gateway, 'grep', 'grep', { pattern: 'x' });
  assert.equal(requests[1].timeoutMs, 20_000);
  await executeRemoteDeviceRpcTool(ctx, gateway, 'read_file', 'read_file', { path: 'x' });
  assert.equal(requests[2].timeoutMs, 60_000, 'unrelated tools retain their existing timeout');
});

test('device grep budget never extends a still-valid grant', async () => {
  let request: any;
  const ctx = context({ deviceRpc: { executeTool: async value => { request = value; return success; } } });
  await executeRemoteDeviceRpcTool(ctx, { ...gateway, grant: { expiresAt: Date.now() + 6_000 } as any }, 'grep', 'grep', { pattern: 'x', timeout_ms: 30_000 });
  assert.ok(request.timeoutMs > 0 && request.timeoutMs <= 6_000);
});

test('thin grep dispatch also has a bounded timeout, without changing route authority', async () => {
  let request: any;
  const result = await executeRouteIfRemote(context({ thinToolRpc: {
    executeTool: async value => { request = value; return success; },
  } }), thinRoute, 'grep', 'grep', { pattern: 'a|b', target: 'other-user', timeout_ms: 1_000 });
  assert.equal(result?.ok, true);
  assert.equal(request.timeoutMs, 6_000);
  assert.equal(request.targetDeviceId, 'device-test');
  assert.equal(request.targetOwnerUserId, 'owner-test');
  assert.deepEqual(request.args, { pattern: 'a|b', timeout_ms: 1_000 });
});

test('invalid grep budgets never dispatch a device or thin request', async () => {
  let calls = 0;
  const ctx = context({
    deviceRpc: { executeTool: async () => { calls++; return success; } },
    thinToolRpc: { executeTool: async () => { calls++; return success; } },
  });
  const a = await executeRemoteDeviceRpcTool(ctx, gateway, 'grep', 'grep', { pattern: 'x', timeout_ms: 0 });
  const b = await executeRouteIfRemote(ctx, thinRoute, 'grep', 'grep', { pattern: 'x', timeout_ms: 'unlimited' });
  for (const result of [a, b]) {
    assert.equal(result?.ok, false);
    if (result && !result.ok) assert.equal(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
  }
  assert.equal(calls, 0);
});

test('grep transport timeout remains incomplete, does not leak error payload, and is not retried', async () => {
  const error = Object.assign(new Error('timed out secret=do-not-echo'), { code: 'REQUEST_TIMEOUT' });
  const ctx = context({
    deviceRpc: { executeTool: async () => { throw error; } },
    thinToolRpc: { executeTool: async () => { throw error; } },
  });
  const a = await executeRemoteDeviceRpcTool(ctx, gateway, 'grep', 'grep', { pattern: 'x' });
  const b = await executeRouteIfRemote(ctx, thinRoute, 'grep', 'grep', { pattern: 'x' });
  for (const result of [a, b]) {
    assert.equal(result?.ok, false);
    if (result && !result.ok) {
      assert.equal(result.errorCode, 'SEARCH_TIMEOUT');
      assert.equal(result.retryable, false);
      assert.match(result.message, /搜索不完整/);
      assert.doesNotMatch(result.message, /secret|未找到匹配/);
    }
  }
});
