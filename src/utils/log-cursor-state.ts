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
  try {
    if (!fs.existsSync(stateFilePath)) {
      return emptyLogCursorState();
    }
    const parsed = JSON.parse(
      fs.readFileSync(stateFilePath, 'utf-8'),
    ) as Partial<LogCursorState>;
    return {
      schemaVersion: 1,
      cursors: parsed.cursors || {},
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
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  const payload: LogCursorState = {
    schemaVersion: 1,
    cursors: state.cursors || {},
  };
  const tmpPath = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  fs.renameSync(tmpPath, stateFilePath);
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
  };
  state.cursors[filePath] = entry;
  return entry;
}

function quarantineCorruptState(stateFilePath: string): void {
  try {
    if (!fs.existsSync(stateFilePath)) return;
    const corruptPath = `${stateFilePath}.corrupt.${Date.now()}`;
    fs.renameSync(stateFilePath, corruptPath);
  } catch {
    // Best-effort quarantine only.
  }
}