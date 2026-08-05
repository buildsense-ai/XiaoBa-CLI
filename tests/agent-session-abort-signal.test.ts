import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  AgentSession,
  MODEL_STREAM_INTERRUPTED_MEMORY_ONLY_MESSAGE,
  MODEL_STREAM_INTERRUPTED_MESSAGE,
  MODEL_TIMEOUT_MESSAGE,
} from '../src/core/agent-session';
import { attachRetrySummary } from '../src/utils/model-error-observability';

test('AgentSession schedules Bot Skill workspace sync after a completed turn', async () => {
  let scheduledSyncs = 0;
  const session = new AgentSession('user:after-turn-skill-sync', buildMockServices({
    afterTurnSkillSyncScheduler() {
      scheduledSyncs++;
    },
    aiService: {
      async chatStream() {
        return { content: 'done', toolCalls: [] };
      },
    },
  }), 'catscompany');
  session.setSystemPromptProvider(() => 'system prompt');

  const result = await session.handleMessage('update the current Skill');

  assert.equal(result.text, 'done');
  assert.equal(scheduledSyncs, 1);
});

test('AgentSession preserves partial stream text and offers continuation after a 504 interruption', async () => {
  const session = new AgentSession('user:partial-stream-504', buildMockServices({
    aiService: {
      getConfig() { return { provider: 'openai', model: 'primary-model' }; },
      async chatStream(_messages: any[], _tools: any[], callbacks: any) {
        callbacks?.onText?.('已经完成的部分');
        const error = Object.assign(new Error('API错误 (504): gateway timeout'), { status: 504 });
        attachRetrySummary(error, {
          attempt_count: 1,
          retry_count: 0,
          max_retries: 14,
          elapsed_ms: 10,
          max_elapsed_ms: 300000,
          stop_reason: 'stream_output_started',
        });
        throw error;
      },
    },
  }), 'catscompany');
  session.setSystemPromptProvider(() => 'system prompt');

  const result = await session.handleMessage('执行一个会流中断的任务');

  assert.equal(result.text, MODEL_STREAM_INTERRUPTED_MESSAGE);
  assert.equal(result.taskOutcome, 'failed');
  assert.equal((session as any).messages.some((message: any) => message.content === '已经完成的部分'), true);
});

test('AgentSession reports memory-only recovery when the partial draft cannot be persisted', async () => {
  const session = new AgentSession('user:partial-stream-memory-only', buildMockServices({
    aiService: {
      getConfig() { return { provider: 'openai', model: 'primary-model' }; },
      async chatStream(_messages: any[], _tools: any[], callbacks: any) {
        callbacks?.onText?.('仅内存保留的部分');
        const error = Object.assign(new Error('API错误 (504): gateway timeout'), { status: 504 });
        attachRetrySummary(error, {
          attempt_count: 1,
          retry_count: 0,
          max_retries: 14,
          elapsed_ms: 10,
          max_elapsed_ms: 300000,
          stop_reason: 'stream_output_started',
        });
        throw error;
      },
    },
  }), 'catscompany');
  session.setSystemPromptProvider(() => 'system prompt');
  (session as any).lifecycleManager.saveContext = () => false;

  const result = await session.handleMessage('执行一个无法落盘的流中断任务');

  assert.equal(result.text, MODEL_STREAM_INTERRUPTED_MEMORY_ONLY_MESSAGE);
  assert.equal((session as any).messages.some((message: any) => message.content === '仅内存保留的部分'), true);
  const logPath = (session as any).sessionTurnLogger.getLogFilePath();
  const turnError = fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .find(entry => entry?.event?.type === 'turn_error');
  assert.equal(turnError.event.payload.partial_progress_preserved, true);
  assert.equal(turnError.event.payload.partial_progress_persistence, 'memory_only');
});

