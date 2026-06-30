/**
 * write-tool 测试：验证 ToolExecutionResult 结构
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { WriteTool } from '../src/tools/write-tool';
import { ToolExecutionContext, ToolExecutionResult } from '../src/types/tool';

function getFailure(result: ToolExecutionResult): Extract<ToolExecutionResult, { ok: false }> {
  assert.strictEqual(result.ok, false);
  if (result.ok) throw new Error('expected write_file to fail');
  return result;
}

describe('WriteTool - ToolExecutionResult', () => {
  let tool: WriteTool;
  let testRoot: string;
  let context: ToolExecutionContext;

  beforeEach(() => {
    tool = new WriteTool();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'write-tool-test-'));
    context = { workingDirectory: testRoot, conversationHistory: [] };
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('成功写入新文件返回 ok=true', async () => {
    const result = await tool.execute({ file_path: 'new.txt', content: 'hello' }, context);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(typeof result.content, 'string');
    assert.ok(result.content!.includes('成功创建'));
    assert.ok(fs.existsSync(path.join(testRoot, 'new.txt')));
  });

  test('成功覆盖文件返回 ok=true', async () => {
    const filePath = path.join(testRoot, 'existing.txt');
    fs.writeFileSync(filePath, 'old');
    const result = await tool.execute({ file_path: filePath, content: 'new content' }, context);
    assert.strictEqual(result.ok, true);
    assert.ok(result.content!.includes('成功覆盖'));
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'new content');
  });

  test('文件内容预览信息正确', async () => {
    const result = await tool.execute({ file_path: 'preview.txt', content: 'line1\nline2\nline3\nline4\nline5' }, context);
    assert.strictEqual(result.ok, true);
    assert.ok(result.content!.includes('行数: 5'));
  });

  test('中间目录不存在时自动创建', async () => {
    const result = await tool.execute({ file_path: 'a/b/c/deep.txt', content: 'deep' }, context);
    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(path.join(testRoot, 'a/b/c/deep.txt')));
  });

  test('缺少 content 时返回 INVALID_TOOL_ARGUMENTS 且不创建文件', async () => {
    const result = await tool.execute({ file_path: 'missing-content.txt' }, context);

    const failure = getFailure(result);
    assert.strictEqual(failure.errorCode, 'INVALID_TOOL_ARGUMENTS');
    assert.strictEqual(fs.existsSync(path.join(testRoot, 'missing-content.txt')), false);
  });

  test('缺少或空 file_path 时返回 INVALID_TOOL_ARGUMENTS', async () => {
    const missingPath = await tool.execute({ content: 'hello' }, context);
    const emptyPath = await tool.execute({ file_path: '', content: 'hello' }, context);

    assert.strictEqual(getFailure(missingPath).errorCode, 'INVALID_TOOL_ARGUMENTS');
    assert.strictEqual(getFailure(emptyPath).errorCode, 'INVALID_TOOL_ARGUMENTS');
  });

  test('目标路径是目录时返回结构化错误', async () => {
    const dirPath = path.join(testRoot, 'dir-target');
    fs.mkdirSync(dirPath);

    const result = await tool.execute({ file_path: dirPath, content: 'hello' }, context);

    const failure = getFailure(result);
    assert.strictEqual(failure.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.match(failure.message, /不是文件|not a file/);
    assert.strictEqual(fs.statSync(dirPath).isDirectory(), true);
  });

  test('父路径是文件时返回结构化错误', async () => {
    const parentFile = path.join(testRoot, 'parent-file');
    fs.writeFileSync(parentFile, 'not a directory');

    const result = await tool.execute({ file_path: path.join(parentFile, 'child.txt'), content: 'hello' }, context);

    const failure = getFailure(result);
    assert.strictEqual(failure.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.match(failure.message, /父路径不是目录/);
    assert.strictEqual(fs.readFileSync(parentFile, 'utf8'), 'not a directory');
  });
});
