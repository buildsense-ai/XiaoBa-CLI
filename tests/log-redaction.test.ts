import { test } from 'node:test';
import * as assert from 'node:assert';
import { formatPathForLog } from '../src/utils/log-redaction';

test('formatPathForLog keeps only a filename label and short hash', () => {
  const label = formatPathForLog('C:\\Users\\alice\\secret-project\\page_0025.jpg');

  assert.match(label, /^page_0025\.jpg#[a-f0-9]{8}$/);
  assert.equal(label.includes('alice'), false);
  assert.equal(label.includes('secret-project'), false);
  assert.equal(label.includes('Users'), false);
});

test('formatPathForLog sanitizes control separators', () => {
  const label = formatPathForLog('/tmp/catsco/bad=name\tfile.png');

  assert.match(label, /^bad_name_file\.png#[a-f0-9]{8}$/);
});
