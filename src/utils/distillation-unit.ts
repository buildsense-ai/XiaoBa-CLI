import * as fs from 'fs';
import * as path from 'path';
import {
  isSessionTurnEntry,
  ParsedSessionLogEntry,
  SessionTurnLogEntry,
  LegacySessionTurnLogEntry,
} from './session-log-schema';
import {
  advanceCursor,
  getCursor,
  loadLogCursorState,
  LogCursorEntry,
  LogCursorState,
  markCursorFailed,
  saveLogCursorState,
} from './log-cursor-state';

/**
 * Distillation Unit extraction for append-only session logs.
 *
 * A Distillation Unit is a chunk of one session log file made from newly
 * appended completed turns plus continuity context (up to ten prior completed
 * turns from the same file), processed independently by the distiller.
 *
 * See CONTEXT.md → "Distillation Unit", "Continuity Context", "Log Cursor".
 */

export const MAX_CONTINUITY_TURNS = 10;

export type CompletedTurn = SessionTurnLogEntry | LegacySessionTurnLogEntry;

export interface DistillationUnit {
  /** Session log file this unit was extracted from. */
  filePath: string;
  /** Newly appended completed turns not yet processed. */
  newTurns: CompletedTurn[];
  /** Up to MAX_CONTINUITY_TURNS prior completed turns from the same file. */
  continuityTurns: CompletedTurn[];
  /** Byte range of the newly processed content in the source file. */
  byteRange: { start: number; end: number };
  /** ISO timestamp of unit creation. */
  generatedAt: string;
}

export interface ExtractionResult {
  /** The produced Distillation Unit, or null when no new completed turns. */
  distillationUnit: DistillationUnit | null;
  /** The cursor after this extraction (caller persists on success). */
  newCursor: LogCursorEntry;
  /** Whether the cursor advanced past previously unprocessed content. */
  advanced: boolean;
}

export interface ProcessSessionLogResult {
  distillationUnit: DistillationUnit | null;
  advanced: boolean;
  processed: boolean;
}

/**
 * Extract a Distillation Unit from a single session log file given the
 * current cursor position.
 *
 * This is a pure function — it does not persist state. The caller is
 * responsible for saving the returned cursor only after successful processing.
 */
export function extractDistillationUnit(
  filePath: string,
  cursor: LogCursorEntry,
): ExtractionResult {
  const buffer = fs.readFileSync(filePath);
  const fileSize = buffer.length;

  // No new bytes beyond the cursor → idempotent, no duplicate DU.
  if (fileSize <= cursor.byteOffset) {
    return {
      distillationUnit: null,
      newCursor: { ...cursor, status: 'completed' },
      advanced: false,
    };
  }

  const newBuffer = buffer.subarray(cursor.byteOffset);

  // Only process up to the last complete line (ending with \n).
  // Partial content at the tail will be retried on the next run.
  const lastNewline = newBuffer.lastIndexOf(0x0a); // '\n'
  const completeBytes = lastNewline === -1 ? 0 : lastNewline + 1;

  if (completeBytes === 0) {
    // No complete lines yet — don't advance, don't produce a DU.
    return {
      distillationUnit: null,
      newCursor: cursor,
      advanced: false,
    };
  }

  const newContent = newBuffer.subarray(0, completeBytes).toString('utf-8');
  const newEntries = parseLines(newContent);
  const newTurns = newEntries.filter(isSessionTurnEntry);

  const advancedOffset = cursor.byteOffset + completeBytes;

  // New non-turn content (runtime, prompt_trace, etc.) advances the cursor
  // but does not produce a Distillation Unit.
  if (newTurns.length === 0) {
    return {
      distillationUnit: null,
      newCursor: {
        filePath,
        byteOffset: advancedOffset,
        processedTurnCount: cursor.processedTurnCount,
        updatedAt: new Date().toISOString(),
        status: 'completed',
      },
      advanced: true,
    };
  }

  // Continuity context: up to MAX_CONTINUITY_TURNS prior completed turns.
  const priorBuffer = buffer.subarray(0, cursor.byteOffset);
  const priorContent = priorBuffer.toString('utf-8');
  const priorEntries = parseLines(priorContent);
  const priorTurns = priorEntries.filter(isSessionTurnEntry);
  const continuityTurns = priorTurns.slice(-MAX_CONTINUITY_TURNS);

  const distillationUnit: DistillationUnit = {
    filePath,
    newTurns,
    continuityTurns,
    byteRange: { start: cursor.byteOffset, end: advancedOffset },
    generatedAt: new Date().toISOString(),
  };

  return {
    distillationUnit,
    newCursor: {
      filePath,
      byteOffset: advancedOffset,
      processedTurnCount: cursor.processedTurnCount + newTurns.length,
      updatedAt: new Date().toISOString(),
      status: 'completed',
    },
    advanced: true,
  };
}

