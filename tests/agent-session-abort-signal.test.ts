import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSession } from '../src/core/agent-session';

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
  (session as any).contextWindowManager.compactIfNeeded = async (messages: any[], options: any) => {
    compactionSignal = options.signal;
    await compactionGate;
    return [...messages, { role: 'assistant', content: '不应恢复的旧压缩结果' }];
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

async function waitFor(predicate: () => boolean, maxAttempts = 50): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met in time');
}
