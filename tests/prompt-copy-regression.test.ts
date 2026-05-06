import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { SubAgentManager } from '../src/core/sub-agent-manager';
import { SendFileTool } from '../src/tools/send-file-tool';
import { SpawnSubagentTool } from '../src/tools/spawn-subagent-tool';

describe('prompt copy regression', () => {
  test('registered tool descriptions do not instruct the model to use a reply tool', () => {
    const descriptions = [
      new SendFileTool().definition.description,
      new SpawnSubagentTool().definition.description,
    ].join('\n');

    assert.doesNotMatch(descriptions, /reply 工具/);
    assert.doesNotMatch(descriptions, /用 reply/);
    assert.doesNotMatch(descriptions, /reply 和 send_file/);
  });

  test('spawn_subagent handoff result does not instruct the model to use a reply tool', async () => {
    const originalGetInstance = SubAgentManager.getInstance;
    (SubAgentManager as any).getInstance = () => ({
      spawn() {
        return {
          id: 'sub-test',
          skillName: 'demo-skill',
          taskDescription: 'demo task',
          status: 'running',
          createdAt: Date.now(),
          progressLog: [],
          outputFiles: [],
        };
      },
    });

    try {
      const result = await new SpawnSubagentTool().execute({
        skill_name: 'demo-skill',
        task_description: 'demo task',
        user_message: 'run demo task',
      }, {
        workingDirectory: process.cwd(),
        conversationHistory: [],
        sessionId: 'cli',
      });

      assert.equal(result.ok, true);
      const content = result.ok ? result.content : result.message;
      assert.doesNotMatch(content, /reply 工具/);
      assert.doesNotMatch(content, /用 reply/);
      assert.doesNotMatch(content, /reply 和 send_file/);
    } finally {
      (SubAgentManager as any).getInstance = originalGetInstance;
    }
  });
});
