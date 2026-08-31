import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSession } from '../src/core/agent-session';

test('AgentSession does not implicitly sync the Bot Skill workspace after a completed turn', async () => {
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
  assert.equal(scheduledSyncs, 0);
});

test('AgentSession checkpoint candidate defaults on with an 85 percent serial threshold', () => {
  const previous = process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
  delete process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
  try {
    const session = new AgentSession('user:candidate-default', buildMockServices({}), 'catscompany');
    assert.equal((session as any).useCheckpointCandidates, true);
    assert.equal((session as any).checkpointCompactionCoordinator.compactionThreshold, 0.85);
    assert.equal((session as any).checkpointCandidateCoordinator.compactionThreshold, 0.75);
  } finally {
    if (previous === undefined) delete process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = previous;
  }
});

test('AgentSession candidate mode supports explicit false rollback', () => {
  const previous = process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
  process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = 'false';
  try {
    const session = new AgentSession('user:candidate-disabled', buildMockServices({}), 'catscompany');
    assert.equal((session as any).useCheckpointCandidates, false);
    assert.equal((session as any).checkpointCompactionCoordinator.compactionThreshold, 0.8);
  } finally {
    if (previous === undefined) delete process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = previous;
  }
});

test('AgentSession keeps one candidate slot and clear cancels it', async () => {
  const previous = process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
  process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = 'true';
  try {
    let observedSignal: AbortSignal | undefined;
    const session = new AgentSession('user:candidate-slot', buildMockServices({}), 'catscompany');
    (session as any).getContextUsageInfo = () => ({
      usedTokens: 75,
      toolTokens: 0,
      maxTokens: 100,
      usagePercent: 75,
    });
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async (_messages: any[], options: any) => {
      observedSignal = options.signal;
      return await new Promise(() => {});
    };

    (session as any).startCheckpointCandidateIfEligible(0, [{ role: 'user', content: 'root' }]);
    const firstCandidate = (session as any).checkpointCandidate;
    (session as any).startCheckpointCandidateIfEligible(0, [{ role: 'user', content: 'root' }]);

    assert.ok(firstCandidate);
    assert.equal((session as any).checkpointCandidate, firstCandidate);
    await waitFor(() => Boolean(observedSignal));
    session.clear();
    assert.equal(observedSignal?.aborted, true);
    assert.equal(firstCandidate.status, 'cancelled');
    assert.equal((session as any).checkpointCandidate, null);
  } finally {
    if (previous === undefined) delete process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = previous;
  }
});

test('AgentSession persists a ready candidate before returning replacement messages', () => {
  const previous = process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
  process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = 'true';
  try {
    const session = new AgentSession('user:candidate-commit', buildMockServices({}), 'catscompany');
    const messages = [{ role: 'user', content: 'root', __episodeId: 'episode-1' }];
    (session as any).getContextUsageInfo = () => ({ usedTokens: 75, toolTokens: 0, maxTokens: 100, usagePercent: 75 });
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => ({
      compacted: true,
      messages: [{ role: 'user', content: 'summary', __episodeId: 'episode-1' }],
    });
    let persisted: any[] | undefined;
    (session as any).persistCheckpoint = (candidateMessages: any[]) => {
      persisted = candidateMessages;
      return true;
    };

    (session as any).startCheckpointCandidateIfEligible(0, messages);
    const candidate = (session as any).checkpointCandidate;
    candidate.complete([{ role: 'user', content: 'summary', __episodeId: 'episode-1' }]);
    const committed = (session as any).commitReadyCheckpointCandidate([
      ...messages,
      { role: 'assistant', content: 'tail', __episodeId: 'episode-2' },
    ]);

    assert.deepEqual(committed.map((message: any) => message.content), ['summary', 'tail']);
    assert.deepEqual(persisted?.map(message => message.content), ['summary', 'tail']);
    assert.equal(candidate.status, 'committed');
    assert.equal((session as any).checkpointCandidate, null);
  } finally {
    if (previous === undefined) delete process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = previous;
  }
});

test('AgentSession keeps original messages when candidate persistence fails', () => {
  const previous = process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
  process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = 'true';
  try {
    const session = new AgentSession('user:candidate-persist-failure', buildMockServices({}), 'catscompany');
    const messages = [{ role: 'user', content: 'root' }];
    (session as any).getContextUsageInfo = () => ({ usedTokens: 75, toolTokens: 0, maxTokens: 100, usagePercent: 75 });
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => ({ compacted: true, messages: [] });
    (session as any).persistCheckpoint = () => false;

    (session as any).startCheckpointCandidateIfEligible(0, messages);
    const candidate = (session as any).checkpointCandidate;
    candidate.complete([{ role: 'user', content: 'summary' }]);
    const committed = (session as any).commitReadyCheckpointCandidate(messages);

    assert.equal(committed, null);
    assert.equal(candidate.status, 'cancelled');
    assert.equal((session as any).checkpointCandidate, null);
  } finally {
    if (previous === undefined) delete process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = previous;
  }
});

test('AgentSession keeps a running candidate through the serial compaction range', async () => {
  const previous = process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
  process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = 'true';
  try {
    let usagePercent = 75;
    let observedSignal: AbortSignal | undefined;
    const session = new AgentSession('user:candidate-preempt', buildMockServices({}), 'catscompany');
    (session as any).getContextUsageInfo = () => ({
      usedTokens: usagePercent,
      toolTokens: 0,
      maxTokens: 100,
      usagePercent,
    });
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async (_messages: any[], options: any) => {
      observedSignal = options.signal;
      return await new Promise(() => {});
    };

    const messages = [{ role: 'user', content: 'root' }];
    (session as any).startCheckpointCandidateIfEligible(0, messages);
    const candidate = (session as any).checkpointCandidate;
    await waitFor(() => Boolean(observedSignal));
    usagePercent = 84;
    (session as any).coordinateCheckpointCandidate(messages);
    assert.equal(observedSignal?.aborted, false);
    assert.equal((session as any).checkpointCandidate, candidate);

    usagePercent = 85;
    (session as any).coordinateCheckpointCandidate(messages);

    assert.equal(observedSignal?.aborted, false);
    assert.equal(candidate.status, 'running');
    assert.equal((session as any).checkpointCandidate, candidate);
  } finally {
    if (previous === undefined) delete process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = previous;
  }
});

test('a candidate result that arrives after 85 percent remains ready for safe commit', async () => {
  const previous = process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
  process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = 'true';
  try {
    let usagePercent = 75;
    let releaseCandidate!: () => void;
    const gate = new Promise<void>(resolve => { releaseCandidate = resolve; });
    const session = new AgentSession('user:candidate-late-result', buildMockServices({}), 'catscompany');
    (session as any).getContextUsageInfo = () => ({
      usedTokens: usagePercent,
      toolTokens: 0,
      maxTokens: 100,
      usagePercent,
    });
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => {
      await gate;
      return { compacted: true, messages: [{ role: 'user', content: 'late summary' }] };
    };
    const messages = [{ role: 'user', content: 'root' }];

    (session as any).startCheckpointCandidateIfEligible(0, messages);
    const candidate = (session as any).checkpointCandidate;
    usagePercent = 85;
    (session as any).coordinateCheckpointCandidate(messages);
    releaseCandidate();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(candidate.status, 'ready');
    assert.ok(candidate.result);
    assert.equal((session as any).checkpointCandidate, candidate);
  } finally {
    if (previous === undefined) delete process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = previous;
  }
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
