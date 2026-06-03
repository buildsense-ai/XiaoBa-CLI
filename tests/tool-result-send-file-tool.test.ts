import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SendFileTool } from '../src/tools/send-file-tool';
import type { ExecutionScope } from '../src/types/session-identity';
import { ToolExecutionContext } from '../src/types/tool';

describe('SendFileTool - ToolExecutionResult', () => {
  let tool: SendFileTool;
  let testRoot: string;
  let context: ToolExecutionContext;

  beforeEach(() => {
    tool = new SendFileTool();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'send-file-test-'));
    context = { workingDirectory: testRoot, workspaceRoot: testRoot, conversationHistory: [], surface: 'cli' };
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  function scope(overrides: Partial<ExecutionScope> = {}): ExecutionScope {
    return {
      source: 'catscompany',
      sessionKey: 'cc_user:usr7',
      topicId: 'chat-1',
      topicType: 'p2p',
      actorUserId: 'usr7',
      agentId: 'usr43',
      agentBodyId: 'body-main',
      permissionsSource: 'server_canonical_message',
      identityTrust: 'server_canonical',
      isTrusted: true,
      ...overrides,
    };
  }

  test('definition marks sent files as outbound transcript messages', () => {
    assert.strictEqual(tool.definition.transcriptMode, 'outbound_file');
    assert.strictEqual(tool.definition.controlMode, undefined);
  });

  test('missing file returns FILE_NOT_FOUND with resolved path', async () => {
    const result = await tool.execute(
      { file_path: 'missing.txt', file_name: 'missing.txt' },
      context,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'FILE_NOT_FOUND');
    assert.ok(result.message.includes('File not found.'));
    assert.ok(result.message.includes(`Resolved path: ${path.join(testRoot, 'missing.txt')}`));
  });

  test('empty file_path returns ok=false', async () => {
    const result = await tool.execute({ file_path: '', file_name: 'test.txt' }, context);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.ok(result.message.includes('文件路径不能为空'));
  });

  test('empty file_name returns ok=false', async () => {
    const result = await tool.execute({ file_path: 'some-path.txt', file_name: '' }, context);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.ok(result.message.includes('文件名不能为空'));
  });

  test('existing file without channel returns ok=false', async () => {
    const filePath = path.join(testRoot, 'real.txt');
    fs.writeFileSync(filePath, 'exists');

    const result = await tool.execute({ file_path: filePath, file_name: 'real.txt' }, context);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.ok(result.message.includes('当前不在聊天会话中'));
  });

  test('relative file_path resolves from current directory before send', async () => {
    const filePath = path.join(testRoot, 'report.md');
    fs.writeFileSync(filePath, 'hello');
    let sentPath = '';
    context.channel = {
      chatId: 'chat-1',
      reply: async () => {},
      sendFile: async (_chatId, resolvedPath) => {
        sentPath = resolvedPath;
      },
    };

    const result = await tool.execute({ file_path: 'report.md', file_name: 'report.md' }, context);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(sentPath, filePath);
    assert.ok((result.content as string).includes('File sent to current chat.'));
    assert.ok((result.content as string).includes(`Path: ${filePath}`));
  });

  test('uses executionScope topic for file sends when scope is present', async () => {
    const filePath = path.join(testRoot, 'scoped.md');
    fs.writeFileSync(filePath, 'hello');
    let sentChatId = '';
    context.executionScope = scope({ topicId: 'chat-1' });
    context.channel = {
      chatId: 'chat-1',
      reply: async () => {},
      sendFile: async (chatId) => {
        sentChatId = chatId;
      },
    };

    const result = await tool.execute({ file_path: filePath, file_name: 'scoped.md' }, context);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(sentChatId, 'chat-1');
  });

  test('blocks file send when channel chatId conflicts with executionScope topic', async () => {
    const filePath = path.join(testRoot, 'secret.md');
    fs.writeFileSync(filePath, 'hello');
    let sendCalled = false;
    context.executionScope = scope({ topicId: 'chat-1' });
    context.channel = {
      chatId: 'chat-2',
      reply: async () => {},
      sendFile: async () => {
        sendCalled = true;
      },
    };

    const result = await tool.execute({ file_path: filePath, file_name: 'secret.md' }, context);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'PERMISSION_DENIED');
    assert.match(result.message, /外发目标与当前执行身份不一致/);
    assert.strictEqual(sendCalled, false);
  });

  test('blocks file send for untrusted CatsCo scope', async () => {
    const filePath = path.join(testRoot, 'report.md');
    fs.writeFileSync(filePath, 'hello');
    let sendCalled = false;
    context.executionScope = scope({
      identityTrust: 'untrusted',
      isTrusted: false,
      agentBodyId: undefined,
      permissionsSource: undefined,
    });
    context.channel = {
      chatId: 'chat-1',
      reply: async () => {},
      sendFile: async () => {
        sendCalled = true;
      },
    };

    const result = await tool.execute({ file_path: filePath, file_name: 'report.md' }, context);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'PERMISSION_DENIED');
    assert.match(result.message, /身份未通过服务端一致性校验/);
    assert.strictEqual(sendCalled, false);
  });

  test('allows file send for legacy CatsCo scope when topic matches', async () => {
    const filePath = path.join(testRoot, 'legacy.md');
    fs.writeFileSync(filePath, 'hello');
    let sentChatId = '';
    context.executionScope = scope({
      identityTrust: 'legacy_context',
      isTrusted: false,
      agentBodyId: undefined,
      permissionsSource: undefined,
    });
    context.channel = {
      chatId: 'chat-1',
      reply: async () => {},
      sendFile: async (chatId) => {
        sentChatId = chatId;
      },
    };

    const result = await tool.execute({ file_path: filePath, file_name: 'legacy.md' }, context);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(sentChatId, 'chat-1');
  });

  test('directory path is rejected before send', async () => {
    context.channel = {
      chatId: 'chat-1',
      reply: async () => {},
      sendFile: async () => {
        throw new Error('should not send');
      },
    };

    const result = await tool.execute({ file_path: '.', file_name: 'root' }, context);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.ok(result.message.includes('Path is not a file.'));
  });

  test('channel errors are returned in tool_result content', async () => {
    const filePath = path.join(testRoot, 'real.txt');
    fs.writeFileSync(filePath, 'exists');
    context.channel = {
      chatId: 'chat-1',
      reply: async () => {},
      sendFile: async () => {
        throw new Error('upload failed');
      },
    };

    const result = await tool.execute({ file_path: filePath, file_name: 'real.txt' }, context);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.ok(result.message.includes('File send failed: upload failed'));
    assert.ok(result.message.includes(`Path: ${filePath}`));
  });
});
