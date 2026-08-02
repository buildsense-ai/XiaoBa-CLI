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
  assert.equal(captured?.cachePartitionKey, 'session-1');
  assert.deepEqual(captured?.modelAttemptContext, {
    sessionId: 'session-1',
    surface: 'cli',
    episodeId: 'episode-1',
    episodeNumber: 1,
  });
});

test('observer records the exact OpenAI cache policy without exposing its routing key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-policy-'));
  try {
    const observer = new CacheTraceObserver({
      sessionId: 'cache:policy',
      traceDir: dir,
      env: { XIAOBA_CACHE_TRACE: 'true' },
    });
    const base = attemptEvent();
    observer.observe(attemptEvent({
      request: {
        ...base.request,
        cache: {
          strategy: 'openai-explicit-stable-prefix',
          stablePrefixEstimatedTokens: 4096,
          stableSystemMessages: 2,
          explicitBreakpoints: 1,
          promptCacheKeyFingerprint: 'abcdef1234567890',
        },
      },
    }));
    await observer.drain();

    const store = await readCacheTraceStore(dir);
    assert.equal(store.records[0].cacheStrategy, 'openai-explicit-stable-prefix');
    assert.deepEqual(store.records[0].cachePlan, {
      stablePrefixEstimatedTokens: 4096,
      stableSystemMessages: 2,
      explicitBreakpoints: 1,
      promptCacheKeyFingerprint: 'abcdef1234567890',
    });
    const raw = fs.readFileSync(listTraceFiles(dir)[0], 'utf8');
    assert.equal(raw.includes('catsco-v3-'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('observer persists only redacted context lifecycle counts and fingerprints', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-context-lifecycle-'));
  try {
    const observer = new CacheTraceObserver({
      sessionId: 'cache:lifecycle',
      traceDir: dir,
      env: { XIAOBA_CACHE_TRACE: 'true' },
    });
    const base = attemptEvent();
    observer.observe(attemptEvent({
      request: {
        ...base.request,
        contextLifecycle: {
          annotatedMessages: 4,
          transientMessages: 3,
          lifecycleCounts: { session: 1, episode: 2, call: 1 },
          cacheScopeCounts: { stable: 1, epoch: 2, volatile: 1 },
          epochFingerprint: '0123456789abcdef',
          requestFingerprint: 'fedcba9876543210',
        },
      },
    }));
    await observer.drain();

    const store = await readCacheTraceStore(dir);
    assert.deepEqual(store.records[0].contextLifecycle, {
      annotatedMessages: 4,
      transientMessages: 3,
      lifecycleCounts: { session: 1, episode: 2, call: 1 },
      cacheScopeCounts: { stable: 1, epoch: 2, volatile: 1 },
      epochFingerprint: '0123456789abcdef',
      requestFingerprint: 'fedcba9876543210',
    });
    const raw = fs.readFileSync(listTraceFiles(dir)[0], 'utf8');
    assert.doesNotMatch(raw, /secret content must not be stored/);
    assert.match(raw, /\"context_lifecycle\"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('reader keeps legacy and v4 traces diagnostic-only while resetting diff on a model switch', async () => {
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
    assert.equal(store.sessions[0].weightedHitRatio, undefined);
    assert.equal(store.sessions[0].eligibleAttempts, 0);
    assert.equal(store.sessions[0].ineligibleAttempts, 2);
    assert.equal(store.sessions[0].ineligibleReasons['legacy-trace-schema'], 2);
    assert.equal(store.records[1].usage.hitRatio, 0.5);
    assert.deepEqual(store.records[1].qualification, {
      eligible: false,
      reasons: ['legacy-trace-schema'],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v5 preserves missing cache usage and qualifies an explicitly reported zero cache read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-v5-truth-'));
  try {
    const observer = new CacheTraceObserver({
      sessionId: 'cache:v5-truth',
      traceDir: dir,
      env: { XIAOBA_CACHE_TRACE: 'true' },
    });
    observer.observe(attemptEvent({ outcome: 'started', callId: 'missing', attemptId: 'missing:1' }));
    observer.observe(attemptEvent({
      outcome: 'succeeded',
      callId: 'missing',
      attemptId: 'missing:1',
      response: { content: 'ok', usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11, inputTokensReported: true } },
    }));
    observer.observe(attemptEvent({ outcome: 'started', callId: 'zero', attemptId: 'zero:1' }));
    observer.observe(attemptEvent({
      outcome: 'succeeded',
      callId: 'zero',
      attemptId: 'zero:1',
      response: {
        content: 'ok',
        usage: { promptTokens: 20, completionTokens: 1, totalTokens: 21, inputTokensReported: true, cachedReadTokens: 0 },
      },
    }));
    await observer.drain();

    const rawLines = listTraceFiles(dir).flatMap(file => fs.readFileSync(file, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line)));
    const missingUsage = rawLines.find(line => line.lifecycle.outcome === 'succeeded'
      && line.lifecycle.call_id === 'missing').response_usage;
    assert.equal(missingUsage.cache_read_reported, false);
    assert.equal(missingUsage.input_tokens_reported, true);
    assert.equal(Object.hasOwn(missingUsage, 'cache_read_tokens'), false);
    const zeroUsage = rawLines.find(line => line.lifecycle.outcome === 'succeeded'
      && line.lifecycle.call_id === 'zero').response_usage;
    assert.equal(zeroUsage.cache_read_reported, true);
    assert.equal(zeroUsage.cache_read_tokens, 0);

    const store = await readCacheTraceStore(dir);
    const missing = store.records.find(record => record.callId === 'missing')!;
    const zero = store.records.find(record => record.callId === 'zero')!;
    assert.equal(missing.usage.cacheReadTokens, undefined);
    assert.equal(missing.usage.hitRatio, undefined);
    assert.deepEqual(missing.qualification.reasons, ['cache-read-not-reported']);
    assert.equal(zero.usage.cacheReadTokens, 0);
    assert.equal(zero.usage.hitRatio, 0);
    assert.deepEqual(zero.qualification, { eligible: true, reasons: [] });
    assert.equal(store.sessions[0].eligibleAttempts, 1);
    assert.equal(store.sessions[0].ineligibleAttempts, 1);
    assert.equal(store.sessions[0].weightedHitRatio, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v5 omits response_usage without provider usage and reports stable qualification reasons', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-v5-reasons-'));
  try {
    const observer = new CacheTraceObserver({
      sessionId: 'cache:v5-reasons',
      traceDir: dir,
      env: { XIAOBA_CACHE_TRACE: 'true' },
    });
    observer.observe(attemptEvent({ outcome: 'started', callId: 'no-usage', attemptId: 'no-usage:1' }));
    observer.observe(attemptEvent({
      outcome: 'succeeded',
      callId: 'no-usage',
      attemptId: 'no-usage:1',
      response: { content: 'ok' },
    }));
    await observer.drain();

    const lines = fs.readFileSync(listTraceFiles(dir)[0], 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(Object.hasOwn(lines[1], 'response_usage'), false);
    const store = await readCacheTraceStore(dir);
    assert.deepEqual(store.records[0].qualification, {
      eligible: false,
      reasons: ['response-usage-missing'],
    });

    fs.writeFileSync(path.join(dir, 'invalid.jsonl'), [
      cacheTraceLine({
        schema: 'xiaoba.cache_trace.v5',
        outcome: 'succeeded',
        attemptId: 'invalid-input:1',
        callId: 'invalid-input',
        provider: 'openai',
        model: 'gpt-test',
        apiType: 'openai-responses',
        timestamp: '2026-08-01T01:02:00.000Z',
        usage: { input_tokens: 0, input_tokens_reported: true, cache_read_reported: true, cache_read_tokens: 0, cache_write_reported: false },
      }),
      cacheTraceLine({
        schema: 'xiaoba.cache_trace.v5',
        outcome: 'succeeded',
        attemptId: 'read-exceeds:1',
        callId: 'read-exceeds',
        provider: 'openai',
        model: 'gpt-test',
        apiType: 'openai-responses',
        timestamp: '2026-08-01T01:03:00.000Z',
        usage: { input_tokens: 10, input_tokens_reported: true, cache_read_reported: true, cache_read_tokens: 11, cache_write_reported: false },
      }),
      cacheTraceLine({
        schema: 'xiaoba.cache_trace.v5',
        outcome: 'succeeded',
        attemptId: 'anthropic-missing-input:1',
        callId: 'anthropic-missing-input',
        provider: 'anthropic',
        model: 'claude-test',
        apiType: 'anthropic-messages',
        timestamp: '2026-08-01T01:04:00.000Z',
        usage: { input_tokens: 100, input_tokens_reported: false, cache_read_reported: true, cache_read_tokens: 90, cache_write_reported: true, cache_write_tokens: 10 },
      }),
      cacheTraceLine({
        schema: 'xiaoba.cache_trace.v5',
        outcome: 'succeeded',
        attemptId: 'anthropic-missing-write:1',
        callId: 'anthropic-missing-write',
        provider: 'anthropic',
        model: 'claude-test',
        apiType: 'anthropic-messages',
        timestamp: '2026-08-01T01:05:00.000Z',
        usage: { input_tokens: 100, input_tokens_reported: true, cache_read_reported: true, cache_read_tokens: 90, cache_write_reported: false },
      }),
    ].join('\n') + '\n');
    const invalidStore = await readCacheTraceStore(dir);
    assert.deepEqual(invalidStore.records.find(record => record.callId === 'invalid-input')?.qualification.reasons, [
      'invalid-input-tokens',
    ]);
    assert.deepEqual(invalidStore.records.find(record => record.callId === 'read-exceeds')?.qualification.reasons, [
      'cache-read-exceeds-input',
    ]);
    assert.deepEqual(invalidStore.records.find(record => record.callId === 'anthropic-missing-input')?.qualification.reasons, [
      'input-tokens-not-reported',
    ]);
    assert.deepEqual(invalidStore.records.find(record => record.callId === 'anthropic-missing-write')?.qualification.reasons, [
      'cache-write-not-reported',
    ]);
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
    assert.deepEqual(failed.qualification.reasons, [
      'attempt-not-succeeded',
      'response-usage-missing',
    ]);
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

test('observer records evidence-driven reasoning recovery on the exact retry attempt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-reasoning-recovery-'));
  try {
    const observer = new CacheTraceObserver({
      sessionId: 'cache:reasoning-recovery',
      traceDir: dir,
      env: { XIAOBA_CACHE_TRACE: 'true' },
    });
    observer.observe(attemptEvent({ outcome: 'started' }));
    observer.observe(attemptEvent({
      outcome: 'retrying',
      error: Object.assign(new Error('reasoning_content is required'), { response: { status: 400 } }),
      retry: {
        retryNumber: 1,
        maxRetries: 1,
        elapsedMs: 3,
        maxElapsedMs: 30_000,
        delayMs: 0,
        recoveryAction: 'reasoning_history_degrade',
      },
    }));
    await observer.drain();

    const lines = fs.readFileSync(listTraceFiles(dir)[0], 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line));
    assert.equal(lines[0].lifecycle.retry_recovery_action, undefined);
    assert.equal(lines[1].lifecycle.retry_recovery_action, 'reasoning_history_degrade');
    assert.equal(lines[1].failure.http_status, 400);
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
  assert.match(index, /href="cache-trace\.html"/);
  assert.match(page, /缓存命中监控/);
  assert.match(page, /catsco\.dashboardApiKey/);
  assert.match(page, /采集 Cache Trace/);
  assert.match(page, /重试后恢复/);
  assert.match(page, /最终失败/);
  assert.match(page, /未完成/);
  assert.match(page, /缓存策略/);
  assert.match(page, /OpenAI 显式稳定前缀/);
  assert.match(page, /Anthropic 分层显式断点/);
  assert.match(page, /上下文 S\/E\/C/);
  assert.match(page, /epoch/);
  assert.match(page, /stablePrefixEstimatedTokens/);
  assert.match(page, /可验收 Attempts/);
  assert.match(page, /不具资格 Attempts/);
  assert.match(page, /不可验收/);
  assert.match(page, /未上报/);
  assert.match(page, /legacy-trace-schema/);
  assert.match(page, /class="muted reason">原因：/);
  assert.match(page, /bar=ineligible===0&&hasNumber/);
  assert.match(page, /@media\(max-width:900px\)/);
  assert.match(page, /\.layout\{grid-template-columns:minmax\(0,1fr\)\}/);
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
  schema?: 'xiaoba.cache_trace.v4' | 'xiaoba.cache_trace.v5';
  outcome: 'started' | 'succeeded';
  callId: string;
  attemptId: string;
  provider: string;
  model: string;
  apiType: string;
  timestamp: string;
  usage?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    schema: options.schema ?? 'xiaoba.cache_trace.v4',
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
