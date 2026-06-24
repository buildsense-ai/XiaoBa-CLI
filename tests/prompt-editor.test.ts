import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deletePromptOverride,
  getPromptEditorFile,
  getPromptEditorState,
  writePromptOverride,
} from '../src/utils/prompt-editor';

describe('prompt-editor', () => {
  test('writes and resets prompt overrides without editing bundled prompts', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-editor-base-'));
    const overrides = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-editor-overrides-'));
    const previous = capturePromptEnv();
    try {
      process.env.XIAOBA_PROMPTS_DIR = base;
      process.env.XIAOBA_PROMPT_OVERRIDES_DIR = overrides;
      delete process.env.XIAOBA_RUNTIME_ROOT;
      delete process.env.XIAOBA_DISABLE_PROMPT_OVERRIDES;
      fs.writeFileSync(path.join(base, 'system-prompt.md'), 'base prompt\n', 'utf-8');
      fs.writeFileSync(path.join(base, 'runtime-context.md'), 'runtime prompt\n', 'utf-8');

      const initial = await getPromptEditorState();
      assert.equal(initial.writable, true);
      assert.deepStrictEqual(
        initial.files.map(file => file.path),
        ['runtime-context.md', 'system-prompt.md'],
      );
      assert.equal(getPromptEditorFile('system-prompt.md').content, 'base prompt');

      const updated = writePromptOverride('system-prompt.md', 'custom prompt\n\n');
      assert.equal(updated.content, 'custom prompt');
      assert.equal(updated.overridden, true);
      assert.equal(fs.readFileSync(path.join(base, 'system-prompt.md'), 'utf-8'), 'base prompt\n');
      assert.equal(fs.readFileSync(path.join(overrides, 'system-prompt.md'), 'utf-8'), 'custom prompt\n');

      const reset = deletePromptOverride('system-prompt.md');
      assert.equal(reset.content, 'base prompt');
      assert.equal(reset.overridden, false);
      assert.equal(fs.existsSync(path.join(overrides, 'system-prompt.md')), false);
    } finally {
      restorePromptEnv(previous);
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(overrides, { recursive: true, force: true });
    }
  });

  test('rejects traversal and non-existing prompt paths', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-editor-base-'));
    const overrides = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-editor-overrides-'));
    const previous = capturePromptEnv();
    try {
      process.env.XIAOBA_PROMPTS_DIR = base;
      process.env.XIAOBA_PROMPT_OVERRIDES_DIR = overrides;
      fs.writeFileSync(path.join(base, 'system-prompt.md'), 'base prompt\n', 'utf-8');
      fs.writeFileSync(path.join(base, 'runtime-context.md'), 'runtime prompt\n', 'utf-8');

      assert.throws(
        () => writePromptOverride('../secret.md', 'nope'),
        /Invalid prompt file path/,
      );
      assert.throws(
        () => writePromptOverride('unknown.md', 'nope'),
        /Prompt file is not editable/,
      );
    } finally {
      restorePromptEnv(previous);
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(overrides, { recursive: true, force: true });
    }
  });

  test('rejects override directory that points at bundled prompts', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-editor-base-'));
    const previous = capturePromptEnv();
    try {
      process.env.XIAOBA_PROMPTS_DIR = base;
      process.env.XIAOBA_PROMPT_OVERRIDES_DIR = base;
      delete process.env.XIAOBA_RUNTIME_ROOT;
      delete process.env.XIAOBA_DISABLE_PROMPT_OVERRIDES;
      fs.writeFileSync(path.join(base, 'system-prompt.md'), 'base prompt\n', 'utf-8');
      fs.writeFileSync(path.join(base, 'runtime-context.md'), 'runtime prompt\n', 'utf-8');

      const state = await getPromptEditorState();
      assert.equal(state.writable, false);
      assert.equal(getPromptEditorFile('system-prompt.md').overridden, false);
      assert.throws(
        () => writePromptOverride('system-prompt.md', 'custom prompt'),
        /Prompt override directory must be separate/,
      );
      assert.equal(fs.readFileSync(path.join(base, 'system-prompt.md'), 'utf-8'), 'base prompt\n');
      assert.throws(
        () => deletePromptOverride('system-prompt.md'),
        /Prompt override directory must be separate/,
      );
      assert.equal(fs.existsSync(path.join(base, 'system-prompt.md')), true);
    } finally {
      restorePromptEnv(previous);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

function capturePromptEnv(): Record<string, string | undefined> {
  return {
    XIAOBA_PROMPTS_DIR: process.env.XIAOBA_PROMPTS_DIR,
    XIAOBA_PROMPT_OVERRIDES_DIR: process.env.XIAOBA_PROMPT_OVERRIDES_DIR,
    XIAOBA_RUNTIME_ROOT: process.env.XIAOBA_RUNTIME_ROOT,
    XIAOBA_DISABLE_PROMPT_OVERRIDES: process.env.XIAOBA_DISABLE_PROMPT_OVERRIDES,
  };
}

function restorePromptEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
