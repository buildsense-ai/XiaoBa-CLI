import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { FileBotDefinitionCloudStateRepository } from '../src/bot-definition/cloud-state';
import {
  acknowledgeCloudBotDefinition,
  BotDefinitionRevisionConflictError,
  patchCloudBotDefinition,
  pullCloudBotDefinition,
} from '../src/bot-definition/definition-client';
import { BOT_DEFINITION_SCHEMA, type BotDefinition } from '../src/bot-definition/types';
import { createBotDefinitionSyncService } from '../src/bot-definition/service';

const auth = {
  token: 'owner-token',
  apiKey: 'bot-api-key',
  httpBaseUrl: 'https://app.example.test',
  serverUrl: 'wss://app.example.test/v0/channels',
};

const definition: BotDefinition = {
  schema: BOT_DEFINITION_SCHEMA,
  botId: '43',
  model: {
    kind: 'custom',
    protocol: 'openai-chat-completions',
    apiBase: 'https://models.example.test/v1',
    model: 'portable-model',
    apiKey: 'sk-runtime-only',
    contextWindowTokens: 128000,
    reasoningEffort: 'high',
  },
  savedCustomModel: {
    kind: 'custom',
    protocol: 'openai-chat-completions',
    apiBase: 'https://models.example.test/v1',
    model: 'portable-model',
    apiKey: 'sk-runtime-only',
    contextWindowTokens: 128000,
    reasoningEffort: 'high',
  },
  prompt: { selected: 'custom', customSystemPrompt: 'You are portable.' },
};

describe('CatsCo BotDefinition cloud contract', () => {
  test('runtime GET validates a complete model and prompt snapshot', async () => {
    const result = await pullCloudBotDefinition({
      botId: '43',
      auth,
      fetchImpl: (async (url, init) => {
        assert.equal(String(url), 'https://app.example.test/api/bot/definition');
        assert.equal((init?.headers as Record<string, string>).Authorization, 'ApiKey bot-api-key');
        return Response.json({ definition, revision: 8, updatedAt: '2026-07-28T00:00:00Z' });
      }) as typeof fetch,
    });
    assert.equal(result.kind, 'found');
    if (result.kind === 'found') {
      assert.equal(result.snapshot.revision, 8);
      assert.deepStrictEqual(result.snapshot.definition, definition);
    }
  });

  test('missing Definition is distinct from an unsupported server', async () => {
    const migration = await pullCloudBotDefinition({
      botId: '43',
      auth,
      fetchImpl: (async () => Response.json({
        error: 'migration_required',
        legacy_model: { kind: 'catalog', modelId: 'minimax-m3' },
      }, { status: 409 })) as typeof fetch,
    });
    assert.deepStrictEqual(migration, {
      kind: 'migration_required',
      legacyModel: { kind: 'catalog', modelId: 'minimax-m3' },
    });

    const unsupported = await pullCloudBotDefinition({
      botId: '43',
      auth,
      fetchImpl: (async () => Response.json({ error: 'not found' }, { status: 404 })) as typeof fetch,
    });
    assert.deepStrictEqual(unsupported, { kind: 'unsupported' });
  });

  test('owner PATCH sends a field patch with expected revision and surfaces conflicts', async () => {
    let captured: any;
    const snapshot = await patchCloudBotDefinition({
      botId: '43',
      auth,
      fetchImpl: (async (url, init) => {
        if (String(url).endsWith('/api/bot/definition')) {
          return Response.json({
            definition: { ...definition, prompt: { selected: 'default', customSystemPrompt: 'You are portable.' } },
            revision: 9,
          });
        }
        assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer owner-token');
        captured = JSON.parse(String(init?.body));
        return Response.json({
          definition: { ...definition, prompt: { selected: 'default', customSystemPrompt: 'You are portable.' } },
          revision: 9,
        });
      }) as typeof fetch,
    }, 8, { prompt: { selected: 'default', customSystemPrompt: 'You are portable.' } });
    assert.equal(snapshot.revision, 9);
    assert.deepStrictEqual(captured, {
      expected_revision: 8,
      prompt: { selected: 'default', customSystemPrompt: 'You are portable.' },
    });

    await assert.rejects(
      patchCloudBotDefinition({
        botId: '43',
        auth,
        fetchImpl: (async () => Response.json({
          error: 'revision_conflict',
          current_revision: 12,
        }, { status: 409 })) as typeof fetch,
      }, 8, { prompt: { selected: 'default' } }),
      (error: unknown) => error instanceof BotDefinitionRevisionConflictError
        && error.currentRevision === 12,
    );
  });

  test('ACK uses bot credentials and the exact full Definition revision', async () => {
    let captured: any;
    await acknowledgeCloudBotDefinition({
      botId: '43',
      auth,
      fetchImpl: (async (_url, init) => {
        assert.equal((init?.headers as Record<string, string>).Authorization, 'ApiKey bot-api-key');
        captured = JSON.parse(String(init?.body));
        return Response.json({ ok: true });
      }) as typeof fetch,
    }, 9, 'prompt materialization failed');
    assert.deepStrictEqual(captured, { revision: 9, error: 'prompt materialization failed' });
  });
});

