'use strict';

// Reasons that represent a transient renderer crash worth one bounded retry
// window. Unrecoverable reasons (launch-failed, integrity-failure, killed,
// clean-exit) must never trigger an auto-reload loop.
const RECOVERABLE_REASONS = new Set(['crashed', 'oom', 'abnormal-exit']);

// Stop auto-recovering after MAX_RELOADS_IN_WINDOW reloads within a rolling
// RECOVERY_WINDOW_MS window. A successful did-finish-load resets the budget.
const MAX_RELOADS_IN_WINDOW = 2;
const RECOVERY_WINDOW_MS = 30_000;
const RELOAD_DELAY_MS = 1_500;

function isRecoverableRendererGoneReason(reason) {
  return RECOVERABLE_REASONS.has(reason);
}

// Bounded auto-recovery guard for the renderer process. Pure logic with all
// side effects injectable so it can be unit-tested without Electron.
function createRendererGoneGuard(options = {}) {
  const now = options.now || (() => Date.now());
  const scheduleReload = options.scheduleReload || ((fn, delay) => setTimeout(fn, delay));
  const clearReload = options.clearReload || ((timer) => clearTimeout(timer));
  const reloadWindow = options.reloadWindow || ((win) => win.reload());
  const log = options.log || (() => {});
  const stableWindowMs = options.stableWindowMs || RECOVERY_WINDOW_MS;

  let windowRef = options.window || null;
  let reloadTimestamps = [];
  let pendingTimer = null;
  let stableTimer = null;

  function cancelStableTimer() {
    if (stableTimer !== null) {
      clearReload(stableTimer);
      stableTimer = null;
    }
  }

  function cancelPendingReload() {
    if (pendingTimer !== null) {
      clearReload(pendingTimer);
      pendingTimer = null;
    }
  }

  function reset() {
    reloadTimestamps = [];
    cancelStableTimer();
  }

  // Release all pending timers. Called when the window is closed or the app is
  // quitting so no stale reload/stability callback fires afterwards.
  function dispose() {
    cancelStableTimer();
    cancelPendingReload();
  }

  // Called on each successful page load. Starts (or restarts) a stability
  // timer; the retry budget is only cleared after the window has stayed loaded
  // for stableWindowMs. Crashes within the stability period keep earlier
  // reloads on record, so a crash -> reload -> load loop cannot reset its own
  // budget and bypass the retry cap.
  function onLoadFinished() {
    cancelStableTimer();
    stableTimer = scheduleReload(() => {
      stableTimer = null;
      reset();
    }, stableWindowMs);
  }

  function onRenderProcessGone(reason) {
    // Any renderer loss invalidates the current stability period immediately,
    // regardless of whether the reason is recoverable. Otherwise the old
    // stability timer could expire after a new crash and clear recent reloads,
    // allowing more than MAX_RELOADS_IN_WINDOW reloads in one window.
    cancelStableTimer();

    if (!isRecoverableRendererGoneReason(reason)) {
      log(`renderer gone reason is not auto-recoverable: ${reason}`);
      return { recovered: false, reason: 'unrecoverable' };
    }

    const timestamp = now();
    reloadTimestamps = reloadTimestamps.filter((ts) => timestamp - ts < RECOVERY_WINDOW_MS);
    if (reloadTimestamps.length >= MAX_RELOADS_IN_WINDOW) {
      log('renderer retry budget exhausted within recovery window');
      return { recovered: false, reason: 'retries-exhausted' };
    }

    const target = windowRef;
    cancelPendingReload();
    pendingTimer = scheduleReload(() => {
      pendingTimer = null;
      // Only touch the window instance captured at schedule time; if it was
      // destroyed and a new window was created, do not reload the replacement.
      if (target && !target.isDestroyed()) {
        reloadTimestamps.push(now());
        reloadWindow(target);
      }
    }, RELOAD_DELAY_MS);
    return { recovered: true, reason: 'scheduled' };
  }

  return { onRenderProcessGone, onLoadFinished, reset, dispose };
}

module.exports = {
  RECOVERABLE_REASONS,
  MAX_RELOADS_IN_WINDOW,
  RECOVERY_WINDOW_MS,
  RELOAD_DELAY_MS,
  isRecoverableRendererGoneReason,
  createRendererGoneGuard,
};
