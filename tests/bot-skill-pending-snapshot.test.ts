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

test('pending evidence records nested links without reading targets or creating package links', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-links-'));
  try {
    const source = path.join(root, 'skills');
    const external = path.join(root, 'external');
    fs.mkdirSync(source);
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, 'private.txt'), 'must not be read or copied');
    fs.writeFileSync(path.join(source, 'README.md'), 'keep local content');
    fs.symlinkSync(external, path.join(source, '.venv'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(source, path.join(source, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
    const originalReaddir = fs.promises.readdir;
    t.mock.method(fs.promises, 'readdir', async (...args: any[]) => {
      const requested = path.resolve(String(args[0]));
      assert.notEqual(requested, external, 'must not traverse the external target');
      assert.notEqual(requested, path.join(source, '.venv'), 'must not traverse an ephemeral-named link');
      assert.notEqual(requested, path.join(source, 'loop'), 'must not traverse a loop');
      return (originalReaddir as any)(...args);
    });
    const options = { runtimeRoot: root, sourcePath: source, botId: 'bot-a',
      reason: 'activation_cloud_reconcile' as const, cloudRevision: 1 };
    const snapshot = await snapshotPendingBotSkillWorkspace(options);
    const manifest = JSON.parse(fs.readFileSync(path.join(snapshot.path, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schema, 'xiaoba.bot-skill-local-pending.v2');
    assert.deepEqual(manifest.links, ['.venv', 'loop'].map(name => ({
      path: name, target: fs.readlinkSync(path.join(source, name)),
    })));
    assert.equal(snapshot.linkCount, 2);
    assert.equal(snapshot.fileCount, 1);
    assert.deepEqual(fs.readdirSync(path.join(snapshot.path, 'package')), ['README.md']);
    assert.equal(fs.readFileSync(path.join(external, 'private.txt'), 'utf8'), 'must not be read or copied');
    assert.equal((await snapshotPendingBotSkillWorkspace(options)).deduplicated, true);

    // A changed manifest must never suppress the creation of valid evidence.
    manifest.links[0].target = 'corrupted';
    fs.writeFileSync(path.join(snapshot.path, 'manifest.json'), JSON.stringify(manifest));
    const replacement = await snapshotPendingBotSkillWorkspace({ ...options,
      now: () => new Date('2026-11-17T00:00:01Z') });
    assert.equal(replacement.deduplicated, false);
    assert.notEqual(replacement.path, snapshot.path);

    // Nor may a runnable link inserted into package/ qualify as valid evidence.
    fs.symlinkSync(external, path.join(replacement.path, 'package', 'injected'),
      process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await snapshotPendingBotSkillWorkspace({ ...options,
      now: () => new Date('2026-11-17T00:00:02Z') })).deduplicated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pending evidence fingerprints link changes and supports dangling and npm file links', {
  skip: process.platform === 'win32' ? 'Windows directory junctions are covered by the nested-link test.' : false,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-file-links-'));
  try {
    const source = path.join(root, 'skills');
    const bin = path.join(source, 'stageshow', 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(source, 'private.txt'), 'do not dereference');
    fs.symlinkSync('../../../private.txt', path.join(bin, 'portless'));
    fs.symlinkSync('missing', path.join(source, 'dangling'));
    const options = { runtimeRoot: root, sourcePath: source, botId: 'bot-a',
      reason: 'activation_cloud_reconcile' as const, cloudRevision: 1 };
    const first = await snapshotPendingBotSkillWorkspace(options);
    assert.equal(first.linkCount, 2);
    const manifest = JSON.parse(fs.readFileSync(path.join(first.path, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.links, [
      { path: 'dangling', target: 'missing' },
      { path: 'stageshow/node_modules/.bin/portless', target: '../../../private.txt' },
    ]);
    assert.equal(fs.existsSync(path.join(first.path, 'package', 'stageshow')), false);
    fs.unlinkSync(path.join(source, 'dangling'));
    fs.symlinkSync('another-missing', path.join(source, 'dangling'));
    const second = await snapshotPendingBotSkillWorkspace(options);
    assert.notEqual(first.fingerprint, second.fingerprint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pending evidence refuses link target changes while copying and keeps the source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-link-race-'));
  const original = fs.promises.copyFile;
  try {
    const source = path.join(root, 'skills');
    const targetA = path.join(root, 'a');
    const targetB = path.join(root, 'b');
    fs.mkdirSync(source);
    fs.mkdirSync(targetA);
    fs.mkdirSync(targetB);
    fs.writeFileSync(path.join(source, 'README.md'), 'keep');
    const link = path.join(source, 'animate');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(targetA, link, linkType);
    fs.promises.copyFile = async (...args) => {
      await original(...args);
      fs.unlinkSync(link);
      fs.symlinkSync(targetB, link, linkType);
    };
    await assert.rejects(snapshotPendingBotSkillWorkspace({ runtimeRoot: root,
      sourcePath: source, botId: 'bot-a', reason: 'activation_cloud_reconcile', cloudRevision: 1 }),
    /workspace changed during pending snapshot/);
    assert.equal(fs.realpathSync(link), fs.realpathSync(targetB));
    assert.deepEqual(fs.readdirSync(path.join(root, 'data', 'bot-skills', 'local-pending', 'bot-a')), []);
  } finally {
    fs.promises.copyFile = original;
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
