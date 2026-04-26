/**
 * write-tool 测试：验证 ToolExecutionResult 结构
 */
import { describe, test, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { WriteTool } from '../src/tools/write-tool';
import { ToolExecutionContext } from '../src/types/tool';

describe('WriteTool - ToolExecutionResult', () => {
  let tool: WriteTool;
  let testRoot: string;
  let context: ToolExecutionContext;

  beforeEach(() => {
    tool = new WriteTool();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'write-tool-test-'));
    context = { workingDirectory: testRoot, conversationHistory: [] };
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
});
