import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withBotSkillWorkspaceLock } from '../src/bot-skills/workspace-lock';

describe('Bot Skill workspace lock', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-skill-lock-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('can lock a not-yet-created workspace and re-enter the same lock', async () => {
    const workspaceRoot = path.join(root, 'runtime', '.skills');
    const equivalentWorkspaceRoot = process.platform === 'win32'
      ? workspaceRoot.toUpperCase()
      : path.join(workspaceRoot, '.');
    const events: string[] = [];

    await withBotSkillWorkspaceLock(workspaceRoot, async () => {
      events.push('outer');
      await withBotSkillWorkspaceLock(equivalentWorkspaceRoot, async () => {
        events.push('inner');
      });
    });

    assert.deepStrictEqual(events, ['outer', 'inner']);
    assert.equal(fs.existsSync(workspaceRoot), false);
    assert.equal(
      fs.existsSync(path.join(path.dirname(workspaceRoot), '.skills.bot-skill.lock')),
      false,
    );
  });

  test('serializes concurrent operations for the same workspace', async () => {
    const workspaceRoot = path.join(root, 'skills');
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = withBotSkillWorkspaceLock(workspaceRoot, async () => {
      events.push('first-start');
      await firstMayFinish;
      events.push('first-end');
    });
    const second = withBotSkillWorkspaceLock(workspaceRoot, async () => {
      events.push('second');
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(events, ['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepStrictEqual(events, ['first-start', 'first-end', 'second']);
  });

  test('self-heals an old truncated lock left by a crashed process', async () => {
    const workspaceRoot = path.join(root, 'skills');
    const lockPath = path.join(root, '.skills.bot-skill.lock');
    fs.writeFileSync(lockPath, '{"pid":');
    const stale = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lockPath, stale, stale);

    let entered = false;
    await withBotSkillWorkspaceLock(workspaceRoot, async () => {
      entered = true;
    });

    assert.equal(entered, true);
    assert.equal(fs.existsSync(lockPath), false);
  });
});
