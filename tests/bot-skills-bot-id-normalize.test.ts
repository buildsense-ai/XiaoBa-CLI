import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BotSkillWorkspaceChangingError,
  prepareBoundBotSkills,
} from '../src/bot-skills/runtime';
import { BotSkillWorkspaceService } from '../src/bot-skills/workspace';

// The WebSocket handshake reports `usr982` while the cloud RPC and every local
// workspace store name the Bot `982`. Production lost the post-reconnect Skill
// reconciliation on every worker because of that mismatch
// ("Bot Skill workspace ownership is changing (982 -> usr982); retry the write.").

describe('Bot Skill workspace Bot id normalization', () => {
  let runtimeRoot: string;
  let previousRuntimeRoot: string | undefined;
  let previousSkillsRoot: string | undefined;

  beforeEach(() => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-skill-id-'));
    previousRuntimeRoot = process.env.XIAOBA_USER_DATA_DIR;
    previousSkillsRoot = process.env.XIAOBA_SKILLS_DIR;
    process.env.XIAOBA_USER_DATA_DIR = runtimeRoot;
    process.env.XIAOBA_SKILLS_DIR = path.join(runtimeRoot, 'skills');
    fs.mkdirSync(process.env.XIAOBA_SKILLS_DIR, { recursive: true });
  });

  afterEach(() => {
    restoreEnv('XIAOBA_USER_DATA_DIR', previousRuntimeRoot);
    restoreEnv('XIAOBA_SKILLS_DIR', previousSkillsRoot);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  // `preserveLocalOnlyWorkspace` returns right after activation, so the
  // ownership check is exercised without touching the network.
  function prepare(botId: string) {
    return prepareBoundBotSkills({
      runtimeRoot,
      botId,
      auth: {} as never,
      definitionService: {} as never,
      requireActiveWorkspace: true,
      preserveLocalOnlyWorkspace: { definitionRevision: 7 },
    });
  }

  function activateWorkspace(botId: string): void {
    new BotSkillWorkspaceService(runtimeRoot, process.env.XIAOBA_SKILLS_DIR!).activate(botId);
  }

  test('accepts the handshake spelling for a workspace named after the bare uid', async () => {
    activateWorkspace('982');
    const prepared = await prepare('usr982');
    assert.equal(prepared.activation.botId, '982');
    assert.equal(prepared.sync?.botId, '982');
    assert.equal(new BotSkillWorkspaceService(runtimeRoot).getActiveBotId(), '982');
  });

  test('keeps accepting the bare uid the cloud RPC already sends', async () => {
    activateWorkspace('982');
    const prepared = await prepare('982');
    assert.equal(prepared.activation.botId, '982');
    assert.equal(prepared.sync?.botId, '982');
  });

  test('confirms the ownership error still fires for a genuinely different Bot', async () => {
    activateWorkspace('982');
    await assert.rejects(
      () => prepare('usr405'),
      (error: unknown) => (
        error instanceof BotSkillWorkspaceChangingError
        && error.activeBotId === '982'
        && error.targetBotId === '405'
      ),
    );
    assert.equal(new BotSkillWorkspaceService(runtimeRoot).getActiveBotId(), '982');
  });

  test('leaves a non-numeric Bot id alone', async () => {
    // Only `usr<digits>` is a handshake spelling; a slug that merely starts
    // with those three letters is a real, different id.
    activateWorkspace('bot-a');
    const prepared = await prepare('bot-a');
    assert.equal(prepared.activation.botId, 'bot-a');

    activateWorkspace('usrdemo');
    await assert.rejects(
      () => prepare('demo'),
      (error: unknown) => (
        error instanceof BotSkillWorkspaceChangingError
        && error.activeBotId === 'usrdemo'
        && error.targetBotId === 'demo'
      ),
    );
  });

  test('treats the two spellings as one owner instead of parking a second workspace', async () => {
    activateWorkspace('982');
    // Reconnect path.
    const handshake = await prepare('usr982');
    assert.equal(handshake.activation.botId, '982');
    assert.equal(handshake.activation.existed, true);
    // Cloud RPC path immediately after: same workspace, still not a switch.
    const rpc = await prepare('982');
    assert.equal(rpc.activation.botId, '982');
    assert.equal(rpc.activation.existed, true);
    // No workspace was parked under the `usr`-prefixed spelling.
    const parked = path.join(runtimeRoot, 'data', 'bot-skills', 'workspaces');
    assert.equal(fs.existsSync(path.join(parked, 'usr982')), false);
    assert.equal(new BotSkillWorkspaceService(runtimeRoot).getActiveBotId(), '982');
  });
});

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}
