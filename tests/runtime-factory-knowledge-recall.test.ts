import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RuntimeFactory } from '../src/runtime/runtime-factory';
import { resolveDefaultRuntimeProfile } from '../src/runtime/runtime-profile';
import { CatsLogKnowledgeRecallTool } from '../src/tools/catslog-knowledge-recall-tool';
import type { ToolExecutionContext } from '../src/types/tool';

/**
 * Actual RuntimeFactory lifecycle test: with the memory-search branch DISABLED
 * and the device LOGGED OUT, the default tool profile still yields a
 * registered `catslog_knowledge_recall` tool backed by a lazy provider. The
 * pre-login call fails closed with a typed error and ZERO HTTP requests; a
 * later login (persisted device capability) is observed on the SAME services
 * without rebuilding the runtime, and the next call succeeds.
 */

describe('RuntimeFactory knowledge recall lifecycle', () => {
  const originalFetch = globalThis.fetch;
  let root: string;
  let envSnapshot: Record<string, string | undefined>;
  let httpCalls: number;

  const stateFile = () => path.join(root, 'data', 'catsco-log-agent-state.json');

  function liveState(token: string) {
    return {
      schemaVersion: 1,
      deviceId: 'device-1',
      skillTokenId: 'cap-1',
      skillToken: token,
      skillTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      uploaded: {},
    };
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-factory-recall-'));
    envSnapshot = {
      XIAOBA_USER_DATA_DIR: process.env.XIAOBA_USER_DATA_DIR,
      CATSCO_LOG_API_BASE_URL: process.env.CATSCO_LOG_API_BASE_URL,
      XIAOBA_RUNTIME_SURFACE: process.env.XIAOBA_RUNTIME_SURFACE,
      CURRENT_PLATFORM: process.env.CURRENT_PLATFORM,
      CATSLOG_MEMORY_ENABLED: process.env.CATSLOG_MEMORY_ENABLED,
      CATSLOG_KNOWLEDGE_RECALL_ENABLED: process.env.CATSLOG_KNOWLEDGE_RECALL_ENABLED,
      XIAOBA_ROLE: process.env.XIAOBA_ROLE,
    };
    process.env.XIAOBA_USER_DATA_DIR = root;
    process.env.CATSCO_LOG_API_BASE_URL = 'https://logs.example.test';
    process.env.XIAOBA_RUNTIME_SURFACE = 'cli';
    // Branch explicitly disabled; recall switch untouched (default on).
    process.env.CATSLOG_MEMORY_ENABLED = 'false';
    delete process.env.XIAOBA_ROLE;
    httpCalls = 0;
    globalThis.fetch = (async (url: any) => {
      httpCalls += 1;
      const urlText = String(url);
      if (urlText.endsWith('/catsco/agent/knowledge/search')) {
        return new Response(JSON.stringify({ hits: [], exhausted: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'unexpected_route' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  function context(): ToolExecutionContext {
    return {
      workingDirectory: root,
      workspaceRoot: root,
      surface: 'cli',
      permissionProfile: 'default',
      conversationHistory: [],
    } as ToolExecutionContext;
  }

  test('branch disabled + logged out: tool registered, call fails closed with no HTTP; login on same services then succeeds', async () => {
    const profile = resolveDefaultRuntimeProfile({ env: process.env, workingDirectory: root });
    // Branch switch is off and no auth exists — the provider must STILL be
    // constructed because the tool profile allows the recall tool.
    const services = RuntimeFactory.createServicesSync(profile);
    assert.equal(services.memoryBranch.enabled, false);
    assert.ok(services.catslogMemory, 'provider must exist while logged out (lazy lifetime)');

    const tool = services.toolManager.getTool('catslog_knowledge_recall');
    assert.ok(tool, 'recall tool must be registered from the default allowlist');
    assert.ok(tool instanceof CatsLogKnowledgeRecallTool);

    // Pre-login call: typed unavailable, and NOT A SINGLE HTTP request may
    // fire (no accidental knowledge requests while disabled/unauthenticated).
    const before = await tool.execute({ action: 'search', query: 'sparse attention' }, context());
    assert.equal(before.ok, false);
    assert.equal(before.errorCode, 'CATSLOG_MEMORY_UNAVAILABLE');
    assert.equal(httpCalls, 0);

    // Later login: persist a live device capability (no runtime rebuild).
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(liveState('logged-in-skill-token')));

    const after = await tool.execute({ action: 'search', query: 'sparse attention' }, context());
    assert.equal(after.ok, true, `expected success after login, got: ${String(after.message ?? after.content).slice(0, 200)}`);
    const parsed = JSON.parse(String(after.content));
    assert.equal(parsed.exhausted, true);
    assert.equal(httpCalls, 1);
  });

  test('recall kill switch and inspector-cat role fail closed per call — still no HTTP', async () => {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(liveState('token')));
    const profile = resolveDefaultRuntimeProfile({ env: process.env, workingDirectory: root });
    const services = RuntimeFactory.createServicesSync(profile);
    const tool = services.toolManager.getTool('catslog_knowledge_recall');
    assert.ok(tool);

    // Kill switch flips AFTER construction: per-call availability check must
    // honor it (same env object is captured by the provider).
    process.env.CATSLOG_KNOWLEDGE_RECALL_ENABLED = '0';
    const killed = await tool.execute({ action: 'search', query: 'q' }, context());
    assert.equal(killed.ok, false);
    assert.equal(killed.errorCode, 'CATSLOG_MEMORY_UNAVAILABLE');
    assert.equal(httpCalls, 0);
    delete process.env.CATSLOG_KNOWLEDGE_RECALL_ENABLED;

    // Role kill switch likewise honored per call.
    process.env.XIAOBA_ROLE = 'inspector-cat';
    const restricted = await tool.execute({ action: 'search', query: 'q' }, context());
    assert.equal(restricted.ok, false);
    assert.equal(restricted.errorCode, 'CATSLOG_MEMORY_UNAVAILABLE');
    assert.equal(httpCalls, 0);
    delete process.env.XIAOBA_ROLE;
  });
});
