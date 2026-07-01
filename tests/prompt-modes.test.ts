import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import {
  TRANSIENT_FIXED_PROMPT_MODE_PREFIX,
  TRANSIENT_PROMPT_MODES_LIST_PREFIX,
  buildPromptModesListMessage,
  clearPromptModeRegistryCache,
  findFixedPromptModeState,
  findPreviousPromptModeState,
  listPromptModeDefinitions,
  loadPromptModePrompt,
} from '../src/runtime/prompt-modes';
import type { Message } from '../src/types';

describe('prompt modes', () => {
  test('loads prompt modes from mode files instead of TypeScript enums', () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-modes-'));
    try {
      fs.mkdirSync(path.join(testRoot, 'modes'), { recursive: true });
      fs.writeFileSync(path.join(testRoot, 'modes', 'research.md'), [
        '---',
        'id: research',
        'name: Research mode',
        'description: Literature and citation work',
        '---',
        '',
        'Use careful research behavior.',
      ].join('\n'), 'utf-8');
      clearPromptModeRegistryCache();

      assert.deepEqual(listPromptModeDefinitions(testRoot).map(mode => mode.id), ['research']);
      assert.match(buildPromptModesListMessage({ promptsDir: testRoot })?.content || '', /research: Research mode/);
      assert.match(loadPromptModePrompt(testRoot, 'research') || '', /\[mode:research\]/);
      assert.match(loadPromptModePrompt(testRoot, 'research') || '', /Use careful research behavior/);
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
      clearPromptModeRegistryCache();
    }
  });

  test('does not inject selectable prompt modes into the main agent context', async () => {
    const builder = new TurnContextBuilder();
    const durableMessages: Message[] = [
      { role: 'system', content: 'base system' },
      { role: 'user', content: '帮我看一下这个 npm build 报错' },
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

    assert.equal(result.messages.some(message => (
      typeof message.content === 'string'
      && message.content.startsWith(TRANSIENT_PROMPT_MODES_LIST_PREFIX)
    )), false);
  });

  test('loads built-in plain-chat mode definition and prompt', () => {
    clearPromptModeRegistryCache();

    const definitions = listPromptModeDefinitions();
    const plainChat = definitions.find(mode => mode.id === 'plain-chat');

    assert.ok(plainChat);
    assert.equal(plainChat.title, '普通对话模式');
    assert.match(plainChat.description, /角色扮演/);

    const prompt = loadPromptModePrompt(path.join(process.cwd(), 'prompts'), 'plain-chat') || '';
    assert.match(prompt, /\[mode:plain-chat\]/);
    assert.match(prompt, /普通对话模式/);
    assert.match(prompt, /不反复强调“我是 AI”/);
  });

  test('injects previously active prompt mode as facts, not an automatic decision', async () => {
    const builder = new TurnContextBuilder();
    const durableMessages: Message[] = [
      { role: 'system', content: 'base system' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_mode',
          type: 'function',
          function: {
            name: 'prompt_mode',
            arguments: JSON.stringify({ mode: 'coding-agent' }),
          },
        }],
      },
      {
        role: 'tool',
        name: 'prompt_mode',
        tool_call_id: 'call_mode',
        content: 'Prompt mode "coding-agent" loaded.\n\n[mode:coding-agent]\nfull instructions',
      },
      { role: 'assistant', content: '我看一下。' },
      { role: 'user', content: '继续' },
    ];

    const previous = findPreviousPromptModeState(durableMessages);
    assert.equal(previous?.mode, 'coding-agent');
    assert.equal(previous?.turnsSinceLoaded, 1);

    const result = await builder.build({
      sessionKey: 'cli',
      durableMessages,
      runtimeFeedback: [],
      skillRuntime: {
        reloadSkills: async () => {},
        buildSkillsListMessage: () => undefined,
      } as any,
    });

    const modeList = result.messages.find(message => (
      message.role === 'user'
      && message.__injected
      && typeof message.content === 'string'
      && message.content.startsWith(TRANSIENT_PROMPT_MODES_LIST_PREFIX)
    ));

    assert.equal(modeList, undefined);
  });

  test('fixed prompt mode suppresses selectable mode list', async () => {
    const builder = new TurnContextBuilder();
    const durableMessages: Message[] = [
      { role: 'system', content: 'base system\n[mode:coding-agent]\nfixed coding instructions' },
      { role: 'user', content: '帮我整理一个 PPT' },
    ];

    const fixed = findFixedPromptModeState(durableMessages);
    assert.equal(fixed?.mode, 'coding-agent');

    const result = await builder.build({
      sessionKey: 'cli',
      durableMessages,
      runtimeFeedback: [],
      skillRuntime: {
        reloadSkills: async () => {},
        buildSkillsListMessage: () => undefined,
      } as any,
    });

    const fixedMessage = result.messages.find(message => (
      message.role === 'user'
      && message.__injected
      && typeof message.content === 'string'
      && message.content.startsWith(TRANSIENT_FIXED_PROMPT_MODE_PREFIX)
    ));

    assert.ok(fixedMessage);
    assert.match(String(fixedMessage.content), /Fixed prompt mode active: coding-agent/);
    assert.match(String(fixedMessage.content), /already part of the system prompt/);
    assert.equal(result.messages.some(message => (
      message.role === 'user'
      && message.__injected
      && typeof message.content === 'string'
      && message.content.startsWith(TRANSIENT_PROMPT_MODES_LIST_PREFIX)
    )), false);
  });

  test('prompt mode routing suppresses selectable mode list but keeps fixed mode status', async () => {
    const builder = new TurnContextBuilder();
    const routed = await builder.build({
      sessionKey: 'cli',
      durableMessages: [
        { role: 'system', content: 'base system' },
        { role: 'user', content: 'debug this build' },
      ],
      runtimeFeedback: [],
      skillRuntime: {
        reloadSkills: async () => {},
        buildSkillsListMessage: () => undefined,
      } as any,
      promptModeRoutingEnabled: true,
    });

    assert.equal(routed.messages.some(message => (
      message.role === 'user'
      && message.__injected
      && typeof message.content === 'string'
      && message.content.startsWith(TRANSIENT_PROMPT_MODES_LIST_PREFIX)
    )), false);

    const fixed = await builder.build({
      sessionKey: 'cli',
      durableMessages: [
        { role: 'system', content: 'base system\n[mode:coding-agent]\nfixed coding instructions' },
        { role: 'user', content: 'debug this build' },
      ],
      runtimeFeedback: [],
      skillRuntime: {
        reloadSkills: async () => {},
        buildSkillsListMessage: () => undefined,
      } as any,
      promptModeRoutingEnabled: true,
    });

    assert.equal(fixed.messages.some(message => (
      message.role === 'user'
      && message.__injected
      && typeof message.content === 'string'
      && message.content.startsWith(TRANSIENT_FIXED_PROMPT_MODE_PREFIX)
    )), true);
    assert.equal(fixed.messages.some(message => (
      message.role === 'user'
      && message.__injected
      && typeof message.content === 'string'
      && message.content.startsWith(TRANSIENT_PROMPT_MODES_LIST_PREFIX)
    )), false);
  });
});
