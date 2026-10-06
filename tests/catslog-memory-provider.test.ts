import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CatscoLogAgentClient } from '../src/utils/catsco-log-agent-client';
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

    await provider.branch({ queryText: 'deploy rollback' });
    await provider.readSkills({ search: 'release' });

    assert.equal(calls.filter(call => call.kind === 'bootstrap').length, 1);
    assert.deepEqual(calls.filter(call => call.kind === 'branch')[0], {
      kind: 'branch',
      token: 'skill-token-1',
      query: { queryText: 'deploy rollback' },
    });
    assert.deepEqual(calls.filter(call => call.kind === 'skills')[0], {
      kind: 'skills',
      token: 'skill-token-1',
      query: { search: 'release' },
    });

    const state = JSON.parse(fs.readFileSync(getCatscoLogAgentConfig(root, env).stateFilePath, 'utf8'));
    assert.equal(state.skillToken, 'skill-token-1');
    assert.equal(state.token, undefined);
  });

  test('refreshes once after a revoked capability and preserves device identity', async () => {
    const calls: Array<{ kind: string; token?: string }> = [];
    let skillsCount = 0;
    const client: Partial<CatscoLogAgentClient> = {
      bootstrap: async () => {
        const token = calls.filter(call => call.kind === 'bootstrap').length === 0
          ? 'skill-token-old'
          : 'skill-token-new';
        calls.push({ kind: 'bootstrap', token });
        return bootstrapResponse(token);
      },
      readSkills: async input => {
        skillsCount++;
        calls.push({ kind: 'skills', token: input.token });
        if (skillsCount === 1) {
          const error: any = new Error('unauthorized');
          error.status = 401;
          throw error;
        }
        return { skills: [] };
      },
    };
    const provider = new CatsLogMemoryProvider(root, {
      env,
      clientFactory: () => client as CatscoLogAgentClient,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
    });

    await provider.readSkills({ search: 'release' });

    assert.deepEqual(calls, [
      { kind: 'bootstrap', token: 'skill-token-old' },
      { kind: 'skills', token: 'skill-token-old' },
      { kind: 'bootstrap', token: 'skill-token-new' },
      { kind: 'skills', token: 'skill-token-new' },
    ]);
    const statePath = getCatscoLogAgentConfig(root, env).stateFilePath;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.deviceId, 'device-stable');
    assert.equal(state.skillToken, 'skill-token-new');
  });

  test('calls the branch route with the device token and persists branch_url', async () => {
    const calls: Array<{ kind: string; token?: string; url?: string; query?: unknown }> = [];
    const client: Partial<CatscoLogAgentClient> = {
      bootstrap: async () => ({
        ...bootstrapResponse('skill-branch'),
        branch_url: '/catsco/agent/branch',
      }),
      branch: async input => {
        calls.push({
          kind: 'branch',
          token: input.token,
          url: input.branchUrl,
          query: stripCapability(input),
        });
        return {
          schema_version: 1,
          content_trust: 'untrusted_branch_evidence',
          request_id: 'req-branch-1',
          status: 'ok',
          branches: [{ source: 'memory', status: 'ok', items: [{ source: 'session', ref: 'stream-r#1', kind: 'session_turn', score_hint: 0.5 }] }],
        };
      },
    };
    const provider = new CatsLogMemoryProvider(root, {
      env,
      clientFactory: () => client as CatscoLogAgentClient,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
    });

    const response = await provider.branch({
      queryText: 'deploy rollback',
      sources: ['memory', 'skill'],
      scopeHints: { sessionId: 's-9', tags: ['deploy'] },
      budgets: { perBranchMaxItems: 10, totalDeadlineMs: 5_000 },
    });

    assert.equal(response.status, 'ok');
    assert.equal(response.branches?.[0]?.items?.[0]?.ref, 'stream-r#1');
    assert.deepEqual(calls, [{
      kind: 'branch',
      token: 'skill-branch',
      url: '/catsco/agent/branch',
      query: {
        queryText: 'deploy rollback',
        sources: ['memory', 'skill'],
        scopeHints: { sessionId: 's-9', tags: ['deploy'] },
        budgets: { perBranchMaxItems: 10, totalDeadlineMs: 5_000 },
      },
    }]);
    const state = JSON.parse(fs.readFileSync(getCatscoLogAgentConfig(root, env).stateFilePath, 'utf8'));
    assert.equal(state.branchUrl, '/catsco/agent/branch');
  });

  test('reports branch citations through the read capability and its branch_url', async () => {
    const calls: Array<{ kind: string; token?: string; url?: string; query?: unknown }> = [];
    const client: Partial<CatscoLogAgentClient> = {
      bootstrap: async () => ({
        ...bootstrapResponse('skill-citations'),
        branch_url: '/catsco/agent/branch',
      }),
      reportBranchCitations: async (input: any) => {
        calls.push({
          kind: 'citations',
          token: input.token,
          url: input.branchUrl,
          query: stripCapability(input),
        });
      },
    };
    const provider = new CatsLogMemoryProvider(root, {
      env,
      clientFactory: () => client as CatscoLogAgentClient,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
    });

    await provider.reportBranchCitations({ requestId: 'br-1', refs: [`ref_${'a'.repeat(64)}`] });

    assert.deepEqual(calls, [{
      kind: 'citations',
      token: 'skill-citations',
      url: '/catsco/agent/branch',
      query: { requestId: 'br-1', refs: [`ref_${'a'.repeat(64)}`] },
    }]);
  });

  test('fails closed when the client lacks the branch citations route', async () => {
    const client: Partial<CatscoLogAgentClient> = {
      bootstrap: async () => bootstrapResponse('skill-no-citations'),
    };
    const provider = new CatsLogMemoryProvider(root, {
      env,
      clientFactory: () => client as CatscoLogAgentClient,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
    });

    await assert.rejects(
      provider.reportBranchCitations({ requestId: 'br-1', refs: [`ref_${'a'.repeat(64)}`] }),
      (error: any) => error instanceof CatsLogMemoryUnavailableError
        && /branch citations route/.test(error.message),
    );
  });

  test('falls back to the default branch URL when bootstrap omits branch_url', async () => {
    const calls: Array<{ url?: string }> = [];
    const client: Partial<CatscoLogAgentClient> = {
      bootstrap: async () => bootstrapResponse('skill-branch-default'),
      branch: async input => {
        calls.push({ url: input.branchUrl });
        return { status: 'ok', branches: [] };
      },
    };
    const provider = new CatsLogMemoryProvider(root, {
      env,
      clientFactory: () => client as CatscoLogAgentClient,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
    });

    await provider.branch({ queryText: 'anything' });
    assert.deepEqual(calls, [{ url: '/catsco/agent/branch' }]);
  });

  test('exposes the device-bound session query on the sessions_url capability', async () => {
    const calls: Array<{ kind: string; token?: string; url?: string; query?: unknown }> = [];
    const client: Partial<CatscoLogAgentClient> = {
      bootstrap: async () => ({
        ...bootstrapResponse('skill-sessions'),
        sessions_url: '/catsco/agent/query/v1/sessions',
      }),
      querySessions: async input => {
        calls.push({
          kind: 'sessions',
          token: input.token,
          url: input.sessionsUrl,
          query: stripCapability(input),
        });
        return { records: [] };
      },
    };
    const provider = new CatsLogMemoryProvider(root, {
      env,
      clientFactory: () => client as CatscoLogAgentClient,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
    });

    await provider.querySessions({ searchAny: ['rollback', 'nginx'], latest: true, limit: 20 });

    assert.deepEqual(calls, [{
      kind: 'sessions',
      token: 'skill-sessions',
      url: '/catsco/agent/query/v1/sessions',
      query: { searchAny: ['rollback', 'nginx'], latest: true, limit: 20 },
    }]);
    // Scope isolation by construction: the device read token is used (never
    // the upload token) and no UID selector exists on the wire type.
    assert.equal(calls[0].token, 'skill-sessions');
    assert.notEqual(calls[0].token, 'upload-token-must-not-be-used-for-memory');
    const query = calls[0].query as Record<string, unknown>;
    assert.equal('uid' in query, false);
    assert.equal('uids' in query, false);
    const state = JSON.parse(fs.readFileSync(getCatscoLogAgentConfig(root, env).stateFilePath, 'utf8'));
    assert.equal(state.sessionsUrl, '/catsco/agent/query/v1/sessions');
  });

  test('falls back to the default sessions URL when bootstrap omits sessions_url', async () => {
    const calls: Array<{ url?: string }> = [];
    const client: Partial<CatscoLogAgentClient> = {
      bootstrap: async () => bootstrapResponse('skill-sessions-default'),
      querySessions: async input => {
        calls.push({ url: input.sessionsUrl });
        return { records: [] };
      },
    };
    const provider = new CatsLogMemoryProvider(root, {
      env,
      clientFactory: () => client as CatscoLogAgentClient,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
    });

    await provider.querySessions({ searchAny: ['anything'] });
    assert.deepEqual(calls, [{ url: '/catsco/agent/query/v1/sessions' }]);
  });

  test('fails closed when neither a capability nor a CatsCompany token exists', async () => {
    const noAuthEnv = { ...env };
    delete noAuthEnv.CATSCO_USER_TOKEN;
    const provider = new CatsLogMemoryProvider(root, { env: noAuthEnv });
    await assert.rejects(
      provider.branch({ queryText: 'anything' }),
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

    await provider.branch({ queryText: 'anything' });
    assert.equal(provider.isAvailable(), true);

    createCatsCoLocalConfigService({ runtimeRoot: root, env }).clearAccount();
    assert.equal(provider.isAvailable(), false);
    const state = JSON.parse(fs.readFileSync(getCatscoLogAgentConfig(root, env).stateFilePath, 'utf8'));
    assert.equal(state.skillToken, undefined);
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
    await provider.branch({ queryText: 'anything' });

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

  test('keeps Skill outcome opt-in on the provider, independent of branch exposure', () => {
    const gated = new CatsLogMemoryProvider(root, { env });
    assert.equal(gated.supportsSkillOutcomes(), false);

    const explicit = new CatsLogMemoryProvider(root, {
      env,
      allowSkillOutcomeWrites: true,
    });
    assert.equal(explicit.supportsSkillOutcomes(), true);

    const envGated = new CatsLogMemoryProvider(root, {
      env: { ...env, CATSLOG_SKILL_OUTCOMES_ENABLED: 'true' },
    });
    assert.equal(envGated.supportsSkillOutcomes(), true);
  });

  test('passes explicit outcome receipts through and fails closed without one', async () => {
    const calls: Array<{ kind: string; token?: string; query?: unknown }> = [];
    const client: Partial<CatscoLogAgentClient> = {
      bootstrap: async () => bootstrapResponse('skill-outcome'),
      reportSkillOutcome: async input => {
        calls.push({ kind: 'outcome', token: input.token, query: stripCapability(input) });
      },
    };
    const provider = new CatsLogMemoryProvider(root, {
      env: { ...env, CATSLOG_SKILL_OUTCOMES_ENABLED: 'true' },
      clientFactory: () => client as CatscoLogAgentClient,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
    });

    await provider.reportSkillOutcome({
      handle: 'release-playbook', revision: 3, outcome: 'succeeded',
      retrievalReceipt: 'receipt-1', requireReceipt: true,
    });
    assert.equal(calls[0].token, 'skill-outcome');
    assert.equal((calls[0].query as any).retrievalReceipt, 'receipt-1');

    // Legacy no-receipt v1 signal stays available without attribution.
    await provider.reportSkillOutcome({
      handle: 'release-playbook', revision: 3, outcome: 'failed',
    });
    assert.equal((calls[1].query as any).retrievalReceipt, undefined);

    await assert.rejects(
      provider.reportSkillOutcome({
        handle: 'release-playbook', revision: 3, outcome: 'succeeded',
        routeId: 'branch-route', requireReceipt: true,
      }),
      /explicit retrieval receipt/,
    );
    await assert.rejects(
      provider.reportSkillOutcome({
        handle: 'release-playbook', revision: 3, outcome: 'succeeded',
        feedback: { code: 'outdated' },
      }),
      /explicit retrieval receipt/,
    );
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
    branch: async input => {
      calls.push({ kind: 'branch', token: input.token, query: stripCapability(input) });
      return { status: 'ok', branches: [] };
    },
    readSkills: async input => {
      calls.push({ kind: 'skills', token: input.token, query: stripCapability(input) });
      return { skills: [] };
    },
  };
  return client as CatscoLogAgentClient;
}

function stripCapability(input: Record<string, unknown> & { token?: string; skillsUrl?: string; sessionsUrl?: string; branchUrl?: string }): unknown {
  const clone = { ...input };
  delete clone.token;
  delete clone.skillsUrl;
  delete clone.sessionsUrl;
  delete clone.branchUrl;
  delete clone.signal;
  delete clone.requireReceipt;
  return clone;
}
