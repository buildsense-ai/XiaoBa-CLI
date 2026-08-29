import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CatscoLogAgentClient,
  CatscoMemoryNoteInput,
  CatscoMemoryRecallQuery,
  CatscoSkillMemoryQuery,
} from '../src/utils/catsco-log-agent-client';
import {
  CatsLogMemoryProvider,
  CatsLogMemoryUnavailableError,
} from '../src/utils/catslog-memory-provider';
import { getCatscoLogAgentConfig } from '../src/utils/catsco-log-agent-config';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';

describe('CatsLog memory provider', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catslog-provider-'));
    env = {
      CATSCO_LOG_API_BASE_URL: 'https://logs.example.test',
      CATSCO_USER_TOKEN: 'catscompany-user-token',
      DOTENV_CONFIG_PATH: path.join(root, 'missing.env'),
      XIAOBA_USER_DATA_DIR: root,
    };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('bootstraps and reuses a device-bound capability, never the upload token', async () => {
    const calls: Array<{ kind: string; token?: string; query?: unknown }> = [];
    const client = fakeClient(calls, 'skill-token-1');
    const provider = new CatsLogMemoryProvider(root, {
      env,
      clientFactory: () => client,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
    });

    await provider.retrieveSkillMemory({ task: 'release' });
    await provider.recallMemory({ search: 'rollback' });

    assert.equal(calls.filter(call => call.kind === 'bootstrap').length, 1);
    assert.deepEqual(calls.filter(call => call.kind === 'retrieve')[0], {
      kind: 'retrieve',
      token: 'skill-token-1',
      query: { task: 'release' },
    });
    assert.deepEqual(calls.filter(call => call.kind === 'recall')[0], {
      kind: 'recall',
      token: 'skill-token-1',
      query: { search: 'rollback' },
    });

    const state = JSON.parse(fs.readFileSync(getCatscoLogAgentConfig(root, env).stateFilePath, 'utf8'));
    assert.equal(state.skillToken, 'skill-token-1');
    assert.equal(state.token, undefined);
  });

  test('refreshes once after a revoked capability and preserves device identity', async () => {
    const calls: Array<{ kind: string; token?: string }> = [];
    let retrieveCount = 0;
    const client: Partial<CatscoLogAgentClient> = {
      bootstrap: async () => {
        const token = calls.filter(call => call.kind === 'bootstrap').length === 0
          ? 'skill-token-old'
          : 'skill-token-new';
        calls.push({ kind: 'bootstrap', token });
        return bootstrapResponse(token);
      },
      retrieveSkillMemory: async input => {
        retrieveCount++;
        calls.push({ kind: 'retrieve', token: input.token });
        if (retrieveCount === 1) {
          const error: any = new Error('unauthorized');
          error.status = 401;
          throw error;
        }
        return { items: [] };
      },
    };
    const provider = new CatsLogMemoryProvider(root, {
      env,
      clientFactory: () => client as CatscoLogAgentClient,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
    });

    await provider.retrieveSkillMemory({ task: 'release' });

    assert.deepEqual(calls, [
      { kind: 'bootstrap', token: 'skill-token-old' },
      { kind: 'retrieve', token: 'skill-token-old' },
      { kind: 'bootstrap', token: 'skill-token-new' },
      { kind: 'retrieve', token: 'skill-token-new' },
    ]);
    const statePath = getCatscoLogAgentConfig(root, env).stateFilePath;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.deviceId, 'device-stable');
    assert.equal(state.skillToken, 'skill-token-new');
  });

  test('fails closed when neither a capability nor a CatsCompany token exists', async () => {
    const noAuthEnv = { ...env };
    delete noAuthEnv.CATSCO_USER_TOKEN;
    const provider = new CatsLogMemoryProvider(root, { env: noAuthEnv });
    await assert.rejects(
      provider.recallMemory({ search: 'anything' }),
      (error: any) => error instanceof CatsLogMemoryUnavailableError
      && error.code === 'CATSLOG_MEMORY_UNAVAILABLE',
    );
  });

  test('re-evaluates availability so a long-lived runtime sees a later login or revocation', () => {
    const dynamicEnv = { ...env };
    delete dynamicEnv.CATSCO_USER_TOKEN;
    const provider = new CatsLogMemoryProvider(root, { env: dynamicEnv });

    assert.equal(provider.isAvailable(), false);

    dynamicEnv.CATSLOG_MEMORY_ENABLED = 'true';
    assert.equal(provider.isAvailable(), false);

    dynamicEnv.CATSCO_USER_TOKEN = 'catscompany-user-token';
    assert.equal(provider.isAvailable(), true);

    dynamicEnv.CATSLOG_MEMORY_ENABLED = 'false';
    assert.equal(provider.isAvailable(), false);
  });

  test('logout clears persisted CatsLog capabilities before the next branch turn', async () => {
    const client = fakeClient([], 'skill-token-logout');
    const provider = new CatsLogMemoryProvider(root, {
      env,
      clientFactory: () => client,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
    });

    await provider.retrieveSkillMemory({ task: 'release' });
    assert.equal(provider.isAvailable(), true);

    createCatsCoLocalConfigService({ runtimeRoot: root, env }).clearAccount();
    assert.equal(provider.isAvailable(), false);
    const state = JSON.parse(fs.readFileSync(getCatscoLogAgentConfig(root, env).stateFilePath, 'utf8'));
    assert.equal(state.skillToken, undefined);
    assert.equal(state.memoryWriteToken, undefined);
    assert.equal(state.deviceId !== undefined, true);
  });

  test('account switches clear the previous device capability before reuse', async () => {
    const localConfig = createCatsCoLocalConfigService({ runtimeRoot: root, env });
    localConfig.persistAccountSession({
      token: 'catscompany-user-old',
      uid: 'user-old',
      httpBaseUrl: 'https://app.catsco.cc',
      serverUrl: 'wss://app.catsco.cc/v0/channels',
    }, { uid: 'user-old', token: 'catscompany-user-old' });

    const provider = new CatsLogMemoryProvider(root, {
      env,
      clientFactory: () => fakeClient([], 'skill-token-old'),
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
    });
    await provider.retrieveSkillMemory({ task: 'release' });

    localConfig.persistAccountSession({
      token: 'catscompany-user-new',
      uid: 'user-new',
      httpBaseUrl: 'https://app.catsco.cc',
      serverUrl: 'wss://app.catsco.cc/v0/channels',
    }, { uid: 'user-new', token: 'catscompany-user-new' });

    const state = JSON.parse(fs.readFileSync(getCatscoLogAgentConfig(root, env).stateFilePath, 'utf8'));
    assert.equal(state.skillToken, undefined);
    assert.equal(state.deviceId !== undefined, true);
  });

  test('keeps Skill outcome opt-in independent from note-write opt-in', () => {
    const writeOnly = new CatsLogMemoryProvider(root, {
      env: { ...env, CATSLOG_MEMORY_WRITE_ENABLED: 'true' },
    });
    assert.equal(writeOnly.supportsSkillOutcomes(), false);
    assert.equal(writeOnly.supportsMemoryNoteWrites(), true);
  });

  test('covers catalog, graph, direct sessions, outcome receipts, and note write tokens', async () => {
    const calls: Array<{ kind: string; token?: string; query?: unknown }> = [];
    const client: Partial<CatscoLogAgentClient> = {
      bootstrap: async () => {
        calls.push({ kind: 'bootstrap' });
        return {
          ...bootstrapResponse('skill-all'),
          skills_url: '/catsco/agent/skills',
          skill_graph_url: '/catsco/agent/skill-graph',
          sessions_url: '/catsco/agent/query/v1/sessions',
          memory_notes_url: '/catsco/agent/memory/notes',
          memory_write_token_id: 'write-id',
          memory_write_token: 'write-token',
          memory_write_token_expires_at: '2099-08-28T00:00:00.000Z',
        };
      },
      readSkills: async input => {
        calls.push({ kind: 'skills', token: input.token, query: stripCapability(input) });
        return { skills: [] };
      },
      readSkillGraph: async input => {
        calls.push({ kind: 'graph', token: input.token, query: stripCapability(input) });
        return { nodes: [], edges: [] };
      },
      querySessions: async input => {
        calls.push({ kind: 'sessions', token: input.token, query: stripCapability(input) });
        return { records: [] };
      },
      retrieveSkillMemory: async input => {
        calls.push({ kind: 'retrieve', token: input.token, query: stripCapability(input) });
        return {
          items: [{ handle: 'release-playbook', revision: 3, retrieval_receipt: 'receipt-1' }],
        };
      },
      reportSkillOutcome: async input => {
        calls.push({ kind: 'outcome', token: input.token, query: { ...input, token: undefined } });
      },
      createMemoryNote: async input => {
        calls.push({ kind: 'note', token: input.token, query: stripCapability(input) });
        return { id: 'note-1', kind: input.kind, content_sha256: 'hash' };
      },
    };
    const writeEnabledEnv = { ...env, CATSLOG_SKILL_OUTCOMES_ENABLED: 'true', CATSLOG_MEMORY_WRITE_ENABLED: 'true' };
    const provider = new CatsLogMemoryProvider(root, {
      env: writeEnabledEnv,
      clientFactory: () => client as CatscoLogAgentClient,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
    });

    await provider.readSkills({ search: 'release', includeTrace: 'summary' });
    await provider.readSkillGraph({ handle: 'release-playbook', depth: 1 });
    await provider.querySessions({ sessionId: 's-1', latest: true });
    await provider.retrieveSkillMemory({ handle: 'release-playbook', includeContent: true });
    await provider.reportSkillOutcome({
      handle: 'release-playbook', revision: 3, outcome: 'succeeded', requireReceipt: true,
    });
    await provider.createMemoryNote({ kind: 'fact', content: 'release owner' });

    assert.deepEqual(calls.map(call => call.kind), ['bootstrap', 'skills', 'graph', 'sessions', 'retrieve', 'outcome', 'note']);
    assert.equal(calls.find(call => call.kind === 'outcome')?.token, 'skill-all');
    assert.equal((calls.find(call => call.kind === 'outcome')?.query as any).retrievalReceipt, 'receipt-1');
    assert.equal(calls.find(call => call.kind === 'note')?.token, 'write-token');
    const state = JSON.parse(fs.readFileSync(getCatscoLogAgentConfig(root, writeEnabledEnv).stateFilePath, 'utf8'));
    assert.equal(state.memoryWriteToken, 'write-token');
    assert.equal(state.token, undefined);
  });

  test('refreshes a revoked write token without clearing the read token', async () => {
    let bootstrapCount = 0;
    const calls: Array<{ kind: string; token?: string }> = [];
    const client: Partial<CatscoLogAgentClient> = {
      bootstrap: async () => {
        bootstrapCount += 1;
        const suffix = bootstrapCount === 1 ? 'old' : 'new';
        return {
          ...bootstrapResponse(`skill-${suffix}`),
          memory_write_token: `write-${suffix}`,
          memory_write_token_expires_at: '2099-08-28T00:00:00.000Z',
        };
      },
      createMemoryNote: async input => {
        calls.push({ kind: 'note', token: input.token });
        if (input.token === 'write-old') {
          const error: any = new Error('expired');
          error.status = 401;
          throw error;
        }
        return { id: 'note-2' };
      },
    };
    const writeEnabledEnv = { ...env, CATSLOG_MEMORY_WRITE_ENABLED: 'true' };
    const provider = new CatsLogMemoryProvider(root, {
      env: writeEnabledEnv,
      clientFactory: () => client as CatscoLogAgentClient,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
    });
    await provider.createMemoryNote({ kind: 'fact', content: 'one' });
    await provider.createMemoryNote({ kind: 'fact', content: 'two' });
    assert.deepEqual(calls, [
      { kind: 'note', token: 'write-old' },
      { kind: 'note', token: 'write-new' },
      { kind: 'note', token: 'write-new' },
    ]);
    const state = JSON.parse(fs.readFileSync(getCatscoLogAgentConfig(root, writeEnabledEnv).stateFilePath, 'utf8'));
    assert.equal(state.skillToken, 'skill-new');
    assert.equal(state.memoryWriteToken, 'write-new');
  });
});

