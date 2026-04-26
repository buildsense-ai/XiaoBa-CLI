/**
 * send-file-tool 测试：验证 ToolExecutionResult 结构，以及关键修复——
 * 文件不存在时必须返回 ok=false，而非误报成功
 */
import { describe, test, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SendFileTool } from '../src/tools/send-file-tool';
import { ToolExecutionContext } from '../src/types/tool';

describe('SendFileTool - ToolExecutionResult', () => {
  let tool: SendFileTool;
  let testRoot: string;
  let context: ToolExecutionContext;

  beforeEach(() => {
    tool = new SendFileTool();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'send-file-test-'));
    // channel 为空，模拟非聊天会话环境
    context = { workingDirectory: testRoot, conversationHistory: [], surface: 'cli' };
  });

  test('文件不存在时必须返回 ok=false（这是本次修复的核心场景）', async () => {
    const result = await tool.execute(
      { file_path: '/this/file/does/not/exist.txt', file_name: 'nope.txt' },
      context,
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.ok(result.message!.includes('不在聊天会话中') || result.message!.includes('无法发送'));
  });

  test('file_path 为空返回 ok=false', async () => {
    // 注意：当没有 channel 时，优先返回"不在聊天会话中"
    const result = await tool.execute({ file_path: '', file_name: 'test.txt' }, context);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    // channel 检查优先于参数检查
    assert.ok(result.message!.includes('不在聊天会话中') || result.message!.includes('文件路径不能为空'));
  });

  test('file_name 为空返回 ok=false', async () => {
    // 注意：当没有 channel 时，优先返回"不在聊天会话中"
    const result = await tool.execute({ file_path: '/some/path.txt', file_name: '' }, context);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.ok(result.message!.includes('不在聊天会话中') || result.message!.includes('文件名不能为空'));
  });

  test('无 channel 时返回 ok=false', async () => {
    const filePath = path.join(testRoot, 'real.txt');
    fs.writeFileSync(filePath, 'exists');
    const result = await tool.execute({ file_path: filePath, file_name: 'real.txt' }, context);
    assert.strictEqual(result.ok, false);
    assert.ok(result.message!.includes('不在聊天会话中'));
  });

  test('无 channel 时不会尝试上传文件', async () => {
    const filePath = path.join(testRoot, 'should_not_upload.txt');
    fs.writeFileSync(filePath, 'content');
    // 即使文件存在，没有 channel 也要返回失败
    const result = await tool.execute({ file_path: filePath, file_name: 'should_not_upload.txt' }, context);
    assert.strictEqual(result.ok, false);
    // 不应该返回 ok=true 的成功消息
    assert.ok(!result.message!.includes('已发送'));
  });
});
