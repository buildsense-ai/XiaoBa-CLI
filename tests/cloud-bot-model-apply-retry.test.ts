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
import { scanBotSkillWorkspace } from '../src/bot-skills/local-manifest';
import { BotSkillWorkspaceService } from '../src/bot-skills/workspace';
import type { BotSkillRef } from '../src/bot-definition/types';

test('post-start BotDefinition updates preserve an operator-managed Skill workspace', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-apply-preserved-skills-'));
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
    schema: BOT_DEFINITION_SCHEMA,
    botId: '43',
    model: {
      kind: 'custom',
      protocol: 'openai-responses',
      apiBase: 'https://models.example.test/v1',
      model: 'unchanged-model',
      apiKey: 'test-model-key',
      contextWindowTokens: 128000,
    },
    prompt: { selected: 'custom', customSystemPrompt: 'Previous prompt.' },
    skills: [],
  };
  definitions.acceptCanonical(previous);
  const desired: BotDefinition = {
    ...previous,
    prompt: { selected: 'custom', customSystemPrompt: 'Updated prompt.' },
    skills: [{
      source: 'skillhub',
      skillId: 'private/cloud-only',
      version: 'sha256-cloud-only',
      contentHash: 'a'.repeat(64),
    }],
  };
  const localSkillRoot = path.join(runtimeRoot, 'skills', 'operator-local');
  const localSkillFile = path.join(localSkillRoot, 'SKILL.md');
  const localSkillText = [
    '---',
    'name: operator-local',
    'description: Operator-managed local Skill used for preservation testing.',
    '---',
    '',
    'Keep this local content unchanged.',
    '',
  ].join('\n');
  fs.mkdirSync(localSkillRoot, { recursive: true });
  fs.writeFileSync(localSkillFile, localSkillText);
  new BotSkillBaseStore(runtimeRoot).write({
    schema: 'xiaoba.bot-skill-sync-base.v2',
    botId: '43',
    definitionRevision: 6,
    skills: [],
    updatedAt: new Date().toISOString(),
  });

  const acks: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    if (url.pathname === '/api/bot/definition' && method === 'GET') {
      return Response.json({ configured: true, revision: 7, definition: desired });
    }
    if (url.pathname === '/api/bot/definition/ack' && method === 'POST') {
      acks.push(JSON.parse(String(init?.body)));
      return Response.json({ status: 'applied' });
    }
    if (url.pathname === '/api/bot/definition/default-prompt') {
      return Response.json({ status: 'stored' });
    }
    throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
  });
  const oldBot = { isIdleForRuntimeReload: () => true } as CatsCompanyBot;
  const result = await applyCloudModelRuntimeSelection({
    runtimeRoot,
    env: { XIAOBA_PRESERVE_SKILLS: '1' },
    botId: '43',
    auth,
    selection: {
      kind: 'custom',
      modelId: 'unchanged-model',
      customModel: desired.model,
      revision: 7,
      definition: desired,
    },
    canApply: () => true,
    connectorConfig: {
      serverUrl: 'wss://cats.example.test/v0/channels',
      apiKey: 'test-bot-key',
      botUid: '43',
    },
    currentBot: () => oldBot,
    replaceBot: () => assert.fail('prompt-only update must not replace the connector'),
    scheduleAckRetry: () => assert.fail('ACK should succeed'),
    clearAckRetry: () => {},
  });

  assert.equal(result, 'applied');
  assert.deepEqual(acks, [{ revision: 7 }]);
  assert.equal(fs.readFileSync(localSkillFile, 'utf8'), localSkillText);
  assert.deepEqual(fs.readdirSync(localSkillRoot), ['SKILL.md']);
  assert.deepEqual(definitions.read('43')?.prompt, desired.prompt);
});

