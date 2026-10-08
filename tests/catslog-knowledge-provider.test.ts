import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CatsLogMemoryProvider,
  CatsLogMemoryUnavailableError,
} from '../src/utils/catslog-memory-provider';

/**
 * Focused provider tests for the optional daily-knowledge recall surface:
 * availability independent of the automatic branch switch, capability
 * bootstrap + 401 refresh + revocation, partial server failures, abort, and
 * token/scope secrecy in every error path.
 */

describe('CatsLogMemoryProvider knowledge recall', () => {
  const originalFetch = globalThis.fetch;
  let root: string;
  let env: NodeJS.ProcessEnv;
  let bootstrapCalls: number;

  const liveState = {
    schemaVersion: 1,
    deviceId: 'device-1',
    skillTokenId: 'cap-1',
    skillToken: 'state-skill-token',
    skillTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    uploaded: {},
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-knowledge-provider-'));
    bootstrapCalls = 0;
    env = {
      CATSCO_LOG_API_BASE_URL: 'https://logs.example.test',
      DOTENV_CONFIG_PATH: path.join(root, 'missing.env'),
      XIAOBA_USER_DATA_DIR: root,
    };
    globalThis.fetch = (async (url: any, init: any) => {
      const urlText = String(url);
      if (urlText.endsWith('/catsco/agent/bootstrap')) {
        bootstrapCalls += 1;
        return new Response(JSON.stringify({
          user_id: 'u-1',
          device_id: 'device-1',
          token_id: 'up-1',
          token: 'upload-token',
          skill_token_id: 'cap-1',
          skill_token: 'fresh-skill-token',
          skill_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          issued_at: new Date().toISOString(),
          upload_url: '/catsco/logs/upload',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function statePath(): string {
    return path.join(root, 'data', 'catsco-log-agent-state.json');
  }

  function writeState(state: unknown): void {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state));
  }

  function provider(): CatsLogMemoryProvider {
    return new CatsLogMemoryProvider(root, { env });
  }

  test('knowledge capability URLs survive provider restart', async () => {
    writeState(liveState);
    globalThis.fetch = (async (url: any) => {
      assert.equal(String(url), 'https://logs.example.test/custom/knowledge/search');
      return new Response(JSON.stringify({ hits: [], exhausted: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as any;
    writeState({ ...liveState, knowledgeSearchUrl: '/custom/knowledge/search',
      knowledgeReadUrl: '/custom/knowledge/read', knowledgeExpandUrl: '/custom/knowledge/expand' });
    await provider().searchKnowledge({ query: 'restart' });
    await provider().searchKnowledge({ query: 'restart again' });
    assert.equal(bootstrapCalls, 0);
  });

  test('recall availability is independent of the automatic branch switch', () => {
    writeState(liveState);
    // Branch explicitly disabled…
    const branchDisabled = { ...env, CATSLOG_MEMORY_ENABLED: 'false' };
    assert.equal(CatsLogMemoryProvider.shouldExpose(root, branchDisabled), false);
    // …but recall stays available: it never depended on the branch switch.
    assert.equal(CatsLogMemoryProvider.shouldExposeKnowledgeRecall(root, branchDisabled), true);
    // And with the branch enabled, both hold.
    assert.equal(CatsLogMemoryProvider.shouldExposeKnowledgeRecall(root, env), true);
  });

  test('recall kill switch, restricted role, corrupt state, and expired tokens fail closed', () => {
    writeState(liveState);
    assert.equal(
      CatsLogMemoryProvider.shouldExposeKnowledgeRecall(root, { ...env, CATSLOG_KNOWLEDGE_RECALL_ENABLED: '0' }),
      false,
    );
    assert.equal(
      CatsLogMemoryProvider.shouldExposeKnowledgeRecall(root, { ...env, XIAOBA_ROLE: 'inspector-cat' }),
      false,
    );
    writeState({ ...liveState, stateCorrupt: true });
    assert.equal(CatsLogMemoryProvider.shouldExposeKnowledgeRecall(root, env), false);
    writeState({ ...liveState, skillTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal(CatsLogMemoryProvider.shouldExposeKnowledgeRecall(root, env), false);
    assert.equal(provider().isKnowledgeRecallAvailable(), false);
  });

  test('search reuses a persisted capability, then refreshes once on 401', async () => {
    writeState(liveState);
    const p = provider();
    let searchCalls = 0;
    const responses: Array<{ status: number; body: string }> = [
      { status: 401, body: JSON.stringify({ error: 'unauthorized' }) },
      {
        status: 200,
        body: JSON.stringify({ hits: [], next_cursor: '', exhausted: true }),
      },
    ];
    globalThis.fetch = (async (url: any, init: any) => {
      const urlText = String(url);
      if (urlText.endsWith('/catsco/agent/bootstrap')) {
        bootstrapCalls += 1;
        assert.equal(init.headers.Authorization, 'Bearer bootstrap-user-token');
        return new Response(JSON.stringify({
          user_id: 'u-1',
          device_id: 'device-1',
          token_id: 'up-1',
          token: 'upload-token',
          skill_token_id: 'cap-2',
          skill_token: 'refreshed-skill-token',
          skill_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          issued_at: new Date().toISOString(),
          upload_url: '/catsco/logs/upload',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const next = responses[searchCalls];
      searchCalls += 1;
      // The wire must carry the CURRENT capability token; after the 401 the
      // retried call must carry the refreshed one.
      if (searchCalls === 1) assert.equal((init.headers as any).Authorization, 'Bearer state-skill-token');
      if (searchCalls === 2) assert.equal((init.headers as any).Authorization, 'Bearer refreshed-skill-token');
      return new Response(next.body, { status: next.status, headers: { 'content-type': 'application/json' } });
    }) as any;
    env.CATSCO_USER_TOKEN = 'bootstrap-user-token';

    const page = await p.searchKnowledge({ query: 'sparse attention', limit: 10 });
    assert.equal(page.exhausted, true);
    assert.equal(searchCalls, 2);
    assert.equal(bootstrapCalls, 1);
    // Refreshed capability is persisted for later calls.
    const persisted = JSON.parse(fs.readFileSync(statePath(), 'utf-8'));
    assert.equal(persisted.skillToken, 'refreshed-skill-token');
  });

  test('unavailable capability is a typed error, never a fake-empty page', async () => {
    // No state, no user token: bootstrap cannot even run.
    await assert.rejects(
      () => provider().searchKnowledge({ query: 'x' }),
      (error: any) => {
        assert.equal(error.code, 'CATSLOG_MEMORY_UNAVAILABLE');
        assert.ok(error instanceof CatsLogMemoryUnavailableError);
        return true;
      },
    );
  });

  test('server failures surface status/detail without leaking the capability token', async () => {
    writeState(liveState);
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: 'knowledge_unavailable' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )) as any;
    try {
      await provider().expandKnowledge({
        anchor: { kind: 'knowledge_entry', id: 'ake-1', document_id: 'akd-1' },
      });
      assert.fail('expected rejection');
    } catch (error: any) {
      assert.equal(error.status, 503);
      assert.match(error.message, /knowledge_unavailable/);
      assert.ok(!error.message.includes('state-skill-token'));
    }
  });

  test('read okf passes the raw body through; abort cancels the call', async () => {
    writeState(liveState);
    let aborted = false;
    globalThis.fetch = (async (url: any, init: any) => {
      init.signal.addEventListener('abort', () => { aborted = true; });
      return new Response('# OKF body\n', {
        status: 200,
        headers: { 'content-type': 'text/markdown' },
      });
    }) as any;
    const controller = new AbortController();
    const result = await provider().readKnowledge({
      document_id: 'akd-1',
      format: 'okf',
    }, controller.signal);
    assert.equal(result.format, 'okf');
    assert.equal(result.format === 'okf' && result.body, '# OKF body\n');
    assert.equal(aborted, false);

    const cancelled = new AbortController();
    cancelled.abort();
    globalThis.fetch = (async () => {
      throw new DOMException('This operation was aborted', 'AbortError');
    }) as any;
    await assert.rejects(
      () => provider().readKnowledge({ document_id: 'akd-1', format: 'okf' }, cancelled.signal),
      /abort/i,
    );
  });

  test('partial capability responses keep knowledge routes on stable defaults', async () => {
    writeState(liveState);
    // The bootstrap response carries no knowledge_*_url overrides; the client
    // must fall back to the stable route constants, never an arbitrary URL.
    let searchUrl = '';
    globalThis.fetch = (async (url: any) => {
      const urlText = String(url);
      if (urlText.endsWith('/bootstrap')) {
        return new Response(JSON.stringify({
          user_id: 'u-1', device_id: 'device-1', token: 'upload-token',
          skill_token: 'fresh', skill_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          issued_at: new Date().toISOString(), upload_url: '/catsco/logs/upload',
          knowledge_search_url: '/catsco/../evil',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      searchUrl = urlText;
      return new Response(JSON.stringify({ hits: [], exhausted: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as any;
    env.CATSCO_USER_TOKEN = 'bootstrap-user-token';
    await provider().searchKnowledge({ query: 'x' });
    assert.equal(searchUrl, 'https://logs.example.test/catsco/agent/knowledge/search');
  });
});
