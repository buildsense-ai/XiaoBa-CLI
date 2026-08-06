import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { ConversationRunner } from '../src/core/conversation-runner';
import { SubAgentSession } from '../src/core/sub-agent-session';

test('SubAgentSession follows the main-session checkpoint compaction rollout switch', async () => {
  const originalFlag = process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED;
  const originalRun = ConversationRunner.prototype.run;
  const observed: Array<{ enableCompression: boolean; checkpointCoordinator: boolean }> = [];

  (ConversationRunner.prototype as any).run = async function runMock(messages: any[]) {
    observed.push({
      enableCompression: Boolean((this as any).enableCompression),
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
    delete process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED;
    await runSession('sub-checkpoint-default');

    process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED = 'false';
    await runSession('sub-checkpoint-legacy');

    assert.deepEqual(observed, [
      { enableCompression: false, checkpointCoordinator: true },
      { enableCompression: true, checkpointCoordinator: false },
    ]);
  } finally {
    ConversationRunner.prototype.run = originalRun;
    if (originalFlag === undefined) delete process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED = originalFlag;
  }
});