test('AgentSession only claims automatic retries when retry_count is positive', async () => {
  const cases = [
    { stopReason: 'non_retryable', expected: MODEL_TIMEOUT_MESSAGE },
    { stopReason: 'retry_window_exhausted', expected: MODEL_TIMEOUT_MESSAGE },
    { stopReason: 'unknown', expected: MODEL_TIMEOUT_MESSAGE },
  ] as const;

  for (const testCase of cases) {
    const session = new AgentSession(`user:no-retry-claim:${testCase.stopReason}`, buildMockServices({
      aiService: {
        getConfig() { return { provider: 'openai', model: 'primary-model' }; },
        async chatStream() {
          const error = Object.assign(new Error('API错误 (504): gateway timeout'), { status: 504 });
          attachRetrySummary(error, {
            attempt_count: 1,
            retry_count: 0,
            max_retries: 14,
            elapsed_ms: 300000,
            max_elapsed_ms: 300000,
            stop_reason: testCase.stopReason,
          });
          throw error;
        },
      },
    }), 'catscompany');
    session.setSystemPromptProvider(() => 'system prompt');

    const result = await session.handleMessage(`验证 ${testCase.stopReason}`);

    assert.equal(result.text, testCase.expected);
    assert.doesNotMatch(result.text, /自动重试/);
  }

  const retriedSession = new AgentSession('user:positive-retry-claim', buildMockServices({
    aiService: {
      getConfig() { return { provider: 'openai', model: 'primary-model' }; },
      async chatStream() {
        const error = Object.assign(new Error('API错误 (504): gateway timeout'), { status: 504 });
        attachRetrySummary(error, {
          attempt_count: 3,
          retry_count: 2,
          max_retries: 2,
          elapsed_ms: 100,
          max_elapsed_ms: 300000,
          stop_reason: 'retry_limit_exhausted',
        });
        throw error;
      },
    },
  }), 'catscompany');
  retriedSession.setSystemPromptProvider(() => 'system prompt');

  const retriedResult = await retriedSession.handleMessage('验证真实重试次数');
  assert.match(retriedResult.text, /已自动重试/);
});

test('AgentSession persists only the final attempt draft after an explicit stream replay', async () => {
  const session = new AgentSession('user:stream-replay-final-draft', buildMockServices({
    aiService: {
      getConfig() { return { provider: 'openai', model: 'primary-model' }; },
      async chatStream(_messages: any[], _tools: any[], callbacks: any) {
        callbacks?.onText?.('作废草稿');
        await callbacks?.onRetry?.(1, 1, { attempt: 1, maxRetries: 1 });
        callbacks?.onText?.('末次草稿');
        const error = Object.assign(new Error('API错误 (504): gateway timeout'), { status: 504 });
        attachRetrySummary(error, {
          attempt_count: 2,
          retry_count: 1,
          max_retries: 1,
          elapsed_ms: 20,
          max_elapsed_ms: 300000,
          stop_reason: 'stream_output_started',
        });
        throw error;
      },
    },
  }), 'catscompany');
  session.setSystemPromptProvider(() => 'system prompt');

  const result = await session.handleMessage('执行一次完整流重试');
  const persistedContents = (session as any).messages.map((message: any) => message.content);

  assert.equal(result.text, MODEL_STREAM_INTERRUPTED_MESSAGE);
  assert.equal(persistedContents.includes('末次草稿'), true);
  assert.equal(persistedContents.includes('作废草稿'), false);
});

