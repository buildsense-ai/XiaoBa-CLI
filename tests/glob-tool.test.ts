import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GlobTool } from '../src/tools/glob-tool';
import type { DeviceRpcToolRequest, ToolExecutionContext } from '../src/types/tool';
import type { DeviceGrantOperation, ScopedDeviceGrant, ScopedDeviceSelection } from '../src/types/session-identity';

describe('GlobTool', () => {
  let root: string;
  let tool: GlobTool;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-tool-'));
    tool = new GlobTool();

    writeFixture('scripts/chat_eval.py', 'print("chat")\n', '2026-06-24T12:00:00.000Z');
    writeFixture('scripts/dialog_test.ts', 'export const dialog = true;\n', '2026-06-24T12:05:00.000Z');
    writeFixture('logs/recent.log', 'recent\n', '2026-06-24T13:00:00.000Z');
    writeFixture('logs/old.log', 'old\n', '2026-06-20T13:00:00.000Z');
    writeFixture('nested/deep/deep_test.py', 'print("deep")\n', '2026-06-24T14:00:00.000Z');
    writeFixture('README.md', '# fixture\n', '2026-06-24T15:00:00.000Z');
    fs.mkdirSync(path.join(root, 'empty-dir'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('keeps legacy single-pattern file search behavior', async () => {
    const result = await tool.execute({ pattern: '**/*.py' }, context());

    assert.equal(result.ok, true);
    const output = String(result.content);
    assert.match(output, /Found 2\/2 files/);
    assert.match(output, /scripts\/chat_eval\.py/);
    assert.match(output, /nested\/deep\/deep_test\.py/);
  });

  test('accepts multiple patterns and includes summary facets', async () => {
    const result = await tool.execute({
      patterns: ['**/*chat*.py', '**/*dialog*.ts'],
      summary: true,
    }, context());

    assert.equal(result.ok, true);
    const output = String(result.content);
    assert.match(output, /Patterns: \*\*\/\*chat\*\.py, \*\*\/\*dialog\*\.ts/);
    assert.match(output, /scripts\/chat_eval\.py/);
    assert.match(output, /scripts\/dialog_test\.ts/);
    assert.match(output, /Summary:/);
    assert.match(output, /top directories: scripts=2/);
    assert.match(output, /extensions: \.py=1, \.ts=1|extensions: \.ts=1, \.py=1/);
  });

  test('filters by entry kind', async () => {
    const result = await tool.execute({ pattern: '*', kind: 'directories' }, context());

    assert.equal(result.ok, true);
    const output = String(result.content);
    assert.match(output, /Kind: directories/);
    assert.match(output, /scripts\//);
    assert.match(output, /logs\//);
    assert.match(output, /empty-dir\//);
    assert.doesNotMatch(output, /README\.md/);
  });

  test('filters by modified time', async () => {
    const result = await tool.execute({
      pattern: 'logs/*.log',
      modified_after: '2026-06-23T00:00:00.000Z',
    }, context());

    assert.equal(result.ok, true);
    const output = String(result.content);
    assert.match(output, /logs\/recent\.log/);
    assert.doesNotMatch(output, /logs\/old\.log/);
    assert.match(output, /Modified after: 2026-06-23T00:00:00.000Z/);
  });

  test('limits recursive traversal with max_depth', async () => {
    const result = await tool.execute({
      pattern: '**/*.py',
      max_depth: 2,
    }, context());

    assert.equal(result.ok, true);
    const output = String(result.content);
    assert.match(output, /scripts\/chat_eval\.py/);
    assert.doesNotMatch(output, /nested\/deep\/deep_test\.py/);
    assert.match(output, /Max depth: 2/);
  });

  test('rejects calls without a pattern dimension', async () => {
    const result = await tool.execute({}, context());

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
      assert.match(result.message, /requires either pattern or patterns/);
    }
  });

  test('adds legacy pattern when forwarding patterns-only calls to a remote target', async () => {
    let forwardedRequest: DeviceRpcToolRequest | undefined;
    const ctx = context();
    ctx.surface = 'catscompany';
    ctx.deviceSelection = selectedDevice(['glob']);
    ctx.deviceGrants = [deviceGrant(['glob'])];
    ctx.deviceRpc = {
      executeTool: async (request) => {
        forwardedRequest = request;
        return { ok: true, content: 'remote glob ok' };
      },
    };

    const result = await tool.execute({
      target: 'speaker_default',
      patterns: ['**/*chat*.py', '**/*dialog*.ts'],
      path: '/remote/project',
      summary: true,
    }, ctx);

    assert.equal(result.ok, true);
    assert.equal(forwardedRequest?.toolName, 'glob');
    assert.equal(forwardedRequest?.operation, 'glob');
    assert.equal(forwardedRequest?.targetDeviceId, 'speaker-device');
    assert.deepEqual(forwardedRequest?.args, {
      patterns: ['**/*chat*.py', '**/*dialog*.ts'],
      path: '/remote/project',
      summary: true,
      pattern: '**/*chat*.py',
    });
  });

  function context(): ToolExecutionContext {
    return {
      workingDirectory: root,
      conversationHistory: [],
      surface: 'cli',
    };
  }

  function selectedDevice(operations: DeviceGrantOperation[]): ScopedDeviceSelection {
    return {
      kind: 'user_device_selection',
      source: 'catscompany',
      status: 'selected',
      sessionKey: 'session:v2:catscompany:p2p:topic:agent:agent-1',
      topicId: 'topic',
      topicType: 'p2p',
      actorUserId: 'speaker-user',
      agentId: 'agent-1',
      identityTrust: 'server_canonical',
      selectedDeviceId: 'speaker-device',
      selectedDeviceDisplayName: 'Speaker Laptop',
      selectedDeviceBodyId: 'speaker-body',
      selectedDeviceInstallationId: 'speaker-install',
      selectedDeviceOperations: operations,
      createdAt: Date.now() - 1000,
    };
  }

  function deviceGrant(operations: DeviceGrantOperation[]): ScopedDeviceGrant {
    return {
      kind: 'user_device_grant',
      source: 'catscompany',
      grantId: 'grant-glob',
      status: 'active',
      identityTrust: 'server_canonical',
      deviceId: 'speaker-device',
      deviceDisplayName: 'Speaker Laptop',
      deviceBodyId: 'speaker-body',
      deviceInstallationId: 'speaker-install',
      ownerUserId: 'speaker-user',
      sessionKey: 'session:v2:catscompany:p2p:topic:agent:agent-1',
      topicId: 'topic',
      topicType: 'p2p',
      actorUserId: 'speaker-user',
      agentId: 'agent-1',
      operations,
      createdAt: Date.now() - 1000,
      expiresAt: Date.now() + 60_000,
    };
  }

  function writeFixture(relativePath: string, content: string, isoMtime: string): void {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    const time = new Date(isoMtime);
    fs.utimesSync(fullPath, time, time);
  }
});
