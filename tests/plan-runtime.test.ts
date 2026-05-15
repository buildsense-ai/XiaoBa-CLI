import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { PlanRuntime } from '../src/core/plan-runtime';
import { ToolManager } from '../src/tools/tool-manager';

describe('PlanRuntime', () => {
  test('updates and formats a runtime plan', () => {
    const runtime = new PlanRuntime();

    const snapshot = runtime.update({
      steps: [
        { text: '检查链路', status: 'completed' },
        { text: '实现计划工具', status: 'in_progress' },
        { text: '跑测试', status: 'pending' },
      ],
    });

    assert.equal(snapshot.steps.length, 3);
    assert.equal(snapshot.steps[1].status, 'in_progress');
    assert.match(runtime.formatForPrompt() || '', /\[in_progress\] 实现计划工具/);
  });

  test('allows multiple in-progress steps for parallel work', () => {
    const runtime = new PlanRuntime();

    const snapshot = runtime.update({
      steps: [
        { text: 'A', status: 'in_progress' },
        { text: 'B', status: 'in_progress' },
      ],
    });

    assert.equal(snapshot.steps.length, 2);
    assert.equal(snapshot.steps.filter(step => step.status === 'in_progress').length, 2);
  });

  test('allows larger plans when the model decides they are useful', () => {
    const runtime = new PlanRuntime();

    const snapshot = runtime.update({
      steps: Array.from({ length: 15 }, (_, index) => ({
        text: `步骤 ${index + 1}`,
        status: index < 3 ? 'in_progress' : 'pending',
      })),
    });

    assert.equal(snapshot.steps.length, 15);
    assert.equal(snapshot.steps[2].status, 'in_progress');
  });

  test('keeps long plan steps intact instead of silently truncating them', () => {
    const runtime = new PlanRuntime();
    const longStep = '梳理运行时计划、子 agent 唤醒、停止取消、事件存储和多平台展示之间的完整链路，并标注每个入口、状态转换、边界条件与测试缺口。'.repeat(4);

    const snapshot = runtime.update({
      steps: [
        { text: longStep, status: 'in_progress' },
      ],
    });

    assert.equal(snapshot.steps[0].text, longStep);
  });

  test('update_plan tool updates runtime and emits CatsCompany runtime plan event', async () => {
    const runtime = new PlanRuntime();
    const sent: any[] = [];
    const manager = new ToolManager('/tmp/xiaoba-plan-runtime', {}, {
      enabledToolNames: ['update_plan'],
    });

    const result = await manager.executeTool({
      id: 'call-plan',
      type: 'function',
      function: {
        name: 'update_plan',
        arguments: JSON.stringify({
          steps: [
            { text: '确认需求', status: 'completed' },
            { text: '实现 runtime', status: 'in_progress' },
          ],
        }),
      },
    }, [], {
      planRuntime: runtime,
      channel: {
        chatId: 'topic-1',
        reply: async () => {},
        sendFile: async () => {},
        sendRuntimePlan: async (chatId, snapshot) => {
          sent.push({ chatId, snapshot });
        },
      },
    });

    assert.equal(result.ok, true);
    assert.match(result.content as string, /计划已更新/);
    assert.equal(runtime.getSnapshot().steps.length, 2);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, 'topic-1');
    assert.equal(sent[0].snapshot.steps[1].status, 'in_progress');
  });

  test('update_plan keeps runtime update when UI card push fails', async () => {
    const runtime = new PlanRuntime();
    const manager = new ToolManager('/tmp/xiaoba-plan-runtime', {}, {
      enabledToolNames: ['update_plan'],
    });

    const result = await manager.executeTool({
      id: 'call-plan-fail-ui',
      type: 'function',
      function: {
        name: 'update_plan',
        arguments: JSON.stringify({
          steps: [
            { text: '先更新内存计划', status: 'in_progress' },
          ],
        }),
      },
    }, [], {
      planRuntime: runtime,
      channel: {
        chatId: 'topic-1',
        reply: async () => {},
        sendFile: async () => {},
        sendRuntimePlan: async () => {
          throw new Error('ui offline');
        },
      },
    });

    assert.equal(result.ok, true);
    assert.match(result.content as string, /计划已更新/);
    assert.match(result.content as string, /计划卡片推送失败/);
    assert.equal(runtime.getSnapshot().steps[0].text, '先更新内存计划');
  });
});
