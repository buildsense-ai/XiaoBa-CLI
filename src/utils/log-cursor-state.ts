import * as fs from 'fs';
import * as path from 'path';

/**
 * Per-session-log Log Cursor state.
 *
 * The Log Cursor records how far the heartbeat log distillation agent has
 * processed an append-only log file. Advancement is durable and keyed by byte
 * offset — it does not depend on last-processed date alone.
 *
 * See CONTEXT.md → "Log Cursor".
 */

export interface LogCursorEntry {
  /** Absolute or relative path of the session log file this cursor tracks. */
  filePath: string;
  /** Byte offset up to which the file has been fully processed. */
  byteOffset: number;
  /** Number of completed turns already processed from this file. */
  processedTurnCount: number;
  /** ISO timestamp of the last cursor advancement (metadata only). */
  updatedAt: string;
  /** Processing status for retryable-state tracking. */
  status: 'pending' | 'completed' | 'failed';
  /** Last error message when status === 'failed'. */
  lastError?: string;
  /**
   * True while the cursor is discarding a JSONL record that exceeded the
   * hard per-read byte quota. Persisting this bit lets later wakes advance in
   * bounded slices without buffering or reparsing the oversized record.
   */
  discardingOversizedLine?: boolean;
}

export interface LogCursorState {
  schemaVersion: 1;
  /** Map of file path → cursor entry. */
  cursors: Record<string, LogCursorEntry>;
  /** Set when the state file was corrupt and quarantined on load. */
  stateCorrupt?: boolean;
}

export function emptyLogCursorState(): LogCursorState {
  return { schemaVersion: 1, cursors: {} };
}

export function loadLogCursorState(stateFilePath: string): LogCursorState {
  if (fs.existsSync(corruptionMarkerPath(stateFilePath))) {
    return { ...emptyLogCursorState(), stateCorrupt: true };
  }
  if (!fs.existsSync(stateFilePath)) {
    return emptyLogCursorState();
  }

  const raw = fs.readFileSync(stateFilePath, 'utf-8');
  try {
    const parsed = JSON.parse(
      raw,
    ) as Partial<LogCursorState>;
    if (parsed.schemaVersion !== 1 || !parsed.cursors || typeof parsed.cursors !== 'object') {
      throw new Error('invalid Log Cursor state');
    }
    return {
      schemaVersion: 1,
      cursors: parsed.cursors,
    };
  } catch {
    quarantineCorruptState(stateFilePath);
    return { ...emptyLogCursorState(), stateCorrupt: true };
  }
}

/**
 * Atomically persist cursor state. Uses temp-file + rename for durability.
 */
export function saveLogCursorState(
  stateFilePath: string,
  state: LogCursorState,
): void {
  if (state.stateCorrupt || fs.existsSync(corruptionMarkerPath(stateFilePath))) {
    throw new Error('Log Cursor state is corrupt; explicit recovery is required before writing.');
  }
  writeLogCursorState(stateFilePath, state);
}

/** Explicit operator recovery after the quarantined cursor was inspected. */
export function recoverLogCursorState(
  stateFilePath: string,
  state: LogCursorState,
): void {
  writeLogCursorState(stateFilePath, { ...state, stateCorrupt: undefined });
  try {
    fs.unlinkSync(corruptionMarkerPath(stateFilePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function writeLogCursorState(stateFilePath: string, state: LogCursorState): void {
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  const payload: LogCursorState = {
    schemaVersion: 1,
    cursors: state.cursors || {},
  };
  const tmpPath = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(tmpPath, stateFilePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only; preserve the original error.
    }
    throw error;
  }
}

/**
 * Returns the cursor for a given file, creating a fresh one at byteOffset 0
 * when none exists yet.
 */
export function getCursor(
  state: LogCursorState,
  filePath: string,
): LogCursorEntry {
  return (
    state.cursors[filePath] ?? {
      filePath,
      byteOffset: 0,
      processedTurnCount: 0,
      updatedAt: '',
      status: 'pending',
    }
  );
}

/**
 * Updates a cursor entry in the state, marking it completed.
 */
export function advanceCursor(
  state: LogCursorState,
  entry: LogCursorEntry,
): void {
  state.cursors[entry.filePath] = entry;
}

/**
 * Marks a cursor as failed while preserving the original byte offset so the
 * next run can retry without losing evidence.
 */
export function markCursorFailed(
  state: LogCursorState,
  filePath: string,
  byteOffset: number,
  error: unknown,
): LogCursorEntry {
  const entry: LogCursorEntry = {
    filePath,
    byteOffset,
    processedTurnCount: state.cursors[filePath]?.processedTurnCount ?? 0,
    updatedAt: new Date().toISOString(),
    status: 'failed',
    lastError: String(error),
    ...(state.cursors[filePath]?.discardingOversizedLine
      ? { discardingOversizedLine: true }
      : {}),
  };
  state.cursors[filePath] = entry;
  return entry;
}

function quarantineCorruptState(stateFilePath: string): void {
  const markerPath = corruptionMarkerPath(stateFilePath);
  fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`, { encoding: 'utf8', mode: 0o600 });
  if (!fs.existsSync(stateFilePath)) return;
  const corruptPath = `${stateFilePath}.corrupt.${Date.now()}`;
  fs.renameSync(stateFilePath, corruptPath);
}

function corruptionMarkerPath(stateFilePath: string): string {
  return `${stateFilePath}.state-corrupt`;
}