test('post-start model-only updates restore B after B -> A -> B and reuse its verified Skills', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-apply-unchanged-skills-'));
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
    schema: BOT_DEFINITION_SCHEMA,
    botId: '43',
    model: {
      kind: 'custom', protocol: 'openai-responses', apiBase: 'https://models.example.test/v1',
      model: 'previous-model', apiKey: 'test-model-key', contextWindowTokens: 128000,
    },
    prompt: { selected: 'custom', customSystemPrompt: 'Unchanged prompt.' },
    skills: [TEST_SKILL_REFERENCE],
  };
  const desired: BotDefinition = {
    ...previous,
    model: { ...previous.model, model: 'next-model' },
  };
  definitions.acceptCanonical(previous);
  const localSkillRoot = path.join(runtimeRoot, 'skills', 'server-local');
  const localSkillFile = path.join(localSkillRoot, 'SKILL.md');
  fs.mkdirSync(localSkillRoot, { recursive: true });
  fs.writeFileSync(localSkillFile, [
    '---',
    'name: server-local',
    'description: Server-local Skill that a model-only update must not reconcile.',
    '---',
    '',
    'Keep this content.',
    '',
  ].join('\n'));
  writeVerifiedSkillBase(runtimeRoot, '43', 6, TEST_SKILL_REFERENCE);
  const before = fs.readFileSync(localSkillFile, 'utf8');
  // Local additions are not part of the unchanged Cloud Skill dimension. In
  // production they forced a full restore whose pending snapshot rejected an
  // unrelated game-assets link, preventing the model from being applied.
  const unmanagedRoot = path.join(runtimeRoot, 'skills', 'operator-extra');
  fs.mkdirSync(unmanagedRoot);
  fs.writeFileSync(path.join(unmanagedRoot, 'SKILL.md'), [
    '---', 'name: operator-extra', 'description: Local addition.', '---', '', 'Keep me.',
  ].join('\n'));
  const linkedRoot = path.join(runtimeRoot, '.agents', 'skills', 'game-assets');
  fs.mkdirSync(linkedRoot, { recursive: true });
  fs.writeFileSync(path.join(linkedRoot, 'SKILL.md'), 'Do not scan or publish this target.');
  const localLink = path.join(runtimeRoot, 'skills', 'game-assets');
  fs.symlinkSync(linkedRoot, localLink, process.platform === 'win32' ? 'junction' : 'dir');
  const linkTarget = fs.readlinkSync(localLink);
  const workspace = new BotSkillWorkspaceService(runtimeRoot);
  workspace.activate('43');
  workspace.activate('other-bot');
  fs.mkdirSync(path.join(runtimeRoot, 'skills', 'other-local'), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, 'skills', 'other-local', 'SKILL.md'), 'other bot content\n');
  const requests: string[] = [];
  const acks: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    requests.push(`${method} ${url.pathname}`);
    if (url.pathname === '/api/bot/definition' && method === 'GET') {
      return Response.json({ configured: true, revision: 7, definition: desired });
    }
    if (url.pathname === '/api/bot/definition/ack' && method === 'POST') {
      acks.push(JSON.parse(String(init?.body)));
      return Response.json({ status: 'applied' });
    }
    if (url.pathname === '/api/bot/definition/default-prompt') {
      return Response.json({ status: 'stored' });
    }
    throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
  });
  let stopped = 0;
  let started = 0;
  const oldBot = {
    isIdleForRuntimeReload: () => true,
    destroy: async () => { stopped += 1; },
  } as CatsCompanyBot;
  let bot = oldBot;
  t.mock.method(CatsCompanyBot.prototype, 'start', async function (this: CatsCompanyBot) {
    started += 1;
    t.after(() => this.destroy());
  });
  t.mock.method(CatsCompanyBot.prototype, 'waitUntilReady', async () => {});

  const result = await applyCloudModelRuntimeSelection({
    runtimeRoot,
    botId: '43',
    auth,
    selection: {
      kind: 'custom',
      modelId: 'next-model',
      customModel: desired.model,
      revision: 7,
      definition: desired,
    },
    canApply: () => true,
    connectorConfig: {
      serverUrl: 'wss://cats.example.test/v0/channels',
      apiKey: 'test-bot-key',
      botUid: '43',
    },
    currentBot: () => bot,
    replaceBot: next => { bot = next; },
    scheduleAckRetry: () => assert.fail('ACK should succeed'),
    clearAckRetry: () => {},
  });

  assert.equal(result, 'applied');
  assert.equal(stopped, 1);
  assert.equal(started, 1);
  assert.notEqual(bot, oldBot);
  assert.deepEqual(acks, [{ revision: 7 }]);
  assert.equal(requests.filter(request => request === 'GET /api/bot/definition').length, 2);
  assert.equal(requests.some(request => request.includes('/api/bot/definition/skills')), false);
  assert.equal(requests.some(request => request.includes('private-skill-packages')), false);
  assert.equal(fs.readFileSync(localSkillFile, 'utf8'), before);
  assert.equal(fs.readlinkSync(localLink), linkTarget);
  assert.equal(fs.existsSync(path.join(unmanagedRoot, '.xiaoba-bot-skill.json')), false);
  assert.equal(fs.existsSync(path.join(linkedRoot, '.xiaoba-bot-skill.json')), false);
  assert.equal(workspace.getActiveBotId(), '43');
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'skills', 'other-local')), false);
  assert.deepEqual(definitions.read('43')?.model, desired.model);
});

