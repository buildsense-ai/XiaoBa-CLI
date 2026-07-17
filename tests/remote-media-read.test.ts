import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReadTool } from '../src/tools/read-tool';
import type { TargetRoute, ToolExecutionContext } from '../src/types/tool';

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe('remote media reads', () => {
  test('imports a remote PDF into the agent runtime before reading it locally', async () => {
    const { context, importedPath, rpcCalls } = createRemoteMediaContext('report.pdf');
    const tool = new ReadTool();
    let locallyReadPath = '';
    (tool as any).readPDF = async (absolutePath: string) => {
      locallyReadPath = absolutePath;
      return `local PDF read: ${absolutePath}`;
    };

    const result = await tool.execute({
      file_path: 'C:\\Users\\Alice\\Desktop\\report.pdf',
      target: 'Alice',
    }, context);

    assert.equal(result.ok, true);
    assert.deepEqual(rpcCalls.map(call => call.toolName), ['import_file']);
    assert.equal(rpcCalls[0].args.file_path, 'C:\\Users\\Alice\\Desktop\\report.pdf');
    assert.equal(rpcCalls[0].args.file_name, 'report.pdf');
    assert.equal(locallyReadPath, importedPath);
    assert.match(result.ok ? String(result.content) : '', new RegExp(escapeRegExp(importedPath)));
  });

  test('imports a remote image into the agent runtime before reading it locally', async () => {
    const { context, importedPath, rpcCalls } = createRemoteMediaContext('chart.png');
    const tool = new ReadTool();
    let locallyReadPath = '';
    (tool as any).readImage = async (absolutePath: string) => {
      locallyReadPath = absolutePath;
      return `local image read: ${absolutePath}`;
    };

    const result = await tool.execute({
      file_path: '/Users/alice/Desktop/chart.png',
      target: 'Alice',
    }, context);

    assert.equal(result.ok, true);
    assert.deepEqual(rpcCalls.map(call => call.toolName), ['import_file']);
    assert.equal(rpcCalls[0].args.file_name, 'chart.png');
    assert.equal(locallyReadPath, importedPath);
  });

  test('keeps remote text reads on the normal remote read_file route', async () => {
    const { context, rpcCalls } = createRemoteMediaContext('notes.txt');
    const tool = new ReadTool();

    const result = await tool.execute({
      file_path: 'C:\\Users\\Alice\\Desktop\\notes.txt',
      target: 'Alice',
    }, context);

    assert.equal(result.ok, true);
    assert.deepEqual(rpcCalls.map(call => call.toolName), ['read_file']);
  });
});

function createRemoteMediaContext(fileName: string): {
  context: ToolExecutionContext;
  importedPath: string;
  rpcCalls: Array<{ toolName: string; args: Record<string, unknown> }>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-media-read-'));
  temporaryRoots.push(root);
  const importedPath = path.join(root, fileName);
  const route: TargetRoute = {
    userId: 'usr-alice',
    userName: 'Alice',
    ownerUserId: 'usr-alice',
    deviceId: 'alice-device',
    label: 'Alice 的电脑',
    os: 'windows',
    status: 'ready',
  };
  const rpcCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

  return {
    importedPath,
    rpcCalls,
    context: {
      workingDirectory: root,
      workspaceRoot: root,
      conversationHistory: [],
      surface: 'catscompany',
      targetRoutes: {
        routes: [route],
        byName: new Map([['alice', [route]]]),
        byUserId: new Map([['usr-alice', [route]]]),
      },
      thinToolRpc: {
        executeTool: async request => {
          rpcCalls.push({ toolName: request.toolName, args: request.args });
          if (request.toolName === 'read_file') {
            return { ok: true, content: 'remote text content' };
          }
          return {
            ok: true,
            content: 'remote upload complete',
            uploadedFile: {
              url: '/uploads/remote-media',
              name: fileName,
              size: 4,
              type: 'file',
            },
          };
        },
      },
      channel: {
        chatId: 'p2p_alice_agent',
        reply: async () => {},
        sendFile: async () => {},
        receiveUploadedFile: async () => {
          fs.writeFileSync(importedPath, 'test');
          return importedPath;
        },
      },
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
