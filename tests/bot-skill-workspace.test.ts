import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  BOT_SKILL_WORKSPACE_MARKER_SCHEMA,
  BotSkillWorkspaceService,
} from '../src/bot-skills/workspace-service';

describe('BotSkillWorkspaceService', () => {
  let runtimeRoot: string;

  beforeEach(() => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-workspace-'));
  });

  afterEach(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  test('claims an existing legacy skills directory without moving offline edits', () => {
    const activePath = path.join(runtimeRoot, 'skills');
    writeSkill(activePath, 'offline-edit', 'belongs to bot A');

    const service = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    const state = service.ensureActive('bot_A');

    assert.equal(state.workspaceOwnerBotId, 'bot_A');
    assert.equal(fs.readFileSync(path.join(activePath, 'offline-edit', 'SKILL.md'), 'utf8'), 'belongs to bot A');
    const marker = JSON.parse(fs.readFileSync(path.join(activePath, '.xiaoba-bot-workspace.json'), 'utf8'));
    assert.equal(marker.schema, BOT_SKILL_WORKSPACE_MARKER_SCHEMA);
    assert.equal(marker.workspaceOwnerBotId, 'bot_A');
  });

  test('isolates same-named skills across Bot workspaces', () => {
    const activePath = path.join(runtimeRoot, 'skills');
    writeSkill(activePath, 'shared-name', 'A content');
    const service = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    service.ensureActive('bot_A');

    const toB = service.beginSwitch('bot_B', { allowCreate: true });
    assert.equal(toB.changed, true);
    writeSkill(activePath, 'shared-name', 'B content');
    service.commitSwitch(toB.transactionId!);

    const toA = service.beginSwitch('bot_A');
    assert.equal(fs.readFileSync(path.join(activePath, 'shared-name', 'SKILL.md'), 'utf8'), 'A content');
    service.commitSwitch(toA.transactionId!);

    const backToB = service.beginSwitch('bot_B');
    assert.equal(fs.readFileSync(path.join(activePath, 'shared-name', 'SKILL.md'), 'utf8'), 'B content');
    service.commitSwitch(backToB.transactionId!);
  });

  test('does not treat a missing target workspace as an empty workspace', () => {
    fs.mkdirSync(path.join(runtimeRoot, 'skills'));
    const service = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    service.ensureActive('bot_A');

    assert.throws(
      () => service.beginSwitch('bot_B'),
      /No local Skill workspace exists/,
    );
    assert.equal(service.readState()?.workspaceOwnerBotId, 'bot_A');
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'skills')), true);
  });

  test('same Bot activation is idempotent', () => {
    fs.mkdirSync(path.join(runtimeRoot, 'skills'));
    const service = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    const first = service.ensureActive('bot_A');
    const second = service.beginSwitch('bot_A');

    assert.equal(second.changed, false);
    assert.equal(service.readState()?.workspaceId, first.workspaceId);
  });

  for (const crashPhase of ['prepared', 'source-parked', 'target-active'] as const) {
    test(`recovers the previous Bot after a crash at ${crashPhase}`, () => {
      const activePath = path.join(runtimeRoot, 'skills');
      writeSkill(activePath, 'owner', 'A');
      new BotSkillWorkspaceService({ runtimeRoot, env: {} }).ensureActive('bot_A');

      const crashing = new BotSkillWorkspaceService({
        runtimeRoot,
        env: {},
        onPhasePersisted: phase => {
          if (phase === crashPhase) throw new Error(`crash:${phase}`);
        },
      });
      assert.throws(
        () => crashing.beginSwitch('bot_B', { allowCreate: true }),
        new RegExp(`crash:${crashPhase}`),
      );

      const recovered = new BotSkillWorkspaceService({ runtimeRoot, env: {} }).recoverInterruptedSwitch();
      assert.equal(recovered?.workspaceOwnerBotId, 'bot_A');
      assert.equal(recovered?.switchJournal, undefined);
      assert.equal(fs.readFileSync(path.join(activePath, 'owner', 'SKILL.md'), 'utf8'), 'A');
    });
  }

  test('rollback returns the target workspace to parking without losing changes', () => {
    const activePath = path.join(runtimeRoot, 'skills');
    writeSkill(activePath, 'owner', 'A');
    const service = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    service.ensureActive('bot_A');
    const switching = service.beginSwitch('bot_B', { allowCreate: true });
    writeSkill(activePath, 'draft', 'B draft');

    service.rollbackSwitch(switching.transactionId);

    assert.equal(fs.readFileSync(path.join(activePath, 'owner', 'SKILL.md'), 'utf8'), 'A');
    assert.equal(
      fs.readFileSync(path.join(service.getParkedPath('bot_B'), 'draft', 'SKILL.md'), 'utf8'),
      'B draft',
    );
  });

  test('hashes hostile Bot ids instead of placing them in paths', () => {
    fs.mkdirSync(path.join(runtimeRoot, 'skills'));
    const service = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    service.ensureActive('bot_A');
    const hostile = '..\\CON/../../other';
    const parkedPath = service.getParkedPath(hostile);

    assert.equal(path.dirname(parkedPath), path.join(runtimeRoot, 'data', 'bot-skills', 'by-bot'));
    assert.match(path.basename(parkedPath), /^b_[a-f0-9]{64}$/);
    const switching = service.beginSwitch(hostile, { allowCreate: true });
    service.commitSwitch(switching.transactionId!);
    assert.equal(service.readState()?.workspaceOwnerBotId, hostile);
  });

  test('rejects an external XIAOBA_SKILLS_DIR override', () => {
    assert.throws(
      () => new BotSkillWorkspaceService({
        runtimeRoot,
        env: { XIAOBA_SKILLS_DIR: path.join(runtimeRoot, 'external-skills') },
      }),
      /require XIAOBA_SKILLS_DIR/,
    );
  });

  test('does not merge into an existing source parking destination', () => {
    fs.mkdirSync(path.join(runtimeRoot, 'skills'));
    const service = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    service.ensureActive('bot_A');
    const sourceParked = service.getParkedPath('bot_A');
    fs.mkdirSync(sourceParked, { recursive: true });

    assert.throws(
      () => service.beginSwitch('bot_B', { allowCreate: true }),
      /destination already exists/,
    );
    assert.equal(service.readState()?.workspaceOwnerBotId, 'bot_A');
  });

  test('holds the activation lock across begin and commit so another caller cannot rollback it', () => {
    fs.mkdirSync(path.join(runtimeRoot, 'skills'));
    const first = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    const lock = first.acquireActivationLock();
    try {
      first.ensureActive('bot_A', { lock });
      const switching = first.beginSwitch('bot_B', {
        allowCreate: true,
        transactionId: 'tx-live-switch',
        lock,
      });

      const second = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
      assert.throws(
        () => second.recoverInterruptedSwitch(),
        /already locked/,
      );
      assert.equal(first.readState()?.switchJournal?.transactionId, 'tx-live-switch');
      assert.equal(
        first.assertPendingTarget('tx-live-switch', 'bot_B').to.botId,
        'bot_B',
      );
      first.commitSwitch(switching.transactionId!, lock);
    } finally {
      lock.release();
    }

    assert.equal(first.readState()?.workspaceOwnerBotId, 'bot_B');
  });

  test('can release a failed first claim without deleting shared Skill content', () => {
    writeSkill(path.join(runtimeRoot, 'skills'), 'legacy', 'keep me');
    const service = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    const lock = service.acquireActivationLock();
    try {
      service.ensureActive('bot_A', { lock });
      service.releaseInitialClaim('bot_A', lock);
    } finally {
      lock.release();
    }

    assert.equal(service.readState(), undefined);
    assert.equal(
      fs.readFileSync(path.join(runtimeRoot, 'skills', 'legacy', 'SKILL.md'), 'utf8'),
      'keep me',
    );
    assert.equal(
      fs.existsSync(path.join(runtimeRoot, 'skills', '.xiaoba-bot-workspace.json')),
      false,
    );
  });

  test('rejects a data-directory symlink or junction before writing outside runtimeRoot', () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-workspace-external-'));
    try {
      fs.symlinkSync(
        external,
        path.join(runtimeRoot, 'data'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const service = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
      assert.throws(
        () => service.ensureActive('bot_A', { allowCreate: true }),
        /real directory|symlink|junction/,
      );
      assert.equal(fs.existsSync(path.join(external, 'bot-skills')), false);
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  test('does not overwrite an unmarked active directory during recovery', () => {
    fs.mkdirSync(path.join(runtimeRoot, 'skills'));
    new BotSkillWorkspaceService({ runtimeRoot, env: {} }).ensureActive('bot_A');
    const crashing = new BotSkillWorkspaceService({
      runtimeRoot,
      env: {},
      onPhasePersisted: phase => {
        if (phase === 'source-parked') throw new Error('crash');
      },
    });
    assert.throws(
      () => crashing.beginSwitch('bot_B', { allowCreate: true }),
      /crash/,
    );
    fs.mkdirSync(path.join(runtimeRoot, 'skills'));
    fs.writeFileSync(path.join(runtimeRoot, 'skills', 'unowned.txt'), 'do not overwrite');

    const service = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    assert.throws(
      () => service.recoverInterruptedSwitch(),
      /ambiguous/,
    );
    assert.equal(
      fs.readFileSync(path.join(runtimeRoot, 'skills', 'unowned.txt'), 'utf8'),
      'do not overwrite',
    );
    assert.ok(service.readState()?.switchJournal);
  });
});

function writeSkill(skillsRoot: string, name: string, content: string): void {
  const skillPath = path.join(skillsRoot, name);
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), content, 'utf8');
}
