import * as fs from 'fs';
import * as path from 'path';
import { PathResolver } from '../utils/path-resolver';
import { sanitizeProviderErrorMessageForLog } from '../utils/provider-error-log-sanitizer';

export interface TurnErrorRecord {
  timestamp: string;
  session_id: string;
  session_type: string;
  category: string;
  error_code: string;
  classification_confidence: string;
  phase: string;
  error_origin: string;
  recovery_action: string;
  retry_strategy: string;
  model: string;
  provider: string;
  http_status: number | null;
  provider_code: string;
  provider_type: string;
  provider_request_id: string;
  error_fingerprint: string;
  stack_fingerprint: string;
  top_frame: string;
  error_summary: string;
  attempt_count: number;
  retry_count: number;
  retry_stop_reason: string;
  retry_elapsed_ms: number;
  turn_elapsed_ms: number;
  partial_progress_preserved: boolean;
  episode_id: string;
  model_call_id: string;
  model_attempt_id: string;
  model_attempt_number: number;
  source_file: string;
  source_line: number;
}

export interface TurnErrorAggregate {
  key: string;
  count: number;
  latest_at: string;
}

export interface TurnErrorReport {
  generated_at: string;
  window_days: number;
  totals: {
    interruptions: number;
    needs_investigation: number;
    retried_before_interrupt: number;
    partial_progress_preserved: number;
    files_scanned: number;
    malformed_lines: number;
  };
  by_category: TurnErrorAggregate[];
  by_fingerprint: TurnErrorAggregate[];
  by_model: TurnErrorAggregate[];
  by_phase: TurnErrorAggregate[];
  by_origin: TurnErrorAggregate[];
  by_top_frame: TurnErrorAggregate[];
  by_retry_stop_reason: TurnErrorAggregate[];
  by_recovery_action: TurnErrorAggregate[];
  recent: TurnErrorRecord[];
}

export interface ReadTurnErrorReportOptions {
  logsRoot?: string;
  days?: number;
  limit?: number;
  now?: Date;
}

export function readTurnErrorReport(options: ReadTurnErrorReportOptions = {}): TurnErrorReport {
  const logsRoot = options.logsRoot ?? PathResolver.getLogsPath('sessions');
  const days = clampInteger(options.days, 7, 1, 365);
  const limit = clampInteger(options.limit, 100, 1, 500);
  const now = options.now ?? new Date();
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  const records: TurnErrorRecord[] = [];
  let malformedLines = 0;
  const files = listJsonlFiles(logsRoot);

  for (const filePath of files) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      malformedLines++;
      continue;
    }
    const relativeFile = path.relative(logsRoot, filePath).replace(/\\/g, '/');
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (!line || !line.includes('"turn_error"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.entry_type !== 'runtime' || entry?.event?.type !== 'turn_error') continue;
        const timestampMs = Date.parse(String(entry.timestamp || ''));
        if (!Number.isFinite(timestampMs) || timestampMs < cutoffMs) continue;
        records.push(toTurnErrorRecord(entry, relativeFile, index + 1));
      } catch {
        malformedLines++;
      }
    }
  }

  records.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const needsInvestigation = records.filter(needsFurtherInvestigation).length;

  return {
    generated_at: now.toISOString(),
    window_days: days,
    totals: {
      interruptions: records.length,
      needs_investigation: needsInvestigation,
      retried_before_interrupt: records.filter(record => record.retry_count > 0).length,
      partial_progress_preserved: records.filter(record => record.partial_progress_preserved).length,
      files_scanned: files.length,
      malformed_lines: malformedLines,
    },
    by_category: aggregate(records, record => record.category),
    by_fingerprint: aggregate(records, record => record.error_fingerprint || record.error_code),
    by_model: aggregate(records, record => record.model || 'unknown'),
    by_phase: aggregate(records, record => record.phase || 'unknown'),
    by_origin: aggregate(records, record => record.error_origin || 'unknown'),
    by_top_frame: aggregate(records, record => record.top_frame || 'unknown'),
    by_retry_stop_reason: aggregate(records, record => record.retry_stop_reason || 'unknown'),
    by_recovery_action: aggregate(records, record => record.recovery_action || 'unknown'),
    recent: records.slice(0, limit),
  };
}

function needsFurtherInvestigation(record: TurnErrorRecord): boolean {
  if (record.classification_confidence === 'low') return true;
  if (record.category === 'unexpected' || record.category === 'provider_rejected') return true;
  // Legacy classifiers sometimes labelled a bare status-only 400 as request_invalid.
  // Without a provider code/type/body this remains an unproven cause.
  return record.classification_confidence === 'unknown'
    && /request failed with status code\s+\d{3}/i.test(record.error_summary)
    && !record.provider_code
    && !record.provider_type;
}

function toTurnErrorRecord(entry: any, sourceFile: string, sourceLine: number): TurnErrorRecord {
  const payload = entry?.event?.payload || {};
  return {
    timestamp: String(entry.timestamp || ''),
    session_id: safeText(entry.session_id),
    session_type: safeText(entry.session_type),
    category: safeText(payload.category) || 'unexpected',
    error_code: safeText(payload.error_code) || 'unexpected',
    classification_confidence: safeText(payload.classification_confidence) || 'unknown',
    phase: safeText(payload.phase) || 'unknown',
    error_origin: safeText(payload.error_origin) || 'unknown',
    recovery_action: safeText(payload.recovery_action) || 'unknown',
    retry_strategy: safeText(payload.retry_strategy) || 'unknown',
    model: safeText(payload.model),
    provider: safeText(payload.provider),
    http_status: safeNumber(payload.http_status),
    provider_code: safeText(payload.provider_code),
    provider_type: safeText(payload.provider_type),
    provider_request_id: safeText(payload.provider_request_id),
    error_fingerprint: safeText(payload.error_fingerprint),
    stack_fingerprint: safeText(payload.stack_fingerprint),
    top_frame: safeText(payload.top_frame),
    error_summary: sanitizeProviderErrorMessageForLog(payload.error_summary || entry.message || 'unknown error'),
    attempt_count: safeInteger(payload.attempt_count, 1),
    retry_count: safeInteger(payload.retry_count, 0),
    retry_stop_reason: safeText(payload.retry_stop_reason) || 'unknown',
    retry_elapsed_ms: safeInteger(payload.retry_elapsed_ms, 0),
    turn_elapsed_ms: safeInteger(payload.turn_elapsed_ms, 0),
    partial_progress_preserved: payload.partial_progress_preserved === true,
    episode_id: safeText(payload.episode_id),
    model_call_id: safeText(payload.model_call_id),
    model_attempt_id: safeText(payload.model_attempt_id),
    model_attempt_number: safeInteger(payload.model_attempt_number, 0),
    source_file: sourceFile,
    source_line: sourceLine,
  };
}

function aggregate(records: TurnErrorRecord[], keyOf: (record: TurnErrorRecord) => string): TurnErrorAggregate[] {
  const grouped = new Map<string, TurnErrorAggregate>();
  for (const record of records) {
    const key = keyOf(record) || 'unknown';
    const current = grouped.get(key);
    if (current) {
      current.count++;
      if (record.timestamp > current.latest_at) current.latest_at = record.timestamp;
    } else {
      grouped.set(key, { key, count: 1, latest_at: record.timestamp });
    }
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count || b.latest_at.localeCompare(a.latest_at));
}

function listJsonlFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
    }
  }
  return files.sort();
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function safeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function safeNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 240);
}