test('AgentSession does not replay a premature close after visible stream text', async () => {
  let calls = 0;
  const session = new AgentSession('user:premature-close-after-text', buildMockServices({
    aiService: {
      getConfig() { return { provider: 'openai', model: 'primary-model' }; },
      async chatStream(_messages: any[], _tools: any[], callbacks: any) {
        calls += 1;
        callbacks?.onText?.('已输出内容');
        const error = Object.assign(new Error('premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
        attachRetrySummary(error, {
          attempt_count: 1,
          retry_count: 0,
          max_retries: 14,
          elapsed_ms: 10,
          max_elapsed_ms: 300000,
          stop_reason: 'stream_output_started',
        });
        throw error;
      },
    },
  }), 'catscompany');
  session.setSystemPromptProvider(() => 'system prompt');

  const result = await session.handleMessage('执行一个会提前关闭的流');

  assert.equal(calls, 1);
  assert.equal(result.text, MODEL_STREAM_INTERRUPTED_MESSAGE);
  assert.equal((session as any).messages.some((message: any) => message.content === '已输出内容'), true);
});

test('AgentSession explains when a 504 was not retried because the retry limit is zero', async () => {
  const session = new AgentSession('user:zero-retry-504', buildMockServices({
    aiService: {
      getConfig() { return { provider: 'openai', model: 'primary-model' }; },
      async chatStream() {
        const error = Object.assign(new Error('API错误 (504): gateway timeout'), { status: 504 });
        attachRetrySummary(error, {
          attempt_count: 1,
          retry_count: 0,
          max_retries: 0,
          elapsed_ms: 0,
          max_elapsed_ms: 300000,
          stop_reason: 'retry_limit_exhausted',
        });
        throw error;
      },
    },
  }), 'catscompany');
  session.setSystemPromptProvider(() => 'system prompt');

  const result = await session.handleMessage('执行一个不重试的任务');

  assert.match(result.text, /当前自动重试上限为 0，因此未执行自动重试/);
  assert.equal(result.taskOutcome, 'failed');
});

test('AgentSession requestInterrupt aborts an in-flight model request', async () => {
  let observedSignal: AbortSignal | undefined;

  const session = new AgentSession('user:abort-main-model', buildMockServices({
    aiService: {
      async chatStream(_messages: any[], _tools: any[], _callbacks: any, options: any = {}) {
        observedSignal = options.signal;
        return await new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
        });
      },
    },
  }), 'feishu');
  session.setSystemPromptProvider(() => 'system prompt');

  const runPromise = session.handleMessage('开始一个会被停止的任务');
  await waitFor(() => Boolean(observedSignal));

  session.requestInterrupt();
  const result = await runPromise;

  assert.equal(observedSignal?.aborted, true);
  assert.equal(result.text, '已停止当前请求。');
});

test('AgentSession clear interrupts an active turn before clearing its history', async () => {
  let observedSignal: AbortSignal | undefined;
  const session = new AgentSession('user:clear-active-turn', buildMockServices({
    aiService: {
      async chatStream(_messages: any[], _tools: any[], _callbacks: any, options: any = {}) {
        observedSignal = options.signal;
        return await new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted by clear')), { once: true });
        });
      },
    },
  }), 'catscompany');
  session.setSystemPromptProvider(() => 'system prompt');

  const runPromise = session.handleMessage('清空前正在处理的消息');
  await waitFor(() => Boolean(observedSignal));

  const clearResult = await session.handleCommand('clear', []);
  const runResult = await runPromise;
  const historyResult = await session.handleCommand('history', []);

  assert.equal(clearResult.reply, '历史已清空');
  assert.equal(observedSignal?.aborted, true);
  assert.equal(runResult.text, '已停止当前请求。');
  assert.match(historyResult.reply || '', /当前历史长度: 0 条消息/);
});

test('AgentSession clear ignores a stale model result even when the provider resolves after abort', async () => {
  let observedSignal: AbortSignal | undefined;
  let releaseModel!: () => void;
  const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
  const session = new AgentSession('user:clear-provider-resolves', buildMockServices({
    aiService: {
      async chatStream(_messages: any[], _tools: any[], _callbacks: any, options: any = {}) {
        observedSignal = options.signal;
        await modelGate;
        return { content: '这个旧回复不应恢复到历史里', toolCalls: [] };
      },
    },
  }), 'catscompany');
  session.setSystemPromptProvider(() => 'system prompt');

  const runPromise = session.handleMessage('清空前的旧请求');
  await waitFor(() => Boolean(observedSignal));
  const clearResult = await session.handleCommand('clear', []);
  releaseModel();
  const runResult = await runPromise;
  const historyResult = await session.handleCommand('history', []);

  assert.equal(clearResult.reply, '历史已清空');
  assert.equal(observedSignal?.aborted, true);
  assert.equal(runResult.text, '已停止当前请求。');
  assert.match(historyResult.reply || '', /当前历史长度: 0 条消息/);
});

