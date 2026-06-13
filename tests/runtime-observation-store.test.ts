import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import {
  RUNTIME_OBSERVATIONS_PREFIX,
  RuntimeObservationStore,
  renderRuntimeObservations,
} from '../src/core/runtime-observation-store';
import { TurnContextBuilder } from '../src/core/turn-context-builder';

const require = createRequire(import.meta.url);

test('runtime observation store filters ready observations by status and expiry', () => {
  const store = new RuntimeObservationStore({ now: () => 1_000 });

  store.upsert({
    id: 'ready',
    sessionId: 'session-a',
    source: 'web_search',
    title: 'Fresh result',
    summary: 'Ready to inject',
    expiresAt: 2_000,
  });
  store.upsert({
    id: 'expired',
    sessionId: 'session-a',
    source: 'review',
    title: 'Old result',
    summary: 'Expired already',
    expiresAt: 999,
  });
  store.upsert({
    id: 'pending',
    sessionId: 'session-a',
    source: 'memory_graph',
    status: 'pending',
    title: 'Pending result',
    summary: 'Not ready yet',
  });
  store.upsert({
    id: 'other-session',
    sessionId: 'session-b',
    source: 'web_search',
    title: 'Other session',
    summary: 'Should not leak',
  });

  assert.deepEqual(store.listReady({ sessionId: 'session-a' }).map(item => item.id), ['ready']);
});

test('runtime observation picker sorts, dedupes, and respects prompt budget', () => {
  const store = new RuntimeObservationStore({ now: () => 1_000 });

  store.upsert({
    id: 'too-large',
    sessionId: 'session-a',
    source: 'review',
    title: 'Large review',
    summary: 'Large review summary',
    priority: 100,
    tokenEstimate: 10,
  });
  store.upsert({
    id: 'best',
    sessionId: 'session-a',
    source: 'web_search',
    title: 'Best result',
    summary: 'Best result summary',
    priority: 90,
    relevance: 0.9,
    tokenEstimate: 2,
  });
  store.upsert({
    id: 'duplicate-lower',
    sessionId: 'session-a',
    source: 'web_search',
    title: 'Duplicate lower',
    summary: 'Same fact',
    priority: 80,
    tokenEstimate: 1,
    hash: 'same-hash',
  });
  store.upsert({
    id: 'duplicate-higher',
    sessionId: 'session-a',
    source: 'web_search',
    title: 'Duplicate higher',
    summary: 'Same fact with better rank',
    priority: 85,
    tokenEstimate: 1,
    hash: 'same-hash',
  });
  store.upsert({
    id: 'never-auto',
    sessionId: 'session-a',
    source: 'memory_graph',
    title: 'Hidden memory',
    summary: 'Policy says do not inject',
    priority: 95,
    tokenEstimate: 1,
    policy: { injectMode: 'never_auto' },
  });

  const picked = store.pickForPrompt({
    sessionId: 'session-a',
    tokenBudget: 4,
    maxItems: 3,
  });

  assert.deepEqual(picked.map(item => item.id), ['best', 'duplicate-higher']);
});

test('runtime observation renderer returns one injected user message', () => {
  const store = new RuntimeObservationStore({ now: () => 1_000 });
  const observation = store.upsert({
    id: 'search-1',
    sessionId: 'session-a',
    source: 'web_search',
    title: 'Search result',
    summary: 'MiniMax cache is sensitive to dynamic system content.',
    citations: [{ title: 'Experiment log', url: 'https://example.test/log' }],
  });

  const message = renderRuntimeObservations([observation]);

  assert.ok(message);
  assert.equal(message.role, 'user');
  assert.equal(message.__injected, true);
  assert.equal(message.__runtimeObservation, true);
  assert.equal(message.runtimeObservationSource, 'runtime_observations');
  assert.equal(typeof message.content, 'string');
  assert.equal(message.content.startsWith(RUNTIME_OBSERVATIONS_PREFIX), true);
  assert.match(message.content, /不是用户的新请求/);
  assert.match(message.content, /\[web_search:search-1\]/);
  assert.match(message.content, /Experiment log <https:\/\/example\.test\/log>/);
});

test('runtime observation lifecycle supports one-shot and until-consumed injections', () => {
  const store = new RuntimeObservationStore({ now: () => 1_000 });

  store.upsert({
    id: 'once',
    sessionId: 'session-a',
    source: 'review',
    title: 'One shot',
    summary: 'Inject once',
    tokenEstimate: 1,
  });
  store.upsert({
    id: 'sticky',
    sessionId: 'session-a',
    source: 'memory_graph',
    title: 'Sticky',
    summary: 'Keep injecting until consumed',
    tokenEstimate: 1,
    policy: { injectMode: 'summary_until_consumed' },
  });

  assert.deepEqual(
    store.pickForPrompt({ sessionId: 'session-a' }).map(item => item.id),
    ['once', 'sticky'],
  );

  store.markInjected(['once', 'sticky'], 'turn-2');
  assert.equal(store.get('once')?.status, 'injected');
  assert.equal(store.get('sticky')?.injectedAtTurn, 'turn-2');
  assert.deepEqual(
    store.pickForPrompt({ sessionId: 'session-a' }).map(item => item.id),
    ['sticky'],
  );

  store.markConsumed(['sticky'], 'turn-3');
  assert.equal(store.get('sticky')?.status, 'consumed');
  assert.equal(store.get('sticky')?.consumedAtTurn, 'turn-3');
  assert.deepEqual(store.pickForPrompt({ sessionId: 'session-a' }), []);
});

