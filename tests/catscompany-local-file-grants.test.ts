import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createCatsCoAttachmentGrant,
  createCatsCoLocalDeviceGrant,
} from '../src/catscompany/local-file-grants';
import type { ExecutionScope } from '../src/types/session-identity';

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

function workspaceWithAttachment(name = 'report.md'): { root: string; filePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-local-grant-'));
  const filePath = path.join(root, 'tmp', 'downloads', name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'hello');
  return { root, filePath };
}

describe('CatsCo local file grant creation', () => {
  test('creates a scoped file grant from canonical CatsCo scope and local device grant', () => {
    const { root, filePath } = workspaceWithAttachment();
    const device = createCatsCoLocalDeviceGrant({
      bodyId: 'body-main',
      installationId: 'install-main',
    });

    const result = createCatsCoAttachmentGrant(scope(), device, {
      localPath: path.join(root, 'tmp', 'downloads', '..', 'downloads', 'report.md'),
      fileName: 'report.md',
      type: 'file',
      workspaceRoot: root,
      attachmentId: 'img_0007',
      receivedAt: 1_234,
      attachmentSource: 'user_upload',
    });

    assert.ok(result);
    assert.equal(result.attachmentRef, 'catsco_attachment:img_0007');
    assert.equal(result.attachmentId, 'img_0007');
    assert.equal(result.attachmentReceivedAt, 1_234);
    assert.equal(result.attachmentSource, 'user_upload');
    assert.equal(result.filePath, fs.realpathSync(filePath));
    assert.equal(result.fileName, 'report.md');
    assert.equal(result.fileType, 'file');
    assert.equal(result.sessionKey, 'cc_user:usr7');
    assert.equal(result.topicId, 'p2p_7_43');
    assert.equal(result.topicType, 'p2p');
    assert.equal(result.actorUserId, 'usr7');
    assert.equal(result.agentId, 'usr43');
    assert.equal(result.agentBodyId, 'body-main');
    assert.equal(result.deviceBodyId, 'body-main');
    assert.equal(result.deviceInstallationId, 'install-main');
    assert.equal(result.identityTrust, 'server_canonical');
    assert.deepEqual(result.operations, ['read_file', 'send_file']);
    assert.ok(result.expiresAt > result.createdAt);
  });

  test('creates a scoped file grant for stable CatsCo attachment cache files', () => {
    const previous = process.env.XIAOBA_USER_DATA_DIR;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-local-cache-grant-'));
    process.env.XIAOBA_USER_DATA_DIR = root;
    try {
      const filePath = path.join(root, 'data', 'attachments', 'catscompany', 'cc_user_usr7', 'report.md');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'hello');
      const device = createCatsCoLocalDeviceGrant({
        bodyId: 'body-main',
        installationId: 'install-main',
      });

      const result = createCatsCoAttachmentGrant(scope(), device, {
        localPath: filePath,
        fileName: 'report.md',
        type: 'file',
        workspaceRoot: path.join(root, 'workspace-that-does-not-contain-cache'),
      });

      assert.ok(result);
      assert.equal(result.filePath, fs.realpathSync(filePath));
      assert.equal(result.fileName, 'report.md');
      assert.deepEqual(result.operations, ['read_file', 'send_file']);
    } finally {
      if (previous === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
      else process.env.XIAOBA_USER_DATA_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not create grants for missing, legacy, untrusted, non-CatsCo, or bodyless scopes', () => {
    const { root, filePath } = workspaceWithAttachment('blocked.md');
    const device = createCatsCoLocalDeviceGrant({ bodyId: 'body-main' });
    const input = {
      localPath: filePath,
      fileName: 'blocked.md',
      type: 'file' as const,
      workspaceRoot: root,
    };

    assert.equal(createCatsCoAttachmentGrant(undefined, device, input), undefined);
    assert.equal(createCatsCoAttachmentGrant(scope({
      identityTrust: 'legacy_context',
      isTrusted: false,
    }), device, input), undefined);
    assert.equal(createCatsCoAttachmentGrant(scope({
      identityTrust: 'untrusted',
      isTrusted: false,
    }), device, input), undefined);
    assert.equal(createCatsCoAttachmentGrant(scope({
      source: 'feishu',
    }), device, input), undefined);
    assert.equal(createCatsCoAttachmentGrant(scope({
      agentBodyId: undefined,
    }), device, input), undefined);
  });

  test('does not create grants when the local device body or managed downloads path does not match', () => {
    const { root, filePath } = workspaceWithAttachment('mismatch.md');

    assert.equal(createCatsCoAttachmentGrant(scope(), createCatsCoLocalDeviceGrant({
      bodyId: 'body-other',
    }), {
      localPath: filePath,
      fileName: 'mismatch.md',
      type: 'file',
      workspaceRoot: root,
    }), undefined);

    const outsidePath = path.join(root, 'tmp', 'other', 'mismatch.md');
    fs.mkdirSync(path.dirname(outsidePath), { recursive: true });
    fs.writeFileSync(outsidePath, 'hello');
    assert.equal(createCatsCoAttachmentGrant(scope(), createCatsCoLocalDeviceGrant({
      bodyId: 'body-main',
    }), {
      localPath: outsidePath,
      fileName: 'mismatch.md',
      type: 'file',
      workspaceRoot: root,
    }), undefined);
  });
});
