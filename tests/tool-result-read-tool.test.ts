/**
 * read-tool 测试：验证 ToolExecutionResult 结构
 */
import { describe, test, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ReadTool } from '../src/tools/read-tool';
import { ToolExecutionContext } from '../src/types/tool';

describe('ReadTool - ToolExecutionResult', () => {
  let tool: ReadTool;
  let testRoot: string;
  let context: ToolExecutionContext;

  beforeEach(() => {
    tool = new ReadTool();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'read-tool-test-'));
    context = { workingDirectory: testRoot, conversationHistory: [] };
  });

  test('成功读取文本文件返回 ok=true', async () => {
    const filePath = path.join(testRoot, 'sample.txt');
    fs.writeFileSync(filePath, 'line1\nline2\nline3');
    const result = await tool.execute({ file_path: filePath }, context);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(typeof result.content, 'string');
    const content = result.content as string;
    assert.ok(content.includes('sample.txt'));
    assert.ok(content.includes('line1'));
  });

  test('使用 offset 和 limit 返回 ok=true', async () => {
    const filePath = path.join(testRoot, 'long.txt');
    fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5');
    const result = await tool.execute({ file_path: filePath, offset: 1, limit: 2 }, context);
    assert.strictEqual(result.ok, true);
    const content = result.content as string;
    assert.ok(content.includes('显示: 2-3'));
  });

  test('文件不存在返回 ok=false + FILE_NOT_FOUND', async () => {
    const result = await tool.execute({ file_path: '/nope/not/exist.txt' }, context);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'FILE_NOT_FOUND');
    assert.ok(result.message.includes('文件不存在'));
  });

  test('PDF 文件返回 ok=true 并给出提示', async () => {
    const filePath = path.join(testRoot, 'dummy.pdf');
    fs.writeFileSync(filePath, '%PDF-1.4 fake content');
    const result = await tool.execute({ file_path: filePath }, context);
    assert.strictEqual(result.ok, true);
    const content = result.content as string;
    assert.ok(content.includes('PDF'));
    assert.ok(content.includes('paper-analysis'));
  });
});
