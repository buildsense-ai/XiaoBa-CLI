import * as fs from 'fs';
import * as path from 'path';
import { resolveCacheTraceDir } from './cache-trace';

export interface CacheTraceUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  freshInputTokens: number;
  outputTokens: number;
  hitRatio: number;
}

export type CacheTraceOutcome = 'succeeded' | 'retrying' | 'failed' | 'cancelled' | 'incomplete';

export interface CacheTraceRecord {
  schema: string;
  file: string;
  sessionId: string;
  sessionType: string;
  surface: string;
  episodeNumber: number;
  runId: string;
  callId: string;
  attemptId: string;
  attemptNumber: number;
  outcome: CacheTraceOutcome;
  hasStarted: boolean;
  timestamp: string;
  durationMs: number;
  provider: string;
  model: string;
  apiType: string;
  requestSha256: string;
  stableSystemSha256: string;
  messageSha256s: string[];
  estimatedTokens: number;
  retryNumber: number;
  retryDelayMs: number;
  retryStopReason: string;
  errorCategory: string;
  errorSummary: string;
  httpStatus: number | null;
  usage: CacheTraceUsage;
  diff: {
    baselineReset: boolean;
    resetReason?: 'first-record' | 'provider-model-api-changed';
    requestChanged: boolean;
    stableSystemChanged: boolean;
    changedMessageIndices: number[];
  };
}

export interface CacheTraceSessionSummary {
  sessionId: string;
  sessionType: string;
  surface: string;
  records: number;
  calls: number;
  successfulAttempts: number;
  retryingAttempts: number;
  failedAttempts: number;
  cancelledAttempts: number;
  incompleteAttempts: number;
  retriedCalls: number;
  recoveredCalls: number;
  terminalFailedCalls: number;
  firstTimestamp: string;
  lastTimestamp: string;
  providers: string[];
  models: string[];
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  weightedHitRatio: number;
  anomalousRecords: number;
}

export interface CacheTraceStore {
  traceDir: string;
  scannedFiles: number;
  malformedFiles: number;
  records: CacheTraceRecord[];
  sessions: CacheTraceSessionSummary[];
}

export async function readCacheTraceStore(
  traceDir: string = resolveCacheTraceDir(),
): Promise<CacheTraceStore> {
  const files = await listTraceFiles(traceDir);
  const normalized: Omit<CacheTraceRecord, 'diff'>[] = [];
  let malformedFiles = 0;

  for (const file of files) {
    try {
      const content = await fs.promises.readFile(file, 'utf8');
      const relative = path.relative(traceDir, file);
      if (file.endsWith('.jsonl')) {
        const groups = new Map<string, any[]>();
        let malformed = false;
        for (const line of content.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
          try {
            const raw = JSON.parse(line);
            const key = text(raw?.lifecycle?.attempt_id || `line-${groups.size + 1}`);
            groups.set(key, [...(groups.get(key) || []), raw]);
          } catch {
            malformed = true;
          }
        }
        for (const events of groups.values()) {
          const record = normalizeAttemptEvents(events, relative);
          if (record) normalized.push(record);
          else malformed = true;
        }
        if (malformed || groups.size === 0) malformedFiles++;
      } else {
        const raw = JSON.parse(content);
        const record = raw?.schema === 'xiaoba.cache_trace.v4'
          ? normalizeAttemptEvents([raw], relative)
          : normalizeLegacyRecord(raw, relative);
        if (record) normalized.push(record);
        else malformedFiles++;
      }
    } catch {
      malformedFiles++;
    }
  }

  normalized.sort((left, right) => left.timestamp.localeCompare(right.timestamp)
    || left.episodeNumber - right.episodeNumber
    || left.attemptNumber - right.attemptNumber
    || left.file.localeCompare(right.file));
  const records = attachDiffs(normalized);
  return {
    traceDir: path.resolve(traceDir),
    scannedFiles: files.length,
    malformedFiles,
    records,
    sessions: summarizeSessions(records),
  };
}