describe('BotDefinition local durable cloud state', () => {
  let runtimeRoot: string;

  beforeEach(() => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-definition-cloud-state-'));
  });

  afterEach(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  test('merges local field patches and preserves conflicts without auto-merge', () => {
    const repository = new FileBotDefinitionCloudStateRepository(runtimeRoot);
    repository.recordSnapshot('43', { definition, revision: 8 });
    repository.queuePatch('43', 8, {
      model: { kind: 'catalog', modelId: 'minimax-m3' },
    });
    repository.queuePatch('43', 8, {
      prompt: { selected: 'default', customSystemPrompt: 'You are portable.' },
    });
    repository.markPatchConflicted('43', 9);

    const state = repository.read('43');
    assert.equal(state.pendingPatch?.expectedRevision, 8);
    assert.equal(state.pendingPatch?.status, 'conflicted');
    assert.equal(state.pendingPatch?.conflictRevision, 9);
    assert.deepStrictEqual(state.pendingPatch?.changes.model, { kind: 'catalog', modelId: 'minimax-m3' });
    assert.deepStrictEqual(state.pendingPatch?.changes.prompt, {
      selected: 'default',
      customSystemPrompt: 'You are portable.',
    });
  });

  test('persists fetched, applied and pending ACK states independently', () => {
    const repository = new FileBotDefinitionCloudStateRepository(runtimeRoot);
    repository.recordSnapshot('43', { definition, revision: 8 });
    repository.markApplied('43', 7);
    repository.queueAck('43', 7);

    let state = new FileBotDefinitionCloudStateRepository(runtimeRoot).read('43');
    assert.equal(state.snapshot?.revision, 8);
    assert.equal(state.appliedRevision, 7);
    assert.equal(state.pendingAck?.revision, 7);

    repository.clearAck('43', 7);
    state = repository.read('43');
    assert.equal(state.pendingAck, undefined);
    assert.equal(state.snapshot?.revision, 8);
    assert.equal(state.appliedRevision, 7);
  });

  test('promotes only the exact fetched revision to the offline applied snapshot', () => {
    const repository = new FileBotDefinitionCloudStateRepository(runtimeRoot);
    repository.recordSnapshot('43', { definition, revision: 8 });
    repository.markApplied('43', 8);
    repository.recordSnapshot('43', {
      definition: { ...definition, prompt: { selected: 'default' } },
      revision: 9,
    });

    const state = repository.read('43');
    assert.equal(state.snapshot?.revision, 9);
    assert.equal(state.appliedRevision, 8);
    assert.equal(state.appliedSnapshot?.revision, 8);
    assert.deepStrictEqual(state.appliedSnapshot?.definition.prompt, definition.prompt);
  });

  test('requires an explicit rebase before retrying a conflicted local patch', () => {
    const repository = new FileBotDefinitionCloudStateRepository(runtimeRoot);
    repository.queuePatch('43', 8, { prompt: { selected: 'default' } });
    repository.markPatchConflicted('43', 9);
    const oldKey = repository.read('43').pendingPatch?.idempotencyKey;

    const rebased = repository.rebasePatch('43', 9);
    assert.equal(rebased?.status, 'pending');
    assert.equal(rebased?.expectedRevision, 9);
    assert.equal(rebased?.conflictRevision, undefined);
    assert.notEqual(rebased?.idempotencyKey, oldKey);
    assert.deepStrictEqual(rebased?.changes.prompt, { selected: 'default' });
  });

  test('keeps edits made while an older field patch is in flight', () => {
    const repository = new FileBotDefinitionCloudStateRepository(runtimeRoot);
    const submitted = repository.queuePatch('43', 8, {
      model: { kind: 'catalog', modelId: 'minimax-m3' },
    });
    repository.queuePatch('43', 8, {
      prompt: { selected: 'default' },
    });

    repository.completePatch('43', submitted, 9);
    const pending = repository.read('43').pendingPatch;
    assert.equal(pending?.expectedRevision, 9);
    assert.equal(pending?.changes.model, undefined);
    assert.deepStrictEqual(pending?.changes.prompt, { selected: 'default' });
    assert.notEqual(pending?.idempotencyKey, submitted.idempotencyKey);
  });

  test('does not discard a conflict if its local changes moved during resolution', () => {
    const repository = new FileBotDefinitionCloudStateRepository(runtimeRoot);
    repository.queuePatch('43', 8, { prompt: { selected: 'default' } });
    repository.markPatchConflicted('43', 9);
    const reviewed = repository.read('43').pendingPatch!;
    repository.queuePatch('43', 8, {
      prompt: { selected: 'custom', customSystemPrompt: 'newer local edit' },
    });

    const accepted = repository.acceptCloudAndClearConflict(
      '43',
      reviewed,
      { definition, revision: 9 },
    );
    assert.equal(accepted, false);
    assert.equal(
      repository.read('43').pendingPatch?.changes.prompt?.customSystemPrompt,
      'newer local edit',
    );
  });

  test('quarantines malformed durable state instead of silently deleting it', () => {
    const repository = new FileBotDefinitionCloudStateRepository(runtimeRoot);
    const stateRoot = path.join(runtimeRoot, 'data', 'bot-definition-cloud-state');
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(stateRoot, '43.json'), '{broken', 'utf-8');

    assert.equal(repository.read('43').snapshot, undefined);
    assert.equal(
      fs.readdirSync(stateRoot).some(name => name.startsWith('43.json.corrupt-')),
      true,
    );
  });

  test('recovers a lost PATCH response when the committed cloud fields already match', async () => {
    const service = createBotDefinitionSyncService({ runtimeRoot });
    service.acceptCloudDefinition({ definition, revision: 8 });
    service.promoteCloudDefinition({ definition, revision: 8 });
    service.updatePrompt('43', { selected: 'default' });
    const committed = {
      ...definition,
      prompt: { selected: 'default' as const },
    };
    const snapshot = await service.flushPendingCloudPatch(
      '43',
      auth,
      (async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/bots/definition' && init?.method === 'PATCH') {
          return Response.json({ error: 'revision_conflict', current_revision: 9 }, { status: 409 });
        }
        if (url.pathname === '/api/bot/definition') {
          return Response.json({ definition: committed, revision: 9 });
        }
        return Response.json({ error: 'unexpected request' }, { status: 500 });
      }) as typeof fetch,
    );
    assert.equal(snapshot?.revision, 9);
    assert.equal(service.readCloudState('43').pendingPatch, undefined);
  });

  test('does not mark or ACK a cloud revision after a concurrent local edit', () => {
    const service = createBotDefinitionSyncService({ runtimeRoot });
    service.acceptCloudDefinition({ definition, revision: 8 });

    assert.equal(service.markCloudDefinitionAppliedIfNoPending('43', 8), true);
    assert.equal(service.readCloudState('43').appliedRevision, 8);

    const revision9 = {
      ...definition,
      prompt: { selected: 'default' as const },
    };
    assert.equal(
      service.commitCloudDefinitionIfNoPending({ definition: revision9, revision: 9 }),
      true,
    );
    service.updatePrompt('43', {
      selected: 'custom',
      customSystemPrompt: 'concurrent local edit',
    });

    assert.equal(service.markCloudDefinitionAppliedIfNoPending('43', 9), false);
    assert.equal(service.readCloudState('43').appliedRevision, 8);
    assert.equal(
      service.readCloudState('43').pendingPatch?.changes.prompt?.customSystemPrompt,
      'concurrent local edit',
    );
  });
});
