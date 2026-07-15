/**
 * Issue #94 — Active-handle assertion utilities.
 *
 * Provides deterministic functions to snapshot and assert that no non-ambient
 * handles remain after a test, shutdown path, or smoke run. This is the
 * release-gate requirement that bounded concurrency does not reintroduce exit
 * hangs.
 *
 * Node.js does not expose individual timer handles through `_getActiveHandles()`
 * (timers use a separate mechanism), and the test harness itself may carry an
 * ambient child-process handle. This module therefore:
 *   - snapshots child-process counts for before/during/after comparisons; and
 *   - asserts that no non-ambient handles such as net.Server instances remain.
 */

export interface ActiveHandleSnapshot {
  /** Total handles from process._getActiveHandles(). */
  readonly total: number;
  /** Absolute child-process handle count. */
  readonly childProcesses: number;
  /** Child-process handles beyond the ambient baseline. */
  readonly childProcessExtra: number;
  /** Non-ambient, non-child-process handles (potential leaks). */
  readonly extra: number;
}

let ambientChildProcessBaseline: number | null = null;

const AMBIENT_HANDLE_NAMES = new Set([
  'Socket',
  'MessagePort',
  'WriteStream',
  'ReadStream',
  'TTY',
  'Pipe',
]);

function getRawHandles(): unknown[] {
  return (process as unknown as {
    _getActiveHandles?: () => unknown[];
  })._getActiveHandles?.() ?? [];
}

function getConstructorName(handle: unknown): string {
  if (!handle || typeof handle !== 'object') return '';
  return (handle as { constructor?: { name?: string } }).constructor?.name ?? '';
}

function countChildProcesses(handles: unknown[]): number {
  let count = 0;
  for (const handle of handles) {
    if (getConstructorName(handle) === 'ChildProcess') {
      count++;
    }
  }
  return count;
}

function countNonAmbientNonChildHandles(handles: unknown[]): number {
  let count = 0;
  for (const handle of handles) {
    const constructorName = getConstructorName(handle);
    if (!constructorName) continue;
    if (constructorName === 'ChildProcess') continue;
    if (AMBIENT_HANDLE_NAMES.has(constructorName)) continue;
    count++;
  }
  return count;
}

export function establishAmbientBaseline(): void {
  if (ambientChildProcessBaseline === null) {
    ambientChildProcessBaseline = countChildProcesses(getRawHandles());
  }
}

export function snapshotActiveHandles(): ActiveHandleSnapshot {
  const handles = getRawHandles();
  if (ambientChildProcessBaseline === null) {
    ambientChildProcessBaseline = countChildProcesses(handles);
  }
  const childProcesses = countChildProcesses(handles);
  return {
    total: handles.length,
    childProcesses,
    childProcessExtra: Math.max(0, childProcesses - ambientChildProcessBaseline),
    extra: countNonAmbientNonChildHandles(handles),
  };
}

/**
 * Assert that no non-ambient handles remain.
 */
export function assertNoActiveHandles(): void {
  const snapshot = snapshotActiveHandles();
  if (snapshot.extra > 0) {
    throw new Error(
      `Expected no active non-ambient handles, but found ${snapshot.extra} extra handle(s) ` +
      `(total handles: ${snapshot.total}, child processes: ${snapshot.childProcesses}, ambient child baseline: ${ambientChildProcessBaseline ?? 0}). ` +
      `This indicates a handle leak in a test or shutdown path.`,
    );
  }
}