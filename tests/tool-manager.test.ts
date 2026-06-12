import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_TOOL_NAMES } from '../src/tools/default-tool-names';
import { ToolManager } from '../src/tools/tool-manager';
import { AgentToolExecutor } from '../src/agents/agent-tool-executor';
import type { Tool } from '../src/types/tool';

function fakeTool(name: string, execute: Tool['execute']): Tool {
  return {
    definition: {
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
    },
    execute,
  };
}

describe('ToolManager', () => {
  test('registers all default tools when no enabled list is provided', () => {
    const manager = new ToolManager('/tmp/xiaoba-tool-manager');

    assert.deepStrictEqual(
      manager.getToolDefinitions().map(definition => definition.name),
      DEFAULT_TOOL_NAMES,
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

  test('registers ask_parent only when explicitly enabled for subagents', async () => {
    const defaultManager = new ToolManager('/tmp/xiaoba-tool-manager');
    assert.equal(defaultManager.getTool('ask_parent'), undefined);

    const subAgentManager = new ToolManager('/tmp/xiaoba-tool-manager', {}, {
      enabledToolNames: ['read_file', 'ask_parent'],
    });

    assert.deepStrictEqual(
      subAgentManager.getToolDefinitions().map(definition => definition.name),
      ['read_file', 'ask_parent'],
    );

    const result = await subAgentManager.executeTool({
      id: 'call-ask-parent',
      type: 'function',
      function: {
        name: 'ask_parent',
        arguments: JSON.stringify({ question: '继续吗？' }),
      },
    }, [], {
      requestParentInput: async question => `收到问题：${question}`,
    });

    assert.equal(result.ok, true);
    assert.match(result.content, /收到问题：继续吗/);
  });

  test('strict local low-risk tools do not require confirmation', async () => {
    const manager = new ToolManager('/tmp/xiaoba-tool-manager', {}, { enabledToolNames: [] });
    let confirmed = false;
    manager.registerTool(fakeTool('read_file', async () => ({ ok: true, content: 'read ok' })));

    const result = await manager.executeTool({
      id: 'call-read',
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ file_path: 'a.txt' }) },
    }, [], {
      permissionProfile: 'strict',
      confirmToolExecution: async () => {
        confirmed = true;
        return false;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.content, 'read ok');
    assert.equal(confirmed, false);
  });

  test('strict local read outside the workspace requires confirmation', async () => {
    const workspace = path.resolve('/tmp/xiaoba-tool-manager');
    const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
    let executed = false;
    manager.registerTool(fakeTool('read_file', async () => {
      executed = true;
      return { ok: true, content: 'read ok' };
    }));

    const denied = await manager.executeTool({
      id: 'call-read-outside',
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ file_path: path.resolve('/tmp/outside-secret.txt') }) },
    }, [], {
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
      confirmToolExecution: async request => {
        assert.equal(request.toolName, 'read_file');
        assert.equal(request.risk, 'medium');
        return { approved: false, reason: '需要用户选择文件' };
      },
    });

    assert.equal(denied.ok, false);
    assert.equal(denied.errorCode, 'PERMISSION_DENIED');
    assert.equal(denied.content, '需要用户选择文件');
    assert.equal(executed, false);
  });

  test('strict local sensitive reads require high-risk confirmation', async () => {
    const manager = new ToolManager('/tmp/xiaoba-tool-manager', {}, { enabledToolNames: [] });
    manager.registerTool(fakeTool('read_file', async () => ({ ok: true, content: 'read ok' })));

    const result = await manager.executeTool({
      id: 'call-read-env',
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ file_path: '.env' }) },
    }, [], {
      permissionProfile: 'strict',
      confirmToolExecution: async request => {
        assert.equal(request.risk, 'high');
        return false;
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PERMISSION_DENIED');
  });

  test('strict local glob absolute pattern outside workspace requires confirmation', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-workspace-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-outside-'));
    const outsidePattern = path.join(outside, '**', '*.json');
    const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
    let executed = false;
    manager.registerTool(fakeTool('glob', async () => {
      executed = true;
      return { ok: true, content: 'glob ok' };
    }));

    const result = await manager.executeTool({
      id: 'call-glob-absolute',
      type: 'function',
      function: { name: 'glob', arguments: JSON.stringify({ pattern: outsidePattern }) },
    }, [], {
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
      confirmToolExecution: async request => {
        assert.equal(request.toolName, 'glob');
        assert.equal(request.risk, 'medium');
        return { approved: false, reason: '搜索范围不在当前工作区' };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PERMISSION_DENIED');
    assert.equal(result.content, '搜索范围不在当前工作区');
    assert.equal(executed, false);
  });

  test('strict local write can create new ordinary workspace files without confirmation', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-workspace-'));
    const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
    let confirmed = false;
    manager.registerTool(fakeTool('write_file', async () => ({ ok: true, content: 'write ok' })));

    const result = await manager.executeTool({
      id: 'call-write-new',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'new-note.txt', content: 'hello' }) },
    }, [], {
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
      confirmToolExecution: async () => {
        confirmed = true;
        return false;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.content, 'write ok');
    assert.equal(confirmed, false);
  });

  test('strict local write waits for confirmation and respects denial', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-workspace-'));
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'old');
    const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
    let executed = false;
    manager.registerTool(fakeTool('write_file', async () => {
      executed = true;
      return { ok: true, content: 'write ok' };
    }));

    const denied = await manager.executeTool({
      id: 'call-write',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'a.txt', content: 'hello' }) },
    }, [], {
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
      confirmToolExecution: async () => ({ approved: false, reason: '用户取消' }),
    });

    assert.equal(denied.ok, false);
    assert.equal(denied.errorCode, 'PERMISSION_DENIED');
    assert.equal(denied.content, '用户取消');
    assert.equal(executed, false);

    const approved = await manager.executeTool({
      id: 'call-write-2',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'a.txt', content: 'hello' }) },
    }, [], {
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
      confirmToolExecution: async request => {
        assert.equal(request.toolName, 'write_file');
        assert.equal(request.risk, 'medium');
        return true;
      },
    });

    assert.equal(approved.ok, true);
    assert.equal(approved.content, 'write ok');
    assert.equal(executed, true);
  });

  test('strict local write returns retryable confirmation request without provider', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-workspace-'));
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'old');
    const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
    manager.registerTool(fakeTool('write_file', async () => ({ ok: true, content: 'write ok' })));

    const result = await manager.executeTool({
      id: 'call-write',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'a.txt', content: 'hello' }) },
    }, [], {
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'NEEDS_CONFIRMATION');
    assert.equal(result.retryable, true);
    assert.match(String(result.content), /需要用户确认/);
  });

  test('strict local unknown tools require confirmation instead of defaulting to low risk', async () => {
    const manager = new ToolManager('/tmp/xiaoba-tool-manager', {}, { enabledToolNames: [] });
    let executed = false;
    manager.registerTool(fakeTool('custom_mutating_tool', async () => {
      executed = true;
      return { ok: true, content: 'custom ok' };
    }));

    const result = await manager.executeTool({
      id: 'call-custom',
      type: 'function',
      function: { name: 'custom_mutating_tool', arguments: JSON.stringify({}) },
    }, [], { permissionProfile: 'strict' });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'NEEDS_CONFIRMATION');
    assert.equal(executed, false);
  });

  test('CatsCo context is not intercepted by local confirmation layer', async () => {
    const manager = new ToolManager('/tmp/xiaoba-tool-manager', {}, { enabledToolNames: [] });
    let confirmed = false;
    manager.registerTool(fakeTool('write_file', async () => ({ ok: true, content: 'catsco tool ran' })));

    const result = await manager.executeTool({
      id: 'call-catsco-write',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'a.txt', content: 'hello' }) },
    }, [], {
      surface: 'catscompany',
      permissionProfile: 'strict',
      confirmToolExecution: async () => {
        confirmed = true;
        return false;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.content, 'catsco tool ran');
    assert.equal(confirmed, false);
  });

  test('AgentToolExecutor uses the same local confirmation gate', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-agent-workspace-'));
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'old');
    let executed = false;
    const executor = new AgentToolExecutor([
      fakeTool('write_file', async () => {
        executed = true;
        return { ok: true, content: 'agent write ok' };
      }),
    ], workspace);

    const result = await executor.executeTool({
      id: 'agent-write',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'a.txt', content: 'hello' }) },
    }, [], {
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
      confirmToolExecution: async () => false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PERMISSION_DENIED');
    assert.equal(executed, false);
  });
});
