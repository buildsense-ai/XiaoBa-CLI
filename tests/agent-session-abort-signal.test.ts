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