test('post-start prompt-only updates reuse unchanged Skills without restarting the connector', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-apply-unchanged-skills-'));
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
    schema: BOT_DEFINITION_SCHEMA,
    botId: '43',
    model: {
      kind: 'custom', protocol: 'openai-responses', apiBase: 'https://models.example.test/v1',
      model: 'unchanged-model', apiKey: 'test-model-key', contextWindowTokens: 128000,
    },
    prompt: { selected: 'custom', customSystemPrompt: 'Previous prompt.' },
    skills: [TEST_SKILL_REFERENCE],
  };
  const desired: BotDefinition = {
    ...previous,
    prompt: { selected: 'custom', customSystemPrompt: 'Updated prompt.' },
  };
  definitions.acceptCanonical(previous);
  const localSkillRoot = path.join(runtimeRoot, 'skills', 'server-local');
  fs.mkdirSync(localSkillRoot, { recursive: true });
  fs.writeFileSync(path.join(localSkillRoot, 'SKILL.md'), 'operator content\n');
  writeVerifiedSkillBase(runtimeRoot, '43', 6, TEST_SKILL_REFERENCE);
  const requests: string[] = [];
  const acks: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    requests.push(`${method} ${url.pathname}`);
    if (url.pathname === '/api/bot/definition' && method === 'GET') {
      return Response.json({ configured: true, revision: 7, definition: desired });
    }
    if (url.pathname === '/api/bot/definition/ack' && method === 'POST') {
      acks.push(JSON.parse(String(init?.body)));
      return Response.json({ status: 'applied' });
    }
    if (url.pathname === '/api/bot/definition/default-prompt') {
      return Response.json({ status: 'stored' });
    }
    throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
  });
  const oldBot = { isIdleForRuntimeReload: () => true } as CatsCompanyBot;

  const result = await applyCloudModelRuntimeSelection({
    runtimeRoot,
    botId: '43',
    auth,
    selection: {
      kind: 'custom', modelId: 'unchanged-model', customModel: desired.model,
      revision: 7, definition: desired,
    },
    canApply: () => true,
    connectorConfig: {
      serverUrl: 'wss://cats.example.test/v0/channels', apiKey: 'test-bot-key', botUid: '43',
    },
    currentBot: () => oldBot,
    replaceBot: () => assert.fail('prompt-only update must not replace the connector'),
    scheduleAckRetry: () => assert.fail('ACK should succeed'),
    clearAckRetry: () => {},
  });

  assert.equal(result, 'applied');
  assert.deepEqual(acks, [{ revision: 7 }]);
  assert.equal(requests.some(request => request.includes('/api/bot/definition/skills')), false);
  assert.equal(fs.readFileSync(path.join(localSkillRoot, 'SKILL.md'), 'utf8'), 'operator content\n');
  assert.deepEqual(definitions.read('43')?.prompt, desired.prompt);
});

