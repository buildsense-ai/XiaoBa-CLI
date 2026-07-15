/**
 * Issue #94 — Active-handle assertions for test lifecycle cleanup.
 *
 * Asserts that no live timer, child-process, lock, or unresolved promise
 * handles remain after a test or shutdown path. This is the release-gate
 * requirement that bounded concurrency does not reintroduce exit hangs.
 *
 * These utilities are deterministic and work before and after #90–#93
 * integrate because they test Node.js handle hygiene, not reader wiring.
 */
import { afterEach, before, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  assertNoActiveHandles,
  establishAmbientBaseline,
  snapshotActiveHandles,
} from '../src/utils/active-handle-assertions';

before(() => {
  establishAmbientBaseline();
});

async function settleHandles(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  await new Promise<void>(resolve => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// snapshotActiveHandles
// ---------------------------------------------------------------------------

describe('active-handle assertions — snapshot', () => {
  test('returns a snapshot with stable fields when idle', () => {
    const snapshot = snapshotActiveHandles();
    assert.equal(typeof snapshot.total, 'number');
    assert.equal(typeof snapshot.childProcesses, 'number');
    assert.equal(typeof snapshot.extra, 'number');
    assert.ok(snapshot.total >= 0);
    assert.ok(snapshot.childProcesses >= 0);
    assert.ok(snapshot.extra >= 0);
  });

  test('detects an extra handle relative to baseline', async () => {
    const before = snapshotActiveHandles();
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const during = snapshotActiveHandles();
    assert.ok(during.extra >= before.extra + 1, 'should detect the new server handle');
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await settleHandles();
    const after = snapshotActiveHandles();
    assert.equal(after.extra, before.extra, 'server handle should be cleaned up');
  });

  test('detects an active child process', async () => {
    const before = snapshotActiveHandles();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: 'ignore',
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const during = snapshotActiveHandles();
    assert.ok(during.childProcesses >= before.childProcesses + 1, 'should detect the child process handle');
    child.kill('SIGTERM');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    await settleHandles();
    const after = snapshotActiveHandles();
    assert.equal(after.childProcessExtra, 0, 'child process handle should be cleaned up');
  });
});

// ---------------------------------------------------------------------------
// assertNoActiveHandles
// ---------------------------------------------------------------------------

describe('active-handle assertions — assertNoActiveHandles', () => {
  test('passes when no extra handles are active', () => {
    assertNoActiveHandles();
  });

  test('passes after a server is opened and closed', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await settleHandles();
    assertNoActiveHandles();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle assertion — no leftover handles after test work
// ---------------------------------------------------------------------------

describe('active-handle assertions — lifecycle', () => {
  let server: net.Server | undefined;
  let child: ChildProcess | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
      server = undefined;
    }
    if (child) {
      child.kill('SIGTERM');
      await new Promise<void>(resolve => child!.once('exit', () => resolve()));
      child = undefined;
    }
  });

  test('opening and closing resources leaves no active handles', async () => {
    server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });

    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: 'ignore',
    });
    await new Promise<void>(resolve => setImmediate(resolve));

    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
    child.kill('SIGTERM');
    await new Promise<void>(resolve => child!.once('exit', () => resolve()));
    child = undefined;
    await settleHandles();

    assertNoActiveHandles();
  });
});