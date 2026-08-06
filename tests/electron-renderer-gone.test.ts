import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  MAX_RELOADS_IN_WINDOW,
  RECOVERY_WINDOW_MS,
  RELOAD_DELAY_MS,
  isRecoverableRendererGoneReason,
  createRendererGoneGuard,
} = require('../electron/renderer-gone.js');

function makeHarness(overrides = {}) {
  let nowValue = 0;
  let nextTimerId = 0;
  const timers = [];
  const reloaded = [];
  const window = overrides.window || {
    isDestroyed: () => false,
    reload: () => reloaded.push('reload'),
  };
  const guard = createRendererGoneGuard({
    window,
    now: () => nowValue,
    scheduleReload: (fn) => {
      nextTimerId += 1;
      timers.push({ id: nextTimerId, fn });
      return nextTimerId;
    },
    clearReload: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    reloadWindow: (target) => reloaded.push(target),
    ...overrides,
  });
  return {
    guard,
    timers,
    reloaded,
    window,
    setNow: (value) => {
      nowValue = value;
    },
    fire: () => {
      // fire the most recently scheduled callback synchronously
      const last = timers.pop();
      if (last) last.fn();
    },
  };
}

test('only transient crash reasons are auto-recoverable', () => {
  for (const reason of ['crashed', 'oom', 'abnormal-exit']) {
    assert.equal(isRecoverableRendererGoneReason(reason), true, `expected ${reason} recoverable`);
  }
  for (const reason of ['clean-exit', 'killed', 'launch-failed', 'integrity-failure', 'unknown', undefined]) {
    assert.equal(isRecoverableRendererGoneReason(reason), false, `expected ${reason} unrecoverable`);
  }
});

test('unrecoverable reasons never schedule a reload', () => {
  const { guard, timers } = makeHarness();
  const outcome = guard.onRenderProcessGone('launch-failed');
  assert.deepEqual(outcome, { recovered: false, reason: 'unrecoverable' });
  assert.equal(timers.length, 0);
});

test('a recoverable reason schedules exactly one bounded reload', () => {
  const { guard, timers, reloaded, fire } = makeHarness();
  const outcome = guard.onRenderProcessGone('crashed');
  assert.deepEqual(outcome, { recovered: true, reason: 'scheduled' });
  assert.equal(timers.length, 1);
  fire();
  assert.equal(reloaded.length, 1);
});

test('retry budget is bounded within the recovery window', () => {
  const { guard, timers, reloaded, fire, setNow } = makeHarness();
  // Two recoverable crashes inside the window -> both reload.
  for (let i = 0; i < MAX_RELOADS_IN_WINDOW; i++) {
    setNow(i * 1000);
    const outcome = guard.onRenderProcessGone('oom');
    assert.equal(outcome.recovered, true, `attempt ${i + 1} should be scheduled`);
    fire();
  }
  assert.equal(reloaded.length, MAX_RELOADS_IN_WINDOW);
  // Third crash within the window -> budget exhausted, no more reloads.
  setNow(MAX_RELOADS_IN_WINDOW * 1000);
  const exhausted = guard.onRenderProcessGone('oom');
  assert.deepEqual(exhausted, { recovered: false, reason: 'retries-exhausted' });
  fire();
  assert.equal(reloaded.length, MAX_RELOADS_IN_WINDOW);
});

test('explicit reset reopens the budget', () => {
  const { guard, timers, reloaded, fire, setNow } = makeHarness();
  for (let i = 0; i < MAX_RELOADS_IN_WINDOW; i++) {
    guard.onRenderProcessGone('crashed');
    fire();
  }
  assert.equal(reloaded.length, MAX_RELOADS_IN_WINDOW);
  guard.reset();
  setNow(MAX_RELOADS_IN_WINDOW * 1000);
  const afterReset = guard.onRenderProcessGone('crashed');
  assert.equal(afterReset.recovered, true);
});

test('crash -> reload -> load loop cannot reset its own budget (lifecycle regression)', () => {
  const { guard, timers, reloaded, fire, setNow } = makeHarness();
  // Two full crash/reload/load rounds inside the 30s window.
  for (let round = 0; round < MAX_RELOADS_IN_WINDOW; round++) {
    setNow(round * 1000);
    const outcome = guard.onRenderProcessGone('crashed');
    assert.equal(outcome.recovered, true, `round ${round + 1} should schedule`);
    fire(); // delayed reload fires and records a timestamp
    guard.onLoadFinished(); // page loads; must NOT clear the budget
  }
  assert.equal(reloaded.length, MAX_RELOADS_IN_WINDOW);
  // Third crash within the window -> budget still exhausted despite the loads.
  setNow(MAX_RELOADS_IN_WINDOW * 1000);
  const exhausted = guard.onRenderProcessGone('crashed');
  assert.deepEqual(exhausted, { recovered: false, reason: 'retries-exhausted' });
  fire();
  assert.equal(reloaded.length, MAX_RELOADS_IN_WINDOW);
});