test('model-only updates keep an unverified local-only workspace when synchronized Skill refs stay empty', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-apply-local-only-skills-'));
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
    schema: BOT_DEFINITION_SCHEMA,
    botId: '43',
    model: {
      kind: 'custom', protocol: 'openai-responses', apiBase: 'https://models.example.test/v1',
      model: 'previous-model', apiKey: 'test-model-key', contextWindowTokens: 128000,
    },
    prompt: { selected: 'custom', customSystemPrompt: 'Unchanged prompt.' },
    skills: [],
  };
  const desired: BotDefinition = {
    ...previous,
    model: { ...previous.model, model: 'next-model' },
  };
  definitions.acceptCanonical(previous);
  const localSkillRoot = path.join(runtimeRoot, 'skills', 'server-local');
  const localSkillFile = path.join(localSkillRoot, 'SKILL.md');
  fs.mkdirSync(localSkillRoot, { recursive: true });
  fs.writeFileSync(localSkillFile, [
    '---',
    'name: server-local',
    'description: Local-only Skill without historical Base metadata.',
    '---',
    '',
    'Keep this content.',
    '',
  ].join('\n'));
  new BotSkillWorkspaceService(runtimeRoot).activate('43');
  assert.equal(new BotSkillBaseStore(runtimeRoot).read('43'), undefined);
  const before = fs.readFileSync(localSkillFile, 'utf8');

  const requests: string[] = [];
  const acks: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    requests.push(`${method} ${url.pathname}`);
    if (url.pathname === '/api/bot/definition' && method === 'GET') {
      return Response.json({ configured: true, revision: 7, definition: desired });
    }
    if (url.pathname === '/api/bot/definition/ack' && method === 'POST') {
      acks.push(JSON.parse(String(init?.body)));
      return Response.json({ status: 'applied' });
    }
    if (url.pathname === '/api/bot/definition/default-prompt') {
      return Response.json({ status: 'stored' });
    }
    throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
  });
  let stopped = 0;
  let started = 0;
  const oldBot = {
    isIdleForRuntimeReload: () => true,
    destroy: async () => { stopped += 1; },
  } as CatsCompanyBot;
  let bot = oldBot;
  t.mock.method(CatsCompanyBot.prototype, 'start', async function (this: CatsCompanyBot) {
    started += 1;
    t.after(() => this.destroy());
  });
  t.mock.method(CatsCompanyBot.prototype, 'waitUntilReady', async () => {});

  const result = await applyCloudModelRuntimeSelection({
    runtimeRoot,
    botId: '43',
    auth,
    selection: {
      kind: 'custom', modelId: 'next-model', customModel: desired.model,
      revision: 7, definition: desired,
    },
    canApply: () => true,
    connectorConfig: {
      serverUrl: 'wss://cats.example.test/v0/channels', apiKey: 'test-bot-key', botUid: '43',
    },
    currentBot: () => bot,
    replaceBot: next => { bot = next; },
    scheduleAckRetry: () => assert.fail('ACK should succeed'),
    clearAckRetry: () => {},
  });

  assert.equal(result, 'applied');
  assert.equal(stopped, 1);
  assert.equal(started, 1);
  assert.notEqual(bot, oldBot);
  assert.deepEqual(acks, [{ revision: 7 }]);
  assert.equal(requests.some(request => request.includes('/api/bot/definition/skills')), false);
  assert.equal(requests.some(request => request.includes('private-skill-packages')), false);
  assert.equal(fs.readFileSync(localSkillFile, 'utf8'), before);
  assert.equal(new BotSkillWorkspaceService(runtimeRoot).getActiveBotId(), '43');
  assert.equal(new BotSkillBaseStore(runtimeRoot).read('43'), undefined);
  assert.deepEqual(definitions.read('43')?.model, desired.model);
});

