import * as fs from 'fs';
import * as path from 'path';
import { resolveCacheTraceDir } from './cache-trace';
import type { ModelRequestKind, ModelRequestOrigin } from '../providers/provider';

export interface CacheTraceUsage {
  responseUsagePresent: boolean;
  inputTokens?: number;
  cacheReadReported: boolean;
  cacheReadTokens?: number;
  cacheReadSource?: string;
  cacheWriteReported: boolean;
  cacheWriteTokens?: number;
  freshInputTokens?: number;
  outputTokens?: number;
  hitRatio?: number;
}

export type CacheTraceOutcome = 'succeeded' | 'retrying' | 'failed' | 'cancelled' | 'incomplete';

export type CacheTraceQualificationReason =
  | 'legacy-trace-schema'
  | 'request-kind-not-reported'
  | 'request-kind-invalid'
  | 'request-origin-not-reported'
  | 'request-origin-invalid'
  | 'attempt-not-succeeded'
  | 'response-usage-missing'
  | 'input-tokens-not-reported'
  | 'cache-read-not-reported'
  | 'cache-read-source-not-reported'
  | 'cache-read-source-invalid'
  | 'cache-write-not-reported'
  | 'invalid-input-tokens'
  | 'invalid-cache-read-tokens'
  | 'cache-read-exceeds-input'
  | 'invalid-cache-write-tokens'
  | 'cache-write-exceeds-input';

export interface CacheTraceQualification {
  eligible: boolean;
  reasons: CacheTraceQualificationReason[];
}

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
  requestKind: ModelRequestKind | 'unknown';
  requestOrigin: ModelRequestOrigin | 'unknown';
  cacheStrategy: string;
  cachePlan?: {
    stablePrefixEstimatedTokens: number;
    stableSystemMessages: number;
    explicitBreakpoints: number;
    promptCacheKeyFingerprint: string;
  };
  contextLifecycle?: {
    annotatedMessages: number;
    transientMessages: number;
    lifecycleCounts: { session: number; episode: number; call: number };
    cacheScopeCounts: { stable: number; epoch: number; volatile: number };
    epochFingerprint: string;
    requestFingerprint: string;
  };
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
  qualification: CacheTraceQualification;
  diff: {
    baselineReset: boolean;
    resetReason?: 'first-record' | 'provider-model-api-changed' | 'checkpoint-compaction';
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
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  weightedHitRatio?: number;
  eligibleAttempts: number;
  ineligibleAttempts: number;
  ineligibleReasons: Partial<Record<CacheTraceQualificationReason, number>>;
  anomalousRecords: number;
  requestKindBreakdown: CacheTraceRequestKindSummary[];
  primaryAccountingAttempts: number;
  primaryEligibleAttempts: number;
  primaryIneligibleAttempts: number;
  auxiliaryEligibleAttempts: number;
  auxiliaryIneligibleAttempts: number;
}

export interface CacheTraceRequestKindSummary {
  requestKind: ModelRequestKind | 'unknown';
  requestOrigin: ModelRequestOrigin | 'unknown';
  records: number;
  eligibleAttempts: number;
  ineligibleAttempts: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  weightedHitRatio?: number;
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
          || raw?.schema === 'xiaoba.cache_trace.v5'
          || raw?.schema === 'xiaoba.cache_trace.v6'
          || raw?.schema === 'xiaoba.cache_trace.v7'
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
  const cachePlan = normalizeCachePlan(request.cache_plan);
  const contextLifecycle = normalizeContextLifecycle(request.context_lifecycle);
  const lifecycle = final.lifecycle || {};
  const firstLifecycle = base.lifecycle || {};
  const responseUsagePresent = hasOwn(final, 'response_usage')
    || Boolean(final.response && hasOwn(final.response, 'usage'))
    || hasOwn(final, 'usage');
  const responseUsage = final.response_usage || final.response?.usage || final.usage || {};
  const session = base.session || final.session || {};
  const episode = base.episode || final.episode || {};
  const messageHashes = request.message_sha256s || request.messages_sha256 || request.message_hashes || [];
  const timestamp = text(firstLifecycle.event_timestamp || request.timestamp || base.timestamp || '');
  if (!timestamp) return null;
  const outcome = terminal
    ? normalizeOutcome(lifecycle.outcome)
    : 'incomplete';
  const schema = text(final.schema || base.schema || 'xiaoba.cache_trace.v4');
  const apiType = text(request.api_type || base.api_type || 'unknown');
  const requestKind = normalizeRequestKind(request.request_kind);
  const requestOrigin = normalizeRequestOrigin(request.request_origin);
  const normalizedUsage = normalizeUsage(
    responseUsage,
    responseUsagePresent,
    schema,
    outcome,
    apiType,
    requestKind,
    hasOwn(request, 'request_kind'),
    requestOrigin,
    hasOwn(request, 'request_origin'),
  );
  const failure = final.failure || {};
  const callId = text(lifecycle.call_id || firstLifecycle.call_id || episode.run_id || path.basename(file));
  const attemptId = text(lifecycle.attempt_id || firstLifecycle.attempt_id || `${callId}:1`);

