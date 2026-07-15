import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ImportFileTool } from '../src/tools/import-file-tool';
import { SendFileTool } from '../src/tools/send-file-tool';
import type { TargetRoute, ToolExecutionContext, UploadedFileResult } from '../src/types/tool';

describe('import_file remote routing', () => {
  test('keeps send_file chat-only and gives import_file a required target', () => {
    const sendDefinition = new SendFileTool().definition;
    const importDefinition = new ImportFileTool().definition;

    assert.equal(sendDefinition.parameters.properties.target, undefined);
    assert.match(sendDefinition.description, /当前聊天会话/);
    assert.doesNotMatch(sendDefinition.description, /目标电脑直接上传/);
    assert.ok(importDefinition.parameters.required?.includes('target'));
    assert.match(importDefinition.description, /不要使用 send_file/);
    assert.match(importDefinition.description, /不会把附件发送到聊天/);
  });

  test('requires a participant target before sending any RPC request', async () => {
    let rpcCalls = 0;
    const result = await new ImportFileTool().execute({
      file_path: 'C:\\Users\\Lin\\Desktop\\报价单.xlsx',
      file_name: '报价单.xlsx',
    }, {
      workingDirectory: process.cwd(),
      conversationHistory: [],
      surface: 'catscompany',
      thinToolRpc: {
        executeTool: async () => {
          rpcCalls += 1;
          return { ok: true, content: 'unexpected' };
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.errorCode, 'INVALID_TOOL_ARGUMENTS');
    assert.equal(rpcCalls, 0);
  });

  test('uploads on the selected computer and saves the original file in the agent workspace', async (t) => {
    const route: TargetRoute = {
      userId: 'usr7',
      userName: 'Lin',
      ownerUserId: 'usr7',
      deviceId: 'lin-laptop',
      label: 'Lin laptop',
      os: 'windows',
      status: 'ready',
    };
    let rpcRequest: any;
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'import-file-remote-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const agentPath = path.join(workspace, '报价单.xlsx');
    fs.writeFileSync(agentPath, Buffer.alloc(456, 7));
    let received: UploadedFileResult | undefined;
    let chatFileSends = 0;
    const context: ToolExecutionContext = {
      workingDirectory: process.cwd(),
      conversationHistory: [],
      surface: 'catscompany',
      executionScope: {
        source: 'catscompany',
        sessionKey: 'session-1',
        topicId: 'p2p_7_43',
        topicType: 'p2p',
        actorUserId: 'usr7',
        agentId: 'usr43',
        identityTrust: 'server_canonical',
        isTrusted: true,
      },
      targetRoutes: {
        routes: [route],
        byName: new Map([['lin', [route]]]),
        byUserId: new Map([['usr7', [route]]]),
      },
      thinToolRpc: {
        executeTool: async request => {
          rpcRequest = request;
          return {
            ok: true,
            content: 'remote upload complete',
            uploadedFile: {
              url: '/uploads/original.xlsx',
              name: '报价单.xlsx',
              size: 456,
              type: 'file',
            },
          };
        },
      },
      channel: {
        chatId: 'p2p_7_43',
        reply: async () => {},
        sendFile: async () => {
          chatFileSends += 1;
        },
        receiveUploadedFile: async (file) => {
          received = file;
          return agentPath;
        },
      },
    };

    const result = await new ImportFileTool().execute({
      file_path: 'C:\\Users\\Lin\\Desktop\\报价单.xlsx',
      file_name: '报价单.xlsx',
      target: 'Lin',
    }, context);

    assert.equal(result.ok, true);
    assert.equal(rpcRequest.toolName, 'import_file');
    assert.equal(rpcRequest.targetOwnerUserId, 'usr7');
    assert.equal(rpcRequest.targetDeviceId, 'lin-laptop');
    assert.equal(rpcRequest.timeoutMs, 300_000);
    assert.deepEqual(rpcRequest.args, {
      file_path: 'C:\\Users\\Lin\\Desktop\\报价单.xlsx',
      file_name: '报价单.xlsx',
    });
    assert.deepEqual(received, {
      url: '/uploads/original.xlsx',
      name: '报价单.xlsx',
      size: 456,
      type: 'file',
    });
    assert.equal(chatFileSends, 0);
    assert.match(result.ok ? String(result.content) : '', /File imported from remote computer into this agent workspace/);
    assert.match(result.ok ? String(result.content) : '', new RegExp(escapeRegExp(agentPath)));
    assert.match(String(result.targetContext), /tool: import_file/);
    assert.match(String(result.targetContext), /target: agent_self/);
    assert.match(String(result.targetContext), new RegExp(`cwd: ${escapeRegExp(workspace)}`));
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
