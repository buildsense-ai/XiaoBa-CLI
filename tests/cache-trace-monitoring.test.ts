import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import express, { Router } from 'express';
import type { Server } from 'http';
import { ConversationRunner } from '../src/core/conversation-runner';
import { CacheTraceObserver, isCacheTraceEnabledForSession } from '../src/observability/cache-trace';
import { readCacheTraceStore } from '../src/observability/cache-trace-reader';
import { registerCacheTraceRoutes } from '../src/dashboard/routes/cache-trace';
import type { ChatResponse, Message } from '../src/types';
import type {
  AIRequestOptions,
  ModelAttemptEvent,
  StreamCallbacks,
} from '../src/providers/provider';
import type { ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/types/tool';

class EmptyTools implements ToolExecutor {
  getToolDefinitions(): ToolDefinition[] { return []; }
  async executeTool(_call: ToolCall): Promise<ToolResult> { throw new Error('not used'); }
}

function oneReplyAI(onOptions?: (options?: AIRequestOptions) => void) {
  return {
    getConfig: () => ({ provider: 'openai', model: 'gpt-test', openaiApiMode: 'responses', contextWindowTokens: 32000 }),
    isToolCallingSupported: () => true,
    async chatStream(
      _messages: Message[],
      _tools: ToolDefinition[],
      _callbacks?: StreamCallbacks,
      options?: AIRequestOptions,
    ): Promise<ChatResponse> {
      onOptions?.(options);
      return { content: 'normal reply', toolCalls: [], usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedReadTokens: 4 } };
    },
  };
}

test('ConversationRunner forwards attempt observation with session and episode context', async () => {
  let captured: AIRequestOptions | undefined;
  const sink = { observe: () => undefined };
  const runner = new ConversationRunner(oneReplyAI(options => { captured = options; }) as any, new EmptyTools(), {
    enableCompression: false,
    episodeId: 'episode-1',
    toolExecutionContext: { sessionId: 'session-1', surface: 'cli' },
    cacheTraceSink: sink,
  });

  const result = await runner.run([{ role: 'user', content: 'hello' }]);

  assert.equal(result.response, 'normal reply');
  assert.equal(captured?.modelAttemptSink, sink);
  assert.deepEqual(captured?.modelAttemptContext, {
    sessionId: 'session-1',
    surface: 'cli',
    episodeId: 'episode-1',
    episodeNumber: 1,
  });
});

test('observer consumes an asynchronous writer rejection', async () => {
  let errors = 0;
  const observer = new CacheTraceObserver({
    sessionId: 'cache:test',
    env: { XIAOBA_CACHE_TRACE: 'true' },
    writeEntry: async () => { throw new Error('ENOSPC'); },
    onError: () => { errors++; },
  });
  observer.observe(attemptEvent({ outcome: 'started' }));
  await observer.drain();
  assert.equal(errors, 1);
});

test('session allow-list enables only the selected session', () => {
  const env = { XIAOBA_CACHE_TRACE: 'true', XIAOBA_CACHE_TRACE_SESSIONS: 'one,two' };
  assert.equal(isCacheTraceEnabledForSession('one', env), true);
  assert.equal(isCacheTraceEnabledForSession('three', env), false);
  assert.equal(new CacheTraceObserver({ sessionId: 'two', env }).enabled, true);
});

