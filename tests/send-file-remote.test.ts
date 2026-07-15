import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { SendFileTool } from '../src/tools/send-file-tool';
import type { TargetRoute, ToolExecutionContext, UploadedFileResult } from '../src/types/tool';

describe('send_file remote routing', () => {
  test('tells the model to use target for a participant computer path', () => {
    const definition = new SendFileTool().definition;
    const target = definition.parameters.properties?.target as { description?: string } | undefined;

    assert.match(definition.description, /必须.*target/);
    assert.match(definition.description, /不要因为 agent 运行在另一种操作系统上就拒绝/);
    assert.match(String(target?.description), /参与者电脑上的路径/);
    assert.match(String(target?.description), /省略时只会在当前 agent 主机上查找文件/);
  });

  test('uploads on the selected computer and sends the returned attachment metadata', async () => {
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
    let sent: UploadedFileResult | undefined;
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
        sendFile: async () => { throw new Error('local sendFile should not be used'); },
        sendUploadedFile: async (_chatId, file) => { sent = file; },
      },
    };

    const result = await new SendFileTool().execute({
      file_path: 'C:\\Users\\Lin\\Desktop\\报价单.xlsx',
      file_name: '报价单.xlsx',
      target: 'Lin',
    }, context);

    assert.equal(result.ok, true);
    assert.equal(rpcRequest.toolName, 'send_file');
    assert.equal(rpcRequest.targetOwnerUserId, 'usr7');
    assert.equal(rpcRequest.targetDeviceId, 'lin-laptop');
    assert.equal(rpcRequest.timeoutMs, 300_000);
    assert.deepEqual(rpcRequest.args, {
      file_path: 'C:\\Users\\Lin\\Desktop\\报价单.xlsx',
      file_name: '报价单.xlsx',
    });
    assert.deepEqual(sent, {
      url: '/uploads/original.xlsx',
      name: '报价单.xlsx',
      size: 456,
      type: 'file',
    });
    assert.match(result.ok ? String(result.content) : '', /File sent to current chat from remote computer/);
    assert.match(String(result.targetContext), /target: Lin/);
  });
});