function normalizeAttemptEvents(
  events: any[],
  file: string,
): Omit<CacheTraceRecord, 'diff'> | null {
  const valid = events.filter(raw => raw && typeof raw === 'object');
  if (valid.length === 0) return null;
  const started = valid.find(raw => raw?.lifecycle?.outcome === 'started');
  const terminal = valid.slice().reverse().find(raw => raw?.lifecycle?.outcome !== 'started');
  const base = started || terminal || valid[0];
  const final = terminal || base;
  const request = base.request || final.request || {};
  const lifecycle = final.lifecycle || {};
  const firstLifecycle = base.lifecycle || {};
  const responseUsage = final.response_usage || final.response?.usage || final.usage || {};
  const session = base.session || final.session || {};
  const episode = base.episode || final.episode || {};
  const messageHashes = request.message_sha256s || request.messages_sha256 || request.message_hashes || [];
  const timestamp = text(firstLifecycle.event_timestamp || request.timestamp || base.timestamp || '');
  if (!timestamp) return null;
  const outcome = terminal
    ? normalizeOutcome(lifecycle.outcome)
    : 'incomplete';
  const inputTokens = number(responseUsage.input_tokens ?? responseUsage.prompt_tokens ?? responseUsage.promptTokens);
  const cacheReadTokens = number(responseUsage.cache_read_tokens ?? responseUsage.cached_read_tokens ?? responseUsage.cachedReadTokens);
  const cacheWriteTokens = number(responseUsage.cache_write_tokens ?? responseUsage.cached_write_tokens ?? responseUsage.cachedWriteTokens);
  const failure = final.failure || {};
  const callId = text(lifecycle.call_id || firstLifecycle.call_id || episode.run_id || path.basename(file));
  const attemptId = text(lifecycle.attempt_id || firstLifecycle.attempt_id || `${callId}:1`);

  return {
    schema: text(final.schema || base.schema || 'xiaoba.cache_trace.v4'),
    file,
    sessionId: text(session.session_id || base.session_id || 'unknown'),
    sessionType: text(session.session_type || base.session_type || 'agent'),
    surface: text(session.surface || base.surface || 'unknown'),
    episodeNumber: integer(episode.episode_number ?? episode.turn_number ?? episode.number),
    runId: callId,
    callId,
    attemptId,
    attemptNumber: Math.max(1, integer(lifecycle.attempt_number ?? firstLifecycle.attempt_number ?? 1)),
    outcome,
    hasStarted: Boolean(started),
    timestamp,
    durationMs: number(lifecycle.duration_ms ?? final.response?.duration_ms),
    provider: text(request.provider || base.provider || 'unknown'),
    model: text(request.model || base.model || 'unknown'),
    apiType: text(request.api_type || base.api_type || 'unknown'),
    requestSha256: text(request.request_sha256 || request.sha256 || ''),
    stableSystemSha256: text(request.system_prompt?.stable_sha256 || request.stable_system_sha256 || ''),
    messageSha256s: Array.isArray(messageHashes) ? messageHashes.map(text) : [],
    estimatedTokens: number(request.estimated_tokens),
    retryNumber: integer(lifecycle.retry_number),
    retryDelayMs: number(lifecycle.retry_delay_ms),
    retryStopReason: text(lifecycle.retry_stop_reason),
    errorCategory: text(failure.category),
    errorSummary: text(failure.summary),
    httpStatus: nullableNumber(failure.http_status),
    usage: {
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      freshInputTokens: number(responseUsage.fresh_input_tokens ?? Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens)),
      outputTokens: number(responseUsage.output_tokens ?? responseUsage.completion_tokens ?? responseUsage.completionTokens),
      hitRatio: ratio(cacheReadTokens, inputTokens),
    },
  };
}

function normalizeLegacyRecord(raw: any, file: string): Omit<CacheTraceRecord, 'diff'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const episode = raw.episode || raw.turn || {};
  const request = raw.request || {};
  const responseUsage = raw.response_usage || raw.response?.usage || raw.usage || {};
  const session = raw.session || {};
  const sessionId = text(session.session_id || raw.session_id || raw.conversation_id || 'unknown');
  const inputTokens = number(responseUsage.input_tokens ?? responseUsage.prompt_tokens ?? responseUsage.promptTokens);
  const cacheReadTokens = number(responseUsage.cache_read_tokens ?? responseUsage.cached_read_tokens ?? responseUsage.cachedReadTokens);
  const cacheWriteTokens = number(responseUsage.cache_write_tokens ?? responseUsage.cached_write_tokens ?? responseUsage.cachedWriteTokens);
  const messageHashes = request.message_sha256s || request.messages_sha256 || request.message_hashes || [];
  const timestamp = text(request.timestamp || raw.timestamp || raw.response?.timestamp || '');
  if (!timestamp) return null;
  const runId = text(episode.run_id || raw.run_id || path.basename(file, '.json'));
  return {
    schema: text(raw.schema || 'unknown'),
    file,
    sessionId,
    sessionType: text(session.session_type || raw.session_type || 'agent'),
    surface: text(session.surface || raw.surface || 'unknown'),
    episodeNumber: integer(episode.episode_number ?? episode.turn_number ?? episode.number ?? raw.turn_number),
    runId,
    callId: runId,
    attemptId: `${runId}:1`,
    attemptNumber: 1,
    outcome: 'succeeded',
    hasStarted: false,
    timestamp,
    durationMs: number(raw.response?.duration_ms),
    provider: text(request.provider || raw.provider || 'unknown'),
    model: text(request.model || raw.model || 'unknown'),
    apiType: text(request.api_type || raw.api_type || 'unknown'),
    requestSha256: text(request.request_sha256 || request.sha256 || ''),
    stableSystemSha256: text(request.system_prompt?.stable_sha256 || request.stable_system_sha256 || ''),
    messageSha256s: Array.isArray(messageHashes) ? messageHashes.map(text) : [],
    estimatedTokens: number(request.estimated_tokens),
    retryNumber: 0,
    retryDelayMs: 0,
    retryStopReason: '',
    errorCategory: '',
    errorSummary: '',
    httpStatus: null,
    usage: {
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      freshInputTokens: number(responseUsage.fresh_input_tokens ?? Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens)),
      outputTokens: number(responseUsage.output_tokens ?? responseUsage.completion_tokens ?? responseUsage.completionTokens),
      hitRatio: ratio(cacheReadTokens, inputTokens),
    },
  };
}

