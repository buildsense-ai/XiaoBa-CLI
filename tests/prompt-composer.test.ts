import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';
import { PromptComposer } from '../src/runtime/prompt-composer';
import { resolveDefaultRuntimeProfile } from '../src/runtime/runtime-profile';

const require = createRequire(import.meta.url);

describe('PromptComposer', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-composer-'));
    writePrompt('runtime-context.md', DEFAULT_RUNTIME_CONTEXT_PROMPT);
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('composes base prompt and runtime info in the current order', () => {
    writePrompt('system-prompt.md', 'Base prompt\n');

    const prompt = PromptComposer.composeSystemPrompt({
      promptsDir: testRoot,
      env: {
        CURRENT_AGENT_DISPLAY_NAME: 'Desk Bot',
        CURRENT_PLATFORM: 'feishu',
      },
      now: new Date('2026-05-01T12:00:00.000Z'),
    });

    assert.equal(prompt, [
      'Base prompt',
      [
        '你在这个平台上的名字是：Desk Bot',
        '当前平台：feishu',
        '当前日期：2026-05-01',
        '当前目录会在每次模型请求中作为临时上下文消息提供。相对文件路径和 shell 路径默认以该当前目录为准。',
        '如果用户要求检查项目、仓库或源码，先把当前目录视为最可能的项目根目录。',
        '不要把 Electron userData、AppData、日志目录或缓存目录误认为源码仓库，除非用户明确要求查看这些运行时文件。',
        '如果当前目录不像用户要求的产品或服务，先做小范围路径检查，或询问正确仓库位置。',
      ].join('\n'),
    ].join('\n\n'));
  });

  test('ignores legacy behavior prompt files', () => {
    writePrompt('system-prompt.md', 'Base prompt');
    writePrompt('behavior.md', 'Legacy behavior prompt that must not be loaded');

    const prompt = PromptComposer.composeSystemPrompt({
      promptsDir: testRoot,
      env: {},
      now: new Date('2026-05-01T12:00:00.000Z'),
    });

    assert.equal(prompt, [
      'Base prompt',
      [
        '当前日期：2026-05-01',
        '当前目录会在每次模型请求中作为临时上下文消息提供。相对文件路径和 shell 路径默认以该当前目录为准。',
        '如果用户要求检查项目、仓库或源码，先把当前目录视为最可能的项目根目录。',
        '不要把 Electron userData、AppData、日志目录或缓存目录误认为源码仓库，除非用户明确要求查看这些运行时文件。',
        '如果当前目录不像用户要求的产品或服务，先做小范围路径检查，或询问正确仓库位置。',
      ].join('\n'),
    ].join('\n\n'));
    assert.doesNotMatch(prompt, /Legacy behavior prompt/);
  });

  test('throws when required system prompt file is missing', () => {
    assert.throws(
      () => PromptComposer.composeSystemPrompt({
        promptsDir: testRoot,
        env: {},
        now: new Date('2026-05-01T12:00:00.000Z'),
      }),
      /Required prompt file is missing or unreadable: system-prompt\.md/,
    );
  });

  test('trims platform and blank display name whitespace', () => {
    writePrompt('system-prompt.md', 'Base prompt');

    const blankDisplayNamePrompt = PromptComposer.composeSystemPrompt({
      promptsDir: testRoot,
      env: {
        CURRENT_AGENT_DISPLAY_NAME: '   ',
        BOT_BRIDGE_NAME: 'Bridge Bot',
        CURRENT_PLATFORM: ' feishu ',
      },
      now: new Date('2026-05-01T12:00:00.000Z'),
    });

    assert.doesNotMatch(blankDisplayNamePrompt, /你在这个平台上的名字是/);
    assert.match(blankDisplayNamePrompt, /当前平台：feishu/);
    assert.match(blankDisplayNamePrompt, /当前目录会在每次模型请求中作为临时上下文消息提供/);
    assert.match(blankDisplayNamePrompt, /Electron userData/);
  });

  test('PromptManager delegates to PromptComposer without changing output', async () => {
    writePrompt('system-prompt.md', 'Base prompt\n');

    delete require.cache[require.resolve('../src/utils/prompt-manager')];
    const { PromptManager } = require('../src/utils/prompt-manager');
    const originalPromptsDir = (PromptManager as any).promptsDir;
    const originalEnv = { ...process.env };

    try {
      (PromptManager as any).promptsDir = testRoot;
      process.env.CURRENT_AGENT_DISPLAY_NAME = 'Desk Bot';
      process.env.CURRENT_PLATFORM = 'feishu';
      delete process.env.BOT_BRIDGE_NAME;

      const managerPrompt = await PromptManager.buildSystemPrompt();
      const dateMatch = managerPrompt.match(/当前日期：(\d{4}-\d{2}-\d{2})/);
      assert.ok(dateMatch);

      const composerPrompt = PromptComposer.composeSystemPrompt({
        promptsDir: testRoot,
        env: process.env,
        now: new Date(`${dateMatch[1]}T12:00:00.000Z`),
      });

      assert.equal(managerPrompt, composerPrompt);
    } finally {
      (PromptManager as any).promptsDir = originalPromptsDir;
      process.env = originalEnv;
    }
  });

  test('profile-aware composition uses transient current-directory guidance instead of concrete profile path', () => {
    writePrompt('system-prompt.md', 'Base prompt\n');
    const env = {
      CURRENT_AGENT_DISPLAY_NAME: 'Desk Bot',
      CURRENT_PLATFORM: 'feishu',
    };
    const now = new Date('2026-05-01T12:00:00.000Z');
    const profile = resolveDefaultRuntimeProfile({
      surface: 'feishu',
      workingDirectory: '/tmp/xiaoba-runtime-profile',
      env,
    });

    const prompt = PromptComposer.composeSystemPromptFromProfile({
      promptsDir: testRoot,
      profile,
      now,
    });

    assert.match(prompt, /你在这个平台上的名字是：Desk Bot/);
    assert.match(prompt, /当前平台：feishu/);
    assert.match(prompt, /当前目录会在每次模型请求中作为临时上下文消息提供/);
    assert.match(prompt, /最可能的项目根目录/);
    assert.doesNotMatch(prompt.replace(/\\/g, '/'), /\/tmp\/xiaoba-runtime-profile/);
  });

  test('legacy env composition keeps current default workspace text when prompt metadata is empty', () => {
    writePrompt('system-prompt.md', 'Base prompt');
    const now = new Date('2026-05-01T12:00:00.000Z');

    const prompt = PromptComposer.composeSystemPrompt({
      promptsDir: testRoot,
      env: {},
      now,
    });

    assert.equal(prompt, [
      'Base prompt',
      [
        '当前日期：2026-05-01',
        '当前目录会在每次模型请求中作为临时上下文消息提供。相对文件路径和 shell 路径默认以该当前目录为准。',
        '如果用户要求检查项目、仓库或源码，先把当前目录视为最可能的项目根目录。',
        '不要把 Electron userData、AppData、日志目录或缓存目录误认为源码仓库，除非用户明确要求查看这些运行时文件。',
        '如果当前目录不像用户要求的产品或服务，先做小范围路径检查，或询问正确仓库位置。',
      ].join('\n'),
    ].join('\n\n'));
  });

  test('profile-aware composition trims displayName and platform whitespace', () => {
    writePrompt('system-prompt.md', 'Base prompt');
    const profile = resolveDefaultRuntimeProfile({
      displayName: 'Top Level Name',
      surface: 'feishu',
      workingDirectory: '/tmp/xiaoba-runtime-profile',
      env: {},
    });
    profile.prompt.displayName = '  Desk Bot  ';
    profile.prompt.platform = ' feishu ';

    const prompt = PromptComposer.composeSystemPromptFromProfile({
      promptsDir: testRoot,
      profile,
      now: new Date('2026-05-01T12:00:00.000Z'),
    });

    assert.match(prompt, /你在这个平台上的名字是：Desk Bot/);
    assert.match(prompt, /当前平台：feishu/);
    assert.match(prompt, /当前目录会在每次模型请求中作为临时上下文消息提供/);
    assert.match(prompt, /日志目录或缓存目录/);
    assert.doesNotMatch(prompt.replace(/\\/g, '/'), /\/tmp\/xiaoba-runtime-profile/);
  });

  function writePrompt(filename: string, content: string): void {
    fs.writeFileSync(path.join(testRoot, filename), content, 'utf-8');
  }
});

const DEFAULT_RUNTIME_CONTEXT_PROMPT = `{{#displayName}}你在这个平台上的名字是：{{displayName}}
{{/displayName}}{{#platform}}当前平台：{{platform}}
{{/platform}}当前日期：{{date}}
当前目录会在每次模型请求中作为临时上下文消息提供。相对文件路径和 shell 路径默认以该当前目录为准。
如果用户要求检查项目、仓库或源码，先把当前目录视为最可能的项目根目录。
不要把 Electron userData、AppData、日志目录或缓存目录误认为源码仓库，除非用户明确要求查看这些运行时文件。
如果当前目录不像用户要求的产品或服务，先做小范围路径检查，或询问正确仓库位置。
`;
