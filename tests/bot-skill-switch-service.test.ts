import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BOT_SKILL_SWITCH_JOURNAL_SCHEMA,
  FileBotSkillSwitchJournalStore,
} from '../src/bot-skills/switch-journal';
import { BotSkillWorkspaceSwitchService } from '../src/bot-skills/switch-service';
import { BotSkillWorkspaceService } from '../src/bot-skills/workspace';

describe('Bot Skill workspace switch transaction', () => {
  let root: string;
  let runtimeRoot: string;
  let activeRoot: string;
  let parkedA: string;
  let preparedB: string;
  let journalStore: FileBotSkillSwitchJournalStore;
  let nextId: number;
  const ownerA = { botId: 'bot-a', authority: 'authority/user' };
  const ownerB = { botId: 'bot-b', authority: 'authority/user' };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-switch-'));
    runtimeRoot = path.join(root, 'runtime');
    activeRoot = path.join(runtimeRoot, 'skills');
    parkedA = path.join(runtimeRoot, 'data', 'bot-skill-workspaces', 'bot-a', 'workspace-a');
    preparedB = path.join(runtimeRoot, 'data', 'bot-skill-workspaces', 'bot-b', 'workspace-b');
    nextId = 1;
    journalStore = new FileBotSkillSwitchJournalStore({ runtimeRoot });
    const active = workspaceAt(activeRoot);
    active.initializeEmpty(ownerA);
    fs.writeFileSync(path.join(activeRoot, 'owner-a.txt'), 'A');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function workspaceAt(skillsRoot: string): BotSkillWorkspaceService {
    return new BotSkillWorkspaceService({
      skillsRoot,
      createId: () => `id-${nextId++}`,
      now: () => new Date('2026-07-24T00:00:00.000Z'),
    });
  }

  function service(): BotSkillWorkspaceSwitchService {
    return new BotSkillWorkspaceSwitchService({
      workspace: workspaceAt(activeRoot),
      journalStore,
      createId: () => `tx-${nextId++}`,
      now: () => new Date('2026-07-24T00:00:00.000Z'),
    });
  }

  test('prepares B before stopping A, then parks A and commits B', async () => {
    const events: string[] = [];
    await service().switch({
      fromOwner: ownerA,
      toOwner: ownerB,
      fromParkedRoot: parkedA,
      targetPreparedRoot: preparedB,
      prepareTarget: async target => {
        events.push('prepare-b');
        workspaceAt(target).initializeEmpty(ownerB);
        fs.writeFileSync(path.join(target, 'owner-b.txt'), 'B');
      },
      stopOldConnector: async () => {
        assert.equal(fs.existsSync(path.join(runtimeRoot, '.skills.bot-skill.lock')), false);
        events.push('stop-a');
      },
      syncOldWorkspace: async () => { events.push('sync-a'); },
      preflightTarget: async () => { events.push('preflight-b'); },
      commitTargetBinding: async () => { events.push('commit-b'); },
      startTargetConnector: async () => {
        assert.equal(fs.existsSync(path.join(runtimeRoot, '.skills.bot-skill.lock')), false);
        events.push('start-b');
      },
    });

    assert.deepStrictEqual(events, ['prepare-b', 'stop-a', 'sync-a', 'preflight-b', 'commit-b', 'start-b']);
    assert.equal(fs.readFileSync(path.join(activeRoot, 'owner-b.txt'), 'utf8'), 'B');
    assert.equal(fs.readFileSync(path.join(parkedA, 'owner-a.txt'), 'utf8'), 'A');
    assert.equal(journalStore.read(), undefined);
  });

  test('preflight failure restores A and keeps the prepared B workspace', async () => {
    const events: string[] = [];
    await assert.rejects(service().switch({
      fromOwner: ownerA,
      toOwner: ownerB,
      fromParkedRoot: parkedA,
      targetPreparedRoot: preparedB,
      prepareTarget: async target => {
        workspaceAt(target).initializeEmpty(ownerB);
        fs.writeFileSync(path.join(target, 'owner-b.txt'), 'B');
      },
      stopOldConnector: async () => { events.push('stop-a'); },
      syncOldWorkspace: async () => undefined,
      preflightTarget: async () => { throw new Error('B preflight failed'); },
      commitTargetBinding: async () => undefined,
      startTargetConnector: async () => undefined,
      restartOldConnector: async () => {
        assert.equal(fs.existsSync(path.join(runtimeRoot, '.skills.bot-skill.lock')), false);
        events.push('restart-a');
      },
    }), /preflight failed/);

    assert.equal(fs.readFileSync(path.join(activeRoot, 'owner-a.txt'), 'utf8'), 'A');
    assert.equal(fs.readFileSync(path.join(preparedB, 'owner-b.txt'), 'utf8'), 'B');
    assert.deepStrictEqual(events, ['stop-a', 'restart-a']);
    assert.equal(journalStore.read(), undefined);
  });

  test('rolls binding back even when its write callback partially commits and then throws', async () => {
    const events: string[] = [];
    await assert.rejects(service().switch({
      fromOwner: ownerA,
      toOwner: ownerB,
      fromParkedRoot: parkedA,
      targetPreparedRoot: preparedB,
      prepareTarget: async target => {
        workspaceAt(target).initializeEmpty(ownerB);
        fs.writeFileSync(path.join(target, 'owner-b.txt'), 'B');
      },
      stopOldConnector: async () => { events.push('stop-a'); },
      syncOldWorkspace: async () => undefined,
      preflightTarget: async () => undefined,
      commitTargetBinding: async () => {
        events.push('write-b-partially');
        throw new Error('env write failed');
      },
      rollbackSourceBinding: async () => { events.push('rollback-a-binding'); },
      startTargetConnector: async () => { events.push('start-b'); },
      restartOldConnector: async () => { events.push('restart-a'); },
    }), /env write failed/);

    assert.deepStrictEqual(events, [
      'stop-a',
      'write-b-partially',
      'rollback-a-binding',
      'restart-a',
    ]);
    assert.equal(fs.readFileSync(path.join(activeRoot, 'owner-a.txt'), 'utf8'), 'A');
    assert.equal(fs.readFileSync(path.join(preparedB, 'owner-b.txt'), 'utf8'), 'B');
  });

  test('recovery rolls an interrupted activation back to A without overwriting B', async () => {
    workspaceAt(preparedB).initializeEmpty(ownerB);
    fs.writeFileSync(path.join(preparedB, 'owner-b.txt'), 'B');
    fs.mkdirSync(path.dirname(parkedA), { recursive: true });
    fs.renameSync(activeRoot, parkedA);
    fs.renameSync(preparedB, activeRoot);
    journalStore.write({
      schema: BOT_SKILL_SWITCH_JOURNAL_SCHEMA,
      transactionId: 'tx-recovery',
      phase: 'TARGET_ACTIVATED',
      fromBotId: 'bot-a',
      fromWorkspaceId: 'id-1',
      toBotId: 'bot-b',
      toWorkspaceId: 'id-2',
      activeRoot,
      fromParkedRoot: parkedA,
      targetPreparedRoot: preparedB,
      startedAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
    });

    const result = await service().recover({ currentBotId: 'bot-a' });

    assert.equal(result, 'rolled_back');
    assert.equal(fs.readFileSync(path.join(activeRoot, 'owner-a.txt'), 'utf8'), 'A');
    assert.equal(fs.readFileSync(path.join(preparedB, 'owner-b.txt'), 'utf8'), 'B');
  });

  test('recovery completes forward when binding already points to B', async () => {
    workspaceAt(preparedB).initializeEmpty(ownerB);
    fs.writeFileSync(path.join(preparedB, 'owner-b.txt'), 'B');
    fs.mkdirSync(path.dirname(parkedA), { recursive: true });
    fs.renameSync(activeRoot, parkedA);
    fs.renameSync(preparedB, activeRoot);
    journalStore.write({
      schema: BOT_SKILL_SWITCH_JOURNAL_SCHEMA,
      transactionId: 'tx-commit',
      phase: 'COMMITTING_BINDING',
      fromBotId: 'bot-a',
      fromWorkspaceId: 'id-1',
      toBotId: 'bot-b',
      toWorkspaceId: 'id-2',
      activeRoot,
      fromParkedRoot: parkedA,
      targetPreparedRoot: preparedB,
      startedAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
    });

    const restarts: string[] = [];
    const result = await service().recover({
      currentBotId: 'bot-b',
      restartConnector: async outcome => { restarts.push(outcome); },
    });

    assert.equal(result, 'committed');
    assert.deepStrictEqual(restarts, ['committed']);
    assert.equal(fs.readFileSync(path.join(activeRoot, 'owner-b.txt'), 'utf8'), 'B');
    assert.equal(fs.readFileSync(path.join(parkedA, 'owner-a.txt'), 'utf8'), 'A');
  });

  test('rolls directories back when a committed journal finds the binding restored to A', async () => {
    workspaceAt(preparedB).initializeEmpty(ownerB);
    fs.writeFileSync(path.join(preparedB, 'owner-b.txt'), 'B');
    fs.mkdirSync(path.dirname(parkedA), { recursive: true });
    fs.renameSync(activeRoot, parkedA);
    fs.renameSync(preparedB, activeRoot);
    journalStore.write({
      schema: BOT_SKILL_SWITCH_JOURNAL_SCHEMA,
      transactionId: 'tx-binding-rolled-back',
      phase: 'BINDING_COMMITTED',
      fromBotId: 'bot-a',
      fromWorkspaceId: 'id-1',
      toBotId: 'bot-b',
      toWorkspaceId: 'id-2',
      oldConnectorWasRunning: true,
      activeRoot,
      fromParkedRoot: parkedA,
      targetPreparedRoot: preparedB,
      startedAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
    });
    const restarts: string[] = [];

    const result = await service().recover({
      currentBotId: 'bot-a',
      restartConnector: async outcome => { restarts.push(outcome); },
    });

    assert.equal(result, 'rolled_back');
    assert.deepStrictEqual(restarts, ['rolled_back']);
    assert.equal(fs.readFileSync(path.join(activeRoot, 'owner-a.txt'), 'utf8'), 'A');
    assert.equal(fs.readFileSync(path.join(preparedB, 'owner-b.txt'), 'utf8'), 'B');
  });
});
