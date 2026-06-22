import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { TRANSIENT_MODE_HINT_PREFIX, detectPromptMode } from '../src/runtime/prompt-modes';
import type { Message } from '../src/types';

describe('prompt modes', () => {
  test('detects task modes from user text', () => {
    assert.equal(detectPromptMode('帮我看一下这个 npm build 报错')?.mode, 'coding-agent');
    assert.equal(detectPromptMode('帮老师生成一份课堂练习题')?.mode, 'classroom');
    assert.equal(detectPromptMode('把这个 PPT 报告整理一下')?.mode, 'office');
    assert.equal(detectPromptMode('整理会议纪要和任务负责人')?.mode, 'team-assistant');
    assert.equal(detectPromptMode('今天天气怎么样'), undefined);
  });

  test('injects dynamic mode hint as transient user context, not system', async () => {
    const builder = new TurnContextBuilder();
    const durableMessages: Message[] = [
      { role: 'system', content: 'base system' },
      { role: 'user', content: '帮我看一下这个项目为什么测试失败' },
    ];

    const result = await builder.build({
      sessionKey: 'cli',
      durableMessages,
      runtimeFeedback: [],
      skillRuntime: {
        reloadSkills: async () => {},
        buildSkillsListMessage: () => undefined,
      } as any,
    });

    const modeHint = result.messages.find(message => (
      message.__injected
      && message.role === 'user'
      && typeof message.content === 'string'
      && message.content.startsWith(TRANSIENT_MODE_HINT_PREFIX)
    ));

    assert.ok(modeHint);
    assert.match(String(modeHint.content), /Matched mode: coding-agent/);
    assert.equal(result.messages.some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.startsWith(TRANSIENT_MODE_HINT_PREFIX)
    )), false);

    const durable = builder.removeTransientMessages(result.messages);
    assert.equal(durable.some(message => (
      typeof message.content === 'string'
      && message.content.startsWith(TRANSIENT_MODE_HINT_PREFIX)
    )), false);
  });
});
