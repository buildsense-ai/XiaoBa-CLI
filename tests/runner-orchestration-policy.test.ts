import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  buildExplicitPlanRequestHintIfUseful,
  buildInitialDecisionHintIfUseful,
  buildPerTurnRunnerHint,
  buildPlanSoftNudge,
  buildSubagentSoftNudge,
  shouldAddPlanSoftNudge,
  shouldAddSubagentSoftNudge,
  TRANSIENT_RUNNER_HINT_PREFIX,
} from '../src/core/runner-orchestration-policy';
import type { Message } from '../src/types';
import type { ToolDefinition } from '../src/types/tool';

const tools = [
  { name: 'update_plan', description: '', parameters: { type: 'object', properties: {} } },
  { name: 'spawn_subagent', description: '', parameters: { type: 'object', properties: {} } },
] as ToolDefinition[];

function user(content: string): Message[] {
  return [{ role: 'user', content }];
}

describe('runner orchestration policy', () => {
  test('builds a per-turn system runner hint', () => {
    const hint = buildPerTurnRunnerHint(tools);

    assert.equal(hint.role, 'system');
    assert.ok(String(hint.content).startsWith(TRANSIENT_RUNNER_HINT_PREFIX));
    assert.doesNotMatch(String(hint.content), /每一轮/);
    assert.match(String(hint.content), /update_plan/);
    assert.match(String(hint.content), /spawn_subagent/);
  });

  test('adds a semantic hint for complex work without forcing a tool call', () => {
    const hint = buildInitialDecisionHintIfUseful(user([
      '帮我全面检查当前项目发布前的质量风险，重点看设置页、停止按钮、日志链路和测试覆盖。',
      '先不要改代码，最后给我结论、证据和建议。',
    ].join('\n')), tools);

    assert.ok(hint);
    assert.equal(hint?.role, 'system');
    assert.match(String(hint?.content), new RegExp(TRANSIENT_RUNNER_HINT_PREFIX));
    assert.match(String(hint?.content), /语义编排提示/);
    assert.match(String(hint?.content), /不是硬性要求|可用编排动作/);
  });

  test('does not inject orchestration hints for meta questions about plan/subagent', () => {
    const hint = buildInitialDecisionHintIfUseful(user('为什么刚才没有触发 plan 和子 agent？'), tools);
    assert.equal(hint, null);
  });

  test('recognizes explicit plan requests as update_plan hints', () => {
    const hint = buildExplicitPlanRequestHintIfUseful(user('先给我列个执行计划，然后再开始检查。'), tools);

    assert.ok(hint);
    assert.match(String(hint?.content), /update_plan/);
    assert.match(String(hint?.content), /普通回复/);
  });

  test('soft nudges are threshold based and stop after the relevant action', () => {
    assert.equal(shouldAddPlanSoftNudge(tools, 2, 10, false, 4), false);
    assert.equal(shouldAddPlanSoftNudge(tools, 3, 4, false, 4), true);
    assert.equal(shouldAddPlanSoftNudge(tools, 3, 20, true, 4), false);
    assert.match(String(buildPlanSoftNudge(3, 4, 0).content), /不是硬性要求/);

    assert.equal(shouldAddSubagentSoftNudge(tools, 5, 20, false, 8), false);
    assert.equal(shouldAddSubagentSoftNudge(tools, 6, 8, false, 8), true);
    assert.equal(shouldAddSubagentSoftNudge(tools, 6, 20, true, 8), false);
    assert.match(String(buildSubagentSoftNudge(6, 8, 0).content), /不是硬性要求/);
  });
});