  return {
    schema,
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
    apiType,
    requestKind,
    requestOrigin,
    cacheStrategy: text(request.cache_strategy || 'unknown'),
    ...(cachePlan ? { cachePlan } : {}),
    ...(contextLifecycle ? { contextLifecycle } : {}),
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
    usage: normalizedUsage.usage,
    qualification: normalizedUsage.qualification,
  };
}

function normalizeLegacyRecord(raw: any, file: string): Omit<CacheTraceRecord, 'diff'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const episode = raw.episode || raw.turn || {};
  const request = raw.request || {};
  const cachePlan = normalizeCachePlan(request.cache_plan);
  const contextLifecycle = normalizeContextLifecycle(request.context_lifecycle);
  const responseUsagePresent = hasOwn(raw, 'response_usage')
    || Boolean(raw.response && hasOwn(raw.response, 'usage'))
    || hasOwn(raw, 'usage');
  const responseUsage = raw.response_usage || raw.response?.usage || raw.usage || {};
  const session = raw.session || {};
  const sessionId = text(session.session_id || raw.session_id || raw.conversation_id || 'unknown');
  const schema = text(raw.schema || 'unknown');
  const apiType = text(request.api_type || raw.api_type || 'unknown');
  const requestKind = normalizeRequestKind(request.request_kind);
  const requestOrigin = normalizeRequestOrigin(request.request_origin);
  const normalizedUsage = normalizeUsage(
    responseUsage,
    responseUsagePresent,
    schema,
    'succeeded',
    apiType,
    requestKind,
    hasOwn(request, 'request_kind'),
    requestOrigin,
    hasOwn(request, 'request_origin'),
  );
  const messageHashes = request.message_sha256s || request.messages_sha256 || request.message_hashes || [];
  const timestamp = text(request.timestamp || raw.timestamp || raw.response?.timestamp || '');
  if (!timestamp) return null;
  const runId = text(episode.run_id || raw.run_id || path.basename(file, '.json'));
  return {
    schema,
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
    apiType,
    requestKind,
    requestOrigin,
    cacheStrategy: text(request.cache_strategy || 'unknown'),
    ...(cachePlan ? { cachePlan } : {}),
    ...(contextLifecycle ? { contextLifecycle } : {}),
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
    usage: normalizedUsage.usage,
    qualification: normalizedUsage.qualification,
  };
}

interface UsageField {
  present: boolean;
  value?: number;
  valid: boolean;
}

