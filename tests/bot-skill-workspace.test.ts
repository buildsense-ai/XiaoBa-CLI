import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BotSkillWorkspaceService } from '../src/bot-skills/workspace';
import { renameBotSkillWorkspaceSync } from '../src/bot-skills/workspace-fs';
import { withBotSkillWorkspaceLock } from '../src/bot-skills/lock';
import { BotSkillSyncService } from '../src/bot-skills/sync-service';

describe('per-Bot Skill workspace switching', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('adopts the legacy workspace once and isolates it across Bot switches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-workspaces-'));
    roots.push(root);
    const active = path.join(root, 'skills');
    fs.mkdirSync(active, { recursive: true });
    fs.writeFileSync(path.join(active, 'a.txt'), 'bot a');
    const service = new BotSkillWorkspaceService(root, active);

    const adopted = service.activate('bot-a');
    assert.equal(adopted.adoptedLegacyWorkspace, true);
    const switched = service.activate('bot-b');
    assert.equal(switched.previousBotId, 'bot-a');
    assert.equal(fs.existsSync(active), false);
    fs.mkdirSync(active, { recursive: true });
    fs.writeFileSync(path.join(active, 'b.txt'), 'bot b');

    service.rollback(switched);
    assert.equal(service.getActiveBotId(), 'bot-a');
    assert.equal(fs.readFileSync(path.join(active, 'a.txt'), 'utf8'), 'bot a');
    service.activate('bot-b');
    service.activate('bot-a');
    assert.equal(fs.readFileSync(path.join(active, 'a.txt'), 'utf8'), 'bot a');
    service.activate('bot-b');
    assert.equal(fs.readFileSync(path.join(active, 'b.txt'), 'utf8'), 'bot b');
  });

  test('retries a transient Windows-style workspace rename with bounded backoff', () => {
    const waits: number[] = [];
    let attempts = 0;
    renameBotSkillWorkspaceSync('source', 'target', {
      maxRetries: 3,
      retryDelayMs: 25,
      renameSync: (() => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
      }) as typeof fs.renameSync,
      waitSync: milliseconds => waits.push(milliseconds),
    });

    assert.equal(attempts, 3);
    assert.deepEqual(waits, [25, 50]);
  });

  test('stops after bounded retries and preserves the original rename error', () => {
    const original = Object.assign(new Error('still locked'), { code: 'EBUSY' });
    let attempts = 0;
    assert.throws(() => renameBotSkillWorkspaceSync('source', 'target', {
      maxRetries: 2,
      retryDelayMs: 0,
      renameSync: (() => {
        attempts += 1;
        throw original;
      }) as typeof fs.renameSync,
      waitSync: () => {},
    }), error => error === original);
    assert.equal(attempts, 3);
  });

  test('does not retry a non-transient workspace rename failure', () => {
    const original = Object.assign(new Error('source missing'), { code: 'ENOENT' });
    let attempts = 0;
    assert.throws(() => renameBotSkillWorkspaceSync('source', 'target', {
      renameSync: (() => {
        attempts += 1;
        throw original;
      }) as typeof fs.renameSync,
      waitSync: () => assert.fail('non-transient failures must not wait'),
    }), error => error === original);
    assert.equal(attempts, 1);
  });

  test('recovers a crash before the previous workspace was parked without misattributing it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-workspace-journal-'));
    roots.push(root);
    const active = path.join(root, 'skills');
    const statePath = path.join(root, 'data', 'bot-skills', 'active.json');
    fs.mkdirSync(active, { recursive: true });
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(path.join(active, 'owner.txt'), 'bot a');
    fs.writeFileSync(statePath, JSON.stringify({
      schema: 'xiaoba.bot-skill-workspace.v1',
      activeBotId: 'bot-a',
      switchingTo: 'bot-b',
      switchPhase: 'prepared',
    }));

    const service = new BotSkillWorkspaceService(root, active);
    service.recoverInterruptedSwitch();
    assert.equal(service.getActiveBotId(), 'bot-a');
    assert.equal(fs.readFileSync(path.join(active, 'owner.txt'), 'utf8'), 'bot a');
  });

  test('stops instead of guessing when the workspace ownership state is unreadable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-workspace-corrupt-'));
    roots.push(root);
    const statePath = path.join(root, 'data', 'bot-skills', 'active.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{broken');
    const service = new BotSkillWorkspaceService(root);
    assert.throws(() => service.activate('bot-a'), /cannot be read safely/i);
  });

  test('serializes workspace operations through one runtime-root lock', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-workspace-lock-'));
    roots.push(root);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let secondEntered = false;
    const first = withBotSkillWorkspaceLock(root, async () => {
      await firstGate;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = withBotSkillWorkspaceLock(root, () => {
      secondEntered = true;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(secondEntered, false);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(secondEntered, true);
  });

  test('rolls back an interrupted cloud restore journal before the next switch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-restore-journal-'));
    roots.push(root);
    const active = path.join(root, 'skills');
    const backup = path.join(root, '.bot-skills-backup-test');
    const stage = path.join(root, '.bot-skills-stage-test');
    const journal = path.join(root, 'data', 'bot-skills', 'restore-journal', 'bot-a.json');
    fs.mkdirSync(backup, { recursive: true });
    fs.mkdirSync(stage, { recursive: true });
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(path.join(backup, 'original.txt'), 'original');
    fs.writeFileSync(path.join(stage, 'partial.txt'), 'partial');
    fs.writeFileSync(journal, JSON.stringify({
      schema: 'xiaoba.bot-skill-restore-journal.v1',
      botId: 'bot-a',
      skillsRoot: active,
      stage,
      backup,
      phase: 'backed_up',
    }));

    BotSkillSyncService.recoverInterruptedRestore(root, 'bot-a', active);
    assert.equal(fs.readFileSync(path.join(active, 'original.txt'), 'utf8'), 'original');
    assert.equal(fs.existsSync(stage), false);
    assert.equal(fs.existsSync(journal), false);
  });

  test('recovers a crash after the active workspace was renamed but before the journal advanced', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-restore-rename-window-'));
    roots.push(root);
    const active = path.join(root, 'skills');
    const backup = path.join(root, '.bot-skills-backup-test');
    const stage = path.join(root, '.bot-skills-stage-test');
    const journal = path.join(root, 'data', 'bot-skills', 'restore-journal', 'bot-a.json');
    fs.mkdirSync(backup, { recursive: true });
    fs.mkdirSync(stage, { recursive: true });
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(path.join(backup, 'original.txt'), 'original');
    fs.writeFileSync(path.join(stage, 'staged.txt'), 'staged');
    fs.writeFileSync(journal, JSON.stringify({
      schema: 'xiaoba.bot-skill-restore-journal.v1',
      botId: 'bot-a',
      skillsRoot: active,
      stage,
      backup,
      phase: 'backup_pending',
    }));

    BotSkillSyncService.recoverInterruptedRestore(root, 'bot-a', active);
    assert.equal(fs.readFileSync(path.join(active, 'original.txt'), 'utf8'), 'original');
    assert.equal(fs.existsSync(stage), false);
    assert.equal(fs.existsSync(journal), false);
  });

  test('rolls an activated restore forward instead of restoring stale backup content', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-restore-activated-'));
    roots.push(root);
    const active = path.join(root, 'skills');
    const backup = path.join(root, '.bot-skills-backup-test');
    const stage = path.join(root, '.bot-skills-stage-test');
    const journal = path.join(root, 'data', 'bot-skills', 'restore-journal', 'bot-a.json');
    fs.mkdirSync(active, { recursive: true });
    fs.mkdirSync(backup, { recursive: true });
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(path.join(active, 'new.txt'), 'new');
    fs.writeFileSync(path.join(backup, 'old.txt'), 'old');
    fs.writeFileSync(journal, JSON.stringify({
      schema: 'xiaoba.bot-skill-restore-journal.v1',
      botId: 'bot-a',
      skillsRoot: active,
      stage,
      backup,
      phase: 'activated',
    }));

    BotSkillSyncService.recoverInterruptedRestore(root, 'bot-a', active);
    assert.equal(fs.readFileSync(path.join(active, 'new.txt'), 'utf8'), 'new');
    assert.equal(fs.existsSync(path.join(active, 'old.txt')), false);
    assert.equal(fs.existsSync(backup), false);
    assert.equal(fs.existsSync(journal), false);
  });

  test('rolls forward when stage activation finished before the journal advanced', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-restore-activation-window-'));
    roots.push(root);
    const active = path.join(root, 'skills');
    const backup = path.join(root, '.bot-skills-backup-test');
    const stage = path.join(root, '.bot-skills-stage-test');
    const journal = path.join(root, 'data', 'bot-skills', 'restore-journal', 'bot-a.json');
    fs.mkdirSync(active, { recursive: true });
    fs.mkdirSync(backup, { recursive: true });
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(path.join(active, 'new.txt'), 'new');
    fs.writeFileSync(path.join(backup, 'old.txt'), 'old');
    fs.writeFileSync(journal, JSON.stringify({
      schema: 'xiaoba.bot-skill-restore-journal.v1',
      botId: 'bot-a',
      skillsRoot: active,
      stage,
      backup,
      phase: 'activation_pending',
    }));

    BotSkillSyncService.recoverInterruptedRestore(root, 'bot-a', active);
    assert.equal(fs.readFileSync(path.join(active, 'new.txt'), 'utf8'), 'new');
    assert.equal(fs.existsSync(path.join(active, 'old.txt')), false);
    assert.equal(fs.existsSync(backup), false);
    assert.equal(fs.existsSync(journal), false);
  });

  test('cleans a committed journal after its backup was already deleted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-restore-committed-'));
    roots.push(root);
    const active = path.join(root, 'skills');
    const backup = path.join(root, '.bot-skills-backup-test');
    const stage = path.join(root, '.bot-skills-stage-test');
    const journal = path.join(root, 'data', 'bot-skills', 'restore-journal', 'bot-a.json');
    fs.mkdirSync(active, { recursive: true });
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(path.join(active, 'new.txt'), 'new');
    fs.writeFileSync(journal, JSON.stringify({
      schema: 'xiaoba.bot-skill-restore-journal.v1',
      botId: 'bot-a',
      skillsRoot: active,
      stage,
      backup,
      phase: 'committed',
    }));

    BotSkillSyncService.recoverInterruptedRestore(root, 'bot-a', active);
    assert.equal(fs.readFileSync(path.join(active, 'new.txt'), 'utf8'), 'new');
    assert.equal(fs.existsSync(journal), false);
  });
});
