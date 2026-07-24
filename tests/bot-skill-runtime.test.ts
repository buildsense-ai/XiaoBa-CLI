import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BOT_DEFINITION_SCHEMA } from '../src/bot-definition/types';
import { FileBotSkillNewBotIntentStore } from '../src/bot-skills/new-bot-intent';
import { FileBotDefinitionCloudClient } from '../src/bot-skills/file-definition-cloud';
import {
  assertBotSkillStartupReady,
  BotSkillRuntime,
} from '../src/bot-skills/runtime';

describe('Bot Skill runtime coordinator', () => {
  let runtimeRoot: string;
  const auth = {
    httpBaseUrl: 'https://cats.example',
    serverUrl: 'wss://cats.example/v0/channels',
    botUid: 'bot-a',
    apiKey: 'bot-key',
    uid: 'user-a',
  };

  beforeEach(() => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-runtime-'));
  });

  afterEach(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  test('creates an explicitly new empty Bot once and safely reuses its Base', async () => {
    const runtime = new BotSkillRuntime({
      runtimeRoot,
      auth,
      transport: 'file',
      debounceMs: 0,
    });
    const definition = {
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-a',
      model: { kind: 'catalog' as const, modelId: 'model-a' },
    };
    const first = await runtime.sync({
      definitionForCreate: definition,
      allowNewWorkspaceCreate: true,
    });
    assert.equal(first.result.action, 'created_cloud');
    assert.deepStrictEqual(first.definition?.skills, []);
    assertBotSkillStartupReady(first, runtime.workspace, runtime.owner);

    const second = await runtime.sync();
    assert.equal(second.result.action, 'noop');
  });

  test('allows an existing valid local Bot to start while a Cloud conflict is pending', () => {
    const runtime = new BotSkillRuntime({
      runtimeRoot,
      auth,
      transport: 'file',
    });
    runtime.workspace.initializeEmpty(runtime.owner);

    assert.doesNotThrow(() => assertBotSkillStartupReady({
      result: {
        action: 'conflict',
        botId: runtime.owner.botId,
        reason: 'CLOUD_ETAG_CONFLICT',
      },
    }, runtime.workspace, runtime.owner));
  });

  test('serializes a local mutation and flushes its scheduled upload', async () => {
    const runtime = new BotSkillRuntime({
      runtimeRoot,
      auth,
      transport: 'file',
      debounceMs: 60_000,
    });
    await runtime.sync({
      definitionForCreate: {
        schema: BOT_DEFINITION_SCHEMA,
        botId: 'bot-a',
        model: { kind: 'catalog', modelId: 'model-a' },
      },
      allowNewWorkspaceCreate: true,
    });
    await runtime.mutate(() => {
      const directory = path.join(runtime.workspace.root, 'alpha');
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'SKILL.md'), [
        '---', 'name: alpha', 'description: alpha skill', '---', '', '# alpha', '',
      ].join('\n'));
    });

    const flushed = await runtime.flush();
    assert.equal(flushed?.result.action, 'uploaded');
    assert.equal(flushed?.definition?.skills?.length, 1);
  });

  test('new-Bot intent is authority/user bound and consumable', () => {
    const store = new FileBotSkillNewBotIntentStore(runtimeRoot);
    store.write({
      botId: 'bot-a',
      authority: 'https://cats.example/path',
      ownerUserId: 'user-a',
    });
    assert.equal(store.matches({
      botId: 'bot-a',
      authority: 'https://cats.example',
      ownerUserId: 'user-a',
    }), true);
    assert.equal(store.matches({
      botId: 'bot-a',
      authority: 'https://other.example',
      ownerUserId: 'user-a',
    }), false);
    store.delete('bot-a');
    assert.equal(store.matches({
      botId: 'bot-a',
      authority: 'https://cats.example',
      ownerUserId: 'user-a',
    }), false);
  });

  test('uploads an offline local edit to the workspace owner Bot after restart, never another Bot', async () => {
    const definitionFor = (botId: string) => ({
      schema: BOT_DEFINITION_SCHEMA,
      botId,
      model: { kind: 'catalog' as const, modelId: 'model-a' },
    });
    const botA = new BotSkillRuntime({
      runtimeRoot,
      auth,
      transport: 'file',
    });
    await botA.sync({
      definitionForCreate: definitionFor('bot-a'),
      allowNewWorkspaceCreate: true,
    });
    await botA.mutate(() => {
      const directory = path.join(botA.workspace.root, 'offline-skill');
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'SKILL.md'), [
        '---', 'name: offline-skill', 'description: offline skill', '---', '', 'before shutdown', '',
      ].join('\n'));
    });
    await botA.flush();

    const botBRoot = path.join(runtimeRoot, 'data', 'bot-b-workspace');
    const botB = new BotSkillRuntime({
      runtimeRoot,
      skillsRoot: botBRoot,
      auth: { ...auth, botUid: 'bot-b', apiKey: 'bot-b-key' },
      transport: 'file',
    });
    await botB.sync({
      definitionForCreate: definitionFor('bot-b'),
      allowNewWorkspaceCreate: true,
    });
    const botBCloud = new FileBotDefinitionCloudClient({
      root: path.join(runtimeRoot, 'data', 'bot-skill-test-cloud', 'definitions'),
      botId: 'bot-b',
    });
    const botBBefore = await botBCloud.read();

    fs.appendFileSync(
      path.join(botA.workspace.root, 'offline-skill', 'SKILL.md'),
      '\nchanged while XiaoBa was offline\n',
    );
    const restartedA = new BotSkillRuntime({
      runtimeRoot,
      auth,
      transport: 'file',
    });
    const recovered = await restartedA.sync({ definitionForCreate: definitionFor('bot-a') });

    assert.equal(recovered.result.action, 'uploaded');
    assert.notDeepStrictEqual(recovered.definition?.skills, []);
    assert.deepStrictEqual(await botBCloud.read(), botBBefore);
    assert.equal(restartedA.workspace.inspect(restartedA.owner).kind, 'valid');
  });
});