test('a change from synchronized Skill refs to empty still requires strict workspace activation', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-apply-skill-removal-'));
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
    schema: BOT_DEFINITION_SCHEMA,
    botId: '43',
    model: {
      kind: 'custom', protocol: 'openai-responses', apiBase: 'https://models.example.test/v1',
      model: 'previous-model', apiKey: 'test-model-key', contextWindowTokens: 128000,
    },
    prompt: { selected: 'custom', customSystemPrompt: 'Unchanged prompt.' },
    skills: [TEST_SKILL_REFERENCE],
  };
  const desired: BotDefinition = {
    ...previous,
    model: { ...previous.model, model: 'next-model' },
    skills: [],
  };
  definitions.acceptCanonical(previous);
  const localSkillRoot = path.join(runtimeRoot, 'skills', 'server-local');
  fs.mkdirSync(localSkillRoot, { recursive: true });
  fs.writeFileSync(path.join(localSkillRoot, 'SKILL.md'), [
    '---',
    'name: server-local',
    'description: Local workspace that must survive a synchronized Skill removal.',
    '---',
    '',
  ].join('\n'));
  new BotSkillWorkspaceService(runtimeRoot).activate('43');

  const acks: any[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    if (url.pathname === '/api/bot/definition' && method === 'GET') {
      return Response.json({ configured: true, revision: 7, definition: desired });
    }
    if (url.pathname === '/api/bot/definition/ack' && method === 'POST') {
      acks.push(JSON.parse(String(init?.body)));
      return Response.json({ status: 'failed' });
    }
    if (url.pathname === '/api/bot/definition/default-prompt') {
      return Response.json({ status: 'stored' });
    }
    throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
  });
  const oldBot = { isIdleForRuntimeReload: () => true } as CatsCompanyBot;

  await assert.rejects(
    applyCloudModelRuntimeSelection({
      runtimeRoot,
      botId: '43',
      auth,
      selection: {
        kind: 'custom', modelId: 'next-model', customModel: desired.model,
        revision: 7, definition: desired,
      },
      canApply: () => true,
      connectorConfig: {
        serverUrl: 'wss://cats.example.test/v0/channels', apiKey: 'test-bot-key', botUid: '43',
      },
      currentBot: () => oldBot,
      replaceBot: () => assert.fail('an unverified Skill removal must not replace the connector'),
      scheduleAckRetry: () => assert.fail('the failure ACK should be delivered'),
      clearAckRetry: () => {},
    }),
    /local_workspace_unverified/,
  );

  assert.equal(acks.length, 1);
  assert.equal(acks[0].revision, 7);
  assert.match(acks[0].error, /local_workspace_unverified/);
  assert.equal(fs.existsSync(path.join(localSkillRoot, 'SKILL.md')), true);
  assert.equal(new BotSkillBaseStore(runtimeRoot).read('43'), undefined);
  assert.deepEqual(definitions.read('43')?.model, previous.model);
});

