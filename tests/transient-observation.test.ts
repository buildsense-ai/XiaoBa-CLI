import { describe, test, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { TransientObserver, createTransientObserver, resetPreviousSystemHash } from '../src/utils/transient-observation';

describe('TransientObserver', () => {
  let observer: TransientObserver;

  beforeEach(() => {
    observer = createTransientObserver();
    resetPreviousSystemHash();
  });

  test('records injected transients', () => {
    observer.recordInjected('[transient_plan_status]', 'user', 'before_last_user', 342);
    observer.recordInjected('[transient_skills_list]', 'user', 'before_last_user', 890);

    assert.strictEqual(observer.injectedCount, 2);
    const obs = observer.buildObservation();
    assert.strictEqual(obs.injected.length, 2);
    assert.strictEqual(obs.injected[0].prefix, '[transient_plan_status]');
    assert.strictEqual(obs.injected[0].role, 'user');
    assert.strictEqual(obs.injected[0].placement, 'before_last_user');
    assert.strictEqual(obs.injected[0].contentLen, 342);
    assert.strictEqual(obs.injected[1].prefix, '[transient_skills_list]');
    assert.strictEqual(obs.injected[1].contentLen, 890);
  });

  test('records suppressed transients', () => {
    observer.recordSuppressed('[transient_soft_check]', 'filtered_by_policy');
    observer.recordSuppressed('[transient_tool_guidance]', 'filtered_by_policy');

    assert.strictEqual(observer.suppressedCount, 2);
    const obs = observer.buildObservation();
    assert.strictEqual(obs.suppressed.length, 2);
    assert.strictEqual(obs.suppressed[0].prefix, '[transient_soft_check]');
    assert.strictEqual(obs.suppressed[0].reason, 'filtered_by_policy');
  });

  test('tracks system hash stability — first turn is not changed', () => {
    const obs = observer.buildObservation({
      turn: 1,
      model: 'minimax-m3',
      systemHash: 'abc123',
      systemLen: 5000,
    });

    assert.strictEqual(obs.systemHash, 'abc123');
    assert.strictEqual(obs.systemHashChanged, false);
    assert.strictEqual(obs.systemLen, 5000);
  });

  test('tracks system hash stability — detects change on second turn', () => {
    const obs1 = createTransientObserver();
    obs1.buildObservation({ systemHash: 'abc123', systemLen: 5000 });

    const obs2 = createTransientObserver();
    const result = obs2.buildObservation({ systemHash: 'def456', systemLen: 5100 });

    assert.strictEqual(result.systemHashChanged, true);
  });

  test('tracks system hash stability — no change when same hash', () => {
    const obs1 = createTransientObserver();
    obs1.buildObservation({ systemHash: 'abc123', systemLen: 5000 });

    const obs2 = createTransientObserver();
    const result = obs2.buildObservation({ systemHash: 'abc123', systemLen: 5000 });

    assert.strictEqual(result.systemHashChanged, false);
  });

  test('tracks system hash stability per session and model bucket', () => {
    const sessionA1 = createTransientObserver().buildObservation({
      sessionId: 'session-a',
      provider: 'anthropic',
      model: 'MiniMax-M3',
      systemHash: 'hash-a',
      systemLen: 5000,
    });
    const sessionB1 = createTransientObserver().buildObservation({
      sessionId: 'session-b',
      provider: 'anthropic',
      model: 'MiniMax-M3',
      systemHash: 'hash-b',
      systemLen: 5100,
    });
    const sessionA2 = createTransientObserver().buildObservation({
      sessionId: 'session-a',
      provider: 'anthropic',
      model: 'MiniMax-M3',
      systemHash: 'hash-a',
      systemLen: 5000,
    });
    const sessionB2 = createTransientObserver().buildObservation({
      sessionId: 'session-b',
      provider: 'anthropic',
      model: 'MiniMax-M3',
      systemHash: 'hash-c',
      systemLen: 5200,
    });

    assert.strictEqual(sessionA1.systemHashChanged, false);
    assert.strictEqual(sessionB1.systemHashChanged, false);
    assert.strictEqual(sessionA2.systemHashChanged, false);
    assert.strictEqual(sessionB2.systemHashChanged, true);
  });

  test('buildObservation includes meta fields', () => {
    observer.recordInjected('[transient_plan_status]', 'user', 'before_last_user', 100);
    observer.recordSuppressed('[transient_tool_guidance]', 'filtered_by_policy');

    const obs = observer.buildObservation({
      turn: 3,
      model: 'minimax-m3',
      requestId: 'ph_abc_1234',
      systemHash: 'xyz789',
      systemLen: 4000,
    });

    assert.strictEqual(obs.turn, 3);
    assert.strictEqual(obs.sessionId, undefined);
    assert.strictEqual(obs.provider, undefined);
    assert.strictEqual(obs.model, 'minimax-m3');
    assert.strictEqual(obs.requestId, 'ph_abc_1234');
    assert.strictEqual(obs.injected.length, 1);
    assert.strictEqual(obs.suppressed.length, 1);
  });
});