function normalizeUsage(
  raw: any,
  responseUsagePresent: boolean,
  schema: string,
  outcome: CacheTraceOutcome,
  apiType: string,
  requestKind: ModelRequestKind | 'unknown',
  requestKindReported: boolean,
  requestOrigin: ModelRequestOrigin | 'unknown',
  requestOriginReported: boolean,
): { usage: CacheTraceUsage; qualification: CacheTraceQualification } {
  const value = raw && typeof raw === 'object' ? raw : {};
  const input = usageField(value, ['input_tokens', 'prompt_tokens', 'promptTokens']);
  const cacheRead = usageField(value, ['cache_read_tokens', 'cached_read_tokens', 'cachedReadTokens']);
  const cacheWrite = usageField(value, ['cache_write_tokens', 'cached_write_tokens', 'cachedWriteTokens']);
  const freshInput = usageField(value, ['fresh_input_tokens']);
  const output = usageField(value, ['output_tokens', 'completion_tokens', 'completionTokens']);
  const isV7 = schema === 'xiaoba.cache_trace.v7';
  const isStructured = isV7
    || schema === 'xiaoba.cache_trace.v6'
    || schema === 'xiaoba.cache_trace.v5';
  const inputReported = isStructured ? value.input_tokens_reported === true : input.present;
  const cacheReadReported = isStructured ? value.cache_read_reported === true : cacheRead.present;
  const cacheWriteReported = isStructured ? value.cache_write_reported === true : cacheWrite.present;
  const cacheReadSource = typeof value.cache_read_source === 'string'
    ? value.cache_read_source
    : undefined;
  const reasons: CacheTraceQualificationReason[] = [];

  if (!isV7) reasons.push('legacy-trace-schema');
  if (isV7 && requestKind === 'unknown') {
    reasons.push(requestKindReported
      ? 'request-kind-invalid'
      : 'request-kind-not-reported');
  }
  if (isV7 && requestOrigin === 'unknown') {
    reasons.push(requestOriginReported
      ? 'request-origin-invalid'
      : 'request-origin-not-reported');
  }
  if (isV7 && !requestKindOriginMatches(requestKind, requestOrigin)) {
    reasons.push('request-origin-invalid');
  }
  if (outcome !== 'succeeded') reasons.push('attempt-not-succeeded');
  if (!responseUsagePresent) {
    reasons.push('response-usage-missing');
  } else {
    if (!inputReported) {
      reasons.push('input-tokens-not-reported');
    } else if (!input.valid || input.value === undefined || input.value <= 0) {
      reasons.push('invalid-input-tokens');
    }
    if (!cacheReadReported) {
      reasons.push('cache-read-not-reported');
    } else if (!cacheRead.valid || cacheRead.value === undefined) {
      reasons.push('invalid-cache-read-tokens');
    } else if (input.valid && input.value !== undefined && cacheRead.value > input.value) {
      reasons.push('cache-read-exceeds-input');
    }
    if (isV7 && cacheReadReported && !cacheReadSource) {
      reasons.push('cache-read-source-not-reported');
    } else if (isV7 && cacheReadReported && !isCacheReadSourceAllowed(apiType, cacheReadSource)) {
      reasons.push('cache-read-source-invalid');
    }
    if (isStructured && apiType === 'anthropic-messages' && !cacheWriteReported) {
      reasons.push('cache-write-not-reported');
    }
    if (cacheWriteReported && (!cacheWrite.valid || cacheWrite.value === undefined)) {
      reasons.push('invalid-cache-write-tokens');
    } else if (cacheWriteReported
      && cacheWrite.value !== undefined
      && input.valid
      && input.value !== undefined
      && cacheWrite.value > input.value) {
      reasons.push('cache-write-exceeds-input');
    }
  }

  const computedFreshInput = freshInput.valid
    ? freshInput.value
    : input.valid
      && cacheRead.valid
      && cacheWrite.valid
      && input.value !== undefined
      && cacheRead.value !== undefined
      && cacheWrite.value !== undefined
      ? Math.max(0, input.value - cacheRead.value - cacheWrite.value)
      : undefined;
  const hitRatio = input.valid
    && input.value !== undefined
    && input.value > 0
    && cacheReadReported
    && cacheRead.valid
    && cacheRead.value !== undefined
    ? ratio(cacheRead.value, input.value)
    : undefined;

  return {
    usage: {
      responseUsagePresent,
      ...(input.valid && input.value !== undefined ? { inputTokens: input.value } : {}),
      cacheReadReported,
      ...(cacheRead.valid && cacheRead.value !== undefined ? { cacheReadTokens: cacheRead.value } : {}),
      ...(cacheReadSource ? { cacheReadSource } : {}),
      cacheWriteReported,
      ...(cacheWrite.valid && cacheWrite.value !== undefined ? { cacheWriteTokens: cacheWrite.value } : {}),
      ...(computedFreshInput === undefined ? {} : { freshInputTokens: computedFreshInput }),
      ...(output.valid && output.value !== undefined ? { outputTokens: output.value } : {}),
      ...(hitRatio === undefined ? {} : { hitRatio }),
    },
    qualification: {
      eligible: reasons.length === 0,
      reasons,
    },
  };
}

