import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PromptModeRuntime,
  TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX,
  buildPromptModeRouterObservation,
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

  test('activates a prompt mode and refreshes full instructions on an interval', () => {
    const runtime = new PromptModeRuntime({ promptsDir, fullPromptRefreshInterval: 3 });
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

    const sameTurnMessage = runtime.buildTransientMessage({ turnNumber: 1 });
    assert.match(String(sameTurnMessage?.content), /Use engineering workflow/);

    const nextTurnMessage = runtime.buildTransientMessage({ turnNumber: 2 });
    assert.match(String(nextTurnMessage?.content), /Active prompt mode: coding-agent/);
    assert.match(String(nextTurnMessage?.content), /Full mode instructions were already supplied on turn 1/);
    assert.doesNotMatch(String(nextTurnMessage?.content), /Use engineering workflow/);

    const thirdTurnMessage = runtime.buildTransientMessage({ turnNumber: 3 });
    assert.match(String(thirdTurnMessage?.content), /Turns until next full refresh: 1/);
    assert.doesNotMatch(String(thirdTurnMessage?.content), /Use engineering workflow/);

    const refreshedMessage = runtime.buildTransientMessage({ turnNumber: 4 });
    assert.match(String(refreshedMessage?.content), /Use engineering workflow/);
  });

  test('injects full instructions again when the active mode changes', () => {
    fs.writeFileSync(path.join(promptsDir, 'modes', 'office.md'), [
      '---',
      'id: office',
      'name: Office Mode',
      'description: Work on office docs',
      '---',
      '',
      'Use office workflow.',
    ].join('\n'), 'utf-8');

    const runtime = new PromptModeRuntime({ promptsDir });
    runtime.applyRouterPayload({
      action: 'activate',
      mode: 'coding-agent',
      confidence: 0.91,
      reason: 'coding task',
    }, 1);
    assert.match(String(runtime.buildTransientMessage({ turnNumber: 1 })?.content), /Use engineering workflow/);
    assert.doesNotMatch(String(runtime.buildTransientMessage({ turnNumber: 2 })?.content), /Use engineering workflow/);

    runtime.applyRouterPayload({
      action: 'activate',
      mode: 'office',
      confidence: 0.91,
      reason: 'document task',
    }, 2);
    assert.match(String(runtime.buildTransientMessage({ turnNumber: 2 })?.content), /Use office workflow/);
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

  test('keeps active mode until router clears it', () => {
    const runtime = new PromptModeRuntime({ promptsDir, fullPromptRefreshInterval: 2 });
    runtime.beginTurn(1);
    runtime.applyRouterPayload({
      action: 'activate',
      mode: 'coding-agent',
      confidence: 0.95,
      reason: 'coding task',
    }, 1);
    assert.ok(runtime.buildTransientMessage({ turnNumber: 1 }));
    assert.ok(runtime.buildTransientMessage({ turnNumber: 10 }));

    runtime.applyRouterPayload({
      action: 'clear',
      confidence: 0.95,
      reason: 'topic changed',
    }, 10);
    assert.equal(runtime.buildTransientMessage({ turnNumber: 10 }), null);
  });

  test('labels late prompt mode router observations in transient mode context', () => {
    const runtime = new PromptModeRuntime({ promptsDir });
    runtime.beginTurn(2);
    runtime.applyRouterObservations([{
      ...buildPromptModeRouterObservation({
        action: 'activate',
        mode: 'coding-agent',
        confidence: 0.93,
        reason: 'local build debugging',
      }),
      timing: 'late_previous_turn',
      metadata: {
        timing: 'late_previous_turn',
        originTurn: 1,
      },
    }], 2);

    const lateMessage = runtime.buildTransientMessage({ turnNumber: 2 });
    assert.match(String(lateMessage?.content), /Timing: selected from turn 1 and arrived late/);

    runtime.applyRouterObservations([{
      ...buildPromptModeRouterObservation({
        action: 'activate',
        mode: 'coding-agent',
        confidence: 0.94,
        reason: 'still coding',
      }),
      timing: 'current_turn',
      metadata: {
        timing: 'current_turn',
        originTurn: 3,
      },
    }], 3);

    const currentMessage = runtime.buildTransientMessage({ turnNumber: 3 });
    assert.match(String(currentMessage?.content), /Timing: selected for the current user turn 3/);
  });
});
