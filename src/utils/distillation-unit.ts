import * as fs from 'fs';
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

/**
 * Production-safe extraction quotas (issue #51 bounded heartbeat work).
 *
 * These bound one Distillation Unit extraction so a single oversized log
 * append cannot produce an unbounded unit, cannot reparse unbounded history
 * for continuity, and cannot run away past a defensive time budget. Quotas are
 * soft caps: at least one complete line is always processed when available so
 * the cursor can advance, and the byte/turn caps split a large batch into
 * multiple units across successive wakes (truncation/offset semantics — the
 * remainder is left past the new cursor for the next wake).
 */
export interface ExtractionQuotas {
  /** Max new bytes (complete lines) folded into one Distillation Unit. */
  maxNewBytesPerUnit: number;
  /** Max new turn entries folded into one Distillation Unit. */
  maxNewTurnsPerUnit: number;
  /**
   * Max bytes of prior content read for continuity context. Only this bounded
   * tail window (an offset-safe read) is parsed, instead of re-parsing the
   * entire processed history of the file on every extraction.
   */
  maxContinuityReadBytes: number;
  /** Defensive wall-clock budget for one extraction in milliseconds. */
  maxExtractionMs: number;
}

/** Production defaults for extraction quotas. */
export const DEFAULT_EXTRACTION_QUOTAS: ExtractionQuotas = {
  maxNewBytesPerUnit: 2 * 1024 * 1024, // 2 MiB
  maxNewTurnsPerUnit: 500,
  maxContinuityReadBytes: 256 * 1024, // 256 KiB
  maxExtractionMs: 5_000, // 5 s
};