test('budget recovers only after a stability period without crashes', () => {
  const { guard, timers, fire, setNow } = makeHarness();
  // Crash -> reload -> successful load starts the stability timer.
  guard.onRenderProcessGone('crashed');
  fire();
  guard.onLoadFinished();
  assert.equal(timers.length, 1); // the stability timer
  // Crash again within the stability period -> budget still counts.
  setNow(5_000);
  const withinStable = guard.onRenderProcessGone('crashed');
  assert.equal(withinStable.recovered, true);
  // Load again and stay stable past the 30s window -> budget resets.
  guard.onLoadFinished();
  setNow(40_000);
  fire(); // stability timer fires -> reset
  const afterStable = guard.onRenderProcessGone('crashed');
  assert.equal(afterStable.recovered, true);
});

test('reload never fires for a window that was destroyed (window replaced)', () => {
  let destroyed = false;
  const capturedWindow = {
    isDestroyed: () => destroyed,
    reload: () => {},
  };
  const { guard, timers, reloaded, fire } = makeHarness({ window: capturedWindow });
  guard.onRenderProcessGone('crashed');
  assert.equal(timers.length, 1);
  // The captured window is closed/destroyed before the delayed reload fires.
  destroyed = true;
  fire();
  assert.equal(timers.length, 0);
  // A destroyed window is never reloaded (the replacement window is untouched).
  assert.equal(reloaded.length, 0);
});

test('a renderer crash cancels the pending stability timer (edge regression)', () => {
  const { guard, timers, reloaded, fire, setNow } = makeHarness();
  // Load completes and starts the stability timer (fires at +30s).
  guard.onLoadFinished();
  assert.equal(timers.length, 1);
  // Crash mid-stability: the old stability timer must be cancelled so it can
  // never expire after the new crash and clear the fresh reload record.
  setNow(20_000);
  const outcome = guard.onRenderProcessGone('crashed');
  assert.equal(outcome.recovered, true);
  assert.equal(timers.length, 1); // only the reload timer, stability timer gone
  // Advance past the OLD stability deadline: nothing must reset the budget.
  setNow(40_000);
  fire(); // reload executes, records a timestamp at 40s
  assert.equal(reloaded.length, 1);
  // Second crash within 30s of the reload is still allowed.
  setNow(40_500);
  assert.equal(guard.onRenderProcessGone('crashed').recovered, true);
  fire();
  // Third crash within the rolling 30s window must be rejected.
  setNow(41_000);
  const third = guard.onRenderProcessGone('crashed');
  assert.deepEqual(third, { recovered: false, reason: 'retries-exhausted' });
  fire();
  assert.equal(reloaded.length, 2); // never more than MAX in one window
});

test('unrecoverable renderer loss also cancels the stability timer', () => {
  const { guard, timers } = makeHarness();
  guard.onLoadFinished();
  assert.equal(timers.length, 1);
  const outcome = guard.onRenderProcessGone('launch-failed');
  assert.deepEqual(outcome, { recovered: false, reason: 'unrecoverable' });
  // Stability timer cancelled and no reload scheduled.
  assert.equal(timers.length, 0);
});

test('dispose cancels pending reload and stability timers', () => {
  const { guard, timers } = makeHarness();
  guard.onLoadFinished();
  guard.onRenderProcessGone('crashed'); // cancels stability, schedules reload
  assert.equal(timers.length, 1);
  guard.dispose();
  assert.equal(timers.length, 0);
  // A later crash still schedules normally after dispose.
  const after = guard.onRenderProcessGone('crashed');
  assert.equal(after.recovered, true);
  guard.dispose();
  assert.equal(timers.length, 0);
});

test('recovery window constants are sane', () => {
  assert.equal(MAX_RELOADS_IN_WINDOW, 2);
  assert.equal(RECOVERY_WINDOW_MS, 30_000);
  assert.equal(RELOAD_DELAY_MS, 1_500);
});
