import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReadTool } from '../src/tools/read-tool';
import type { ExecutionScope, ScopedLocalDeviceGrant, ScopedLocalFileGrant } from '../src/types/session-identity';
import type { ToolExecutionContext } from '../src/types/tool';

describe('ReadTool local file grants', () => {
  let testRoot: string;
  let tool: ReadTool;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'read-file-grants-'));
    tool = new ReadTool();
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  function scope(overrides: Partial<ExecutionScope> = {}): ExecutionScope {
    return {
      source: 'catscompany',
      sessionKey: 'cc_user:usr7',
      topicId: 'p2p_7_43',
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

  function grant(filePath: string, overrides: Partial<ScopedLocalFileGrant> = {}): ScopedLocalFileGrant {
    const stat = fs.statSync(filePath);
    const now = Date.now();
    return {
      kind: 'catscompany_attachment',
      source: 'catscompany',
      attachmentRef: 'catsco_attachment:current-read-grant',
      filePath,
      fileName: path.basename(filePath),
      fileType: 'file',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sessionKey: 'cc_user:usr7',
      topicId: 'p2p_7_43',
      topicType: 'p2p',
      actorUserId: 'usr7',
      agentId: 'usr43',
      agentBodyId: 'body-main',
      deviceBodyId: 'body-main',
      deviceInstallationId: 'install-main',
      identityTrust: 'server_canonical',
      operations: ['read_file', 'send_file'],
      createdAt: now,
      expiresAt: now + 60_000,
      ...overrides,
    };
  }

  function deviceGrant(overrides: Partial<ScopedLocalDeviceGrant> = {}): ScopedLocalDeviceGrant {
    return {
      kind: 'catscompany_body',
      source: 'catscompany',
      bodyId: 'body-main',
      installationId: 'install-main',
      deviceId: 'install-main',
      createdAt: Date.now(),
      ...overrides,
    };
  }

  function catsContext(
    localFileGrants?: ScopedLocalFileGrant[],
    executionScope: ExecutionScope = scope(),
  ): ToolExecutionContext {
    return {
      workingDirectory: testRoot,
      workspaceRoot: testRoot,
      conversationHistory: [],
      sessionId: executionScope.sessionKey,
      surface: 'catscompany',
      executionScope,
      localDeviceGrant: deviceGrant(),
      localFileGrants,
    };
  }

  function managedFile(name = 'report.md'): string {
    const filePath = path.join(testRoot, 'tmp', 'downloads', name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'hello from current attachment\nsecond line');
    return filePath;
  }

  test('allows reading a CatsCo attachment cache file with a matching local grant', async () => {
    const filePath = managedFile();
    const result = await tool.execute({ file_path: filePath }, catsContext([grant(filePath)]));

    assert.equal(result.ok, true);
    assert.match(String(result.content), /hello from current attachment/);
  });

  test('allows reading a CatsCo attachment by opaque reference without exposing the local path', async () => {
    const filePath = managedFile('referenced.md');
    const result = await tool.execute(
      { file_path: 'catsco_attachment:read-current' },
      catsContext([grant(filePath, { attachmentRef: 'catsco_attachment:read-current' })]),
    );

    assert.equal(result.ok, true);
    assert.match(String(result.content), /hello from current attachment/);
    assert.match(String(result.content), /Path: catsco_attachment:read-current/);
    assert.doesNotMatch(String(result.content), new RegExp(escapeRegExp(filePath)));
    assert.doesNotMatch(String(result.content), new RegExp(escapeRegExp(testRoot)));
  });

  test('rejects unknown CatsCo attachment references without exposing granted local paths', async () => {
    const filePath = managedFile('private.md');
    const result = await tool.execute(
      { file_path: 'catsco_attachment:missing-read' },
      catsContext([grant(filePath, { attachmentRef: 'catsco_attachment:owned-read' })]),
    );

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PERMISSION_DENIED');
    assert.match(result.message, /附件引用不属于当前已授权/);
    assert.match(result.message, /catsco_attachment:missing-read/);
    assert.doesNotMatch(result.message, new RegExp(escapeRegExp(filePath)));
    assert.doesNotMatch(result.message, new RegExp(escapeRegExp(testRoot)));
  });

  test('allows reading a relative CatsCo attachment path with an absolute matching grant', async () => {
    const filePath = managedFile('relative.md');
    const result = await tool.execute({ file_path: path.join('tmp', 'downloads', 'relative.md') }, catsContext([grant(filePath)]));

    assert.equal(result.ok, true);
    assert.match(String(result.content), /hello from current attachment/);
  });

  test('rejects reading a CatsCo attachment cache file without a current grant', async () => {
    const filePath = managedFile('old-report.md');
    const result = await tool.execute({ file_path: filePath }, catsContext());

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PERMISSION_DENIED');
    assert.match(result.message, /不属于当前已授权的用户消息/);
  });

  test('rejects managed attachment reads for legacy or untrusted execution scopes', async () => {
    const filePath = managedFile('legacy.md');
    const canonicalGrant = grant(filePath);

    const legacy = await tool.execute({ file_path: filePath }, catsContext([canonicalGrant], scope({
      identityTrust: 'legacy_context',
      isTrusted: false,
    })));
    assert.equal(legacy.ok, false);
    assert.equal(legacy.errorCode, 'PERMISSION_DENIED');
    assert.doesNotMatch(legacy.message, /hello from current attachment/);

    const untrusted = await tool.execute({ file_path: filePath }, catsContext([canonicalGrant], scope({
      identityTrust: 'untrusted',
      isTrusted: false,
    })));
    assert.equal(untrusted.ok, false);
    assert.equal(untrusted.errorCode, 'PERMISSION_DENIED');
    assert.doesNotMatch(untrusted.message, /hello from current attachment/);
  });

  test('rejects stale CatsCo attachment references without exposing the local path', async () => {
    const filePath = managedFile('expired-reference.md');
    const result = await tool.execute({
      file_path: 'catsco_attachment:expired-read',
    }, catsContext([grant(filePath, {
      attachmentRef: 'catsco_attachment:expired-read',
      expiresAt: Date.now() - 1,
    })]));

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PERMISSION_DENIED');
    assert.match(result.message, /已过期/);
    assert.match(result.message, /catsco_attachment:expired-read/);
    assert.doesNotMatch(result.message, /expired-reference\.md/);
    assert.doesNotMatch(result.message, new RegExp(escapeRegExp(testRoot)));
  });

  test('keeps missing-file errors ahead of local grant checks', async () => {
    const filePath = path.join(testRoot, 'tmp', 'downloads', 'missing.md');
    const result = await tool.execute({ file_path: filePath }, catsContext());

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'FILE_NOT_FOUND');
  });

  test('returns a directory read error before local grant checks for managed directories', async () => {
    const directoryPath = path.join(testRoot, 'tmp', 'downloads');
    fs.mkdirSync(directoryPath, { recursive: true });
    const result = await tool.execute({ file_path: directoryPath }, catsContext());

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.match(result.message, /Path is not a file/);
  });

  test('does not require local grants for CLI reads', async () => {
    const filePath = managedFile('cli-report.md');
    const result = await tool.execute({
      file_path: filePath,
    }, {
      workingDirectory: testRoot,
      workspaceRoot: testRoot,
      conversationHistory: [],
      surface: 'cli',
    });

    assert.equal(result.ok, true);
    assert.match(String(result.content), /hello from current attachment/);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
