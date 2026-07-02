import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const manifestPath = join(root, 'dashboard/pet/manifest.json');

test('pet manifest includes companion states and valid frame paths', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const expectedStates = [
    'idle',
    'idle_active',
    'thinking',
    'typing',
    'success',
    'happy',
    'skill',
    'notify',
    'sleepy',
    'error',
    'level_up',
    'peek',
  ];

  for (const state of expectedStates) {
    assert.equal(Array.isArray(manifest[state]), true, `${state} should have frames`);
    assert.equal(manifest[state].length > 0, true, `${state} should not be empty`);
    for (const frame of manifest[state]) {
      assert.equal(existsSync(join(root, 'dashboard', frame)), true, `${state} frame exists: ${frame}`);
      assert.doesNotMatch(frame, /pet\/happy\//, `${state} should not use removed happy frames`);
      assert.doesNotMatch(frame, /pet\/sleepy\//, `${state} should not use removed sleepy frames`);
    }
  }
});

test('pet manifest declares level-specific frame overrides with fallbacks', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  assert.equal(typeof manifest.levels, 'object');
  assert.equal(Array.isArray(manifest.levels['3'].idle), true);
  assert.match(manifest.levels['3'].idle[0], /pet\/idle_active\//);
  assert.match(manifest.levels['5'].level_up[0], /pet\/level_up\//);
  for (const level of Object.values(manifest.levels) as any[]) {
    for (const frames of Object.values(level) as any[]) {
      for (const frame of frames) {
        assert.doesNotMatch(frame, /pet\/happy\//);
        assert.doesNotMatch(frame, /pet\/sleepy\//);
      }
    }
  }
});