function isCacheReadSourceAllowed(apiType: string, source: string | undefined): boolean {
  if (!source) return false;
  if (apiType === 'openai-responses') {
    return source === 'openai.input_tokens_details.cached_tokens';
  }
  if (apiType === 'openai-chat-completions') {
    return source === 'openai.prompt_tokens_details.cached_tokens'
      || source === 'deepseek.prompt_cache_hit_tokens';
  }
  if (apiType === 'anthropic-messages') {
    return source === 'anthropic.cache_read_input_tokens';
  }
  return false;
}

function usageField(value: Record<string, unknown>, keys: string[]): UsageField {
  const key = keys.find(candidate => hasOwn(value, candidate));
  if (!key) return { present: false, valid: false };
  const raw = value[key];
  if ((typeof raw !== 'number' && typeof raw !== 'string') || raw === '') {
    return { present: true, valid: false };
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? { present: true, valid: true, value: parsed }
    : { present: true, valid: false };
}

function normalizeCachePlan(value: any): CacheTraceRecord['cachePlan'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return {
    stablePrefixEstimatedTokens: number(value.stable_prefix_estimated_tokens),
    stableSystemMessages: integer(value.stable_system_messages),
    explicitBreakpoints: integer(value.explicit_breakpoints),
    promptCacheKeyFingerprint: text(value.prompt_cache_key_fingerprint),
  };
}

function normalizeContextLifecycle(value: any): CacheTraceRecord['contextLifecycle'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const lifecycle = value.lifecycle_counts || {};
  const scopes = value.cache_scope_counts || {};
  return {
    annotatedMessages: integer(value.annotated_messages),
    transientMessages: integer(value.transient_messages),
    lifecycleCounts: {
      session: integer(lifecycle.session),
      episode: integer(lifecycle.episode),
      call: integer(lifecycle.call),
    },
    cacheScopeCounts: {
      stable: integer(scopes.stable),
      epoch: integer(scopes.epoch),
      volatile: integer(scopes.volatile),
    },
    epochFingerprint: text(value.epoch_fingerprint),
    requestFingerprint: text(value.request_fingerprint),
  };
}

function attachDiffs(records: Omit<CacheTraceRecord, 'diff'>[]): CacheTraceRecord[] {
  const previousBySessionAndKind = new Map<string, Omit<CacheTraceRecord, 'diff'>>();
  return records.map(record => {
    if (record.requestKind === 'checkpoint_compaction') {
      return {
        ...record,
        diff: {
          baselineReset: true,
          resetReason: 'checkpoint-compaction' as const,
          requestChanged: false,
          stableSystemChanged: false,
          changedMessageIndices: [],
        },
      };
    }
    const baselineKey = `${record.sessionId}\0${record.requestKind}\0${record.requestOrigin}`;
    const previous = previousBySessionAndKind.get(baselineKey);
    const sameSegment = previous && segment(previous) === segment(record);
    const changedMessageIndices: number[] = [];
    if (sameSegment && previous) {
      const count = Math.max(previous.messageSha256s.length, record.messageSha256s.length);
      for (let index = 0; index < count; index++) {
        if (previous.messageSha256s[index] !== record.messageSha256s[index]) changedMessageIndices.push(index);
      }
    }
    previousBySessionAndKind.set(baselineKey, record);
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
    const eligibleItems = items.filter(item => item.qualification.eligible);
    const primaryItems = items.filter(isPrimaryAccountingRecord);
    const primaryEligibleItems = primaryItems.filter(item => item.qualification.eligible);
    const auxiliaryItems = items.filter(item => !isPrimaryAccountingRecord(item));
    const auxiliaryEligibleItems = auxiliaryItems.filter(item => item.qualification.eligible);
    const inputTokens = sum(primaryEligibleItems, item => item.usage.inputTokens ?? 0);
    const cacheReadTokens = sum(primaryEligibleItems, item => item.usage.cacheReadTokens ?? 0);
    const cacheWriteFullyReported = primaryEligibleItems.length > 0
      && primaryEligibleItems.every(item => item.usage.cacheWriteReported
        && item.usage.cacheWriteTokens !== undefined);
    const calls = groupBy(items, item => item.callId);
    const callItems = [...calls.values()];
    const ineligibleReasons: Partial<Record<CacheTraceQualificationReason, number>> = {};
    for (const item of items) {
      for (const reason of item.qualification.reasons) {
        ineligibleReasons[reason] = (ineligibleReasons[reason] ?? 0) + 1;
      }
    }
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
      ...(primaryEligibleItems.length > 0 ? { inputTokens, cacheReadTokens } : {}),
      ...(cacheWriteFullyReported ? {
        cacheWriteTokens: sum(primaryEligibleItems, item => item.usage.cacheWriteTokens ?? 0),
      } : {}),
      ...(inputTokens > 0 ? { weightedHitRatio: ratio(cacheReadTokens, inputTokens) } : {}),
      eligibleAttempts: eligibleItems.length,
      ineligibleAttempts: items.length - eligibleItems.length,
      ineligibleReasons,
      anomalousRecords: items.filter(item => !item.diff.baselineReset && item.diff.stableSystemChanged).length,
      requestKindBreakdown: summarizeRequestKinds(items),
      primaryAccountingAttempts: primaryEligibleItems.length,
      primaryEligibleAttempts: primaryEligibleItems.length,
      primaryIneligibleAttempts: primaryItems.length - primaryEligibleItems.length,
      auxiliaryEligibleAttempts: auxiliaryEligibleItems.length,
      auxiliaryIneligibleAttempts: auxiliaryItems.length - auxiliaryEligibleItems.length,
    };
  }).sort((left, right) => right.lastTimestamp.localeCompare(left.lastTimestamp));
}