function bootstrapResponse(skillToken: string) {
  return {
    user_id: 'catsco-123',
    external_provider: 'catsco',
    external_user_id: '123',
    device_id: 'device-stable',
    token_id: 'upload-token-id',
    token: 'upload-token-must-not-be-used-for-memory',
    upload_url: '/catsco/logs/upload',
    issued_at: '2026-08-28T00:00:00.000Z',
    expires_at: '2099-08-28T00:00:00.000Z',
    skill_token_id: `${skillToken}-id`,
    skill_token: skillToken,
    skill_token_expires_at: '2099-08-28T00:00:00.000Z',
    memory_url: '/catsco/agent/memory/retrieve',
    memory_recall_url: '/catsco/agent/memory/recall',
  };
}

function fakeClient(
  calls: Array<{ kind: string; token?: string; query?: unknown }>,
  skillToken: string,
): CatscoLogAgentClient {
  const client: Partial<CatscoLogAgentClient> = {
    bootstrap: async () => {
      calls.push({ kind: 'bootstrap' });
      return bootstrapResponse(skillToken);
    },
    retrieveSkillMemory: async input => {
      calls.push({ kind: 'retrieve', token: input.token, query: stripCapability(input) });
      return { items: [] };
    },
    recallMemory: async input => {
      calls.push({ kind: 'recall', token: input.token, query: stripCapability(input) });
      return { session_available: true, session: { records: [] }, notes: [] };
    },
  };
  return client as CatscoLogAgentClient;
}

function stripCapability(input: CatscoSkillMemoryQuery | CatscoMemoryRecallQuery | CatscoMemoryNoteInput | Record<string, unknown> & { token?: string; memoryUrl?: string; memoryRecallUrl?: string }): unknown {
  const clone = { ...(input as any) };
  delete clone.token;
  delete clone.memoryUrl;
  delete clone.memoryRecallUrl;
  delete clone.skillsUrl;
  delete clone.skillGraphUrl;
  delete clone.sessionsUrl;
  delete clone.memoryNotesUrl;
  delete clone.signal;
  delete clone.requireReceipt;
  return clone;
}