test('model-only updates with empty Skill refs still restore workspace ownership for the bound Bot', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-apply-foreign-workspace-'));
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
    schema: BOT_DEFINITION_SCHEMA,
    botId: '43',
    model: {
      kind: 'custom', protocol: 'openai-responses', apiBase: 'https://models.example.test/v1',
      model: 'previous-model', apiKey: 'test-model-key', contextWindowTokens: 128000,
    },
    prompt: { selected: 'custom', customSystemPrompt: 'Unchanged prompt.' },
    skills: [],
  };
  const desired: BotDefinition = {
    ...previous,
    model: { ...previous.model, model: 'next-model' },
  };
  definitions.acceptCanonical(previous);

  // A previous session left the active workspace owned by another Bot that also
  // parked local-only Skill content inside it.
  new BotSkillWorkspaceService(runtimeRoot).activate('99');
  const foreignSkillRoot = path.join(runtimeRoot, 'skills', 'other-bot-skill');
  fs.mkdirSync(foreignSkillRoot, { recursive: true });
  const foreignSkillFile = path.join(foreignSkillRoot, 'SKILL.md');
  fs.writeFileSync(foreignSkillFile, [
    '---',
    'name: other-bot-skill',
    'description: Local-only Skill that belongs to another Bot.',
    '---',
    '',
    'Another Bot owns this content.',
    '',
  ].join('\n'));
  const before = fs.readFileSync(foreignSkillFile, 'utf8');

  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    requests.push(`${method} ${url.pathname}`);
    if (url.pathname === '/api/bot/definition' && method === 'GET') {
      return Response.json({ configured: true, revision: 7, definition: desired });
    }
    if (url.pathname === '/api/bot/definition/ack' && method === 'POST') {
      return Response.json({ status: 'applied' });
    }
    if (url.pathname === '/api/bot/definition/default-prompt') {
      return Response.json({ status: 'stored' });
    }
    throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
  });
  let stopped = 0;
  let started = 0;
  const oldBot = {
    isIdleForRuntimeReload: () => true,
    destroy: async () => { stopped += 1; },
  } as CatsCompanyBot;
  let bot = oldBot;
  t.mock.method(CatsCompanyBot.prototype, 'start', async function (this: CatsCompanyBot) {
    started += 1;
    t.after(() => this.destroy());
  });
  t.mock.method(CatsCompanyBot.prototype, 'waitUntilReady', async () => {});

  const result = await applyCloudModelRuntimeSelection({
    runtimeRoot,
    botId: '43',
    auth,
    selection: {
      kind: 'custom', modelId: 'next-model', customModel: desired.model,
      revision: 7, definition: desired,
    },
    canApply: () => true,
    connectorConfig: {
      serverUrl: 'wss://cats.example.test/v0/channels', apiKey: 'test-bot-key', botUid: '43',
    },
    currentBot: () => bot,
    replaceBot: next => { bot = next; },
    scheduleAckRetry: () => assert.fail('ACK should succeed'),
    clearAckRetry: () => {},
  });

  assert.equal(result, 'applied');
  assert.equal(stopped, 1);
  assert.equal(started, 1);
  assert.equal(new BotSkillWorkspaceService(runtimeRoot).getActiveBotId(), '43');
  assert.equal(fs.existsSync(foreignSkillFile), false);
  assert.equal(
    fs.readFileSync(
      path.join(runtimeRoot, 'data', 'bot-skills', 'workspaces', '99', 'other-bot-skill', 'SKILL.md'),
      'utf8',
    ),
    before,
  );
  assert.equal(requests.some(request => request.includes('private-skill-packages')), false);
  assert.equal(new BotSkillBaseStore(runtimeRoot).read('43'), undefined);
  assert.deepEqual(definitions.read('43')?.model, desired.model);
});

test('preparation that advances from a prompt-only revision to a model revision restarts before ACK', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-apply-advanced-revision-'));
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
    schema: BOT_DEFINITION_SCHEMA,
    botId: '43',
    model: {
      kind: 'custom', protocol: 'openai-responses', apiBase: 'https://models.example.test/v1',
      model: 'old-model', apiKey: 'test-model-key', contextWindowTokens: 128000,
    },
    prompt: { selected: 'custom', customSystemPrompt: 'Previous prompt.' },
    skills: [TEST_SKILL_REFERENCE],
  };
  const queuedPromptOnly: BotDefinition = {
    ...previous,
    prompt: { selected: 'custom', customSystemPrompt: 'Queued prompt.' },
  };
  const advancedModelChange: BotDefinition = {
    ...queuedPromptOnly,
    model: { ...previous.model, model: 'new-model' },
  };
  definitions.acceptCanonical(previous);
  const localSkillRoot = path.join(runtimeRoot, 'skills', 'server-local');
  fs.mkdirSync(localSkillRoot, { recursive: true });
  fs.writeFileSync(path.join(localSkillRoot, 'SKILL.md'), 'verified local content\n');
  writeVerifiedSkillBase(runtimeRoot, '43', 6, TEST_SKILL_REFERENCE);

  let definitionReads = 0;
  const acks: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    if (url.pathname === '/api/bot/definition' && method === 'GET') {
      definitionReads += 1;
      return Response.json({
        configured: true,
        revision: definitionReads === 1 ? 7 : 8,
        definition: definitionReads === 1 ? queuedPromptOnly : advancedModelChange,
      });
    }
    if (url.pathname === '/api/bot/definition/ack' && method === 'POST') {
      acks.push(JSON.parse(String(init?.body)));
      return Response.json({ status: 'applied' });
    }
    if (url.pathname === '/api/bot/definition/default-prompt') {
      return Response.json({ status: 'stored' });
    }
    throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
  });

  let idleChecks = 0;
  let stopped = 0;
  let started = 0;
  const oldBot = {
    isIdleForRuntimeReload: () => { idleChecks += 1; return true; },
    destroy: async () => { stopped += 1; },
  } as CatsCompanyBot;
  let bot = oldBot;
  t.mock.method(CatsCompanyBot.prototype, 'start', async function (this: CatsCompanyBot) {
    started += 1;
    t.after(() => this.destroy());
  });
  t.mock.method(CatsCompanyBot.prototype, 'waitUntilReady', async () => {});

  const result = await applyCloudModelRuntimeSelection({
    runtimeRoot,
    botId: '43',
    auth,
    selection: {
      kind: 'custom', modelId: 'old-model', customModel: queuedPromptOnly.model,
      revision: 7, definition: queuedPromptOnly,
    },
    canApply: () => true,
    connectorConfig: {
      serverUrl: 'wss://cats.example.test/v0/channels', apiKey: 'test-bot-key', botUid: '43',
    },
    currentBot: () => bot,
    replaceBot: next => { bot = next; },
    scheduleAckRetry: () => assert.fail('ACK should succeed'),
    clearAckRetry: () => {},
  });

  assert.equal(result, 'applied');
  assert.equal(definitionReads, 2);
  assert.equal(idleChecks, 1, 'the effective model change must re-check connector idleness');
  assert.equal(stopped, 1);
  assert.equal(started, 1);
  assert.notEqual(bot, oldBot);
  assert.deepEqual(acks, [{ revision: 8 }]);
  assert.deepEqual(definitions.read('43')?.model, advancedModelChange.model);
});

