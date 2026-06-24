import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { SubAgentManager } from '../src/core/sub-agent-manager';
import { SendFileTool } from '../src/tools/send-file-tool';
import { SendTextTool } from '../src/tools/send-text-tool';
import { SpawnSubagentTool } from '../src/tools/spawn-subagent-tool';

describe('prompt copy regression', () => {
  test('registered tool descriptions do not instruct the model to use a reply tool', () => {
    const descriptions = [
      new SendTextTool().definition.description,
      new SendFileTool().definition.description,
      new SpawnSubagentTool().definition.description,
    ].join('\n');

    assert.doesNotMatch(descriptions, /reply 工具/);
    assert.doesNotMatch(descriptions, /用 reply/);
    assert.doesNotMatch(descriptions, /reply 和 send_file/);
    assert.doesNotMatch(descriptions, /50-150/);
    assert.doesNotMatch(descriptions, /超过 150 字/);
    assert.doesNotMatch(descriptions, /分成多段/);
    assert.match(descriptions, /调用成功后立即返回，不等待完成/);
    assert.match(descriptions, /只有本工具返回的展示名和 ID 才是真实子智能体引用/);
    assert.match(descriptions, /不要编造子智能体或 sub-\.\.\. ID/);
    assert.match(descriptions, /当前主线必须由主 agent 继续推进/);
    assert.match(descriptions, /普通最终回复可以直接作为 assistant 内容返回/);
    assert.match(descriptions, /只代表普通文本已发送/);
    assert.match(descriptions, /不要用它声称文件、附件、预览、HTML 报告或其他富媒体产物已经生成或交付/);
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
