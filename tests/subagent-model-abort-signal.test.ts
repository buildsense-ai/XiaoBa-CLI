import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { SubAgentSession } from '../src/core/sub-agent-session';

test('SubAgentSession stop aborts an in-flight model request', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-subagent-model-abort-'));
  let observedSignal: AbortSignal | undefined;

  const session = new SubAgentSession('sub-model-abort', {
    async chatStream(_messages: any[], _tools: any[], _callbacks: any, options: any = {}) {
      observedSignal = options.signal;
      return await new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
      });
    },
  } as any, {
    getSkill() { return undefined; },
    loadSkills: async () => {},
  } as any, {
    agentType: 'explorer',
    taskDescription: 'abort model request',
    userMessage: 'abort model request',
    workingDirectory,
  });

  try {
    const runPromise = session.run();
    await waitFor(() => Boolean(observedSignal));

    session.stop();
    await runPromise;

    assert.equal(observedSignal?.aborted, true);
    assert.equal(session.status, 'stopped');
  } finally {
    await session.close();
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, maxAttempts = 50): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met in time');
}
