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
    assert.match(descriptions, /调用成功后立即返回，不等待任务完成/);
    assert.match(descriptions, /只有本工具成功返回的展示名和 ID 才算真实已派出/);
    assert.match(descriptions, /不要编造子智能体或 sub-\.\.\. ID/);
    assert.match(descriptions, /简单问答、短链路排查和很快能完成的小任务不要用/);
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
      assert.match(content, /已派遣 子智能体 \(sub-test\)/);
      assert.match(content, /完成后会以后台结果通知回到主会话/);
      assert.match(content, /你仍负责主线推进和最终回复/);
      assert.doesNotMatch(content, /可以继续调用 spawn_subagent 派发/);
    } finally {
      (SubAgentManager as any).getInstance = originalGetInstance;
    }
  });
});
