import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  MAX_DEVICE_RPC_SHELL_CONTENT_CHARS,
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

  test('summarizes long execute_shell result content with head and tail context', () => {
    const longOutput = Array.from({ length: 2000 }, (_, i) => `line-${i.toString().padStart(4, '0')} ${'x'.repeat(40)}`).join('\n');

    const result = normalizeDeviceRpcToolResultPayload({
      ok: true,
      content: longOutput,
    }, { toolName: 'execute_shell' });

    assert.equal(result.ok, true);
    const content = result.ok ? String(result.content) : '';
    assert.ok(content.length < longOutput.length);
    assert.match(content, /execute_shell 输出已摘要/);
    assert.match(content, /原始 \d+ 字符/);
    assert.match(content, /line-0000/);
    assert.match(content, /line-1999/);
    assert.ok(content.length > MAX_DEVICE_RPC_SHELL_CONTENT_CHARS);
  });

  test('does not apply shell-sized budget to non-shell tool results', () => {
    const content = 'x'.repeat(MAX_DEVICE_RPC_SHELL_CONTENT_CHARS + 1000);

    const result = normalizeDeviceRpcToolResultPayload({
      ok: true,
      content,
    }, { toolName: 'read_file' });

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.content : '', content);
  });

  test('summarizes long local-device shell result before transport returns it', () => {
    const longOutput = Array.from({ length: 2000 }, (_, i) => `transport-${i.toString().padStart(4, '0')} ${'y'.repeat(40)}`).join('\n');

    const result = normalizeDeviceRpcToolResultForTransport({
      ok: true,
      content: longOutput,
    }, { toolName: 'execute_shell' });

    assert.equal(result.ok, true);
    const content = result.ok ? String(result.content) : '';
    assert.ok(content.length < longOutput.length);
    assert.match(content, /execute_shell 输出已摘要/);
    assert.match(content, /transport-0000/);
    assert.match(content, /transport-1999/);
  });
});
