import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { ConversationRunner } from '../src/core/conversation-runner';

function makeRunner(model: string): ConversationRunner {
  return new ConversationRunner(
    {
      getConfig: () => ({ model }),
    } as any,
    {
      getToolDefinitions: () => [],
      executeTool: async () => ({ ok: true, content: '' }),
    } as any,
    { stream: false, enableCompression: false },
  );
}

describe('ConversationRunner MiniMax-M3 cache behavior', () => {
  test('suppresses transient runner hints for MiniMax-M3 by default', () => {
    const previous = process.env.XIAOBA_M3_TRANSIENT_RUNNER_HINTS;
    delete process.env.XIAOBA_M3_TRANSIENT_RUNNER_HINTS;
    try {
      assert.equal((makeRunner('MiniMax-M3') as any).shouldSuppressTransientRunnerHintsForCache(), true);
      assert.equal((makeRunner('MiniMax-M2.7') as any).shouldSuppressTransientRunnerHintsForCache(), false);
    } finally {
      if (previous === undefined) {
        delete process.env.XIAOBA_M3_TRANSIENT_RUNNER_HINTS;
      } else {
        process.env.XIAOBA_M3_TRANSIENT_RUNNER_HINTS = previous;
      }
    }
  });

  test('allows an explicit MiniMax-M3 transient hint override', () => {
    const previous = process.env.XIAOBA_M3_TRANSIENT_RUNNER_HINTS;
    process.env.XIAOBA_M3_TRANSIENT_RUNNER_HINTS = '1';
    try {
      assert.equal((makeRunner('MiniMax-M3') as any).shouldSuppressTransientRunnerHintsForCache(), false);
    } finally {
      if (previous === undefined) {
        delete process.env.XIAOBA_M3_TRANSIENT_RUNNER_HINTS;
      } else {
        process.env.XIAOBA_M3_TRANSIENT_RUNNER_HINTS = previous;
      }
    }
  });
});
