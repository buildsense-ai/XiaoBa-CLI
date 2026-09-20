import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeContextText } from '../src/core/runtime-context-builder';
import {
  setMachineResourceSnapshotForTest,
  __resetMachineResourceCacheForTest,
} from '../src/utils/machine-resources';

const GIB = 1024 ** 3;

function injectSnapshot(): void {
  setMachineResourceSnapshotForTest({
    platform: 'linux',
    cpuCount: 2,
    totalMemoryBytes: 3.6 * GIB,
    availableMemoryBytes: 1.2 * GIB,
    swapTotalBytes: 10 * GIB,
    swapFreeBytes: 8 * GIB,
    load1: 0.4,
    sampledAt: Date.now(),
  });
}

afterEach(() => {
  delete process.env.XIAOBA_MACHINE_RESOURCES;
  __resetMachineResourceCacheForTest();
});

describe('runtime context machine resources', () => {
  test('injects the live machine resource section into the transient runtime context', () => {
    injectSnapshot();
    const text = buildRuntimeContextText(undefined, '/tmp/xiaoba-attachments');
    assert.ok(text.startsWith('[transient_runtime_context]'));
    assert.ok(text.includes('[本机资源]'));
    assert.ok(text.includes('CPU 2 核'));
    assert.ok(text.includes('内存 3.6G（可用 1.2G）'));
    assert.ok(text.endsWith('[/transient_runtime_context]'));
  });

  test('omits the machine resource section when disabled via env', () => {
    process.env.XIAOBA_MACHINE_RESOURCES = 'off';
    injectSnapshot();
    const text = buildRuntimeContextText();
    assert.ok(!text.includes('[本机资源]'));
    assert.ok(text.includes('[/transient_runtime_context]'));
  });
});
