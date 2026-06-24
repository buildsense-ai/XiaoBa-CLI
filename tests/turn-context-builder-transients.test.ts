import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { TRANSIENT_RUNNER_HINT_PREFIX } from '../src/core/runner-orchestration-policy';
import { TRANSIENT_SUBAGENT_STATUS_PREFIX } from '../src/core/sub-agent-observation';
import { TRANSIENT_SKILLS_LIST_PREFIX } from '../src/skills/session-skill-runtime';
import { Message } from '../src/types';

describe('TurnContextBuilder transient cache safety', () => {
  test('removes old system transients and new injected user transients', () => {
    const builder = new TurnContextBuilder();
    const messages: Message[] = [
      { role: 'system', content: 'base system prompt' },
      { role: 'system', content: '[transient_plan_status]\nold plan' },
      { role: 'system', content: `${TRANSIENT_SUBAGENT_STATUS_PREFIX}\nold subagent` },
      { role: 'system', content: `${TRANSIENT_SKILLS_LIST_PREFIX}\nold skills` },
      { role: 'system', content: `${TRANSIENT_RUNNER_HINT_PREFIX}\nsystem runner hint` },
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

  test('does not put dynamic non-runner transient prompt messages into system context', async () => {
    const builder = new TurnContextBuilder();
    const result = await builder.build({
      sessionKey: 'test-session',
      durableMessages: [
        { role: 'system', content: 'stable base system' },
        { role: 'system', content: '[transient_skills_list]\nlegacy transient should be dropped' },
        { role: 'user', content: 'hello' },
      ],
      runtimeFeedback: [],
      planRuntime: {
        formatForPrompt: () => 'current plan status',
      } as any,
      skillRuntime: {
        reloadSkills: async () => undefined,
        buildSkillsListMessage: () => ({
          role: 'system',
          content: '[transient_skills_list]\nuse skill tool by name',
          __injected: true,
        } as Message),
      } as any,
    });

    const transientMessages = result.messages
      .filter(isTransientPromptMessage)
      .filter(message => !String(message.content).startsWith('[transient_runtime_observation_rules]'));
    assert.ok(transientMessages.length >= 2, 'expected plan and skills transient messages');
    assert.equal(
      transientMessages.some(message => message.role === 'system'),
      false,
      'non-runner transient prompt messages must not enter system context',
    );
    assert.ok(transientMessages.every(message => message.role === 'user'));
    assert.ok(transientMessages.every(message => message.__injected === true));

    const systemText = result.messages
      .filter(message => message.role === 'system')
      .map(message => String(message.content))
      .join('\n');
    assert.doesNotMatch(systemText, /\[transient_(plan_status|skills_list|subagent_status|runner_hint|soft_check)/);
  });

  test('removes injected transient user messages from durable history', () => {
    const builder = new TurnContextBuilder();
    const durable = builder.removeTransientMessages([
      { role: 'system', content: 'stable base system' },
      { role: 'user', content: '[transient_plan_status]\nplan', __injected: true },
      { role: 'user', content: '[transient_skills_list]\nskills', __injected: true },
      { role: 'user', content: 'real user message' },
    ]);

    assert.deepEqual(durable, [
      { role: 'system', content: 'stable base system' },
      { role: 'user', content: 'real user message' },
    ]);
  });
});

function isTransientPromptMessage(message: Message): boolean {
  return typeof message.content === 'string' && message.content.startsWith('[transient_');
}
