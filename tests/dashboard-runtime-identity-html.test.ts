import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('dashboard visibly distinguishes data, code, and workspace roots', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'dashboard', 'index.html'), 'utf8');

  assert.match(html, /id="runtime-identity-card"/);
  assert.match(html, /id="runtime-data-root"/);
  assert.match(html, /id="runtime-code-root"/);
  assert.match(html, /id="runtime-workspace-root"/);
  assert.match(html, /id="copy-runtime-data-root"/);
  assert.match(html, /profile:/);
  assert.match(html, /copyRuntimeDataRoot/);
  assert.match(html, /已复制/);
  assert.match(html, /复制失败/);
});