function attachDiffs(records: Omit<CacheTraceRecord, 'diff'>[]): CacheTraceRecord[] {
  const previousBySession = new Map<string, Omit<CacheTraceRecord, 'diff'>>();
  return records.map(record => {
    const previous = previousBySession.get(record.sessionId);
    const sameSegment = previous && segment(previous) === segment(record);
    const changedMessageIndices: number[] = [];
    if (sameSegment && previous) {
      const count = Math.max(previous.messageSha256s.length, record.messageSha256s.length);
      for (let index = 0; index < count; index++) {
        if (previous.messageSha256s[index] !== record.messageSha256s[index]) changedMessageIndices.push(index);
      }
    }
    previousBySession.set(record.sessionId, record);
    return {
      ...record,
      diff: {
        baselineReset: !sameSegment,
        ...(!previous ? { resetReason: 'first-record' as const }
          : !sameSegment ? { resetReason: 'provider-model-api-changed' as const } : {}),
        requestChanged: Boolean(sameSegment && previous && previous.requestSha256 !== record.requestSha256),
        stableSystemChanged: Boolean(sameSegment && previous && previous.stableSystemSha256 !== record.stableSystemSha256),
        changedMessageIndices,
      },
    };
  });
}

function summarizeSessions(records: CacheTraceRecord[]): CacheTraceSessionSummary[] {
  const groups = new Map<string, CacheTraceRecord[]>();
  for (const record of records) groups.set(record.sessionId, [...(groups.get(record.sessionId) || []), record]);
  return [...groups.entries()].map(([sessionId, items]) => {
    const inputTokens = sum(items, item => item.usage.inputTokens);
    const cacheReadTokens = sum(items, item => item.usage.cacheReadTokens);
    const calls = groupBy(items, item => item.callId);
    const callItems = [...calls.values()];
    return {
      sessionId,
      sessionType: items.at(-1)?.sessionType || 'agent',
      surface: items.at(-1)?.surface || 'unknown',
      records: items.length,
      calls: calls.size,
      successfulAttempts: count(items, item => item.outcome === 'succeeded'),
      retryingAttempts: count(items, item => item.outcome === 'retrying'),
      failedAttempts: count(items, item => item.outcome === 'failed'),
      cancelledAttempts: count(items, item => item.outcome === 'cancelled'),
      incompleteAttempts: count(items, item => item.outcome === 'incomplete'),
      retriedCalls: count(callItems, attemptItems => attemptItems.some(item => item.outcome === 'retrying' || item.attemptNumber > 1)),
      recoveredCalls: count(callItems, attemptItems => attemptItems.some(item => item.outcome === 'succeeded' && item.attemptNumber > 1)),
      terminalFailedCalls: count(callItems, attemptItems => !attemptItems.some(item => item.outcome === 'succeeded')
        && attemptItems.some(item => item.outcome === 'failed')),
      firstTimestamp: items[0]?.timestamp || '',
      lastTimestamp: items.at(-1)?.timestamp || '',
      providers: unique(items.map(item => item.provider)),
      models: unique(items.map(item => item.model)),
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens: sum(items, item => item.usage.cacheWriteTokens),
      weightedHitRatio: ratio(cacheReadTokens, inputTokens),
      anomalousRecords: items.filter(item => !item.diff.baselineReset && item.diff.stableSystemChanged).length,
    };
  }).sort((left, right) => right.lastTimestamp.localeCompare(left.lastTimestamp));
}

async function listTraceFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async entry => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl'))) output.push(full);
    }));
  };
  await walk(root);
  return output.sort();
}

function normalizeOutcome(value: unknown): CacheTraceOutcome {
  return value === 'succeeded' || value === 'retrying' || value === 'failed' || value === 'cancelled'
    ? value
    : 'incomplete';
}

function segment(record: Pick<CacheTraceRecord, 'provider' | 'model' | 'apiType'>): string {
  return `${record.provider}\u0000${record.model}\u0000${record.apiType}`;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function integer(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 10000) / 10000 : 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sum<T>(values: T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function count<T>(values: T[], predicate: (value: T) => boolean): number {
  return values.reduce((total, value) => total + (predicate(value) ? 1 : 0), 0);
}

function groupBy<T>(values: T[], keyOf: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) groups.set(keyOf(value), [...(groups.get(keyOf(value)) || []), value]);
  return groups;
}
