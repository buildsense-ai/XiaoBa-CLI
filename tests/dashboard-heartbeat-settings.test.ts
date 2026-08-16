import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDashboardSettings, updateDashboardSettings } from '../src/dashboard/settings';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Dashboard Distillation Heartbeat settings', () => {
  test('defaults to inheriting the primary model', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-heartbeat-settings-'));
    roots.push(root);
    const snapshot = getDashboardSettings({ runtimeRoot: root, env: {} });
    const mode = snapshot.fields.find(field => field.id === 'heartbeat.mode');
    assert.equal(mode?.value, 'inherit');
  });

  test('persists independent model fields and never writes the primary model keys', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-heartbeat-settings-'));
    roots.push(root);
    updateDashboardSettings({ settings: {
      'heartbeat.mode': 'custom',
      'heartbeat.provider': 'openai',
      'heartbeat.apiBase': 'https://models.example.test/v1',
      'heartbeat.model': 'heartbeat-model',
      'heartbeat.contextWindowTokens': '256000',
      'heartbeat.reasoningEffort': 'high',
      'heartbeat.openaiApiMode': 'responses',
      'heartbeat.apiKey': { action: 'replace', value: 'heartbeat-secret' },
    } }, { runtimeRoot: root, env: {} });
    const contents = fs.readFileSync(path.join(root, '.env'), 'utf8');
    assert.match(contents, /DISTILLATION_HEARTBEAT_LLM_MODE="custom"/);
    assert.match(contents, /DISTILLATION_HEARTBEAT_LLM_API_KEY="heartbeat-secret"/);
    assert.doesNotMatch(contents, /GAUZ_LLM_/);
    const snapshot = getDashboardSettings({ runtimeRoot: root, env: {} });
    assert.equal(snapshot.fields.find(field => field.id === 'heartbeat.apiKey')?.present, true);
    assert.equal(snapshot.fields.find(field => field.id === 'heartbeat.openaiApiMode')?.value, 'responses');
  });
});