for (const workspaceCase of ['missing', 'corrupt'] as const) {
test(`unchanged Skill refs do not bypass strict activation for a ${workspaceCase} workspace`, async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `model-apply-${workspaceCase}-skills-`));
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
    schema: BOT_DEFINITION_SCHEMA,
    botId: '43',
    model: {
      kind: 'custom', protocol: 'openai-responses', apiBase: 'https://models.example.test/v1',
      model: 'previous-model', apiKey: 'test-model-key', contextWindowTokens: 128000,
    },
    prompt: { selected: 'custom', customSystemPrompt: 'Unchanged prompt.' },
    skills: [TEST_SKILL_REFERENCE],
  };
  const desired: BotDefinition = {
    ...previous,
    model: { ...previous.model, model: 'next-model' },
  };
  definitions.acceptCanonical(previous);
  const skillsRoot = path.join(runtimeRoot, 'skills');
  if (workspaceCase === 'corrupt') {
    const corruptRoot = path.join(skillsRoot, 'server-local');
    fs.mkdirSync(corruptRoot, { recursive: true });
    fs.writeFileSync(path.join(corruptRoot, 'SKILL.md'), '---\nname: [invalid\n---\n');
  }
  new BotSkillWorkspaceService(runtimeRoot).activate('43');
  new BotSkillBaseStore(runtimeRoot).write({
    schema: 'xiaoba.bot-skill-sync-base.v2',
    botId: '43',
    definitionRevision: 6,
    skills: [{
      localSkillId: 'local-server-skill',
      name: 'server-local',
      installName: 'server-local',
      contentHash: 'b'.repeat(64),
      reference: TEST_SKILL_REFERENCE,
    }],
    updatedAt: new Date().toISOString(),
  });

  let definitionReads = 0;
  const acks: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    if (url.pathname === '/api/bot/definition' && method === 'GET') {
      definitionReads += 1;
      if (definitionReads === 3) {
        return Response.json({ error: 'temporary outage' }, { status: 503 });
      }
      return Response.json({ configured: true, revision: 7, definition: desired });
    }
    if (url.pathname === '/api/bot/definition/ack' && method === 'POST') {
      acks.push(JSON.parse(String(init?.body)));
      return Response.json({ status: 'applied' });
    }
    if (url.pathname === '/api/bot/definition/default-prompt') {
      return Response.json({ status: 'stored' });
    }
    throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
  });
  let stopped = 0;
  const oldBot = {
    isIdleForRuntimeReload: () => true,
    destroy: async () => { stopped += 1; },
  } as CatsCompanyBot;

  const result = await applyCloudModelRuntimeSelection({
    runtimeRoot,
    botId: '43',
    auth,
    selection: {
      kind: 'custom', modelId: 'next-model', customModel: desired.model,
      revision: 7, definition: desired,
    },
    canApply: () => true,
    connectorConfig: {
      serverUrl: 'wss://cats.example.test/v0/channels', apiKey: 'test-bot-key', botUid: '43',
    },
    currentBot: () => oldBot,
    replaceBot: () => assert.fail('an unverified workspace must not replace the connector'),
    scheduleAckRetry: () => assert.fail('an unverified workspace must not schedule an ACK'),
    clearAckRetry: () => {},
  });

  assert.equal(result, 'deferred');
  assert.equal(definitionReads, 3, 'strict Skill activation must re-read the cloud definition');
  assert.deepEqual(acks, []);
  assert.equal(stopped, 0);
  assert.deepEqual(definitions.read('43')?.model, previous.model);
});
}

