import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  MAX_DEVICE_RPC_TOOL_CONTENT_CHARS,
  normalizeDeviceRpcToolResultPayload,
  normalizeDeviceRpcToolResultForTransport,
  resolveRemoteToolTimeoutMs,
} from '../src/tools/device-rpc-tool';

describe('Device RPC tool helpers', () => {
  test('resolves default, requested, capped, and grant-bounded timeouts', () => {
    const now = 1_000_000;
    const longGrant = now + 10 * 60_000;

    assert.equal(resolveRemoteToolTimeoutMs(longGrant, undefined, now), 60_000);
    assert.equal(resolveRemoteToolTimeoutMs(longGrant, 120_000, now), 120_000);
    assert.equal(resolveRemoteToolTimeoutMs(longGrant, 999, now), 5_000);
    assert.equal(resolveRemoteToolTimeoutMs(longGrant, 999_999, now), 180_000);
    assert.equal(resolveRemoteToolTimeoutMs(now + 30_000, 120_000, now), 30_000);
  });

  test('keeps execute_shell result content below the general RPC limit intact', () => {
    const content = 'x'.repeat(20_000);

    const result = normalizeDeviceRpcToolResultPayload({
      ok: true,
      content,
    }, { toolName: 'execute_shell' });

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.content : '', content);
  });

  test('does not apply shell-sized budget to non-shell tool results', () => {
    const content = 'x'.repeat(20_000);

    const result = normalizeDeviceRpcToolResultPayload({
      ok: true,
      content,
    }, { toolName: 'read_file' });

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.content : '', content);
  });

  test('keeps local-device shell transport content below the general RPC limit intact', () => {
    const content = 'y'.repeat(20_000);

    const result = normalizeDeviceRpcToolResultForTransport({
      ok: true,
      content,
    }, { toolName: 'execute_shell' });

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.content : '', content);
  });

  test('still truncates remote tool content above the general RPC limit', () => {
    const content = 'z'.repeat(MAX_DEVICE_RPC_TOOL_CONTENT_CHARS + 1000);

    const result = normalizeDeviceRpcToolResultPayload({
      ok: true,
      content,
    }, { toolName: 'execute_shell' });

    assert.equal(result.ok, true);
    assert.ok((result.ok ? String(result.content) : '').length < content.length);
    assert.match(result.ok ? String(result.content) : '', /远程设备结果超过/);
  });
});
