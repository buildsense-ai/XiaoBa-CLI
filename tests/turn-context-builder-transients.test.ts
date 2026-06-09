import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { TRANSIENT_RUNNER_HINT_PREFIX } from '../src/core/runner-orchestration-policy';
import { TRANSIENT_SUBAGENT_STATUS_PREFIX } from '../src/core/sub-agent-observation';
import { TRANSIENT_SKILLS_LIST_PREFIX } from '../src/skills/session-skill-runtime';
import type { Message } from '../src/types';

describe('TurnContextBuilder transient cleanup', () => {
  test('removes old system transients and new injected user transients', () => {
    const builder = new TurnContextBuilder();
    const messages: Message[] = [
      { role: 'system', content: 'base system prompt' },
      { role: 'system', content: '[transient_plan_status]\nold plan' },
      { role: 'system', content: `${TRANSIENT_SUBAGENT_STATUS_PREFIX}\nold subagent` },
      { role: 'system', content: `${TRANSIENT_SKILLS_LIST_PREFIX}\nold skills` },
      { role: 'user', content: '[transient_plan_status]\nnew plan', __injected: true },
      { role: 'user', content: `${TRANSIENT_RUNNER_HINT_PREFIX}\nnew hint`, __injected: true },
      { role: 'user', content: '[transient_soft_check]\nnew soft check', __injected: true },
      { role: 'user', content: `${TRANSIENT_SUBAGENT_STATUS_PREFIX}\nnew subagent`, __injected: true },
      { role: 'user', content: `${TRANSIENT_SKILLS_LIST_PREFIX}\nnew skills`, __injected: true },
      { role: 'user', content: '[transient_plan_status]\nuser typed this literally' },
      { role: 'user', content: 'latest real request' },
    ];

    const cleaned = builder.removeTransientMessages(messages);

    assert.deepEqual(cleaned.map(message => message.content), [
      'base system prompt',
      '[transient_plan_status]\nuser typed this literally',
      'latest real request',
    ]);
  });
});
