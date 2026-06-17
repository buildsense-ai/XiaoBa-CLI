import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  normalizePromptText,
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
});
