import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CatsCompanyBot } from '../src/catscompany';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { applyCloudModelRuntimeSelection } from '../src/commands/catscompany';
import { pullCloudBotModelSelection } from '../src/bot-definition/cloud-client';
import { CloudBotModelRuntimeReloadController } from '../src/bot-definition/runtime-reload';
import { createBotDefinitionSyncService } from '../src/bot-definition/service';
import { BOT_DEFINITION_SCHEMA, type BotDefinition } from '../src/bot-definition/types';
import { BotSkillBaseStore } from '../src/bot-skills/base-store';

test('a cloud Skill recheck outage preserves the old connector and retries the same model revision', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-apply-retry-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const configService = createCatsCoLocalConfigService({ runtimeRoot });
  configService.save({
    version: 1,
    endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
    account: { token: 'test-owner-token', uid: '7' },
    currentBot: { uid: '43', apiKey: 'test-bot-key', boundByUserUid: '7', bindingSource: 'test' },
  });
  const auth = configService.getAuthState();
  const definitions = createBotDefinitionSyncService({ runtimeRoot });
  const previous: BotDefinition = {
    schema: BOT_DEFINITION_SCHEMA, botId: '43',
    model: {
      kind: 'custom', protocol: 'openai-responses', apiBase: 'https://models.example.test/v1',
      apiKey: 'test-model-key', model: 'previous-model', contextWindowTokens: 128000,
    },
    prompt: { selected: 'custom', customSystemPrompt: 'Test prompt.' }, skills: [],
  };
  definitions.acceptCanonical(previous);
  const desired = { ...previous, model: { ...previous.model, model: 'next-model' } };
  fs.mkdirSync(path.join(runtimeRoot, 'skills'), { recursive: true });
  new BotSkillBaseStore(runtimeRoot).write({
    schema: 'xiaoba.bot-skill-sync-base.v2', botId: '43', definitionRevision: 6,
    skills: [], updatedAt: new Date().toISOString(),
  });

  let reads = 0;
  let failedOnce = false;
  const acks: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    if (url.pathname === '/api/bot/definition' && method === 'GET') {
      reads += 1;
      // Poll, revision check, startup reconciliation, then Skill recheck.
      if (reads === 4) {
        failedOnce = true;
        return Response.json({ error: 'temporary outage' }, { status: 503 });
      }
      return Response.json({ configured: true, revision: 7, definition: desired });
    }
    if (url.pathname === '/api/bot/definition/ack' && method === 'POST') {
      acks.push(JSON.parse(String(init?.body)));
      return Response.json({ status: 'applied' });
    }
    if (url.pathname === '/api/bot/definition/default-prompt') return Response.json({ status: 'stored' });
    throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
  });
  let stopped = 0;
  let started = 0;
  let ready = 0;
  const oldBot = { isIdleForRuntimeReload: () => true, destroy: async () => { stopped += 1; } } as CatsCompanyBot;
  let bot = oldBot;
  t.mock.method(CatsCompanyBot.prototype, 'start', async function (this: CatsCompanyBot) {
    started += 1;
    t.after(() => this.destroy());
  });
  t.mock.method(CatsCompanyBot.prototype, 'waitUntilReady', async () => { ready += 1; });
  t.mock.method(CatsCompanyBot.prototype, 'isIdleForRuntimeReload', () => true);
  const errors: unknown[] = [];
  const controller = new CloudBotModelRuntimeReloadController({
    initialRevision: 6,
    pullSelection: () => pullCloudBotModelSelection({ botId: '43', auth }),
    isIdle: () => true,
    applySelection: selection => applyCloudModelRuntimeSelection({
      runtimeRoot, botId: '43', auth, selection, canApply: () => true,
      connectorConfig: { serverUrl: 'wss://cats.example.test/v0/channels', apiKey: 'test-bot-key', botUid: '43' },
      currentBot: () => bot, replaceBot: next => { bot = next; },
      scheduleAckRetry: () => assert.fail('ACK should succeed'), clearAckRetry: () => {},
    }),
    onError: error => errors.push(error),
  });
  await controller.pollOnce();
  assert.equal(failedOnce, true);
  assert.deepEqual(acks, []);
  assert.equal(bot, oldBot);
  assert.equal(stopped, 0);
  assert.deepEqual(definitions.read('43')?.model, previous.model);

  await controller.pollOnce();
  assert.notEqual(bot, oldBot);
  assert.equal(stopped, 1);
  assert.equal(started, 1);
  assert.equal(ready, 1);
  assert.deepEqual(acks, [{ revision: 7 }]);
  assert.deepEqual(definitions.read('43')?.model, desired.model);
  await controller.pollOnce();
  assert.equal(started, 1);
  assert.deepEqual(errors, []);
});
