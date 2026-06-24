import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PromptModeRuntime,
  TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX,
} from '../src/core/prompt-mode-runtime';

describe('PromptModeRuntime', () => {
  let promptsDir: string;

  beforeEach(() => {
    promptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-mode-runtime-'));
    fs.mkdirSync(path.join(promptsDir, 'modes'), { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'modes', 'coding-agent.md'), [
      '---',
      'id: coding-agent',
      'name: Coding Agent',
      'description: Work on code and local projects',
      '---',
      '',
      'Use engineering workflow.',
    ].join('\n'), 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(promptsDir, { recursive: true, force: true });
  });

  test('activates a prompt mode and builds a transient system message', () => {
    const runtime = new PromptModeRuntime({ promptsDir });
    runtime.beginTurn(1);
    runtime.applyRouterPayload({
      action: 'activate',
      mode: 'coding-agent',
      confidence: 0.91,
      reason: 'User is debugging a local build.',
    }, 1);

    const message = runtime.buildTransientMessage({ turnNumber: 1 });
    assert.equal(message?.role, 'system');
    assert.match(String(message?.content), new RegExp(`^\\${TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX}`));
    assert.match(String(message?.content), /\[mode:coding-agent\]/);
    assert.match(String(message?.content), /Use engineering workflow/);
  });

  test('ignores low-confidence activation and unknown modes', () => {
    const runtime = new PromptModeRuntime({ promptsDir });
    runtime.beginTurn(1);

    runtime.applyRouterPayload({
      action: 'activate',
      mode: 'coding-agent',
      confidence: 0.4,
      reason: 'weak signal',
    }, 1);
    assert.equal(runtime.buildTransientMessage({ turnNumber: 1 }), null);

    runtime.applyRouterPayload({
      action: 'activate',
      mode: 'unknown-mode',
      confidence: 0.95,
      reason: 'bad mode',
    }, 1);
    assert.equal(runtime.buildTransientMessage({ turnNumber: 1 }), null);
  });

  test('clears active mode and expires after the TTL', () => {
    const runtime = new PromptModeRuntime({ promptsDir, maxActiveTurns: 2 });
    runtime.beginTurn(1);
    runtime.applyRouterPayload({
      action: 'activate',
      mode: 'coding-agent',
      confidence: 0.95,
      reason: 'coding task',
    }, 1);
    assert.ok(runtime.buildTransientMessage({ turnNumber: 3 }));
    assert.equal(runtime.buildTransientMessage({ turnNumber: 4 }), null);

    runtime.applyRouterPayload({
      action: 'activate',
      mode: 'coding-agent',
      confidence: 0.95,
      reason: 'coding task again',
    }, 4);
    assert.ok(runtime.buildTransientMessage({ turnNumber: 4 }));
    runtime.applyRouterPayload({
      action: 'clear',
      confidence: 0.95,
      reason: 'topic changed',
    }, 4);
    assert.equal(runtime.buildTransientMessage({ turnNumber: 4 }), null);
  });
});
