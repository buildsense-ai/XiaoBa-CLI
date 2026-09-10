import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runPromptEditorCommand } from '../src/skills/prompt-editor-command';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { createBotDefinitionSyncService } from '../src/bot-definition/service';
import { createBotDefinitionCloudSyncService } from '../src/bot-definition/cloud-sync';
import { PromptReconcileCoordinator } from '../src/bot-definition/prompt-sync';
import { BotDefinition, BotPromptDefinition } from '../src/bot-definition/types';

describe('prompt skill cloud-first operations', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let canonical: BotDefinition;
  let revision: number;
  let patches: number;
  let patchStatus: number;
  let readFailsAfterWrite: boolean;
  let onPatch: (() => void) | undefined;
  let fetchImpl: typeof fetch;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-command-'));
    const app = path.join(root, 'app');
    fs.mkdirSync(path.join(app, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(app, 'prompts/system-prompt.md'), 'Bundled v1\n');
    env = { XIAOBA_APP_ROOT: app, XIAOBA_USER_DATA_DIR: root };
    createCatsCoLocalConfigService({ runtimeRoot: root, env }).save({
      version: 1,
      account: { uid: '38', token: 'synthetic-owner-secret' },
      currentBot: { uid: '982', apiKey: 'synthetic-bot-secret', boundByUserUid: '38', bindingSource: 'test' },
      endpoints: { httpBaseUrl: 'https://example.invalid', serverUrl: 'wss://example.invalid/v0/channels' },
    });
    canonical = { schema: 'xiaoba.bot-definition.v1', botId: '982',
      model: { kind: 'catalog', modelId: 'deepseek-v4-flash' }, prompt: { selected: 'default' } };
    revision = 28; patches = 0; patchStatus = 200; readFailsAfterWrite = false; onPatch = undefined;
    fetchImpl = (async (input, init) => {
      if (init?.method === 'PATCH') {
        patches++;
        assert.equal(String(input), 'https://example.invalid/api/bots/definition/prompt?uid=982');
        assert.equal((init.headers as any).Authorization, 'Bearer synthetic-owner-secret');
        if (patchStatus !== 200) return Response.json({ error: 'synthetic-owner-secret' }, { status: patchStatus });
        const payload = JSON.parse(String(init.body));
        assert.deepEqual(Object.keys(payload).sort(), ['prompt', 'revision']);
        assert.equal(payload.revision, revision);
        canonical.prompt = payload.prompt;
        revision++;
        onPatch?.();
        return Response.json({ revision });
      }
      assert.equal((init?.headers as any).Authorization, 'ApiKey synthetic-bot-secret');
      if (readFailsAfterWrite && patches) throw new Error('synthetic-owner-secret');
      return Response.json({ uid: 982, configured: true, revision, definition: canonical });
    }) as typeof fetch;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const call = (args: string[]) => runPromptEditorCommand(args, { runtimeRoot: root, env, fetchImpl });
  const active = () => path.join(root, 'prompt-overrides/system-prompt.md');
  async function request(content?: string) {
    const state = await call(['show']);
    assert.equal(state.ok, true);
    const file = path.join(root, 'request.json');
    fs.writeFileSync(file, JSON.stringify({ botId: state.botId, expectedHash: state.expectedHash,
      expectedRevision: state.expectedRevision, ...(content !== undefined ? { content } : {}) }));
    return file;
  }

  test('show reads canonical selection without creating or changing runtime data', async () => {
    const before = fs.readdirSync(root);
    const state = await call(['show']);
    assert.equal(state.selected, 'default');
    assert.equal(state.content, 'Bundled v1');
    assert.equal(state.localMatches, false);
    assert.equal(state.cloudVerified, true);
    assert.equal(state.expectedRevision, 28);
    assert.deepEqual(fs.readdirSync(root), before);
    assert.equal(patches, 0);
  });

  test('set, next-process load, reset and newer default preserve model, skills and custom draft', async () => {
    const service = createBotDefinitionSyncService({ runtimeRoot: root, env });
    service.acceptCanonical({ ...canonical, skills: [{ source: 'skillhub', skillId: 'user/demo', version: '1', contentHash: 'a'.repeat(64) }] });
    const skills = service.read('982')!.skills;
    const custom = 'My rules\n\nContinue tools until verified.\n';
    const saved = await call(['set', await request(custom)]);
    assert.equal(saved.ok, true);
    assert.equal(saved.cloudWritten, true);
    assert.equal(saved.localMatches, true);
    assert.equal(saved.selected, 'custom');
    assert.equal(saved.content, custom.trim());
    assert.deepEqual(service.read('982')!.skills, skills);
    assert.deepEqual(service.read('982')!.model, canonical.model);
    const restarted = new PromptReconcileCoordinator({ runtimeRoot: root, env });
    await restarted.activateBot('982', { preferDefinition: true });
    assert.equal(fs.readFileSync(active(), 'utf8').trim(), custom.trim());
    const reset = await call(['reset', await request()]);
    assert.equal(reset.ok, true);
    assert.equal(reset.selected, 'default');
    assert.equal(reset.customContent, custom.trim());
    assert.equal(reset.content, 'Bundled v1');
    fs.writeFileSync(path.join(root, 'app/prompts/system-prompt.md'), 'Bundled v2\n');
    await new PromptReconcileCoordinator({ runtimeRoot: root, env }).activateBot('982', { preferDefinition: true });
    assert.equal((await call(['show'])).content, 'Bundled v2');
    assert.equal((await call(['show'])).localMatches, true);
    assert.equal(patches, 2);
  });

  test('refuses stale hashes, revisions and bot identity without writes', async () => {
    for (const field of ['expectedHash', 'expectedRevision', 'botId']) {
      const file = await request('new');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      value[field] = 'stale'; fs.writeFileSync(file, JSON.stringify(value));
      assert.equal((await call(['set', file])).code, 'CONFLICT');
    }
    assert.equal(patches, 0); assert.equal(fs.existsSync(active()), false);
  });

  test('does not silently rebase a cloud conflict or expose raw upstream errors', async () => {
    patchStatus = 409;
    const result = await call(['set', await request('new')]);
    assert.equal(result.ok, false); assert.equal(result.code, 'CONFLICT');
    assert.equal(patches, 1); assert.equal(fs.existsSync(active()), false);
    assert.ok(!JSON.stringify(result).includes('synthetic-owner-secret'));
  });

  test('unauthorized or unavailable cloud writes never change local prompt', async () => {
    for (const status of [401, 403, 404, 500]) {
      patchStatus = status;
      const result = await call(['set', await request('new')]);
      assert.equal(result.ok, false); assert.equal(result.cloudWritten, false);
      assert.equal(fs.existsSync(active()), false);
    }
  });

  test('refuses missing owner credentials before any write', async () => {
    const config = createCatsCoLocalConfigService({ runtimeRoot: root, env });
    const value = config.load(); value.account = undefined; config.save(value);
    assert.equal((await call(['set', await request('new')])).code, 'OWNER_AUTH_REQUIRED');
    assert.equal(patches, 0); assert.equal(fs.existsSync(active()), false);
  });

  test('reports cloud success with failed readback as partial, not local success', async () => {
    readFailsAfterWrite = true;
    const result = await call(['set', await request('new')]);
    assert.equal(result.ok, false); assert.equal(result.cloudWritten, true);
    assert.equal(canonical.prompt!.selected, 'custom');
    assert.equal(fs.existsSync(active()), false);
  });

  test('does not materialize a prompt after the bot switches during cloud write', async () => {
    onPatch = () => {
      const config = createCatsCoLocalConfigService({ runtimeRoot: root, env });
      const value = config.load(); value.currentBot!.uid = 'other-bot'; config.save(value);
    };
    const result = await call(['set', await request('new')]);
    assert.equal(result.code, 'BOT_CHANGED'); assert.equal(result.cloudWritten, true);
    assert.equal(fs.existsSync(active()), false);
  });

  test('preserves pending local edits instead of overwriting them', async () => {
    createBotDefinitionCloudSyncService({ runtimeRoot: root, env }).markPromptPending('982');
    assert.equal((await call(['set', await request('new')])).code, 'PENDING_LOCAL_EDIT');
    assert.equal(patches, 0);
  });

  test('rejects empty, oversized, unexpected fields and reset content', async () => {
    for (const content of ['', ' '.repeat(50), 'x'.repeat(256 * 1024 + 1)]) {
      assert.equal((await call(['set', await request(content)])).code, 'INVALID_CONTENT');
    }
    assert.equal((await call(['reset', await request('bad')])).code, 'INVALID_REQUEST');
    const file = await request('new');
    const value = JSON.parse(fs.readFileSync(file, 'utf8')); value.path = '../runtime-context.md';
    fs.writeFileSync(file, JSON.stringify(value));
    assert.equal((await call(['set', file])).code, 'INVALID_REQUEST');
    assert.equal(patches, 0);
  });
});
