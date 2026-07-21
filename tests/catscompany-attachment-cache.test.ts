import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildCatsCoAttachmentCachePath,
  cleanupCatsCoAttachmentCache,
  getCatsCoAttachmentCacheRoot,
  getCatsCoAttachmentCacheSessionRoot,
} from '../src/catscompany/attachment-cache';

async function withRuntimeRoot<T>(run: (root: string) => T | Promise<T>): Promise<T> {
  const previous = process.env.XIAOBA_USER_DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-attachment-cache-'));
  process.env.XIAOBA_USER_DATA_DIR = root;
  try {
    return await run(root);
  } finally {
    if (previous === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeFile(filePath: string, content: string, timeMs: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  const time = new Date(timeMs);
  fs.utimesSync(filePath, time, time);
}

describe('CatsCo attachment cache', () => {
  test('builds stable cache paths under the runtime data root', () => {
    return withRuntimeRoot((root) => {
      const filePath = buildCatsCoAttachmentCachePath('cc_group:grp/123', '../image.png', new Date(2026, 6, 3, 1, 2, 3, 4));
      const sessionRoot = getCatsCoAttachmentCacheSessionRoot('cc_group:grp/123');

      assert.equal(path.dirname(filePath), sessionRoot);
      assert.equal(path.dirname(path.dirname(filePath)), getCatsCoAttachmentCacheRoot());
      assert.ok(filePath.startsWith(path.join(root, 'data', 'attachments', 'catscompany')));
      assert.match(path.basename(filePath), /^20260703_010203_004_[a-f0-9-]{8}_image\.png$/);
      assert.equal(fs.existsSync(path.dirname(filePath)), false);
    });
  });

  test('removes old files and trims cache below the low-water mark', async () => {
    await withRuntimeRoot(async () => {
      const root = getCatsCoAttachmentCacheRoot();
      const oldFile = path.join(root, 'session', 'old.txt');
      const a = path.join(root, 'session', 'a.txt');
      const b = path.join(root, 'session', 'b.txt');
      const c = path.join(root, 'session', 'c.txt');

      writeFile(oldFile, 'old', 1_000);
      writeFile(a, 'aaa', 10_000);
      writeFile(b, 'bbb', 20_000);
      writeFile(c, 'ccc', 30_000);

      const summary = await cleanupCatsCoAttachmentCache(root, {
        now: 50_000,
        maxAgeMs: 40_000,
        highWaterBytes: 8,
        lowWaterBytes: 4,
      });

      assert.equal(fs.existsSync(oldFile), false);
      assert.equal(fs.existsSync(a), false);
      assert.equal(fs.existsSync(b), false);
      assert.equal(fs.existsSync(c), true);
      assert.equal(summary.removed, 3);
      assert.equal(summary.bytesAfter, 3);
    });
  });
});
