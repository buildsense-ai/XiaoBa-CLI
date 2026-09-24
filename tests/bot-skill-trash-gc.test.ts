import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cleanupExpiredBotSkillTrash,
  startSkillTrashGarbageCollector,
  trashBotSkill,
} from '../src/bot-skills/deleted-skill-trash';
import { withBotSkillWorkspaceLock } from '../src/bot-skills/lock';

const testRoots: string[] = [];

describe('Bot Skill trash garbage collection', () => {
  afterEach(() => {
    for (const root of testRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('removes only verified expired backups across Bot scopes', () => {
    const runtimeRoot = makeRuntimeRoot();
    const expired = createSkill(runtimeRoot, 'expired');
    const active = createSkill(runtimeRoot, 'active');
    const expiredBackup = trashBotSkill({
      runtimeRoot,
      botId: 'bot-expired',
      sourcePath: expired,
      localSkillId: 'expired-local',
      name: 'expired',
      installName: 'expired',
      deletedByOwnerUid: 'owner-1',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const activeBackup = trashBotSkill({
      runtimeRoot,
      botId: 'bot-active',
      sourcePath: active,
      localSkillId: 'active-local',
      name: 'active',
      installName: 'active',
      deletedByOwnerUid: 'owner-1',
      now: () => new Date('2026-09-01T00:00:00.000Z'),
    });

    const result = cleanupExpiredBotSkillTrash({
      runtimeRoot,
      now: () => new Date('2026-02-01T00:00:00.000Z'),
    });

    assert.deepEqual(result, { scanned: 2, removed: 1, preserved: 1 });
    assert.equal(fs.existsSync(trashPath(runtimeRoot, 'bot-expired', expiredBackup.backupId)), false);
    assert.equal(fs.existsSync(trashPath(runtimeRoot, 'bot-active', activeBackup.backupId)), true);
  });

  test('preserves incomplete and tampered evidence instead of deleting it', () => {
    const runtimeRoot = makeRuntimeRoot();
    const skill = createSkill(runtimeRoot, 'tampered');
    const backup = trashBotSkill({
      runtimeRoot,
      botId: 'bot-evidence',
      sourcePath: skill,
      localSkillId: 'tampered-local',
      name: 'tampered',
      installName: 'tampered',
      deletedByOwnerUid: 'owner-1',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    fs.appendFileSync(
      path.join(trashPath(runtimeRoot, 'bot-evidence', backup.backupId), 'package', 'SKILL.md'),
      '\nchanged after deletion\n',
    );
    const incomplete = path.join(runtimeRoot, 'data', 'bot-skills', 'trash', 'bot-evidence', 'incomplete');
    fs.mkdirSync(incomplete, { recursive: true });

    const result = cleanupExpiredBotSkillTrash({
      runtimeRoot,
      now: () => new Date('2026-02-01T00:00:00.000Z'),
    });

    assert.deepEqual(result, { scanned: 2, removed: 0, preserved: 2 });
    assert.equal(fs.existsSync(trashPath(runtimeRoot, 'bot-evidence', backup.backupId)), true);
    assert.equal(fs.existsSync(incomplete), true);
  });

  test('serializes a background run with the Bot Skill workspace lock', async () => {
    const runtimeRoot = makeRuntimeRoot();
    const backupPath = createExpiredBackup(runtimeRoot);
    const collector = startSkillTrashGarbageCollector({
      runtimeRoot,
      now: () => new Date('2026-02-01T00:00:00.000Z'),
    });
    try {
      let pending!: ReturnType<typeof collector.runNow>;
      await withBotSkillWorkspaceLock(runtimeRoot, async () => {
        pending = collector.runNow();
        assert.equal(collector.runNow(), pending);
        assert.equal(fs.existsSync(backupPath), true);
      });
      assert.deepEqual(await pending, { scanned: 1, removed: 1, preserved: 0 });
      assert.equal(fs.existsSync(backupPath), false);
    } finally {
      collector.stop();
    }
  });

  test('stop cancels pending cleanup after lock acquisition and subsequent manual runs', async () => {
    const runtimeRoot = makeRuntimeRoot();
    const backupPath = createExpiredBackup(runtimeRoot);
    const collector = startSkillTrashGarbageCollector({ runtimeRoot, now: () => new Date('2026-02-01') });
    let pending!: ReturnType<typeof collector.runNow>;
    await withBotSkillWorkspaceLock(runtimeRoot, async () => {
      pending = collector.runNow();
      collector.stop();
    });
    await pending;
    await collector.runNow();
    assert.equal(fs.existsSync(backupPath), true);
  });

  for (const fault of ['extra-file', 'wrong-bot', 'short-retention', 'invalid-files']) {
    test(`preserves expired backups with ${fault}`, () => {
      const runtimeRoot = makeRuntimeRoot();
      const backupPath = createExpiredBackup(runtimeRoot);
      const manifestPath = path.join(backupPath, 'deletion.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (fault === 'extra-file') fs.writeFileSync(path.join(backupPath, 'recovery-note.txt'), 'keep');
      if (fault === 'wrong-bot') manifest.botId = 'another-bot';
      if (fault === 'short-retention') manifest.expiresAt = manifest.deletedAt;
      if (fault === 'invalid-files') manifest.files = [null];
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const result = cleanupExpiredBotSkillTrash({ runtimeRoot, now: () => new Date('2026-02-01') });
      assert.equal(result.removed, 0);
      assert.equal(fs.existsSync(backupPath), true);
    });
  }

  test('rejects a linked bot-skills ancestor without touching its target', () => {
    const runtimeRoot = makeRuntimeRoot();
    const externalRoot = makeRuntimeRoot();
    const backupPath = createExpiredBackup(externalRoot);
    fs.mkdirSync(path.join(runtimeRoot, 'data'));
    fs.symlinkSync(path.join(externalRoot, 'data', 'bot-skills'), path.join(runtimeRoot, 'data', 'bot-skills'), 'junction');
    assert.throws(() => cleanupExpiredBotSkillTrash({ runtimeRoot }), /not a safe directory/);
    assert.equal(fs.existsSync(backupPath), true);
  });

  test('supports shared release data while preserving active Skills and pending evidence', () => {
    const runtimeRoot = makeRuntimeRoot();
    const sharedRoot = makeRuntimeRoot();
    const backupPath = createExpiredBackup(sharedRoot);
    fs.symlinkSync(path.join(sharedRoot, 'data'), path.join(runtimeRoot, 'data'), 'junction');
    const active = createSkill(runtimeRoot, 'active');
    const evidence = path.join(sharedRoot, 'data', 'bot-skills', 'local-pending');
    fs.mkdirSync(evidence);
    fs.writeFileSync(path.join(evidence, 'recovery.txt'), 'keep');
    assert.equal(cleanupExpiredBotSkillTrash({ runtimeRoot, now: () => new Date('2026-02-01') }).removed, 1);
    assert.equal(fs.existsSync(backupPath), false);
    assert.equal(fs.existsSync(path.join(active, 'SKILL.md')), true);
    assert.equal(fs.readFileSync(path.join(evidence, 'recovery.txt'), 'utf8'), 'keep');
  });
});

function createExpiredBackup(runtimeRoot: string): string {
  const result = trashBotSkill({
    runtimeRoot,
    botId: 'bot-expired',
    sourcePath: createSkill(runtimeRoot, 'expired'),
    localSkillId: 'expired-local',
    name: 'expired',
    installName: 'expired',
    deletedByOwnerUid: 'owner-1',
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  return trashPath(runtimeRoot, 'bot-expired', result.backupId);
}

function makeRuntimeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-trash-gc-'));
  testRoots.push(root);
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  return root;
}

function createSkill(runtimeRoot: string, name: string): string {
  const skillPath = path.join(runtimeRoot, 'skills', name);
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`, 'utf8');
  return skillPath;
}

function trashPath(runtimeRoot: string, botId: string, backupId: string): string {
  return path.join(runtimeRoot, 'data', 'bot-skills', 'trash', botId, backupId);
}