/**
 * Full processing flow for one session log file.
 *
 * Loads cursor state, extracts the Distillation Unit, invokes the processor,
 * and durably persists the cursor only after the processor succeeds.
 *
 * If the processor throws, the cursor stays at its original byte offset
 * (retryable) while the original log file is untouched (evidence preserved).
 *
 * @param filePath    Path to the append-only session log file.
 * @param stateFilePath  Path to the cursor state JSON file.
 * @param processor   Callback invoked with the Distillation Unit when one is
 *                    produced. If it throws, the cursor is not advanced.
 * @returns The Distillation Unit (if produced) and whether the cursor advanced.
 */
export function processSessionLog(
  filePath: string,
  stateFilePath: string,
  processor: (unit: DistillationUnit) => void,
): ProcessSessionLogResult {
  const state = loadLogCursorState(stateFilePath);
  const cursor = getCursor(state, filePath);

  let result: ExtractionResult;
  try {
    result = extractDistillationUnit(filePath, cursor);
  } catch (error) {
    markCursorFailed(state, filePath, cursor.byteOffset, error);
    saveLogCursorState(stateFilePath, state);
    return { distillationUnit: null, advanced: false, processed: false };
  }

  if (result.distillationUnit) {
    try {
      processor(result.distillationUnit);
      advanceCursor(state, result.newCursor);
      saveLogCursorState(stateFilePath, state);
      return {
        distillationUnit: result.distillationUnit,
        advanced: true,
        processed: true,
      };
    } catch (error) {
      // Processing failed — mark failed but preserve original byte offset
      // for retry. The log file (evidence) is never modified.
      markCursorFailed(state, filePath, cursor.byteOffset, error);
      saveLogCursorState(stateFilePath, state);
      return {
        distillationUnit: result.distillationUnit,
        advanced: false,
        processed: false,
      };
    }
  }

  // No Distillation Unit produced. Advance the cursor if new non-turn
  // content was seen, but don't invoke the processor.
  if (result.advanced) {
    advanceCursor(state, result.newCursor);
    saveLogCursorState(stateFilePath, state);
  }

  return { distillationUnit: null, advanced: result.advanced, processed: false };
}

/**
 * Process all session log files found under a directory tree.
 *
 * Each file is processed independently via {@link processSessionLog}.
 */
export function processSessionLogDirectory(
  logDir: string,
  stateFilePath: string,
  processor: (unit: DistillationUnit) => void,
): { units: DistillationUnit[]; advancedFiles: number } {
  const files = collectJsonlFiles(logDir);
  const units: DistillationUnit[] = [];
  let advancedFiles = 0;

  for (const filePath of files) {
    const result = processSessionLog(filePath, stateFilePath, processor);
    if (result.processed && result.distillationUnit) units.push(result.distillationUnit);
    if (result.advanced) advancedFiles++;
  }

  return { units, advancedFiles };
}

function collectJsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

function parseLines(content: string): ParsedSessionLogEntry[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as ParsedSessionLogEntry);
}