function normalizeExtractionQuota(
  value: number | undefined,
  fallback: number,
  minimum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

export type CompletedTurn = SessionTurnLogEntry | LegacySessionTurnLogEntry;

/** Origin metadata carried only on in-memory continuity turns. */
export interface TurnOrigin {
  filePath: string;
  byteRange?: { start: number; end: number };
}

export type DistillationTurn = CompletedTurn & { origin?: TurnOrigin };

/**
 * Structured external-source event provenance.
 *
 * Present only on Distillation Units produced by external Session Log
 * Sources (e.g. xURL). Carries the provider-scoped identity and immutable
 * content fingerprint so downstream stages (distiller, learning-episode
 * extractor, skill renderer) can expose lineage without fragile parsing of
 * the synthetic `filePath`.
 *
 * For external units `byteRange` holds the canonical ordinal range
 * (`startOrdinal`–`endOrdinal`), not filesystem byte offsets; this type
 * makes that explicit so renderers can label it correctly.
 */
export interface ExternalEventProvenance {
  /** External provider that owns the thread (e.g. "openai", "pi"). */
  readonly provider: string;
  /** Thread / conversation identity within the provider. */
  readonly threadId: string;
  /** Immutable content fingerprint from the rendered Timeline. */
  readonly contentHash: string;
  /** Inclusive start ordinal of the canonical event. */
  readonly startOrdinal: number;
  /** Inclusive end ordinal of the canonical event. */
  readonly endOrdinal: number;
  /** Branch identity within the thread, when the source exposes one. */
  readonly branchId?: string;
  /** Source revision / updated-at token, when available. */
  readonly revision?: string;
}

export interface DistillationUnit {
  /** Session log file this unit was extracted from. */
  filePath: string;
  /** Newly appended completed turns not yet processed. */
  newTurns: DistillationTurn[];
  /** Up to MAX_CONTINUITY_TURNS prior completed turns from the same file. */
  continuityTurns: DistillationTurn[];
  /** Byte range of the newly processed content in the source file. */
  byteRange: { start: number; end: number };
  /** ISO timestamp of unit creation. */
  generatedAt: string;
  /**
   * External source event provenance; present only for units produced by
   * external Session Log Sources (xURL). Absent for local/session-log units
   * and older persisted records.
   */
  externalEventProvenance?: ExternalEventProvenance;
}

export interface CrossFileContinuityOptions {
  /** Ordered session-log files; only the immediate predecessor is eligible. */
  orderedFilePaths: readonly string[];
  /** Runtime session identity that must match both files. */
  runtimeSessionId?: string;
  /** Defensive upper bound; values above the V3 ten-turn policy are capped. */
  maxTurns?: number;
}

/** Normalize a caller-supplied continuity limit before applying the policy cap. */
export function normalizeContinuityLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_CONTINUITY_TURNS;
  return Math.max(0, Math.floor(value));
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
  options: {
    crossFileContinuity?: CrossFileContinuityOptions;
    /**
     * Production-safe extraction quotas. When omitted, the
     * {@link DEFAULT_EXTRACTION_QUOTAS production defaults} are applied.
     */
    quotas?: Partial<ExtractionQuotas>;
  } = {},
): ExtractionResult {
  const requestedQuotas = options.quotas;
  const quotas: ExtractionQuotas = {
    maxNewBytesPerUnit: normalizeExtractionQuota(
      requestedQuotas?.maxNewBytesPerUnit,
      DEFAULT_EXTRACTION_QUOTAS.maxNewBytesPerUnit,
      1,
    ),
    maxNewTurnsPerUnit: normalizeExtractionQuota(
      requestedQuotas?.maxNewTurnsPerUnit,
      DEFAULT_EXTRACTION_QUOTAS.maxNewTurnsPerUnit,
      1,
    ),
    maxContinuityReadBytes: normalizeExtractionQuota(
      requestedQuotas?.maxContinuityReadBytes,
      DEFAULT_EXTRACTION_QUOTAS.maxContinuityReadBytes,
      0,
    ),
    maxExtractionMs: normalizeExtractionQuota(
      requestedQuotas?.maxExtractionMs,
      DEFAULT_EXTRACTION_QUOTAS.maxExtractionMs,
      1,
    ),
  };
  const startMs = Date.now();
  const fileSize = fs.statSync(filePath).size;

  // No new bytes beyond the cursor → idempotent, no duplicate DU.
  if (fileSize <= cursor.byteOffset) {
    return {
      distillationUnit: null,
      newCursor: { ...cursor, status: 'completed' },
      advanced: false,
    };
  }

  // Hard-bounded range read: at most maxNewBytesPerUnit bytes enter memory in
  // one extraction. Oversized records are discarded in durable cursor slices
  // instead of forcing Buffer.concat to grow until an arbitrarily distant
  // newline. Normal partial appends remain unacknowledged until complete.
  const fd = fs.openSync(filePath, 'r');
  try {
    const readResult = readBoundedCompleteLines(
      fd,
      cursor.byteOffset,
      fileSize,
      quotas.maxNewBytesPerUnit,
      cursor.discardingOversizedLine === true,
    );
    if (!readResult.consumedBytes) {
      return {
        distillationUnit: null,
        newCursor: cursor,
        advanced: false,
      };
    }

    if (readResult.content.length === 0) {
      return {
        distillationUnit: null,
        newCursor: {
          filePath,
          byteOffset: cursor.byteOffset + readResult.consumedBytes,
          processedTurnCount: cursor.processedTurnCount,
          updatedAt: new Date().toISOString(),
          status: 'completed',
          ...(readResult.discardingOversizedLine ? { discardingOversizedLine: true } : {}),
        },
        advanced: true,
      };
    }

    const newContentBytes = readResult.content;
    const completeBytes = readResult.content.length;

    // Parse complete new lines up to the byte/turn/time quotas. At least one
    // complete line is always processed so the cursor can advance past an
    // oversized append; the remainder is left past the new cursor for the
    // next wake (truncation/offset semantics).
    const newContent = newContentBytes.subarray(0, completeBytes);
    const newTurns: DistillationTurn[] = [];
    let processedBytes = 0;
    let producedAny = false;

    let offset = 0;
    while (offset < newContent.length) {
      const nl = newContent.indexOf(0x0a, offset);
      if (nl === -1) break; // completeBytes is a complete-line boundary; defensive
      const lineEnd = nl + 1;
      const lineLen = lineEnd - offset;
      // Byte quota: stop before adding this line would exceed the budget,
      // but always process at least one complete line (oversized-line safety).
      if (producedAny && processedBytes + lineLen > quotas.maxNewBytesPerUnit) break;
      // Time budget (defensive). Checked only after producing at least one line.
      if (producedAny && Date.now() - startMs > quotas.maxExtractionMs) break;
      const entry = JSON.parse(
        newContent.subarray(offset, lineEnd).toString('utf-8').trim(),
      ) as ParsedSessionLogEntry;
      processedBytes = lineEnd;
      offset = lineEnd;
      producedAny = true;
      if (isSessionTurnEntry(entry)) {
        newTurns.push(entry as DistillationTurn);
        if (newTurns.length >= quotas.maxNewTurnsPerUnit) break; // event quota
      }
    }

    const advancedOffset = cursor.byteOffset + processedBytes;

    // New non-turn content (runtime, prompt_trace, etc.) advances the cursor
    // but does not produce a Distillation Unit. If quotas truncated before any
    // turn was reached, the processed non-turn content still advances the
    // cursor and the remaining turns are retried on the next wake.
    if (newTurns.length === 0) {
      return {
        distillationUnit: null,
        newCursor: {
          filePath,
          byteOffset: advancedOffset,
          processedTurnCount: cursor.processedTurnCount,
          updatedAt: new Date().toISOString(),
          status: 'completed',
          ...(readResult.discardingOversizedLine ? { discardingOversizedLine: true } : {}),
        },
        advanced: processedBytes > 0,
      };
    }

    // Continuity context: up to MAX_CONTINUITY_TURNS prior completed turns,
    // read from a bounded offset-safe tail window BEFORE the cursor (never the
    // whole processed history). This is a bounded range read from the same fd.
    const continuityTurns = readContinuityTailFromFile(
      fd,
      cursor.byteOffset,
      quotas.maxContinuityReadBytes,
    );
    const resolvedContinuityTurns =
      continuityTurns.length > 0 || !options.crossFileContinuity
        ? continuityTurns
        : readImmediatePredecessorTurns(
          filePath,
          newTurns,
          options.crossFileContinuity,
          quotas.maxContinuityReadBytes,
        );

    const distillationUnit: DistillationUnit = {
      filePath,
      newTurns,
      continuityTurns: resolvedContinuityTurns,
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
        ...(readResult.discardingOversizedLine ? { discardingOversizedLine: true } : {}),
      },
      advanced: true,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read up to {@link MAX_CONTINUITY_TURNS} prior completed turns from a bounded
 * offset-safe tail window of the processed history. Only the last
 * `maxBytes` before the cursor are read and parsed (a bounded range read on
 * `fd`), so continuity never loads or re-parses unbounded history. A leading
 * partial line (when the window starts mid-line) is dropped so it cannot
 * corrupt JSON parsing.
 */
interface CompleteLineReadResult {
  readonly content: Buffer;
  readonly consumedBytes: number;
  readonly discardingOversizedLine: boolean;
}

function readBoundedCompleteLines(
  fd: number,
  startOffset: number,
  fileSize: number,
  byteQuota: number,
  discardingOversizedLine: boolean,
): CompleteLineReadResult {
  const readLength = Math.min(Math.max(1, byteQuota), fileSize - startOffset);
  if (readLength <= 0) {
    return { content: Buffer.alloc(0), consumedBytes: 0, discardingOversizedLine };
  }
  const buffer = Buffer.alloc(readLength);
  const bytesRead = fs.readSync(fd, buffer, 0, readLength, startOffset);
  if (bytesRead <= 0) {
    return { content: Buffer.alloc(0), consumedBytes: 0, discardingOversizedLine };
  }
  const actual = buffer.subarray(0, bytesRead);

  if (discardingOversizedLine) {
    const newline = actual.indexOf(0x0a);
    const consumedBytes = newline >= 0 ? newline + 1 : bytesRead;
    return {
      content: Buffer.alloc(0),
      consumedBytes,
      discardingOversizedLine: newline < 0,
    };
  }

  const lastNewline = actual.lastIndexOf(0x0a);
  if (lastNewline >= 0) {
    const consumedBytes = lastNewline + 1;
    return {
      content: actual.subarray(0, consumedBytes),
      consumedBytes,
      discardingOversizedLine: false,
    };
  }

  // A record that fills the hard byte window without a newline is too large
  // to admit safely. Advance this bounded slice and remember that subsequent
  // slices must be discarded until the record boundary is found.
  if (bytesRead >= byteQuota) {
    return {
      content: Buffer.alloc(0),
      consumedBytes: bytesRead,
      discardingOversizedLine: true,
    };
  }

  // The writer has not completed this line yet. Preserve the cursor exactly.
  return { content: Buffer.alloc(0), consumedBytes: 0, discardingOversizedLine: false };
}

function readContinuityTailFromFile(
  fd: number,
  cursorByteOffset: number,
  maxBytes: number,
): DistillationTurn[] {
  if (cursorByteOffset <= 0 || maxBytes <= 0) return [];
  const readLen = Math.min(maxBytes, cursorByteOffset);
  const readStart = cursorByteOffset - readLen;
  const buf = Buffer.alloc(readLen);
  const bytesRead = fs.readSync(fd, buf, 0, readLen, readStart);
  const window = buf.subarray(0, bytesRead).toString('utf-8');
  // Drop a leading partial line unless the window starts at offset 0.
  const body = readStart > 0 ? dropLeadingPartialLine(window) : window;
  if (body.length === 0) return [];
  const priorTurns = parseLines(body).filter(isSessionTurnEntry) as DistillationTurn[];
  return priorTurns.slice(-MAX_CONTINUITY_TURNS);
}

/**
 * Read up to {@link MAX_CONTINUITY_TURNS} prior completed turns from a bounded
 * offset-safe tail window at the end of `filePath` (used for the cross-file
 * immediate-predecessor case). Opens its own short-lived fd; only the last
 * `maxBytes` of the file are read and parsed.
 */
function readContinuityTailFromPath(
  filePath: string,
  maxBytes: number,
): DistillationTurn[] {
  const fileSize = fs.statSync(filePath).size;
  if (fileSize <= 0 || maxBytes <= 0) return [];
  const fd = fs.openSync(filePath, 'r');
  try {
    return readContinuityTailFromFile(fd, fileSize, maxBytes);
  } finally {
    fs.closeSync(fd);
  }
}

function dropLeadingPartialLine(content: string): string {
  const nl = content.indexOf('\n');
  if (nl < 0) return ''; // whole window is one partial line — nothing complete
  return content.slice(nl + 1);
}

function readImmediatePredecessorTurns(
  currentFilePath: string,
  currentTurns: DistillationTurn[],
  options: CrossFileContinuityOptions,
  maxContinuityReadBytes: number,
): DistillationTurn[] {
  const currentIndex = options.orderedFilePaths.indexOf(currentFilePath);
  if (currentIndex <= 0 || currentTurns.length === 0) return [];
  if (!hasContinuationSignal(currentTurns[0].user.text)) return [];
  const expectedRuntimeSessionId = options.runtimeSessionId?.trim() || runtimeSessionId(currentTurns[0]);
  if (currentTurns.some(turn => runtimeSessionId(turn) !== expectedRuntimeSessionId)) return [];

  // This is the only cross-file read: the ordered list proves the selected
  // source is the immediate predecessor, not an arbitrary historical log.
  // Read only a bounded tail window of the predecessor (offset-safe range
  // read) rather than loading or re-parsing its entire history.
  const predecessorPath = options.orderedFilePaths[currentIndex - 1];
  if (!fs.existsSync(predecessorPath)) return [];
  const predecessorTurns = readContinuityTailFromPath(
    predecessorPath,
    maxContinuityReadBytes,
  ).filter(turn => runtimeSessionId(turn) === expectedRuntimeSessionId) as DistillationTurn[];
  if (predecessorTurns.length === 0) return [];
  const maxTurns = Math.min(MAX_CONTINUITY_TURNS, normalizeContinuityLimit(options.maxTurns));
  return maxTurns === 0
    ? []
    : predecessorTurns.slice(-maxTurns).map(turn => ({
      ...turn,
      origin: { filePath: predecessorPath },
    }));
}

function runtimeSessionId(turn: CompletedTurn): string {
  const candidate = turn as CompletedTurn & { runtime_session_id?: string; runtime_id?: string };
  return String(candidate.runtime_session_id || candidate.runtime_id || candidate.session_id).trim();
}

function hasContinuationSignal(text: string): boolean {
  return /(?:^|\W)(?:continue|resume|redo|try again|接着做|继续|重做)(?:$|\W)/i.test(
    String(text || '').replace(/\s+/g, ' ').trim(),
  );
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

function parseLines(content: string): ParsedSessionLogEntry[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as ParsedSessionLogEntry);
}
