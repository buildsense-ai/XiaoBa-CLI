import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveLocalFileAccess, resolveLocalFileReference } from '../src/tools/local-file-gateway';
import type {
  ExecutionScope,
  ScopedLocalDeviceGrant,
  ScopedLocalFileGrant,
} from '../src/types/session-identity';
import type { ToolExecutionContext, ToolSurface } from '../src/types/tool';

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

function grant(filePath: string, overrides: Partial<ScopedLocalFileGrant> = {}): ScopedLocalFileGrant {
  const stat = fs.statSync(filePath);
  const now = Date.now();
  return {
    kind: 'catscompany_attachment',
    source: 'catscompany',
    attachmentRef: 'catsco_attachment:current-grant',
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

function context(options: {
  workspaceRoot: string;
  surface?: ToolSurface;
  executionScope?: ExecutionScope;
  localDeviceGrant?: ScopedLocalDeviceGrant;
  localFileGrants?: ScopedLocalFileGrant[];
}): ToolExecutionContext {
  return {
    workingDirectory: options.workspaceRoot,
    workspaceRoot: options.workspaceRoot,
    conversationHistory: [],
    sessionId: options.executionScope?.sessionKey,
    surface: options.surface ?? 'catscompany',
    executionScope: options.executionScope,
    localDeviceGrant: options.localDeviceGrant,
    localFileGrants: options.localFileGrants,
  };
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-local-grant-test-'));
}

function makeManagedFile(workspaceRoot: string, name = 'report.md'): string {
  const filePath = path.join(workspaceRoot, 'tmp', 'downloads', name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'hello');
  return filePath;
}

describe('resolveLocalFileAccess', () => {
  test('allows a CatsCo managed attachment path with a matching canonical grant', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = makeManagedFile(workspaceRoot);
    const result = resolveLocalFileAccess(context({
      workspaceRoot,
      executionScope: scope(),
      localDeviceGrant: deviceGrant(),
      localFileGrants: [grant(filePath)],
    }), {
      operation: 'read_file',
      absolutePath: filePath,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.displayPath, 'catsco_attachment:current-grant');
    }
  });

  test('resolves a CatsCo attachment reference without exposing the local path', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = makeManagedFile(workspaceRoot, 'current-ref.md');
    const result = resolveLocalFileReference(context({
      workspaceRoot,
      executionScope: scope(),
      localDeviceGrant: deviceGrant(),
      localFileGrants: [grant(filePath, { attachmentRef: 'catsco_attachment:current-ref' })],
    }), {
      operation: 'read_file',
      inputPath: ' catsco_attachment:current-ref ',
    });

    assert.equal(result.matched, true);
    if (result.matched) {
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.absolutePath, path.resolve(filePath));
        assert.equal(result.displayPath, 'catsco_attachment:current-ref');
      }
    }
  });

  test('rejects invalid attachment references without leaking the local path', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = makeManagedFile(workspaceRoot, 'expired-ref.md');
    const result = resolveLocalFileReference(context({
      workspaceRoot,
      executionScope: scope(),
      localDeviceGrant: deviceGrant(),
      localFileGrants: [grant(filePath, {
        attachmentRef: 'catsco_attachment:expired-ref',
        expiresAt: Date.now() - 1,
      })],
    }), {
      operation: 'read_file',
      inputPath: 'catsco_attachment:expired-ref',
    });

    assert.equal(result.matched, true);
    if (result.matched) {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.message, /已过期/);
        assert.match(result.message, /catsco_attachment:expired-ref/);
        assert.doesNotMatch(result.message, /expired-ref\.md/);
        assert.doesNotMatch(result.message, new RegExp(escapeRegExp(workspaceRoot)));
      }
    }
  });

  test('rejects unknown attachment references without leaking any granted local path', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = makeManagedFile(workspaceRoot, 'private-ref.md');
    const result = resolveLocalFileReference(context({
      workspaceRoot,
      executionScope: scope(),
      localDeviceGrant: deviceGrant(),
      localFileGrants: [grant(filePath, { attachmentRef: 'catsco_attachment:owned-ref' })],
    }), {
      operation: 'read_file',
      inputPath: 'catsco_attachment:unknown-ref',
    });

    assert.equal(result.matched, true);
    if (result.matched) {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.errorCode, 'PERMISSION_DENIED');
        assert.match(result.message, /附件引用不属于当前已授权/);
        assert.match(result.message, /catsco_attachment:unknown-ref/);
        assert.doesNotMatch(result.message, /private-ref\.md/);
        assert.doesNotMatch(result.message, new RegExp(escapeRegExp(workspaceRoot)));
      }
    }
  });

  test('rejects attachment references when current identity mismatches without leaking the local path', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = makeManagedFile(workspaceRoot, 'wrong-actor-ref.md');
    const result = resolveLocalFileReference(context({
      workspaceRoot,
      executionScope: scope({ actorUserId: 'usr8', sessionKey: 'cc_user:usr8' }),
      localDeviceGrant: deviceGrant(),
      localFileGrants: [grant(filePath, { attachmentRef: 'catsco_attachment:wrong-actor' })],
    }), {
      operation: 'read_file',
      inputPath: 'catsco_attachment:wrong-actor',
    });

    assert.equal(result.matched, true);
    if (result.matched) {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.errorCode, 'PERMISSION_DENIED');
        assert.match(result.message, /授权与当前执行身份不一致/);
        assert.match(result.message, /Attachment ref: catsco_attachment:wrong-actor/);
        assert.doesNotMatch(result.message, /wrong-actor-ref\.md/);
        assert.doesNotMatch(result.message, new RegExp(escapeRegExp(workspaceRoot)));
      }
    }
  });

  test('rejects CatsCo attachment references outside CatsCo sessions', () => {
    const workspaceRoot = makeWorkspace();
    const result = resolveLocalFileReference(context({
      workspaceRoot,
      surface: 'cli',
    }), {
      operation: 'read_file',
      inputPath: 'catsco_attachment:outside-catsco',
    });

    assert.deepEqual(result, {
      matched: true,
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: 'CatsCo 附件引用只能在当前 CatsCo 会话中使用。',
    });
  });

  test('rejects a CatsCo managed attachment path without a current grant', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = makeManagedFile(workspaceRoot, 'old-report.md');
    const result = resolveLocalFileAccess(context({
      workspaceRoot,
      executionScope: scope(),
      localDeviceGrant: deviceGrant(),
    }), {
      operation: 'read_file',
      absolutePath: filePath,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, 'PERMISSION_DENIED');
      assert.match(result.message, /不属于当前已授权的用户消息/);
      assert.match(result.message, /\[CatsCo managed attachment cache\]/);
      assert.doesNotMatch(result.message, /old-report\.md/);
      assert.doesNotMatch(result.message, new RegExp(escapeRegExp(workspaceRoot)));
    }
  });

  test('rejects legacy_context scope even when a matching grant is present', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = makeManagedFile(workspaceRoot);
    const result = resolveLocalFileAccess(context({
      workspaceRoot,
      executionScope: scope({ identityTrust: 'legacy_context', isTrusted: false }),
      localDeviceGrant: deviceGrant(),
      localFileGrants: [grant(filePath)],
    }), {
      operation: 'read_file',
      absolutePath: filePath,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.message, /未通过服务端一致性校验/);
      assert.match(result.message, /catsco_attachment:current-grant/);
      assert.doesNotMatch(result.message, new RegExp(escapeRegExp(workspaceRoot)));
    }
  });

  test('rejects a grant when actor identity does not match the current execution scope', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = makeManagedFile(workspaceRoot);
    const result = resolveLocalFileAccess(context({
      workspaceRoot,
      executionScope: scope({ actorUserId: 'usr8', sessionKey: 'cc_user:usr8' }),
      localDeviceGrant: deviceGrant(),
      localFileGrants: [grant(filePath)],
    }), {
      operation: 'send_file',
      absolutePath: filePath,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, 'PERMISSION_DENIED');
      assert.match(result.message, /授权与当前执行身份不一致/);
      assert.match(result.message, /actorUserId/);
      assert.match(result.message, /sessionKey/);
    }
  });

  test('rejects a grant when topic, agent, or body identity does not match', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = makeManagedFile(workspaceRoot);
    const result = resolveLocalFileAccess(context({
      workspaceRoot,
      executionScope: scope({
        topicId: 'p2p_8_43',
        topicType: 'group',
        agentId: 'usr99',
        agentBodyId: 'body-other',
      }),
      localDeviceGrant: deviceGrant({ bodyId: 'body-other' }),
      localFileGrants: [grant(filePath)],
    }), {
      operation: 'read_file',
      absolutePath: filePath,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.message, /topicId/);
      assert.match(result.message, /topicType/);
      assert.match(result.message, /agentId/);
      assert.match(result.message, /agentBodyId/);
      assert.match(result.message, /deviceBodyId/);
    }
  });

  test('rejects a grant when device installation identity does not match', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = makeManagedFile(workspaceRoot);
    const result = resolveLocalFileAccess(context({
      workspaceRoot,
      executionScope: scope(),
      localDeviceGrant: deviceGrant({ installationId: 'install-other' }),
      localFileGrants: [grant(filePath, { deviceInstallationId: 'install-main' })],
    }), {
      operation: 'read_file',
      absolutePath: filePath,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.message, /deviceInstallationId/);
      assert.doesNotMatch(result.message, new RegExp(escapeRegExp(workspaceRoot)));
    }
  });

  test('rejects local attachment access for untrusted scope even when a path grant is present', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = makeManagedFile(workspaceRoot);
    const result = resolveLocalFileAccess(context({
      workspaceRoot,
      executionScope: scope({
        identityTrust: 'untrusted',
        isTrusted: false,
      }),
      localDeviceGrant: deviceGrant(),
      localFileGrants: [grant(filePath)],
    }), {
      operation: 'read_file',
      absolutePath: filePath,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, 'PERMISSION_DENIED');
      assert.match(result.message, /未通过服务端一致性校验/);
    }
  });

  test('rejects grants whose own identity is not canonical CatsCo', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = makeManagedFile(workspaceRoot);
    const result = resolveLocalFileAccess(context({
      workspaceRoot,
      executionScope: scope(),
      localDeviceGrant: deviceGrant(),
      localFileGrants: [grant(filePath, { identityTrust: 'legacy_context' })],
    }), {
      operation: 'read_file',
      absolutePath: filePath,
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /不是服务端可信 CatsCo 身份/);
  });

  test('rejects changed attachment files after grant creation', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = makeManagedFile(workspaceRoot);
    const fileGrant = grant(filePath);
    fs.writeFileSync(filePath, 'changed');

    const result = resolveLocalFileAccess(context({
      workspaceRoot,
      executionScope: scope(),
      localDeviceGrant: deviceGrant(),
      localFileGrants: [fileGrant],
    }), {
      operation: 'read_file',
      absolutePath: filePath,
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /发生变化/);
  });

  test('rejects expired attachment grants', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = makeManagedFile(workspaceRoot);
    const result = resolveLocalFileAccess(context({
      workspaceRoot,
      executionScope: scope(),
      localDeviceGrant: deviceGrant(),
      localFileGrants: [grant(filePath, { expiresAt: Date.now() - 1 })],
    }), {
      operation: 'read_file',
      absolutePath: filePath,
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /已过期/);
  });

  test('allows normalized paths that still resolve to a matching grant', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = makeManagedFile(workspaceRoot);
    const normalizedVariant = path.join(workspaceRoot, 'tmp', 'downloads', '..', 'downloads', 'report.md');
    const result = resolveLocalFileAccess(context({
      workspaceRoot,
      executionScope: scope(),
      localDeviceGrant: deviceGrant(),
      localFileGrants: [grant(filePath)],
    }), {
      operation: 'read_file',
      absolutePath: normalizedVariant,
    });

    assert.equal(result.ok, true);
  });

  test('does not treat downloads-old as a managed attachment cache prefix', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = path.join(workspaceRoot, 'tmp', 'downloads-old', 'report.md');
    const result = resolveLocalFileAccess(context({
      workspaceRoot,
      executionScope: scope(),
      localDeviceGrant: deviceGrant(),
    }), {
      operation: 'read_file',
      absolutePath: filePath,
    });

    assert.deepEqual(result, { ok: true });
  });

  test('keeps non-CatsCo legacy file access unchanged', () => {
    const workspaceRoot = makeWorkspace();
    const filePath = makeManagedFile(workspaceRoot);
    const result = resolveLocalFileAccess(context({
      workspaceRoot,
      surface: 'cli',
    }), {
      operation: 'read_file',
      absolutePath: filePath,
    });

    assert.deepEqual(result, { ok: true });
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
