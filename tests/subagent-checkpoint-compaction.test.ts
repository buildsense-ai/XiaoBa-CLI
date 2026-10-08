import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { ConversationRunner } from '../src/core/conversation-runner';
import { SubAgentSession } from '../src/core/sub-agent-session';

test('SubAgentSession always runs on checkpoint compaction', async () => {
  const originalRun = ConversationRunner.prototype.run;
  const observed: Array<{ checkpointCoordinator: boolean }> = [];

  (ConversationRunner.prototype as any).run = async function runMock(messages: any[]) {
    observed.push({
      checkpointCoordinator: Boolean((this as any).checkpointCompactionCoordinator),
    });
    return {
      response: 'done',
      finalResponseVisible: true,
      messages,
      newMessages: [],
    };
  };

  const runSession = async (id: string) => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `xiaoba-${id}-`));
    const session = new SubAgentSession(id, {
      getConfig: () => ({ contextWindowTokens: 256_000 }),
    } as any, {
      getSkill() { return undefined; },
      loadSkills: async () => {},
    } as any, {
      agentType: 'explorer',
      taskDescription: 'verify compaction mode',
      userMessage: 'verify compaction mode',
      workingDirectory,
    });
    try {
      await session.run();
    } finally {
      await session.close();
      fs.rmSync(workingDirectory, { recursive: true, force: true });
    }
  };

  try {
    await runSession('sub-checkpoint-default');

    assert.deepEqual(observed, [
      { checkpointCoordinator: true },
    ]);
  } finally {
    ConversationRunner.prototype.run = originalRun;
  }
});