test('reader accepts legacy JSON and v4 JSONL while resetting diff on a model switch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-reader-'));
  try {
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({
      schema: 'xiaoba.cache_trace.v2',
      session: { session_id: 'session-a', session_type: 'agent', surface: 'cli' },
      turn: { turn_number: 1, run_id: 'old-run' },
      request: { timestamp: '2026-08-01T01:00:00.000Z', provider: 'openai', model: 'old-model', api_type: 'openai-chat-completions', request_sha256: 'a', message_sha256s: ['m1'] },
      response_usage: { input_tokens: 100, cache_read_tokens: 20, output_tokens: 10 },
    }));
    fs.writeFileSync(path.join(dir, 'new.jsonl'), [
      cacheTraceLine({
        outcome: 'started',
        attemptId: 'new-run:1',
        callId: 'new-run',
        provider: 'anthropic',
        model: 'new-model',
        apiType: 'anthropic-messages',
        timestamp: '2026-08-01T01:01:00.000Z',
      }),
      cacheTraceLine({
        outcome: 'succeeded',
        attemptId: 'new-run:1',
        callId: 'new-run',
        provider: 'anthropic',
        model: 'new-model',
        apiType: 'anthropic-messages',
        timestamp: '2026-08-01T01:01:01.000Z',
        usage: { input_tokens: 200, cache_read_tokens: 100, cache_write_tokens: 10, output_tokens: 20 },
      }),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');

    const store = await readCacheTraceStore(dir);
    assert.equal(store.scannedFiles, 3);
    assert.equal(store.malformedFiles, 1);
    assert.equal(store.records.length, 2);
    assert.equal(store.records[0].runId, 'old-run');
    assert.equal(store.records[1].outcome, 'succeeded');
    assert.equal(store.records[1].hasStarted, true);
    assert.equal(store.records[1].diff.baselineReset, true);
    assert.equal(store.records[1].diff.resetReason, 'provider-model-api-changed');
    assert.equal(store.sessions[0].weightedHitRatio, 0.4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('observer writes retry recovery as two correlated attempts and preserves cache usage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-write-'));
  try {
    const observer = new CacheTraceObserver({
      sessionId: 'cache:write',
      traceDir: dir,
      env: { XIAOBA_CACHE_TRACE: 'true' },
    });
    observer.observe(attemptEvent({ outcome: 'started', attemptNumber: 1, attemptId: 'call-1:1' }));
    observer.observe(attemptEvent({
      outcome: 'retrying',
      attemptNumber: 1,
      attemptId: 'call-1:1',
      error: Object.assign(new Error('temporary 503'), { response: { status: 503 } }),
      retry: { retryNumber: 1, maxRetries: 2, elapsedMs: 5, maxElapsedMs: 1000, delayMs: 10 },
    }));
    observer.observe(attemptEvent({ outcome: 'started', attemptNumber: 2, attemptId: 'call-1:2' }));
    observer.observe(attemptEvent({
      outcome: 'succeeded',
      attemptNumber: 2,
      attemptId: 'call-1:2',
      response: { content: 'ok', usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11, cachedReadTokens: 4 } },
    }));
    await observer.drain();

    const files = listTraceFiles(dir);
    assert.equal(files.length, 2);
    assert.equal(fs.readFileSync(files[0], 'utf8').trim().split(/\r?\n/).length, 2);
    const store = await readCacheTraceStore(dir);
    assert.deepEqual(store.records.map(record => record.outcome), ['retrying', 'succeeded']);
    assert.equal(store.records[0].httpStatus, 503);
    assert.equal(store.records[1].usage.cacheReadTokens, 4);
    assert.equal(store.sessions[0].calls, 1);
    assert.equal(store.sessions[0].retriedCalls, 1);
    assert.equal(store.sessions[0].recoveredCalls, 1);
    assert.equal(store.sessions[0].terminalFailedCalls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a started-only trace stays visible as incomplete and failure details are redacted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-incomplete-'));
  try {
    const observer = new CacheTraceObserver({
      sessionId: 'cache:incomplete',
      traceDir: dir,
      env: { XIAOBA_CACHE_TRACE: 'true' },
    });
    observer.observe(attemptEvent({ outcome: 'started', callId: 'unfinished', attemptId: 'unfinished:1' }));
    observer.observe(attemptEvent({ outcome: 'started', callId: 'failed', attemptId: 'failed:1' }));
    observer.observe(attemptEvent({
      outcome: 'failed',
      callId: 'failed',
      attemptId: 'failed:1',
      error: Object.assign(new Error('Bearer secret-token at https://private.example/v1'), { response: { status: 403 } }),
      retry: { retryNumber: 0, maxRetries: 0, elapsedMs: 2, maxElapsedMs: 100, stopReason: 'non_retryable' },
    }));
    await observer.drain();

    const store = await readCacheTraceStore(dir);
    assert.deepEqual(store.records.map(record => record.outcome).sort(), ['failed', 'incomplete']);
    const failed = store.records.find(record => record.outcome === 'failed')!;
    assert.equal(failed.httpStatus, 403);
    assert.doesNotMatch(failed.errorSummary, /secret-token|private\.example/);
    assert.equal(store.sessions[0].incompleteAttempts, 1);
    assert.equal(store.sessions[0].terminalFailedCalls, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('observer stores request content only on the started line when explicitly enabled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-content-'));
  try {
    const observer = new CacheTraceObserver({
      sessionId: 'cache:content',
      traceDir: dir,
      env: { XIAOBA_CACHE_TRACE: 'true', XIAOBA_CACHE_TRACE_CONTENT: 'true' },
    });
    observer.observe(attemptEvent({ outcome: 'started' }));
    observer.observe(attemptEvent({ outcome: 'succeeded', response: { content: 'ok' } }));
    await observer.drain();
    const lines = fs.readFileSync(listTraceFiles(dir)[0], 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(lines[0].request.request_snapshot.kind, 'wire-input');
    assert.equal(lines[1].request.request_snapshot, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('observer records provider request preflight repairs without storing message content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-preflight-'));
  try {
    const observer = new CacheTraceObserver({
      sessionId: 'cache:preflight',
      traceDir: dir,
      env: { XIAOBA_CACHE_TRACE: 'true' },
    });
    observer.observe(attemptEvent({
      outcome: 'started',
      request: {
        messages: [{ role: 'user', content: 'secret content' }],
        tools: [],
        preflight: {
          repaired: true,
          issueCodes: ['missing_tool_result', 'provider_replay_mismatch'],
          droppedMessages: 1,
          droppedToolCalls: 2,
          droppedToolResults: 1,
          providerReplayFallbacks: 1,
        },
      },
    }));
    await observer.drain();

    const entry = JSON.parse(fs.readFileSync(listTraceFiles(dir)[0], 'utf8').trim());
    assert.deepEqual(entry.request.preflight, {
      repaired: true,
      issue_codes: ['missing_tool_result', 'provider_replay_mismatch'],
      dropped_messages: 1,
      dropped_tool_calls: 2,
      dropped_tool_results: 1,
      provider_replay_fallbacks: 1,
    });
    assert.equal(entry.request.request_snapshot, undefined);
    assert.doesNotMatch(JSON.stringify(entry), /secret content/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one attempt keeps one JSONL file when it crosses midnight', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-midnight-'));
  try {
    const observer = new CacheTraceObserver({
      sessionId: 'cache:midnight',
      traceDir: dir,
      env: { XIAOBA_CACHE_TRACE: 'true' },
    });
    observer.observe(attemptEvent({ outcome: 'started', timestamp: '2026-08-01T23:59:59.999Z' }));
    observer.observe(attemptEvent({ outcome: 'succeeded', timestamp: '2026-08-02T00:00:00.001Z', response: { content: 'ok' } }));
    await observer.drain();

    const files = listTraceFiles(dir);
    assert.equal(files.length, 1);
    assert.equal(fs.readFileSync(files[0], 'utf8').trim().split(/\r?\n/).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard exposes a discoverable cache trace page', () => {
  const root = path.resolve(__dirname, '..');
  const index = fs.readFileSync(path.join(root, 'dashboard', 'index.html'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'dashboard', 'cache-trace.html'), 'utf8');
  assert.match(index, /onclick="switchPage\('cache-trace'\)" data-page="cache-trace"/);
  assert.match(index, /id="page-cache-trace"/);
  assert.match(index, /id="cache-trace-frame"/);
  assert.match(index, /data-src="cache-trace\.html"/);
  assert.match(page, /缓存命中监控/);
  assert.match(page, /catsco\.dashboardApiKey/);
  assert.match(page, /采集 Cache Trace/);
  assert.match(page, /重试后恢复/);
  assert.match(page, /最终失败/);
  assert.match(page, /未完成/);
  assert.match(page, /\/api\/cache-trace\/config/);
  assert.match(page, /\/api\/cache-trace\/sessions/);
});

test('dashboard persists the cache trace switch and restarts a running connector', async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-config-'));
  const env: NodeJS.ProcessEnv = {};
  let restarts = 0;
  const serviceManager = {
    getService: () => ({ status: 'running' as const }),
    restart: () => { restarts++; return { status: 'running' as const }; },
  };
  const app = express();
  app.use(express.json());
  const router = Router();
  registerCacheTraceRoutes(router, { runtimeRoot, env, serviceManager: serviceManager as any });
  app.use('/api', router);
  const server = await listen(app);

  try {
    const before = await fetchJson(server, '/api/cache-trace/config');
    assert.equal(before.enabled, false);
    assert.equal(before.dashboardAvailable, true);

    const response = await fetchJson(server, '/api/cache-trace/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(response.enabled, true);
    assert.equal(response.connectorRestarted, true);
    assert.equal(env.XIAOBA_CACHE_TRACE, 'true');
    assert.equal(restarts, 1);
    const savedEnv = dotenv.parse(fs.readFileSync(path.join(runtimeRoot, '.env'), 'utf8'));
    assert.equal(savedEnv.XIAOBA_CACHE_TRACE, 'true');
  } finally {
    await close(server);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('cache trace switch waits for the next Agent start when the connector is stopped', async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-config-stopped-'));
  const app = express();
  app.use(express.json());
  const router = Router();
  registerCacheTraceRoutes(router, {
    runtimeRoot,
    env: {},
    serviceManager: {
      getService: () => ({ status: 'stopped' } as any),
      restart: () => { throw new Error('must not restart'); },
    },
  });
  app.use('/api', router);
  const server = await listen(app);

  try {
    const response = await fetchJson(server, '/api/cache-trace/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(response.connectorRestarted, false);
    assert.equal(response.appliesOnNextStart, true);
  } finally {
    await close(server);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

function attemptEvent(overrides: Partial<ModelAttemptEvent> = {}): ModelAttemptEvent {
  return {
    schema: 'xiaoba.model_attempt.v1',
    callId: 'call-1',
    attemptId: 'call-1:1',
    attemptNumber: 1,
    timestamp: '2026-08-01T01:00:00.000Z',
    outcome: 'started',
    provider: 'openai',
    model: 'gpt-test',
    apiType: 'openai-responses',
    stream: true,
    context: { sessionId: 'cache:write', surface: 'cli', episodeNumber: 7 },
    request: {
      messages: [{ role: 'user', content: 'secret content must not be stored' }],
      tools: [],
    },
    ...overrides,
  };
}

function cacheTraceLine(options: {
  outcome: 'started' | 'succeeded';
  callId: string;
  attemptId: string;
  provider: string;
  model: string;
  apiType: string;
  timestamp: string;
  usage?: Record<string, number>;
}): string {
  return JSON.stringify({
    schema: 'xiaoba.cache_trace.v4',
    session: { session_id: 'session-a', session_type: 'agent', surface: 'cli' },
    episode: { episode_number: 2, run_id: options.callId },
    lifecycle: {
      call_id: options.callId,
      attempt_id: options.attemptId,
      attempt_number: 1,
      outcome: options.outcome,
      event_timestamp: options.timestamp,
    },
    request: {
      timestamp: options.timestamp,
      provider: options.provider,
      model: options.model,
      api_type: options.apiType,
      request_sha256: 'b',
      message_sha256s: ['m2'],
      system_prompt: { stable_sha256: 'system-2' },
    },
    ...(options.outcome === 'succeeded' ? { response_usage: options.usage } : {}),
  });
}

function listTraceFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(root, entry.name);
    return entry.isDirectory()
      ? listTraceFiles(full)
      : entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) ? [full] : [];
  });
}

function listen(app: express.Express): Promise<Server> {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function fetchJson(server: Server, pathname: string, init?: RequestInit): Promise<any> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, init);
  assert.equal(response.status, 200);
  return response.json();
}
