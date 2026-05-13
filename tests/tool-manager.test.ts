import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import { DEFAULT_TOOL_NAMES, resolveDefaultToolNames } from '../src/tools/default-tool-names';
import { ToolManager } from '../src/tools/tool-manager';

describe('ToolManager', () => {
  let originalGauzMemEnabled: string | undefined;

  beforeEach(() => {
    originalGauzMemEnabled = process.env.GAUZMEM_ENABLED;
    delete process.env.GAUZMEM_ENABLED;
  });

  afterEach(() => {
    if (originalGauzMemEnabled === undefined) delete process.env.GAUZMEM_ENABLED;
    else process.env.GAUZMEM_ENABLED = originalGauzMemEnabled;
  });

  test('registers all default tools when no enabled list is provided', () => {
    const manager = new ToolManager('/tmp/xiaoba-tool-manager');

    assert.deepStrictEqual(
      manager.getToolDefinitions().map(definition => definition.name),
      DEFAULT_TOOL_NAMES,
    );
  });

  test('registers GauzMem before skill when explicitly enabled', () => {
    process.env.GAUZMEM_ENABLED = 'true';
    const manager = new ToolManager('/tmp/xiaoba-tool-manager');

    assert.deepStrictEqual(
      manager.getToolDefinitions().map(definition => definition.name),
      resolveDefaultToolNames(process.env),
    );
  });

  test('honors explicit GauzMem tool profile even when env is not enabled', () => {
    const manager = new ToolManager('/tmp/xiaoba-tool-manager', {}, {
      enabledToolNames: [
        'gauzmem_search',
      ],
    });

    assert.deepStrictEqual(
      manager.getToolDefinitions().map(definition => definition.name),
      ['gauzmem_search'],
    );
  });

  test('registers only enabled default tools when an enabled list is provided', async () => {
    const manager = new ToolManager('/tmp/xiaoba-tool-manager', {}, {
      enabledToolNames: [
        'read_file',
        'execute_shell',
      ],
    });

    assert.deepStrictEqual(
      manager.getToolDefinitions().map(definition => definition.name),
      ['read_file', 'execute_shell'],
    );
    assert.equal(manager.getToolCount(), 2);
    assert.equal(manager.getTool('write_file'), undefined);

    const result = await manager.executeTool({
      id: 'call-disabled',
      type: 'function',
      function: {
        name: 'write_file',
        arguments: '{}',
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'TOOL_NOT_FOUND');
    assert.match(result.content, /未找到工具 "write_file"/);
  });
});
