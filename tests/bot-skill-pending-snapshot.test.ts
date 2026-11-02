import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { snapshotPendingBotSkillWorkspace } from '../src/bot-skills/pending-snapshot';

test('pending evidence skips unrelated packages and yields while hashing matching content', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-responsive-'));
  const source = path.join(root, 'skills');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'large.bin'), Buffer.alloc(32 * 1024 * 1024, 7));
  const options = { runtimeRoot: root, sourcePath: source, botId: 'bot-a',
    reason: 'activation_cloud_reconcile' as const, cloudRevision: 1 };
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  const original = fs.promises.readdir;
  try {
    const first = await snapshotPendingBotSkillWorkspace(options);
    assert.ok(ticks > 0, 'snapshot creation must allow heartbeat timers to run');
    const unrelated = path.join(path.dirname(first.path), '000-unrelated');
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, 'manifest.json'), JSON.stringify({
      schema: 'xiaoba.bot-skill-local-pending.v1', fingerprint: 'different', files: [],
    }));
    let unrelatedReads = 0;
    (fs.promises as any).readdir = async (target: any, ...args: any[]) => {
      if (String(target) === path.join(unrelated, 'package')) unrelatedReads += 1;
      return (original as any)(target, ...args);
    };
    ticks = 0;
    const second = await snapshotPendingBotSkillWorkspace(options);
    assert.equal(second.deduplicated, true);
    assert.equal(second.path, first.path);
    assert.equal(unrelatedReads, 0, 'unrelated packages must not be scanned');
    assert.ok(ticks > 0, 'candidate content verification must allow timers to run');

    fs.writeFileSync(path.join(first.path, 'package', 'large.bin'), 'corrupt');
    const replacement = await snapshotPendingBotSkillWorkspace({ ...options,
      now: () => new Date('2026-11-02T00:00:01Z') });
    assert.equal(replacement.deduplicated, false);
  } finally {
    clearInterval(timer);
    fs.promises.readdir = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pending evidence cleans temporary output on copy failure and preserves the source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-failure-'));
  const source = path.join(root, 'skills');
  const original = fs.promises.copyFile;
  try {
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'README.md'), 'keep me');
    fs.promises.copyFile = async () => { throw new Error('injected copy failure'); };
    await assert.rejects(snapshotPendingBotSkillWorkspace({ runtimeRoot: root,
      sourcePath: source, botId: 'bot-a', reason: 'activation_cloud_reconcile', cloudRevision: 1 }), /injected copy failure/);
    assert.equal(fs.readFileSync(path.join(source, 'README.md'), 'utf8'), 'keep me');
    assert.deepEqual(fs.readdirSync(path.join(root, 'data', 'bot-skills', 'local-pending', 'bot-a')), []);
  } finally {
    fs.promises.copyFile = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pending evidence refuses nested links and leaves no published partial snapshot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-links-'));
  try {
    const source = path.join(root, 'skills');
    const external = path.join(root, 'external');
    fs.mkdirSync(source);
    fs.mkdirSync(external);
    fs.symlinkSync(external, path.join(source, '.venv'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(snapshotPendingBotSkillWorkspace({ runtimeRoot: root,
      sourcePath: source, botId: 'bot-a', reason: 'activation_cloud_reconcile', cloudRevision: 1 }), /symbolic link/);
    assert.equal(fs.existsSync(path.join(root, 'data')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pending evidence refuses source edits made while async copy yields', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-concurrent-edit-'));
  const source = path.join(root, 'skills');
  const original = fs.promises.copyFile;
  try {
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'README.md'), 'original');
    fs.promises.copyFile = async (...args) => {
      await original(...args);
      fs.writeFileSync(path.join(source, 'late.md'), 'must not disappear');
    };
    await assert.rejects(snapshotPendingBotSkillWorkspace({ runtimeRoot: root,
      sourcePath: source, botId: 'bot-a', reason: 'activation_cloud_reconcile', cloudRevision: 1 }), /workspace changed during pending snapshot/);
    assert.equal(fs.readFileSync(path.join(source, 'late.md'), 'utf8'), 'must not disappear');
    assert.deepEqual(fs.readdirSync(path.join(root, 'data', 'bot-skills', 'local-pending', 'bot-a')), []);
  } finally {
    fs.promises.copyFile = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
