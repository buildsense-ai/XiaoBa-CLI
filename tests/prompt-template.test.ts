import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  normalizePromptText,
  readRequiredDefaultPromptFile,
  readRequiredPromptFile,
  renderPromptTemplate,
} from '../src/utils/prompt-template';

describe('prompt-template', () => {
  test('normalizes line endings, trailing whitespace and excessive blank lines', () => {
    const normalized = normalizePromptText('  hello  \r\nworld\t\n\n\nnext\n');

    assert.equal(normalized, 'hello\nworld\n\nnext');
  });

  test('required prompt file throws when missing or empty', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-template-'));
    try {
      assert.throws(
        () => readRequiredPromptFile(root, 'missing.md'),
        /Required prompt file is missing or unreadable: missing\.md/,
      );

      fs.writeFileSync(path.join(root, 'empty.md'), '   \n\n');
      assert.throws(
        () => readRequiredPromptFile(root, 'empty.md'),
        /Prompt file is empty: empty\.md/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('renders variables and optional sections', () => {
    const rendered = renderPromptTemplate(
      [
        'Name: {{name}}',
        '{{#enabled}}Enabled: {{enabled}}{{/enabled}}',
        '{{#missing}}Missing section{{/missing}}',
        'Unknown: {{unknown}}',
      ].join('\n'),
      {
        name: 'CatsCo',
        enabled: true,
      },
    );

    assert.equal(rendered, [
      'Name: CatsCo',
      'Enabled: true',
      '',
      'Unknown:',
    ].join('\n'));
    assert.doesNotMatch(rendered, /Missing section/);
  });

  test('default prompt reads local override when configured', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-base-'));
    const overrides = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-overrides-'));
    const previous = {
      XIAOBA_PROMPTS_DIR: process.env.XIAOBA_PROMPTS_DIR,
      XIAOBA_PROMPT_OVERRIDES_DIR: process.env.XIAOBA_PROMPT_OVERRIDES_DIR,
      XIAOBA_RUNTIME_ROOT: process.env.XIAOBA_RUNTIME_ROOT,
      XIAOBA_DISABLE_PROMPT_OVERRIDES: process.env.XIAOBA_DISABLE_PROMPT_OVERRIDES,
    };
    try {
      process.env.XIAOBA_PROMPTS_DIR = base;
      process.env.XIAOBA_PROMPT_OVERRIDES_DIR = overrides;
      delete process.env.XIAOBA_RUNTIME_ROOT;
      delete process.env.XIAOBA_DISABLE_PROMPT_OVERRIDES;

      fs.writeFileSync(path.join(base, 'system-prompt.md'), 'base prompt\n', 'utf-8');
      assert.equal(readRequiredDefaultPromptFile('system-prompt.md'), 'base prompt');

      fs.writeFileSync(path.join(overrides, 'system-prompt.md'), 'override prompt\n', 'utf-8');
      assert.equal(readRequiredDefaultPromptFile('system-prompt.md'), 'override prompt');
    } finally {
      restoreEnv(previous);
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(overrides, { recursive: true, force: true });
    }
  });

  test('default delivery prompt standardizes newly generated Excel files on XLSX', () => {
    const prompt = fs.readFileSync(path.join(process.cwd(), 'prompts', 'system-prompt.md'), 'utf-8');

    assert.match(prompt, /新生成的 Excel 表格统一使用标准 \.xlsx/);
    assert.match(prompt, /不新建旧版 \.xls/);
    assert.match(prompt, /不把 HTML 或 CSV 文本伪装成 \.xls/);
  });
});

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