for (const failure of [502, 503, 504, 429, 'timeout', 'reset', 'shutdown'] as const) {
for (const failureRead of [3, 4]) {
test(`cloud recheck ${failure} at read ${failureRead} preserves the old connector`, async t => {
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
    prompt: { selected: 'custom', customSystemPrompt: 'Test prompt.' },
  };
  definitions.acceptCanonical(previous);
  const desired = { ...previous, model: { ...previous.model, model: 'next-model' }, skills: [] };
  fs.mkdirSync(path.join(runtimeRoot, 'skills'), { recursive: true });
  new BotSkillBaseStore(runtimeRoot).write({
    schema: 'xiaoba.bot-skill-sync-base.v2', botId: '43', definitionRevision: 6,
    skills: [], updatedAt: new Date().toISOString(),
  });

  let reads = 0;
  let failedOnce = false;
  let active = true;
  const acks: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    if (url.pathname === '/api/bot/definition' && method === 'GET') {
      reads += 1;
      // Poll, revision check, startup reconciliation, then Skill recheck.
      if (reads === failureRead) {
        failedOnce = true;
        if (failure === 'shutdown') active = false;
        else if (failure === 'timeout') throw new DOMException('Test timeout', 'TimeoutError');
        else if (failure === 'reset') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
        else return Response.json({ error: 'temporary outage' }, { status: failure });
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
  let now = 0;
  const controller = new CloudBotModelRuntimeReloadController({
    now: () => now, random: () => 0,
    initialRevision: 6,
    pullSelection: () => pullCloudBotModelSelection({ botId: '43', auth }),
    isIdle: () => true,
    applySelection: selection => applyCloudModelRuntimeSelection({
      runtimeRoot, botId: '43', auth, selection, canApply: () => active,
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

  if (failure === 'shutdown') {
    await controller.pollOnce();
    assert.equal(started, 0);
    assert.deepEqual(acks, []);
    assert.deepEqual(errors, []);
    return;
  }
  now = 5000;
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

}
}

const TEST_SKILL_REFERENCE: BotSkillRef = {
  source: 'skillhub',
  skillId: 'private/server-local',
  version: 'sha256-server-local',
  contentHash: 'a'.repeat(64),
};

function writeVerifiedSkillBase(
  runtimeRoot: string,
  botId: string,
  definitionRevision: number,
  reference: BotSkillRef,
): void {
  const local = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'), { writeMarkers: false });
  assert.equal(local.length, 1);
  new BotSkillBaseStore(runtimeRoot).write({
    schema: 'xiaoba.bot-skill-sync-base.v2',
    botId,
    definitionRevision,
    skills: local.map(entry => ({
      localSkillId: entry.localSkillId,
      name: entry.name,
      installName: entry.installName,
      contentHash: entry.contentHash,
      reference,
    })),
    updatedAt: new Date().toISOString(),
  });
}