test('turn context injects queued runtime observations before the latest user message', async () => {
  const store = new RuntimeObservationStore({ now: () => 1_000 });
  store.upsert({
    id: 'queued-web',
    sessionId: 'session-a',
    source: 'web_search',
    title: 'Fresh web result',
    summary: 'The background search found a relevant release note.',
    tokenEstimate: 3,
  });

  const builder = new TurnContextBuilder();
  const result = await builder.build({
    sessionKey: 'session-a',
    durableMessages: [
      { role: 'system', content: 'base system' },
      { role: 'user', content: 'real question' },
    ],
    runtimeFeedback: [],
    skillRuntime: createNoopSkillRuntime(),
    runtimeObservationStore: store,
  });

  const observationIndex = result.messages.findIndex(message =>
    typeof message.content === 'string'
    && message.content.startsWith(RUNTIME_OBSERVATIONS_PREFIX)
  );
  const userIndex = result.messages.findIndex(message =>
    message.role === 'user' && message.content === 'real question'
  );

  assert.deepEqual(result.runtimeObservationIdsForPrompt, ['queued-web']);
  assert.ok(observationIndex >= 0, 'runtime observation should be injected');
  assert.ok(observationIndex < userIndex, 'runtime observation should appear before latest user');
  assert.equal(result.messages[observationIndex].role, 'user');
  assert.equal(result.messages[observationIndex].__injected, true);
  assert.equal(result.messages[observationIndex].__runtimeObservation, true);
  assert.equal(store.get('queued-web')?.status, 'ready', 'builder should not mark sent observations');

  const durable = builder.removeTransientMessages(result.messages);
  assert.equal(durable.some(message =>
    typeof message.content === 'string'
    && message.content.startsWith(RUNTIME_OBSERVATIONS_PREFIX)
  ), false);
  assert.equal(durable.some(message => message.role === 'user' && message.content === 'real question'), true);
});

test('AgentSession sends queued runtime observations once and keeps durable history clean', async () => {
  const originalCwd = process.cwd();
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-observation-store-'));
  process.chdir(testRoot);

  try {
    const { AgentSession } = loadAgentSessionModules();
    const capturedRequests: any[][] = [];
    const session = new AgentSession('user:runtime-observation-store-demo', buildMockServices({
      aiService: {
        async chatStream(messages: any[]) {
          capturedRequests.push(messages.map(message => ({ ...message })));
          return {
            content: 'done',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
      },
    }), 'chat');
    session.setSystemPromptProvider(() => 'system prompt');

    const queued = session.upsertRuntimeObservation({
      id: 'queued-review',
      source: 'review',
      title: 'Background review',
      summary: 'The async reviewer found one cache-sensitive prompt insertion.',
      tokenEstimate: 4,
    });
    assert.equal(queued.status, 'ready');

    await session.handleMessage('real question');

    assert.equal(capturedRequests.length, 1);
    const requestMessages = capturedRequests[0];
    const observationIndex = requestMessages.findIndex(message =>
      typeof message.content === 'string'
      && message.content.startsWith(RUNTIME_OBSERVATIONS_PREFIX)
    );
    const userIndex = requestMessages.findIndex(message =>
      message.role === 'user' && message.content === 'real question'
    );

    assert.ok(observationIndex >= 0, 'provider input should include the queued observation');
    assert.ok(observationIndex < userIndex, 'queued observation should be before the real user request');
    assert.equal(requestMessages[observationIndex].role, 'user');
    assert.equal(requestMessages[observationIndex].__injected, true);
    assert.equal(requestMessages[observationIndex].__runtimeObservation, true);
    assert.equal((session as any).runtimeObservationStore.get('queued-review')?.status, 'injected');
    assert.equal((session as any).messages.some((message: any) =>
      typeof message.content === 'string'
      && message.content.startsWith(RUNTIME_OBSERVATIONS_PREFIX)
    ), false);
  } finally {
    process.chdir(originalCwd);
    await removeTempDir(testRoot);
  }
});

function createNoopSkillRuntime(): any {
  return {
    reloadSkills: async () => undefined,
    buildSkillsListMessage: () => null,
  };
}

function loadAgentSessionModules(): any {
  for (const modulePath of [
    '../src/core/agent-session',
    '../src/core/session-lifecycle-manager',
    '../src/utils/session-store',
    '../src/utils/session-turn-logger',
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
  return require('../src/core/agent-session');
}

function buildMockServices(overrides: any = {}): any {
  return {
    aiService: overrides.aiService ?? {},
    toolManager: overrides.toolManager ?? {
      getToolDefinitions() { return []; },
      executeTool() { throw new Error('not expected'); },
      getWorkspaceRoot() { return process.cwd(); },
    },
    skillManager: {
      getSkill() { return undefined; },
      getUserInvocableSkills() { return []; },
      getAutoInvocableSkills() { return []; },
      findAutoInvocableSkillByText() { return undefined; },
      loadSkills: async () => {},
    },
  };
}

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (error?.code !== 'EBUSY' && error?.code !== 'EPERM') {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