function summarizeRequestKinds(items: CacheTraceRecord[]): CacheTraceRequestKindSummary[] {
  const groups = groupBy(items, item => `${item.requestKind}\0${item.requestOrigin}`);
  return [...groups.values()].map(records => {
    const eligible = records.filter(record => record.qualification.eligible);
    const inputTokens = sum(eligible, record => record.usage.inputTokens ?? 0);
    const cacheReadTokens = sum(eligible, record => record.usage.cacheReadTokens ?? 0);
    return {
      requestKind: records[0].requestKind,
      requestOrigin: records[0].requestOrigin,
      records: records.length,
      eligibleAttempts: eligible.length,
      ineligibleAttempts: records.length - eligible.length,
      ...(eligible.length > 0 ? { inputTokens, cacheReadTokens } : {}),
      ...(inputTokens > 0 ? { weightedHitRatio: ratio(cacheReadTokens, inputTokens) } : {}),
    };
  }).sort((left, right) => (
    left.requestKind.localeCompare(right.requestKind)
    || left.requestOrigin.localeCompare(right.requestOrigin)
  ));
}

function isPrimaryAccountingRecord(record: Pick<CacheTraceRecord, 'requestKind' | 'requestOrigin'>): boolean {
  return record.requestOrigin === 'main'
    && (record.requestKind === 'main_inference'
      || record.requestKind === 'checkpoint_compaction');
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

function normalizeRequestKind(value: unknown): ModelRequestKind | 'unknown' {
  return value === 'main_inference'
    || value === 'checkpoint_compaction'
    || value === 'memory_branch_inference'
    || value === 'subagent_inference'
    ? value
    : 'unknown';
}

function normalizeRequestOrigin(value: unknown): ModelRequestOrigin | 'unknown' {
  return value === 'main' || value === 'memory_branch' || value === 'subagent'
    ? value
    : 'unknown';
}

function requestKindOriginMatches(
  kind: ModelRequestKind | 'unknown',
  origin: ModelRequestOrigin | 'unknown',
): boolean {
  if (kind === 'unknown' || origin === 'unknown') return true;
  return kind === 'checkpoint_compaction'
    || (kind === 'main_inference' && origin === 'main')
    || (kind === 'memory_branch_inference' && origin === 'memory_branch')
    || (kind === 'subagent_inference' && origin === 'subagent');
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

function hasOwn(value: unknown, key: string): boolean {
  return value !== undefined && value !== null && Object.prototype.hasOwnProperty.call(value, key);
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
