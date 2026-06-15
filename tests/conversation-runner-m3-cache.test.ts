import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { ConversationRunner } from '../src/core/conversation-runner';
import { TRANSIENT_RUNNER_HINT_PREFIX } from '../src/core/runner-orchestration-policy';
import type { Message } from '../src/types';
import type { ToolDefinition, ToolExecutor } from '../src/types/tool';

function makeRunner(
  model: string,
  requests: Message[][],
  tools: ToolDefinition[] = [],
): ConversationRunner {
  const aiService = {
    getConfig: () => ({ provider: 'anthropic', model }),
    async chat(messages: Message[]) {
      requests.push(messages.map(message => ({ ...message })));
      return { content: 'done' };
    },
  };
  const executor: ToolExecutor = {
    getToolDefinitions: () => tools,
    executeTool: async () => ({ ok: true, content: '' }),
  } as any;

  return new ConversationRunner(aiService as any, executor, {
    stream: false,
    enableCompression: false,
  });
}

describe('ConversationRunner MiniMax-M3 cache behavior', () => {
  test('sends a system runner hint to MiniMax-M3 requests', async () => {
    const requests: Message[][] = [];
    const runner = makeRunner('MiniMax-M3', requests);

    const result = await runner.run([{ role: 'user', content: 'check the project' }]);

    assert.equal(result.response, 'done');
    assert.equal(requests.length, 1);

    const runnerHints = requests[0].filter(message =>
      typeof message.content === 'string'
      && message.content.startsWith(TRANSIENT_RUNNER_HINT_PREFIX)
    );
    assert.equal(runnerHints.length, 1);
    assert.equal(runnerHints[0].role, 'system');
    assert.equal(result.messages.some(message =>
      typeof message.content === 'string'
      && message.content.startsWith(TRANSIENT_RUNNER_HINT_PREFIX)
    ), false);
  });
});