test('AgentSession clear ignores stale context compaction that resolves after abort', async () => {
  let compactionSignal: AbortSignal | undefined;
  let releaseCompaction!: () => void;
  let modelCalls = 0;
  const compactionGate = new Promise<void>(resolve => { releaseCompaction = resolve; });
  const session = new AgentSession('user:clear-compaction-resolves', buildMockServices({
    aiService: {
      async chatStream() {
        modelCalls++;
        return { content: 'unexpected', toolCalls: [] };
      },
    },
  }), 'catscompany');
  session.setSystemPromptProvider(() => 'system prompt');
  (session as any).messages = [{ role: 'user', content: '压缩前的旧历史' }];
  (session as any).checkpointCompactionCoordinator.compactIfNeeded = async (messages: any[], options: any) => {
    compactionSignal = options.signal;
    await compactionGate;
    return {
      compacted: true,
      messages: [...messages, { role: 'assistant', content: '不应恢复的旧压缩结果' }],
    };
  };

  const runPromise = session.handleMessage('压缩期间的新请求');
  await waitFor(() => Boolean(compactionSignal));
  const clearResult = await session.handleCommand('clear', []);
  releaseCompaction();
  const runResult = await runPromise;
  const historyResult = await session.handleCommand('history', []);

  assert.equal(clearResult.reply, '历史已清空');
  assert.equal(compactionSignal?.aborted, true);
  assert.equal(runResult.text, '已停止当前请求。');
  assert.equal(modelCalls, 0);
  assert.match(historyResult.reply || '', /当前历史长度: 0 条消息/);
});

test('AgentSession clear ignores stale restore compaction during first initialization', async () => {
  let restoreCompactionSignal: AbortSignal | undefined;
  let releaseRestoreCompaction!: () => void;
  let compactionCalls = 0;
  let modelCalls = 0;
  const restoreCompactionGate = new Promise<void>(resolve => { releaseRestoreCompaction = resolve; });
  const session = new AgentSession('user:clear-restore-compaction', buildMockServices({
    aiService: {
      async chatStream() {
        modelCalls++;
        return { content: 'unexpected', toolCalls: [] };
      },
    },
  }), 'catscompany');
  session.setSystemPromptProvider(() => 'system prompt');
  (session as any).lifecycleManager.consumePendingRestore = () => [
    { role: 'user', content: '不应恢复的云端旧历史' },
  ];
  (session as any).checkpointCompactionCoordinator.compactIfNeeded = async (messages: any[], options: any) => {
    compactionCalls++;
    if (compactionCalls === 1) return { compacted: false, messages };
    restoreCompactionSignal = options.signal;
    await restoreCompactionGate;
    return {
      compacted: true,
      messages: [...messages, { role: 'assistant', content: '不应恢复的旧恢复压缩结果' }],
    };
  };

  const runPromise = session.handleMessage('触发首次初始化');
  await waitFor(() => Boolean(restoreCompactionSignal));
  const clearResult = await session.handleCommand('clear', []);
  releaseRestoreCompaction();
  const runResult = await runPromise;
  const historyResult = await session.handleCommand('history', []);

  assert.equal(clearResult.reply, '历史已清空');
  assert.equal(restoreCompactionSignal?.aborted, true);
  assert.equal(runResult.text, '已停止当前请求。');
  assert.equal(modelCalls, 0);
  assert.match(historyResult.reply || '', /当前历史长度: 0 条消息/);
});

