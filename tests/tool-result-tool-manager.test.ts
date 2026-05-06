/**
 * tool-manager 核心测试：验证 ToolExecutionResult 结构统一处理
 */
import { describe, test, beforeEach, mock } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ToolManager } from '../src/tools/tool-manager';

describe('ToolManager - ToolExecutionResult 统一处理', () => {
  let manager: ToolManager;
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-result-'));
    manager = new ToolManager(testRoot);
  });

  // ─── 成功路径 ───────────────────────────────────────────────

  test('write_file 成功返回 ok=true', async () => {
    const result = await manager.executeTool(
      { id: 't1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'ok.txt', content: 'hello' }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('成功写入') || result.content?.includes('成功创建'));
    assert.strictEqual(result.errorCode, undefined);
  });

  test('read_file 成功返回 ok=true', async () => {
    const filePath = path.join(testRoot, 'read_ok.txt');
    fs.writeFileSync(filePath, 'line1\nline2\nline3');
    const result = await manager.executeTool(
      { id: 't2', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: filePath }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('read_ok.txt'));
    assert.strictEqual(result.errorCode, undefined);
  });

  test('edit_file 成功返回 ok=true', async () => {
    const filePath = path.join(testRoot, 'edit_ok.txt');
    fs.writeFileSync(filePath, 'hello world');
    const result = await manager.executeTool(
      { id: 't3', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ file_path: filePath, old_string: 'world', new_string: 'Albert' }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('成功编辑'));
    assert.strictEqual(result.errorCode, undefined);
  });

  test('glob 成功返回 ok=true', async () => {
    fs.writeFileSync(path.join(testRoot, 'a.txt'), '');
    fs.writeFileSync(path.join(testRoot, 'b.txt'), '');
    const result = await manager.executeTool(
      { id: 't4', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.txt' }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('找到'));
    assert.strictEqual(result.errorCode, undefined);
  });

  test('grep 成功返回 ok=true', async () => {
    const filePath = path.join(testRoot, 'grep_ok.txt');
    fs.writeFileSync(filePath, 'match line here');
    const result = await manager.executeTool(
      { id: 't5', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'match', path: testRoot }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('找到'));
    assert.strictEqual(result.errorCode, undefined);
  });

  test('thinking 成功返回 ok=true', async () => {
    // thinking-tool 直接实例化测试（不在 ToolManager 默认注册）
    const { ThinkingTool } = await import('../src/tools/thinking-tool');
    const tool = new ThinkingTool();
    const result = await tool.execute({ content: 'test thinking' }, { workingDirectory: testRoot, conversationHistory: [] });
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('已思考'));
  });

  // ─── 失败路径 ───────────────────────────────────────────────

  test('read_file 文件不存在返回 ok=false + FILE_NOT_FOUND', async () => {
    const result = await manager.executeTool(
      { id: 't7', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: '/nope/not/exist.txt' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'FILE_NOT_FOUND');
    assert.ok(result.content?.includes('文件不存在'));
  });

  test('edit_file 文件不存在返回 ok=false + FILE_NOT_FOUND', async () => {
    const result = await manager.executeTool(
      { id: 't8', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ file_path: '/nope/not/exist.txt', old_string: 'a', new_string: 'b' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'FILE_NOT_FOUND');
    assert.ok(result.content?.includes('文件不存在'));
  });

  test('edit_file old_string 不存在返回 ok=false', async () => {
    const filePath = path.join(testRoot, 'no_match.txt');
    fs.writeFileSync(filePath, 'original content');
    const result = await manager.executeTool(
      { id: 't9', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ file_path: filePath, old_string: 'not found string', new_string: 'x' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.ok(result.content?.includes('未找到'));
  });

  test('edit_file replace_all=false 但匹配多个返回 ok=false', async () => {
    const filePath = path.join(testRoot, 'multi_match.txt');
    fs.writeFileSync(filePath, 'foo bar foo baz');
    const result = await manager.executeTool(
      { id: 't10', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ file_path: filePath, old_string: 'foo', new_string: 'baz', replace_all: false }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.ok(result.content?.includes('2 个匹配项'));
  });

  test('glob 目录不存在返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't11', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.txt', path: '/nope/not/here' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'FILE_NOT_FOUND');
  });

  test('tool 不存在返回 ok=false + TOOL_NOT_FOUND', async () => {
    const result = await manager.executeTool(
      { id: 't12', type: 'function', function: { name: 'nonexistent_tool', arguments: '{}' } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_NOT_FOUND');
  });

  test('参数 JSON 无效返回 ok=false + INVALID_TOOL_ARGUMENTS', async () => {
    const result = await manager.executeTool(
      { id: 't13', type: 'function', function: { name: 'write_file', arguments: '{bad json' } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
  });

  test('spawn_subagent 参数缺失返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't14', type: 'function', function: { name: 'spawn_subagent', arguments: JSON.stringify({}) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
    assert.ok(result.content?.includes('必填参数'));
  });

  test('stop_subagent 参数缺失返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't15', type: 'function', function: { name: 'stop_subagent', arguments: JSON.stringify({}) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
  });

  test('resume_subagent 参数缺失返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't16', type: 'function', function: { name: 'resume_subagent', arguments: JSON.stringify({ subagent_id: 'sub-1' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
  });

  test('check_subagent 不存在的 ID 返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't17', type: 'function', function: { name: 'check_subagent', arguments: JSON.stringify({ subagent_id: 'sub-does-not-exist' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_NOT_FOUND');
  });

  test('stop_subagent 不存在的 ID 返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't18', type: 'function', function: { name: 'stop_subagent', arguments: JSON.stringify({ subagent_id: 'sub-does-not-exist' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_NOT_FOUND');
  });

  // ─── 别名兼容 ───────────────────────────────────────────────

  test('Bash 别名映射到 execute_shell 成功', async () => {
    const result = await manager.executeTool(
      { id: 't19', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'echo hello' }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('hello'));
  });

  test('Write 别名映射到 write_file 成功', async () => {
    const result = await manager.executeTool(
      { id: 't20', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: 'alias.txt', content: 'via alias' }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('成功'));
  });
});
