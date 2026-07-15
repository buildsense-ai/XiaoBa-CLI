import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireCatsCoConnectorLock } from '../src/catscompany/connector-lock';

describe('CatsCo connector startup lock', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-connector-lock-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('blocks a second live connector for the same body id', () => {
    const first = acquireCatsCoConnectorLock({
      runtimeRoot: tempDir,
      bodyId: 'body-a',
      command: 'first',
    });
    assert.equal(first.acquired, true);

    const second = acquireCatsCoConnectorLock({
      runtimeRoot: tempDir,
      bodyId: 'body-a',
      command: 'second',
    });
    assert.equal(second.acquired, false);

    const otherDevice = acquireCatsCoConnectorLock({
      runtimeRoot: tempDir,
      bodyId: 'body-b',
      command: 'other-device',
    });
    assert.equal(otherDevice.acquired, true);
    first.release();
    otherDevice.release();
  });

  test('replaces a live connector lock whose dashboard owner has exited', () => {
    const lockDir = path.join(tempDir, '.xiaoba');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, 'catsco-connector.lock.json'),
      JSON.stringify({
        bodyId: 'body-a',
        pid: process.pid,
        ownerPid: 2_147_483_647,
        startedAt: new Date().toISOString(),
        command: 'orphaned-dashboard-connector',
        token: 'orphaned-token',
      }),
      'utf8',
    );

    const acquired = acquireCatsCoConnectorLock({
      runtimeRoot: tempDir,
      bodyId: 'body-a',
      command: 'replacement',
      ownerPid: process.pid,
    });
    assert.equal(acquired.acquired, true);
    acquired.release();
  });

  test('overwrites a stale lock for the same body id', () => {
    const lockDir = path.join(tempDir, '.xiaoba');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, 'catsco-connector.lock.json'),
      JSON.stringify({
        bodyId: 'body-a',
        pid: -1,
        startedAt: new Date().toISOString(),
        command: 'stale-process',
        token: 'stale-token',
      }),
      'utf8',
    );

    const acquired = acquireCatsCoConnectorLock({
      runtimeRoot: tempDir,
      bodyId: 'body-a',
      command: 'replacement',
    });
    assert.equal(acquired.acquired, true);
    acquired.release();
  });
});
