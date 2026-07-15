import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearCatsCoImageCatalog,
  getCatsCoImageCatalogPath,
  importCatsCoAgentImage,
  listRecentCatsCoImages,
  registerCatsCoImage,
} from '../src/catscompany/image-catalog';
import type { ExecutionScope } from '../src/types/session-identity';

function scope(overrides: Partial<ExecutionScope> = {}): ExecutionScope {
  return {
    source: 'catscompany',
    sessionKey: 'session:v2:catscompany:group:grp_1:actor:usr7:agent:usr43',
    topicId: 'grp_1',
    topicType: 'group',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-main',
    identityTrust: 'server_canonical',
    isTrusted: true,
    ...overrides,
  };
}

async function withRuntimeRoot<T>(run: (root: string) => T | Promise<T>): Promise<T> {
  const previous = process.env.XIAOBA_USER_DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-image-catalog-'));
  process.env.XIAOBA_USER_DATA_DIR = root;
  try {
    return await run(root);
  } finally {
    if (previous === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function managedImage(root: string, name: string, content = name): string {
  const filePath = path.join(root, 'data', 'attachments', 'catscompany', 'session', name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('CatsCo image catalog', () => {
  test('persists stable image ids and isolates entries by current speaker', async () => {
    await withRuntimeRoot((root) => {
      const aliceScope = scope();
      const bobScope = scope({ actorUserId: 'usr8' });
      const alicePath = managedImage(root, 'alice.png');
      const bobPath = managedImage(root, 'bob.jpg');

      const alice = registerCatsCoImage({
        scope: aliceScope,
        fileName: 'alice.png',
        filePath: alicePath,
        source: 'user_upload',
        receivedAt: Date.now() - 100,
        messageSeq: 10,
      });
      const bob = registerCatsCoImage({
        scope: bobScope,
        fileName: 'bob.jpg',
        filePath: bobPath,
        source: 'user_upload',
        receivedAt: Date.now(),
        messageSeq: 11,
      });

      assert.equal(alice?.id, 'img_0001');
      assert.equal(bob?.id, 'img_0002');
      assert.equal(fs.existsSync(getCatsCoImageCatalogPath(aliceScope.sessionKey)), true);
      assert.deepEqual(listRecentCatsCoImages(aliceScope).map(entry => entry.id), ['img_0001']);
      assert.deepEqual(listRecentCatsCoImages(bobScope).map(entry => entry.id), ['img_0002']);
      assert.equal(listRecentCatsCoImages(aliceScope)[0].messageSeq, 10);
    });
  });

  test('copies agent outputs into managed storage and restores them from disk', async () => {
    await withRuntimeRoot((root) => {
      const currentScope = scope({ topicType: 'p2p', topicId: 'p2p_7_43' });
      const sourcePath = path.join(root, 'workspace', 'generated.png');
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, 'generated-image');

      const entry = importCatsCoAgentImage({
        scope: currentScope,
        fileName: 'result.png',
        filePath: sourcePath,
        receivedAt: Date.now(),
      });

      assert.ok(entry);
      assert.equal(entry.source, 'agent_output');
      assert.notEqual(entry.filePath, fs.realpathSync(sourcePath));
      assert.ok(entry.filePath.startsWith(path.join(root, 'data', 'attachments', 'catscompany')));
      assert.equal(fs.readFileSync(entry.filePath, 'utf8'), 'generated-image');
      assert.equal(listRecentCatsCoImages(currentScope)[0].id, entry.id);
      assert.equal(listRecentCatsCoImages(currentScope)[0].originPath, fs.realpathSync(sourcePath));
    });
  });

  test('drops missing files and clears catalog metadata on conversation clear', async () => {
    await withRuntimeRoot((root) => {
      const currentScope = scope();
      const firstPath = managedImage(root, 'first.webp');
      const secondPath = managedImage(root, 'second.png');
      registerCatsCoImage({
        scope: currentScope,
        fileName: 'first.webp',
        filePath: firstPath,
        source: 'user_upload',
      });
      registerCatsCoImage({
        scope: currentScope,
        fileName: 'second.png',
        filePath: secondPath,
        source: 'user_upload',
      });

      fs.rmSync(secondPath);
      assert.deepEqual(listRecentCatsCoImages(currentScope).map(entry => entry.id), ['img_0001']);

      clearCatsCoImageCatalog(currentScope.sessionKey);
      assert.deepEqual(listRecentCatsCoImages(currentScope), []);
      assert.equal(fs.existsSync(getCatsCoImageCatalogPath(currentScope.sessionKey)), false);
    });
  });

  test('rejects untrusted scopes and image paths outside managed storage', async () => {
    await withRuntimeRoot((root) => {
      const outside = path.join(root, 'workspace', 'outside.png');
      fs.mkdirSync(path.dirname(outside), { recursive: true });
      fs.writeFileSync(outside, 'image');

      assert.equal(registerCatsCoImage({
        scope: scope({ identityTrust: 'untrusted', isTrusted: false }),
        fileName: 'outside.png',
        filePath: outside,
        source: 'user_upload',
      }), undefined);
      assert.equal(registerCatsCoImage({
        scope: scope(),
        fileName: 'outside.png',
        filePath: outside,
        source: 'user_upload',
      }), undefined);
    });
  });
});
