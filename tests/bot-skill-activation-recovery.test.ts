import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import {
  discardBotSkillBindingRollback,
  persistBotSkillBindingRollback,
  recoverBotSkillActivation,
} from '../src/bot-skills/activation-recovery';
import { BotSkillWorkspaceService } from '../src/bot-skills/workspace-service';

describe('Bot Skill activation recovery', () => {
  let runtimeRoot: string;

  beforeEach(() => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-activation-'));
  });

  afterEach(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  test('restores binding and the previous workspace after an interrupted switch', () => {
    const config = createCatsCoLocalConfigService({ runtimeRoot, env: {} });
    config.save(botConfig('bot_A', 'key_A'));
    fs.writeFileSync(
      path.join(runtimeRoot, '.env'),
      'UNRELATED_PROVIDER_SECRET=do-not-copy\nCATSCO_BOT_UID=bot_A\nCATSCO_API_KEY=key_A\n',
    );
    writeSkill(path.join(runtimeRoot, 'skills'), 'owner', 'A');
    const workspace = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    workspace.ensureActive('bot_A');

    const transactionId = 'tx-recover-A';
    persistBotSkillBindingRollback(runtimeRoot, transactionId);
    assert.equal(
      fs.readFileSync(
        path.join(runtimeRoot, 'data', 'bot-skills', 'binding-rollback.json'),
        'utf8',
      ).includes('do-not-copy'),
      false,
    );
    workspace.beginSwitch('bot_B', { allowCreate: true, transactionId });
    config.save(botConfig('bot_B', 'key_B'));
    fs.writeFileSync(
      path.join(runtimeRoot, '.env'),
      'UNRELATED_PROVIDER_SECRET=do-not-copy\nCATSCO_BOT_UID=bot_B\nCATSCO_API_KEY=key_B\n',
    );
    writeSkill(path.join(runtimeRoot, 'skills'), 'draft', 'B draft');

    const result = recoverBotSkillActivation(runtimeRoot, workspace);

    assert.equal(result.recovered, true);
    assert.equal(result.restoredBotId, 'bot_A');
    assert.equal(config.load().currentBot?.uid, 'bot_A');
    const recoveredEnv = fs.readFileSync(path.join(runtimeRoot, '.env'), 'utf8');
    assert.match(recoveredEnv, /CATSCO_BOT_UID=bot_A/);
    assert.match(recoveredEnv, /UNRELATED_PROVIDER_SECRET=do-not-copy/);
    assert.equal(fs.readFileSync(path.join(runtimeRoot, 'skills', 'owner', 'SKILL.md'), 'utf8'), 'A');
    assert.equal(
      fs.readFileSync(path.join(workspace.getParkedPath('bot_B'), 'draft', 'SKILL.md'), 'utf8'),
      'B draft',
    );
    assert.equal(
      fs.existsSync(path.join(runtimeRoot, 'data', 'bot-skills', 'binding-rollback.json')),
      false,
    );
  });

  test('refuses workspace recovery when the matching binding snapshot is missing', () => {
    fs.mkdirSync(path.join(runtimeRoot, 'skills'));
    const workspace = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    workspace.ensureActive('bot_A');
    workspace.beginSwitch('bot_B', {
      allowCreate: true,
      transactionId: 'tx-missing-snapshot',
    });

    assert.throws(
      () => recoverBotSkillActivation(runtimeRoot, workspace),
      /missing its binding rollback snapshot/,
    );
    assert.equal(workspace.readState()?.switchJournal?.transactionId, 'tx-missing-snapshot');
  });

  test('discards a stale binding snapshot after the workspace transaction committed', () => {
    const config = createCatsCoLocalConfigService({ runtimeRoot, env: {} });
    config.save(botConfig('bot_A', 'key_A'));
    fs.mkdirSync(path.join(runtimeRoot, 'skills'));
    const workspace = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    workspace.ensureActive('bot_A');

    persistBotSkillBindingRollback(runtimeRoot, 'tx-stale');
    const result = recoverBotSkillActivation(runtimeRoot, workspace);

    assert.equal(result.recovered, false);
    assert.equal(
      fs.existsSync(path.join(runtimeRoot, 'data', 'bot-skills', 'binding-rollback.json')),
      false,
    );
  });

  test('does not discard a snapshot belonging to a different transaction', () => {
    const config = createCatsCoLocalConfigService({ runtimeRoot, env: {} });
    config.save(botConfig('bot_A', 'key_A'));
    persistBotSkillBindingRollback(runtimeRoot, 'tx-A');

    assert.throws(
      () => discardBotSkillBindingRollback(runtimeRoot, 'tx-B'),
      /different Bot binding rollback snapshot/,
    );
  });

  test('target Connector validates a live parent transaction without rolling it back', () => {
    const config = createCatsCoLocalConfigService({ runtimeRoot, env: {} });
    config.save(botConfig('bot_A', 'key_A'));
    fs.mkdirSync(path.join(runtimeRoot, 'skills'));
    const workspace = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    workspace.ensureActive('bot_A');
    persistBotSkillBindingRollback(runtimeRoot, 'tx-live');
    workspace.beginSwitch('bot_B', {
      allowCreate: true,
      transactionId: 'tx-live',
    });
    config.save(botConfig('bot_B', 'key_B'));

    const result = recoverBotSkillActivation(runtimeRoot, workspace, {
      expectedLiveTransactionId: 'tx-live',
    });

    assert.equal(result.recovered, false);
    assert.equal(result.pendingTargetBotId, 'bot_B');
    assert.equal(workspace.readState()?.switchJournal?.transactionId, 'tx-live');
  });

  test('first-binding Connector validates a stable initial claim while the parent lock is held', () => {
    const config = createCatsCoLocalConfigService({ runtimeRoot, env: {} });
    config.save(botConfig('bot_A', 'key_A'));
    fs.mkdirSync(path.join(runtimeRoot, 'skills'));
    const workspace = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    const lock = workspace.acquireActivationLock();
    try {
      workspace.ensureActive('bot_A', { lock });
      const result = recoverBotSkillActivation(runtimeRoot, workspace, {
        expectedLiveTransactionId: 'initial:test-token',
      });
      assert.equal(result.pendingTargetBotId, 'bot_A');
      assert.equal(workspace.readState()?.workspaceOwnerBotId, 'bot_A');
    } finally {
      lock.release();
    }
  });
});

function botConfig(botId: string, apiKey: string) {
  return {
    version: 1 as const,
    currentBot: {
      uid: botId,
      apiKey,
      boundByUserUid: 'user-1',
      bindingSource: 'test',
    },
    device: {
      deviceId: 'device-1',
      bodyId: 'device-1',
      installationId: 'device-1',
    },
  };
}

function writeSkill(skillsRoot: string, name: string, content: string): void {
  const skillPath = path.join(skillsRoot, name);
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), content, 'utf8');
}