test('clear commands prevent an interrupted restore turn from persisting after reset', async () => {
  for (const clearArgs of [[], ['--all']]) {
    let restoreCompactionSignal: AbortSignal | undefined;
    let releaseRestoreCompaction!: () => void;
    let compactionCalls = 0;
    let saveCalls = 0;
    const restoreCompactionGate = new Promise<void>(resolve => { releaseRestoreCompaction = resolve; });
    const session = new AgentSession(`user:clear-restore-persist:${clearArgs.join('-') || 'regular'}`, buildMockServices(), 'catscompany');
    session.setSystemPromptProvider(() => 'system prompt');
    (session as any).lifecycleManager.consumePendingRestore = () => [
      { role: 'user', content: '不应在清空后保存的云端旧历史' },
    ];
    (session as any).lifecycleManager.saveContext = () => { saveCalls++; };
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = async (messages: any[], options: any) => {
      compactionCalls++;
      if (compactionCalls === 1) return { compacted: false, messages };
      restoreCompactionSignal = options.signal;
      await restoreCompactionGate;
      return { compacted: true, messages };
    };

    const runPromise = session.handleMessage('触发首次初始化');
    await waitFor(() => Boolean(restoreCompactionSignal));
    await session.handleCommand('clear', clearArgs);
    releaseRestoreCompaction();
    await runPromise;

    assert.equal(saveCalls, 0, `stale turn persisted after /clear ${clearArgs.join(' ')}`);
  }
});

test('clear commands discard a first initialization still building its system prompt', async () => {
  for (const clearArgs of [[], ['--all']]) {
    let promptStarted = false;
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>(resolve => { releasePrompt = resolve; });
    const session = new AgentSession(`user:clear-init-prompt:${clearArgs.join('-') || 'regular'}`, buildMockServices(), 'catscompany');
    (session as any).buildCurrentSystemPrompt = async () => {
      promptStarted = true;
      await promptGate;
      return { systemPrompt: '不应在清空后写回的系统提示词', promptTrace: undefined };
    };

    const runPromise = session.handleMessage('触发首次初始化');
    await waitFor(() => promptStarted);
    await session.handleCommand('clear', clearArgs);
    releasePrompt();
    const runResult = await runPromise;
    const historyResult = await session.handleCommand('history', []);

    assert.equal(runResult.text, '已停止当前请求。');
    assert.equal((session as any).initialized, false);
    assert.match(historyResult.reply || '', /当前历史长度: 0 条消息/);
  }
});

test('clear commands discard an initialized session prompt hot reload', async () => {
  for (const clearArgs of [[], ['--all']]) {
    let promptCalls = 0;
    let reloadStarted = false;
    let releaseReload!: () => void;
    let modelCalls = 0;
    const reloadGate = new Promise<void>(resolve => { releaseReload = resolve; });
    const session = new AgentSession(`user:clear-prompt-reload:${clearArgs.join('-') || 'regular'}`, buildMockServices({
      aiService: {
        async chatStream() {
          modelCalls++;
          return { content: 'unexpected', toolCalls: [] };
        },
      },
    }), 'catscompany');
    session.setSystemPromptProvider(async () => {
      promptCalls++;
      if (promptCalls === 1) return 'system prompt v1';
      reloadStarted = true;
      await reloadGate;
      return '不应在清空后写回的 system prompt v2';
    });
    await session.init();

    const runPromise = session.handleMessage('触发 prompt 热加载');
    await waitFor(() => reloadStarted);
    await session.handleCommand('clear', clearArgs);
    releaseReload();
    const runResult = await runPromise;
    const historyResult = await session.handleCommand('history', []);

    assert.equal(runResult.text, '已停止当前请求。');
    assert.equal((session as any).initialized, false);
    assert.equal(modelCalls, 0);
    assert.match(historyResult.reply || '', /当前历史长度: 0 条消息/);
  }
});

function buildMockServices(overrides: any = {}): any {
  return {
    aiService: overrides.aiService ?? {},
    afterTurnSkillSyncScheduler: overrides.afterTurnSkillSyncScheduler,
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

async function waitFor(predicate: () => boolean, maxAttempts = 50): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met in time');
}
