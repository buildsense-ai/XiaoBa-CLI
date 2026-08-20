import assert from 'node:assert/strict';
import test from 'node:test';
import { Message } from '../src/types';
import { Tool } from '../src/types/tool';
import { BranchSession } from '../src/core/branch-session';
import { ConversationRunner } from '../src/core/conversation-runner';

class TestBranchSession extends BranchSession {
  protected async buildInitialMessages(): Promise<Message[]> {
    return [{ role: 'user', content: 'verify branch compaction mode' }];
  }

  protected buildTools(): Tool[] {
    return [];
  }

  runForTest() {
    return this.runConversation();
  }
}

test('BranchSession uses an isolated checkpoint coordinator with legacy rollback', async () => {
  const originalFlag = process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED;
  const originalRun = ConversationRunner.prototype.run;
  const observed: Array<{
    enableCompression: boolean;
    checkpointCoordinator: boolean;
    episodeId?: string;
    persistentCheckpoint: boolean;
  }> = [];

  (ConversationRunner.prototype as any).run = async function runMock(messages: Message[]) {
    observed.push({
      enableCompression: Boolean((this as any).enableCompression),
      checkpointCoordinator: Boolean((this as any).checkpointCompactionCoordinator),
      episodeId: (this as any).episodeId,
      persistentCheckpoint: Boolean((this as any).onCompactionCheckpoint),
    });
    return {
      response: 'done',
      finalResponseVisible: true,
      messages,
      newMessages: [],
    };
  };

  const runSession = async (id: string) => {
    const session = new TestBranchSession({
      id,
      type: 'memory_search',
      aiService: {
        getConfig: () => ({ contextWindowTokens: 256_000 }),
      } as any,
      workingDirectory: process.cwd(),
      logEnabled: false,
    });
    await session.runForTest();
  };

  try {
    delete process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED;
    await runSession('branch-checkpoint-default');

    process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED = 'false';
    await runSession('branch-checkpoint-legacy');

    assert.deepEqual(observed, [
      {
        enableCompression: false,
        checkpointCoordinator: true,
        episodeId: 'branch-checkpoint-default',
        persistentCheckpoint: false,
      },
      {
        enableCompression: true,
        checkpointCoordinator: false,
        episodeId: 'branch-checkpoint-legacy',
        persistentCheckpoint: false,
      },
    ]);
  } finally {
    ConversationRunner.prototype.run = originalRun;
    if (originalFlag === undefined) delete process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED = originalFlag;
  }
});
