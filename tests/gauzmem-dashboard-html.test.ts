import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const html = readFileSync(join(process.cwd(), 'dashboard/gauzmem.html'), 'utf-8');
const indexHtml = readFileSync(join(process.cwd(), 'dashboard/index.html'), 'utf-8');

test('GauzMem dashboard HTML exposes replay, graph, and metabolism views', () => {
  assert.match(html, /GauzMem Dashboard/);
  assert.match(html, /Session Replay/);
  assert.match(html, /Persistent Graph/);
  assert.match(html, /Metabolism Timeline/);
  assert.match(html, /\/api\/gauzmem\/dashboard/);
  assert.match(html, /id="graph-svg"/);
  assert.match(html, /id="timeline"/);
  assert.match(html, /id="metabolism-bars"/);
  assert.match(html, /class="run-stats"/);
  assert.match(html, /function renderTraceRow/);
});

test('main dashboard links to the GauzMem dashboard without replacing the existing SPA pages', () => {
  assert.match(indexHtml, /href="gauzmem\.html"/);
  assert.match(indexHtml, /<span>GauzMem<\/span>/);
  assert.match(indexHtml, /switchPage\('services'\)/);
});
