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
      defaultSystemPrompt: 'Fallback prompt',
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
        'Current directory is provided in a transient message for each model request. Use that current directory for relative file and shell paths.',
        'If the user asks you to inspect a project, repository, or source code, treat the current directory as the likely project root first.',
        'Do not mistake Electron userData, AppData, logs, or cache directories for the source repository unless the user explicitly asks about those runtime files.',
        'If the current directory does not appear to contain the requested product or service, do a small path check or ask for the correct repository instead of repeatedly scanning the wrong directory.',
      ].join('\n'),
    ].join('\n\n'));
  });

  test('ignores legacy behavior prompt files', () => {
    writePrompt('system-prompt.md', 'Base prompt');
    writePrompt('behavior.md', 'Legacy behavior prompt that must not be loaded');

    const prompt = PromptComposer.composeSystemPrompt({
      promptsDir: testRoot,
      defaultSystemPrompt: 'Fallback prompt',
      env: {},
      now: new Date('2026-05-01T12:00:00.000Z'),
    });

    assert.equal(prompt, [
      'Base prompt',
      [
        '当前日期：2026-05-01',
        'Current directory is provided in a transient message for each model request. Use that current directory for relative file and shell paths.',
        'If the user asks you to inspect a project, repository, or source code, treat the current directory as the likely project root first.',
        'Do not mistake Electron userData, AppData, logs, or cache directories for the source repository unless the user explicitly asks about those runtime files.',
        'If the current directory does not appear to contain the requested product or service, do a small path check or ask for the correct repository instead of repeatedly scanning the wrong directory.',
      ].join('\n'),
    ].join('\n\n'));
    assert.doesNotMatch(prompt, /Legacy behavior prompt/);
  });

  test('falls back to default system prompt when system prompt file is missing', () => {
    const prompt = PromptComposer.composeSystemPrompt({
      promptsDir: testRoot,
      defaultSystemPrompt: 'Fallback prompt',
      env: {},
      now: new Date('2026-05-01T12:00:00.000Z'),
    });

    assert.match(prompt, /^Fallback prompt\n\n当前日期：2026-05-01/);
  });

  test('loads an alternate prompt file from a runtime profile', () => {
    writePrompt('system-prompt.md', 'Default base prompt');
    writePrompt('signal-catcher-system-prompt.md', 'Signal Catcher base prompt');
    const profile = resolveDefaultRuntimeProfile({
      surface: 'cli',
      workingDirectory: '/tmp/xiaoba-runtime-profile',
      env: {},
    });
    profile.prompt.file = 'signal-catcher-system-prompt.md';

    const prompt = PromptComposer.composeSystemPromptFromProfile({
      promptsDir: testRoot,
      defaultSystemPrompt: 'Fallback prompt',
      profile,
      now: new Date('2026-05-01T12:00:00.000Z'),
    });

    assert.match(prompt, /^Signal Catcher base prompt\n\n当前日期：2026-05-01/);
    assert.doesNotMatch(prompt, /Default base prompt/);
  });

  test('can disable runtime info for immersive roleplay prompts', () => {
    writePrompt('signal-catcher-system-prompt.md', 'Signal Catcher base prompt');
    const profile = resolveDefaultRuntimeProfile({
      surface: 'cli',
      workingDirectory: '/tmp/xiaoba-runtime-profile',
      env: {
        CURRENT_AGENT_DISPLAY_NAME: 'Desk Bot',
        CURRENT_PLATFORM: 'cli',
      },
    });
    profile.prompt.file = 'signal-catcher-system-prompt.md';
    profile.prompt.runtimeInfo = false;

    const prompt = PromptComposer.composeSystemPromptFromProfile({
      promptsDir: testRoot,
      defaultSystemPrompt: 'Fallback prompt',
      profile,
      now: new Date('2026-05-01T12:00:00.000Z'),
    });

    assert.equal(prompt, 'Signal Catcher base prompt');
    assert.doesNotMatch(prompt, /Current directory/);
    assert.doesNotMatch(prompt, /当前日期/);
  });

  test('PromptManager fallback default prompt is not hardcoded to XiaoBa identity', () => {
    delete require.cache[require.resolve('../src/utils/prompt-manager')];
    const { PromptManager } = require('../src/utils/prompt-manager');
    const fallbackPrompt = PromptManager.getDefaultSystemPrompt();

    assert.match(fallbackPrompt, /你是用户的私人助理/);
    assert.doesNotMatch(fallbackPrompt, /你是小八/);
  });

  test('keeps current env whitespace behavior', () => {
    writePrompt('system-prompt.md', 'Base prompt');

    const blankDisplayNamePrompt = PromptComposer.composeSystemPrompt({
      promptsDir: testRoot,
      defaultSystemPrompt: 'Fallback prompt',
      env: {
        CURRENT_AGENT_DISPLAY_NAME: '   ',
        BOT_BRIDGE_NAME: 'Bridge Bot',
        CURRENT_PLATFORM: ' feishu ',
      },
      now: new Date('2026-05-01T12:00:00.000Z'),
    });

    assert.doesNotMatch(blankDisplayNamePrompt, /你在这个平台上的名字是/);
    assert.match(blankDisplayNamePrompt, /当前平台： feishu /);
    assert.match(blankDisplayNamePrompt, /Current directory is provided in a transient message/);
    assert.match(blankDisplayNamePrompt, /Do not mistake Electron userData/);
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
        defaultSystemPrompt: (PromptManager as any).getDefaultSystemPrompt(),
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
      defaultSystemPrompt: 'Fallback prompt',
      profile,
      now,
    });

    assert.match(prompt, /你在这个平台上的名字是：Desk Bot/);
    assert.match(prompt, /当前平台：feishu/);
    assert.match(prompt, /Current directory is provided in a transient message/);
    assert.match(prompt, /likely project root first/);
    assert.doesNotMatch(prompt.replace(/\\/g, '/'), /\/tmp\/xiaoba-runtime-profile/);
  });

  test('legacy env composition keeps current default workspace text when prompt metadata is empty', () => {
    writePrompt('system-prompt.md', 'Base prompt');
    const now = new Date('2026-05-01T12:00:00.000Z');

    const prompt = PromptComposer.composeSystemPrompt({
      promptsDir: testRoot,
      defaultSystemPrompt: 'Fallback prompt',
      env: {},
      now,
    });

    assert.equal(prompt, [
      'Base prompt',
      [
        '当前日期：2026-05-01',
        'Current directory is provided in a transient message for each model request. Use that current directory for relative file and shell paths.',
        'If the user asks you to inspect a project, repository, or source code, treat the current directory as the likely project root first.',
        'Do not mistake Electron userData, AppData, logs, or cache directories for the source repository unless the user explicitly asks about those runtime files.',
        'If the current directory does not appear to contain the requested product or service, do a small path check or ask for the correct repository instead of repeatedly scanning the wrong directory.',
      ].join('\n'),
    ].join('\n\n'));
  });

  test('profile-aware composition trims displayName but keeps platform whitespace', () => {
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
      defaultSystemPrompt: 'Fallback prompt',
      profile,
      now: new Date('2026-05-01T12:00:00.000Z'),
    });

    assert.match(prompt, /你在这个平台上的名字是：Desk Bot/);
    assert.match(prompt, /当前平台： feishu /);
    assert.match(prompt, /Current directory is provided in a transient message/);
    assert.match(prompt, /logs, or cache directories/);
    assert.doesNotMatch(prompt.replace(/\\/g, '/'), /\/tmp\/xiaoba-runtime-profile/);
  });

  function writePrompt(filename: string, content: string): void {
    fs.writeFileSync(path.join(testRoot, filename), content, 'utf-8');
  }
});
