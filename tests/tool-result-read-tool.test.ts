/**
 * read-tool 测试：验证 ToolExecutionResult 结构
 */
import { describe, test, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { DEFAULT_TEXT_READ_LIMIT, ReadTool } from '../src/tools/read-tool';
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

  test('默认只读取文本文件开头窗口', async () => {
    const filePath = path.join(testRoot, 'large.txt');
    const lines = Array.from({ length: DEFAULT_TEXT_READ_LIMIT + 5 }, (_, index) => `line${index + 1}`);
    fs.writeFileSync(filePath, lines.join('\n'));

    const result = await tool.execute({ file_path: filePath }, context);

    assert.strictEqual(result.ok, true);
    const content = result.content as string;
    assert.ok(content.includes(`显示: 1-${DEFAULT_TEXT_READ_LIMIT}`));
    assert.ok(content.includes(`默认只显示 ${DEFAULT_TEXT_READ_LIMIT} 行`));
    assert.ok(content.includes(`offset=${DEFAULT_TEXT_READ_LIMIT + 1}`));
    assert.ok(content.includes('line200'));
    assert.ok(!content.includes('line201'));
  });

  test('使用 1-based offset 和 limit 返回 ok=true', async () => {
    const filePath = path.join(testRoot, 'long.txt');
    fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5');
    const result = await tool.execute({ file_path: filePath, offset: 2, limit: 2 }, context);
    assert.strictEqual(result.ok, true);
    const content = result.content as string;
    assert.ok(content.includes('显示: 2-3'));
    assert.ok(content.includes('    2→ line2'));
    assert.ok(!content.includes('    1→ line1'));
  });

  test('limit=0 对小文本文件读取全文', async () => {
    const filePath = path.join(testRoot, 'full.txt');
    fs.writeFileSync(filePath, 'line1\nline2\nline3');
    const result = await tool.execute({ file_path: filePath, limit: 0 }, context);
    assert.strictEqual(result.ok, true);
    const content = result.content as string;
    assert.ok(content.includes('显示: 1-3'));
    assert.ok(content.includes('line3'));
    assert.ok(!content.includes('默认只显示'));
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
    assert.ok(content.includes('不再做 PDF 全文解析'));
    assert.ok(content.includes('文档解析工具'));
    assert.ok(!content.includes('paper-analysis'));
  });
});
