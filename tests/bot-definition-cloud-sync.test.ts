import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { BotDefinitionCloudSyncService } from '../src/bot-definition/cloud-sync';
import { createBotDefinitionSyncService } from '../src/bot-definition/service';
import type { BotDefinition } from '../src/bot-definition/types';

const roots: string[] = [];
const auth = {
  token: 'owner-token',
  apiKey: 'bot-api-key',
  httpBaseUrl: 'https://cats.example.test',
  serverUrl: 'wss://cats.example.test/v0/channels',
} as any;

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-definition-'));
  roots.push(root);
  return root;
}

function definition(modelId: string, prompt = 'default'): BotDefinition {
  return {
    schema: 'xiaoba.bot-definition.v1',
    botId: '43',
    model: { kind: 'catalog', modelId },
    prompt: prompt === 'default'
      ? { selected: 'default' }
      : { selected: 'custom', customSystemPrompt: prompt },
  };
}

function response(revision: number, value: BotDefinition): Response {
  return Response.json({
    uid: 43,
    configured: true,
    revision,
    definition: value,
    runtime: { desiredRevision: revision },
  });
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('BotDefinition cloud synchronization', () => {
  test('pull stores the cloud definition in the runnable local cache', async () => {
    const runtimeRoot = makeRoot();
    const definitionService = createBotDefinitionSyncService({ runtimeRoot, env: {} });
    const sync = new BotDefinitionCloudSyncService({
      runtimeRoot,
      env: {},
      definitionService,
      fetchImpl: (async () => response(5, definition('gpt-5.6-sol'))) as typeof fetch,
    });

    const snapshot = await sync.pull('43', auth);

    assert.equal(snapshot?.revision, 5);
    assert.deepStrictEqual(definitionService.read('43'), definition('gpt-5.6-sol'));
    assert.deepStrictEqual(sync.readState('43'), {
      schema: 'xiaoba.bot-definition-cloud-sync.v1',
      botId: '43',
      revision: 5,
      pendingModel: false,
      pendingPrompt: false,
    });
  });

  test('preserves cached Skills when an older cloud Definition omits the field', async () => {
    const runtimeRoot = makeRoot();
    const definitionService = createBotDefinitionSyncService({ runtimeRoot, env: {} });
    definitionService.publish('43', definition('minimax-m3').model);
    definitionService.updateSkills('43', [{
      source: 'skillhub',
      skillId: 'local-skill',
      version: '1',
      contentHash: 'a'.repeat(64),
    }]);
    const sync = new BotDefinitionCloudSyncService({
      runtimeRoot,
      env: {},
      definitionService,
      fetchImpl: (async () => response(5, definition('gpt-5.6-sol'))) as typeof fetch,
    });

    const snapshot = await sync.pull('43', auth);

    assert.equal(
      Object.prototype.hasOwnProperty.call(snapshot?.definition ?? {}, 'skills'),
      false,
    );
    assert.deepStrictEqual(definitionService.read('43')?.skills, [{
      source: 'skillhub',
      skillId: 'local-skill',
      version: '1',
      contentHash: 'a'.repeat(64),
    }]);
    assert.deepStrictEqual(definitionService.read('43')?.model, {
      kind: 'catalog',
      modelId: 'gpt-5.6-sol',
    });
  });

  test('does not commit cloud Skills before the workspace sync succeeds', async () => {
    const runtimeRoot = makeRoot();
    const definitionService = createBotDefinitionSyncService({ runtimeRoot, env: {} });
    const localSkills = [{
      source: 'skillhub' as const,
      skillId: 'local-skill',
      version: '1',
      contentHash: 'a'.repeat(64),
    }];
    const cloudSkills = [{
      source: 'skillhub' as const,
      skillId: 'cloud-skill',
      version: '2',
      contentHash: 'b'.repeat(64),
    }];
    definitionService.publish('43', definition('minimax-m3').model);
    definitionService.updateSkills('43', localSkills);
    const sync = new BotDefinitionCloudSyncService({
      runtimeRoot,
      env: {},
      definitionService,
      fetchImpl: (async () => response(6, {
        ...definition('gpt-5.6-sol'),
        skills: cloudSkills,
      })) as typeof fetch,
    });

    const snapshot = await sync.pull('43', auth);

    assert.deepStrictEqual(snapshot?.definition?.skills, cloudSkills);
    assert.deepStrictEqual(definitionService.read('43')?.skills, localSkills);
    assert.deepStrictEqual(definitionService.read('43')?.model, {
      kind: 'catalog',
      modelId: 'gpt-5.6-sol',
    });
  });

  test('applies cloud prompt during a local handoff without replacing the runnable model', async () => {
    const runtimeRoot = makeRoot();
    const definitionService = createBotDefinitionSyncService({ runtimeRoot, env: {} });
    definitionService.publish('43', definition('gpt-5.6-sol').model);
    definitionService.updatePrompt('43', { selected: 'default' });
    const sync = new BotDefinitionCloudSyncService({
      runtimeRoot,
      env: {},
      definitionService,
      fetchImpl: (async () => Response.json({
        uid: 43,
        configured: true,
        revision: 7,
        definition: {
          schema: 'xiaoba.bot-definition.v1',
          botId: '43',
          model: { kind: 'local', modelId: 'local' },
          prompt: { selected: 'custom', customSystemPrompt: 'Cloud prompt, local model.' },
        },
      })) as typeof fetch,
    });

    const snapshot = await sync.pull('43', auth);
    const cached = definitionService.read('43');

    assert.deepStrictEqual(snapshot?.definition?.model, { kind: 'local', modelId: 'local' });
    assert.deepStrictEqual(cached?.model, { kind: 'catalog', modelId: 'gpt-5.6-sol' });
    assert.deepStrictEqual(cached?.prompt, {
      selected: 'custom',
      customSystemPrompt: 'Cloud prompt, local model.',
    });
  });

  test('does not persist a local handoff marker when this device has no runnable model yet', async () => {
    const runtimeRoot = makeRoot();
    const definitionService = createBotDefinitionSyncService({ runtimeRoot, env: {} });
    const sync = new BotDefinitionCloudSyncService({
      runtimeRoot,
      env: {},
      definitionService,
      fetchImpl: (async () => Response.json({
        uid: 43,
        configured: true,
        revision: 3,
        definition: {
          schema: 'xiaoba.bot-definition.v1',
          botId: '43',
          model: { kind: 'local', modelId: 'local' },
          prompt: { selected: 'default' },
        },
      })) as typeof fetch,
    });

    const snapshot = await sync.pull('43', auth);

    assert.deepStrictEqual(snapshot?.definition?.model, { kind: 'local', modelId: 'local' });
    assert.equal(definitionService.read('43'), undefined);
    assert.equal(sync.readState('43').revision, 3);
  });

  test('keeps a failed local update pending and retries it later', async () => {
    const runtimeRoot = makeRoot();
    const definitionService = createBotDefinitionSyncService({ runtimeRoot, env: {} });
    definitionService.publish('43', definition('gpt-5.6-sol').model);
    let available = false;
    let revision = 1;
    const fetchImpl = (async (input) => {
      const url = String(input);
      if (!available && url.includes('/api/bots/definition/model')) {
        return Response.json({ error: 'offline' }, { status: 503 });
      }
      if (url.includes('/api/bots/definition/model')) {
        revision++;
        return Response.json({ revision });
      }
      return response(revision, definition('gpt-5.6-sol'));
    }) as typeof fetch;
    const sync = new BotDefinitionCloudSyncService({
      runtimeRoot,
      env: {},
      definitionService,
      fetchImpl,
    });

    await assert.rejects(sync.pushModel('43', auth), /offline/);
    assert.equal(sync.readState('43').pendingModel, true);

    available = true;
    const snapshot = await sync.flushPending('43', auth);
    assert.equal(snapshot?.revision, 2);
    assert.equal(sync.readState('43').pendingModel, false);
  });

  test('flushes model and prompt from the same pending local snapshot', async () => {
    const runtimeRoot = makeRoot();
    const definitionService = createBotDefinitionSyncService({ runtimeRoot, env: {} });
    const local = definition('gpt-5.6-sol', 'local prompt');
    definitionService.publish('43', local.model);
    definitionService.updatePrompt('43', local.prompt!);
    let cloud = definition('minimax-m3', 'cloud prompt');
    let revision = 1;
    const fetchImpl = (async (input, init) => {
      const url = String(input);
      if (url.includes('/api/bots/definition/model')) {
        const body = JSON.parse(String(init?.body));
        cloud = { ...cloud, model: body.model };
        revision++;
        return Response.json({ revision });
      }
      if (url.includes('/api/bots/definition/prompt')) {
        const body = JSON.parse(String(init?.body));
        cloud = { ...cloud, prompt: body.prompt };
        revision++;
        return Response.json({ revision });
      }
      return response(revision, cloud);
    }) as typeof fetch;
    const sync = new BotDefinitionCloudSyncService({
      runtimeRoot,
      env: {},
      definitionService,
      fetchImpl,
    });
    sync.markModelPending('43');
    sync.markPromptPending('43');

    const snapshot = await sync.flushPending('43', auth);

    assert.equal(snapshot?.revision, 3);
    assert.deepStrictEqual(cloud, local);
    assert.equal(sync.readState('43').pendingModel, false);
    assert.equal(sync.readState('43').pendingPrompt, false);
  });

  test('retries startup pending data only when the cloud revision is unchanged', async () => {
    const runtimeRoot = makeRoot();
    const definitionService = createBotDefinitionSyncService({ runtimeRoot, env: {} });
    definitionService.publish('43', definition('gpt-5.6-sol').model);
    let cloud = definition('minimax-m3');
    let revision = 1;
    let patchCount = 0;
    const fetchImpl = (async (input, init) => {
      const url = String(input);
      if (url.includes('/api/bots/definition/model')) {
        patchCount++;
        const body = JSON.parse(String(init?.body));
        cloud = { ...cloud, model: body.model };
        revision++;
        return Response.json({ revision });
      }
      return response(revision, cloud);
    }) as typeof fetch;
    const sync = new BotDefinitionCloudSyncService({
      runtimeRoot,
      env: {},
      definitionService,
      fetchImpl,
    });
    await sync.pull('43', auth);
    definitionService.updateModel('43', definition('gpt-5.6-sol').model);
    sync.markModelPending('43');

    const snapshot = await sync.reconcileStartup('43', auth);

    assert.equal(snapshot?.revision, 2);
    assert.equal(patchCount, 1);
    assert.deepStrictEqual(definitionService.read('43')?.model, definition('gpt-5.6-sol').model);
    assert.equal(sync.readState('43').pendingModel, false);
  });

  test('does not overwrite a newer cloud revision with stale startup pending data', async () => {
    const runtimeRoot = makeRoot();
    const definitionService = createBotDefinitionSyncService({ runtimeRoot, env: {} });
    let cloud = definition('minimax-m3');
    let revision = 1;
    let patchCount = 0;
    const fetchImpl = (async input => {
      const url = String(input);
      if (url.includes('/api/bots/definition/model')) {
        patchCount++;
        return Response.json({ error: 'unexpected patch' }, { status: 500 });
      }
      return response(revision, cloud);
    }) as typeof fetch;
    const sync = new BotDefinitionCloudSyncService({
      runtimeRoot,
      env: {},
      definitionService,
      fetchImpl,
    });
    await sync.pull('43', auth);
    definitionService.updateModel('43', definition('gpt-5.6-sol').model);
    sync.markModelPending('43');
    cloud = definition('deepseek-v4-flash');
    revision = 2;

    const snapshot = await sync.reconcileStartup('43', auth);

    assert.equal(snapshot?.revision, 2);
    assert.equal(patchCount, 0);
    assert.deepStrictEqual(definitionService.read('43'), cloud);
    assert.equal(sync.readState('43').pendingModel, false);
  });

  test('retries one explicit local field update after a stale revision', async () => {
    const runtimeRoot = makeRoot();
    const definitionService = createBotDefinitionSyncService({ runtimeRoot, env: {} });
    definitionService.publish('43', definition('gpt-5.6-sol').model);
    let patchCount = 0;
    let cloud = definition('minimax-m3');
    let revision = 2;
    const fetchImpl = (async (input, init) => {
      const url = String(input);
      if (url.includes('/api/bots/definition/model')) {
        patchCount++;
        const body = JSON.parse(String(init?.body));
        if (patchCount === 1) {
          cloud = definition('deepseek-v4-flash');
          revision = 3;
          return Response.json({ error: 'stale' }, { status: 409 });
        }
        assert.equal(body.revision, 3);
        cloud = {
          ...cloud,
          model: body.model,
        };
        revision = 4;
        return Response.json({ revision });
      }
      return response(revision, cloud);
    }) as typeof fetch;
    const sync = new BotDefinitionCloudSyncService({
      runtimeRoot,
      env: {},
      definitionService,
      fetchImpl,
    });

    const snapshot = await sync.pushModel('43', auth, definition('gpt-5.6-sol').model);

    assert.equal(patchCount, 2);
    assert.equal(snapshot?.revision, 4);
    assert.equal(definitionService.read('43')?.model.kind, 'catalog');
    assert.equal((definitionService.read('43')?.model as any).modelId, 'gpt-5.6-sol');
    assert.equal(sync.readState('43').pendingModel, false);
  });
});
