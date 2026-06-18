import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('prompt companion advisor', { concurrency: false }, () => {
  let testRoot: string;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-companion-'));
    previousEnv = captureEnv();
    process.env.XIAOBA_PROMPTS_DIR = path.join(testRoot, 'prompts');
    process.env.XIAOBA_PROMPT_OVERRIDES_DIR = path.join(testRoot, 'prompt-overrides');
    process.env.XIAOBA_PET_DATA_DIR = path.join(testRoot, 'pet');
    process.env.XIAOBA_ELECTRON_USER_DATA_DIR = testRoot;
    process.env.XIAOBA_PROMPT_COMPANION_LLM = 'false';
    delete process.env.XIAOBA_RUNTIME_ROOT;
    delete process.env.XIAOBA_DISABLE_PROMPT_OVERRIDES;
    writePrompt('system-prompt.md', '# CatsCo\n\n你是 CatsCo。');
    writePrompt('runtime-context.md', '当前日期：{{date}}');
    writePrompt('compact-system.md', '请压缩上下文。');
  });

  afterEach(() => {
    restoreEnv(previousEnv);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('proposes and applies a prompt override after recent failures', async () => {
    const {
      applyPromptCompanionProposal,
      getPromptCompanionProposal,
    } = loadModule('../src/pet/prompt-companion');

    writeSessionTurnLog('[处理失败: API错误 (500): temporary failure]');

    const first = await getPromptCompanionProposal();
    assert.equal(first.proposal?.id, 'error-recovery-v1');
    assert.equal(first.proposal?.path, 'system-prompt.md');
    assert.equal(first.proposal?.operation, 'append');
    assert.match(first.proposal?.preview || '', /异常恢复/);

    const applied = await applyPromptCompanionProposal(first.proposal!.id);
    assert.equal(applied.applied, true);
    assert.equal(applied.file.overridden, true);

    const overridePath = path.join(testRoot, 'prompt-overrides', 'system-prompt.md');
    assert.match(fs.readFileSync(overridePath, 'utf8'), /异常恢复/);
    assert.equal(fs.readFileSync(path.join(testRoot, 'prompts', 'system-prompt.md'), 'utf8'), '# CatsCo\n\n你是 CatsCo。');
  });

  function writePrompt(relativePath: string, content: string): void {
    const filePath = path.join(testRoot, 'prompts', relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  function writeSessionTurnLog(assistantText: string): void {
    const filePath = path.join(testRoot, 'logs', 'sessions', 'catscompany', '2026-06-18', 'session.jsonl');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({
      entry_type: 'turn',
      turn: 1,
      timestamp: new Date().toISOString(),
      session_id: 'session:test',
      session_type: 'catscompany',
      user: { text: 'hello' },
      assistant: { text: assistantText, tool_calls: [] },
      tokens: { prompt: 10, completion: 2 },
    })}\n`, 'utf8');
  }
});

function loadModule(modulePath: string): any {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

function captureEnv(): Record<string, string | undefined> {
  return {
    XIAOBA_PROMPTS_DIR: process.env.XIAOBA_PROMPTS_DIR,
    XIAOBA_PROMPT_OVERRIDES_DIR: process.env.XIAOBA_PROMPT_OVERRIDES_DIR,
    XIAOBA_PET_DATA_DIR: process.env.XIAOBA_PET_DATA_DIR,
    XIAOBA_ELECTRON_USER_DATA_DIR: process.env.XIAOBA_ELECTRON_USER_DATA_DIR,
    XIAOBA_PROMPT_COMPANION_LLM: process.env.XIAOBA_PROMPT_COMPANION_LLM,
    XIAOBA_RUNTIME_ROOT: process.env.XIAOBA_RUNTIME_ROOT,
    XIAOBA_DISABLE_PROMPT_OVERRIDES: process.env.XIAOBA_DISABLE_PROMPT_OVERRIDES,
  };
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
