import { createHash } from 'crypto';

export type ModelErrorPhase =
  | 'pre_turn_compaction'
  | 'session_init'
  | 'agent_turn'
  | 'model_request'
  | 'result_persistence'
  | 'unknown';

export type RetryStopReason =
  | 'non_retryable'
  | 'retry_limit_exhausted'
  | 'retry_window_exhausted'
  | 'stream_output_started'
  | 'aborted'
  | 'unknown';

export interface ModelRetrySummary {
  attempt_count: number;
  retry_count: number;
  max_retries: number;
  elapsed_ms: number;
  max_elapsed_ms: number;
  stop_reason: RetryStopReason;
}

export interface ModelAttemptReference {
  call_id?: string;
  attempt_id?: string;
  attempt_number?: number;
  episode_id?: string;
}

export interface ModelErrorDiagnostics {
  provider?: string;
  model?: string;
  phase?: ModelErrorPhase;
  origin?: 'provider' | 'transport' | 'runtime' | 'model_response';
  http_status?: number;
  provider_code?: string;
  provider_type?: string;
  request_id?: string;
  error_name?: string;
  top_frame?: string;
  stack_fingerprint?: string;
  error_summary: string;
  fingerprint: string;
  retry?: ModelRetrySummary;
  attempt?: ModelAttemptReference;
}

const MODEL_ERROR_DIAGNOSTICS = Symbol.for('xiaoba.model-error-diagnostics');
const MAX_STRUCTURED_FIELD_LENGTH = 120;

type ErrorWithDiagnostics = Error & {
  [MODEL_ERROR_DIAGNOSTICS]?: ModelErrorDiagnostics;
};

export function attachModelErrorDiagnostics(
  error: unknown,
  diagnostics: ModelErrorDiagnostics,
): void {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return;
  try {
    const existing = readModelErrorDiagnostics(error);
    const merged = normalizeDiagnostics({
      ...existing,
      ...diagnostics,
      retry: diagnostics.retry ?? existing?.retry,
    });
    Object.defineProperty(error, MODEL_ERROR_DIAGNOSTICS, {
      value: merged,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  } catch {
    // Diagnostics are best-effort and must never replace the original failure.
  }
}

export function readModelErrorDiagnostics(error: unknown): ModelErrorDiagnostics | undefined {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
  try {
    return (error as ErrorWithDiagnostics)[MODEL_ERROR_DIAGNOSTICS];
  } catch {
    return undefined;
  }
}

export function captureModelErrorDiagnostics(
  error: any,
  context: Partial<Pick<ModelErrorDiagnostics, 'provider' | 'model' | 'phase'>> = {},
): ModelErrorDiagnostics {
  try {
    return captureModelErrorDiagnosticsUnsafe(error, context);
  } catch {
    const errorSummary = safeFallbackErrorSummary(error);
    return normalizeDiagnostics({
      provider: context.provider,
      model: context.model,
      phase: context.phase,
      origin: 'runtime',
      error_summary: errorSummary,
      fingerprint: buildModelErrorFingerprint({
        provider: context.provider,
        model: context.model,
        error_summary: errorSummary,
      }),
    });
  }
}

function captureModelErrorDiagnosticsUnsafe(
  error: any,
  context: Partial<Pick<ModelErrorDiagnostics, 'provider' | 'model' | 'phase'>>,
): ModelErrorDiagnostics {
  const wrapperDiagnostics = readModelErrorDiagnostics(error);
  const cause = safeRead(error, 'cause');
  const causeDiagnostics = readModelErrorDiagnostics(cause);
  const existing = wrapperDiagnostics ?? causeDiagnostics;
  const responseError = safePath(error, 'response', 'data', 'error');
  const nestedError = safeRead(error, 'error');
  const httpStatus = firstNumber(
    existing?.http_status,
    safePath(error, 'response', 'status'),
    safeRead(error, 'status'),
    safeRead(nestedError, 'status'),
    causeDiagnostics?.http_status,
    safePath(cause, 'response', 'status'),
    safeRead(cause, 'status'),
    extractStatusFromText(safeRead(error, 'message')),
    extractStatusFromText(safeRead(cause, 'message')),
  );
  const providerCode = firstText(
    existing?.provider_code,
    safeRead(responseError, 'code'),
    safePath(error, 'response', 'data', 'code'),
    safeRead(nestedError, 'code'),
    causeDiagnostics?.provider_code,
    safePath(cause, 'response', 'data', 'error', 'code'),
    safeRead(cause, 'code'),
  );
  const transportCode = firstText(safeRead(error, 'code'), safeRead(cause, 'code'));
  const providerType = firstText(
    existing?.provider_type,
    safeRead(responseError, 'type'),
    safePath(error, 'response', 'data', 'type'),
    safeRead(nestedError, 'type'),
    causeDiagnostics?.provider_type,
    safePath(cause, 'response', 'data', 'error', 'type'),
  );
  const requestId = firstText(
    existing?.request_id,
    safePath(error, 'response', 'data', 'request_id'),
    safeRead(responseError, 'request_id'),
    safeRead(error, 'request_id'),
    safeRead(error, 'requestId'),
    safePath(error, 'response', 'headers', 'x-request-id'),
    safePath(error, 'headers', 'x-request-id'),
    causeDiagnostics?.request_id,
    safePath(cause, 'response', 'headers', 'x-request-id'),
  );
  const sourceMessage = firstText(
    safeRead(responseError, 'message'),
    safePath(error, 'response', 'data', 'message'),
    safeRead(nestedError, 'message'),
    safeRead(error, 'message'),
    causeDiagnostics?.error_summary,
    safeRead(cause, 'message'),
    error,
  ) || 'unknown error';
  const errorName = firstText(
    wrapperDiagnostics?.error_name,
    causeDiagnostics?.error_name,
    safeRead(error, 'name'),
    safeRead(cause, 'name'),
  );
  const errorSummary = buildSafeErrorSummary({
    sourceMessage,
    httpStatus,
    providerCode: providerCode ?? transportCode,
    providerType,
    errorName,
  });
  const stack = captureStackDiagnostics(error);
  const origin = existing?.origin ?? inferErrorOrigin({
    httpStatus,
    providerCode,
    providerType,
    transportCode,
  });

  return normalizeDiagnostics({
    provider: context.provider ?? existing?.provider,
    model: context.model ?? existing?.model,
    phase: context.phase ?? existing?.phase,
    origin,
    http_status: httpStatus,
    provider_code: providerCode ?? transportCode,
    provider_type: providerType,
    request_id: requestId,
    error_name: errorName,
    top_frame: existing?.top_frame ?? stack.topFrame,
    stack_fingerprint: existing?.stack_fingerprint ?? stack.fingerprint,
    error_summary: errorSummary,
    fingerprint: buildModelErrorFingerprint({
      provider: context.provider ?? existing?.provider,
      model: context.model ?? existing?.model,
      http_status: httpStatus,
      provider_code: providerCode ?? transportCode,
      provider_type: providerType,
      error_summary: errorSummary,
    }),
    retry: existing?.retry,
    attempt: existing?.attempt,
  });
}

export function attachRetrySummary(
  error: unknown,
  retry: ModelRetrySummary,
  attempt?: ModelAttemptReference,
): void {
  const diagnostics = captureModelErrorDiagnostics(error);
  attachModelErrorDiagnostics(error, {
    ...diagnostics,
    retry: normalizeRetrySummary(retry),
    ...(attempt && { attempt: normalizeAttemptReference(attempt) }),
  });
}

export function buildModelErrorFingerprint(input: {
  provider?: string;
  model?: string;
  http_status?: number;
  provider_code?: string;
  provider_type?: string;
  error_summary: string;
}): string {
  const normalizedMessage = input.error_summary
    .toLowerCase()
    .replace(/\breq[_-]?[a-z0-9_-]+\b/gi, 'req_*')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, 'uuid')
    .replace(/\b[0-9a-f]{16,}\b/gi, 'hex')
    .replace(/\b\d{6,}\b/g, 'number')
    .replace(/\s+/g, ' ')
    .trim();
  const material = [
    input.provider || '',
    input.model || '',
    input.http_status ?? '',
    input.provider_code || '',
    input.provider_type || '',
    normalizedMessage,
  ].join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

function normalizeDiagnostics(input: ModelErrorDiagnostics): ModelErrorDiagnostics {
  const providerCode = canonicalDiagnosticToken(input.provider_code);
  const providerType = canonicalDiagnosticToken(input.provider_type);
  const errorName = canonicalDiagnosticToken(input.error_name);
  const errorSummary = buildSafeErrorSummary({
    sourceMessage: input.error_summary || 'unknown error',
    httpStatus: input.http_status,
    providerCode,
    providerType,
    errorName,
  });
  return {
    ...(safeText(input.provider) && { provider: safeText(input.provider) }),
    ...(safeText(input.model) && { model: safeText(input.model) }),
    ...(input.phase && { phase: input.phase }),
    ...(input.origin && { origin: input.origin }),
    ...(typeof input.http_status === 'number' && { http_status: input.http_status }),
    ...(providerCode && { provider_code: providerCode }),
    ...(providerType && { provider_type: providerType }),
    ...(hashedIdentifier(input.request_id, 'request') && { request_id: hashedIdentifier(input.request_id, 'request') }),
    ...(errorName && { error_name: errorName }),
    ...(safeText(input.top_frame) && { top_frame: safeText(input.top_frame) }),
    ...(safeText(input.stack_fingerprint) && { stack_fingerprint: safeText(input.stack_fingerprint) }),
    error_summary: errorSummary,
    fingerprint: safeText(input.fingerprint) || buildModelErrorFingerprint({
      provider: input.provider,
      model: input.model,
      http_status: input.http_status,
      provider_code: providerCode,
      provider_type: providerType,
      error_summary: errorSummary,
    }),
    ...(input.retry && { retry: normalizeRetrySummary(input.retry) }),
    ...(input.attempt && { attempt: normalizeAttemptReference(input.attempt) }),
  };
}

function normalizeAttemptReference(input: ModelAttemptReference): ModelAttemptReference {
  return {
    ...(safeText(input.call_id) && { call_id: safeText(input.call_id) }),
    ...(safeText(input.attempt_id) && { attempt_id: safeText(input.attempt_id) }),
    ...(Number.isFinite(input.attempt_number) && { attempt_number: Math.max(1, Math.floor(input.attempt_number!)) }),
    ...(safeText(input.episode_id) && { episode_id: safeText(input.episode_id) }),
  };
}

function normalizeRetrySummary(input: ModelRetrySummary): ModelRetrySummary {
  return {
    attempt_count: nonNegativeInteger(input.attempt_count),
    retry_count: nonNegativeInteger(input.retry_count),
    max_retries: nonNegativeInteger(input.max_retries),
    elapsed_ms: nonNegativeInteger(input.elapsed_ms),
    max_elapsed_ms: nonNegativeInteger(input.max_elapsed_ms),
    stop_reason: input.stop_reason || 'unknown',
  };
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function safeRead(value: unknown, property: PropertyKey): any {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

function safePath(value: unknown, ...properties: PropertyKey[]): unknown {
  let current = value;
  for (const property of properties) {
    current = safeRead(current, property);
    if (current === undefined || current === null) return current;
  }
  return current;
}

function safeText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const normalized = String(value).replace(/\s+/g, ' ').trim();
    if (!normalized) return undefined;
    return normalized.slice(0, MAX_STRUCTURED_FIELD_LENGTH);
  } catch {
    return undefined;
  }
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = safeText(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function extractStatusFromText(value: unknown): number | undefined {
  const match = (safeText(value) || '').match(/(?:API错误|HTTP|status(?:\s*code)?)\s*[\(:= ]\s*(\d{3})\b/i);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function canonicalDiagnosticToken(value: unknown): string | undefined {
  const normalized = safeText(value)?.toLowerCase();
  if (!normalized || !/^[a-z][a-z0-9._-]{0,63}$/.test(normalized)) return undefined;
  if (/(?:secret|token|password|credential|api[_-]?key|authorization)/i.test(normalized)) return undefined;
  return normalized;
}

function hashedIdentifier(value: unknown, prefix: string): string | undefined {
  const normalized = safeText(value);
  if (!normalized) return undefined;
  const alreadyHashed = normalized.startsWith(`${prefix}_`)
    && normalized.length === prefix.length + 13
    && /^[a-f0-9]{12}$/.test(normalized.slice(prefix.length + 1));
  if (alreadyHashed) return normalized;
  return `${prefix}_${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

function buildSafeErrorSummary(input: {
  sourceMessage: unknown;
  httpStatus?: number;
  providerCode?: string;
  providerType?: string;
  errorName?: string;
}): string {
  const source = safeText(input.sourceMessage)?.toLowerCase() || '';
  const parts: string[] = [];
  if (typeof input.httpStatus === 'number') parts.push(`http_${input.httpStatus}`);
  for (const match of source.matchAll(/\bsignal_(reasoning_replay_required|auth_invalid|access_denied|model_or_endpoint_missing|input_too_large|rate_limited|request_invalid|timeout|transport_error|empty_response|image_safety)\b/g)) {
    parts.push(`signal_${match[1]}`);
  }
  const code = canonicalDiagnosticToken(input.providerCode);
  const type = canonicalDiagnosticToken(input.providerType);
  const name = canonicalDiagnosticToken(input.errorName);
  if (code) parts.push(`code_${code}`);
  if (type) parts.push(`type_${type}`);
  if (name && name !== 'error') parts.push(`name_${name}`);

  const signals: Array<[RegExp, string]> = [
    [/reasoning[_\s-]?(?:content|text).{0,80}(?:must be passed back|must be echoed|not passed back|required|expected)|thinking mode.{0,80}reasoning/i, 'reasoning_replay_required'],
    [/invalid[_\s-]?api[_\s-]?key|unauthorized|authentication (?:failed|error)|invalid[_\s-]?token/i, 'auth_invalid'],
    [/forbidden|permission denied|access denied|not authorized|insufficient[_\s-]?permissions?/i, 'access_denied'],
    [/model[_\s-]?not[_\s-]?found|endpoint[_\s-]?not[_\s-]?found|unknown model|no such model/i, 'model_or_endpoint_missing'],
    [/context length|maximum context|context window|prompt too long|token limit|too many tokens/i, 'input_too_large'],
    [/rate limit|too many requests/i, 'rate_limited'],
    [/invalid[_\s-]?request|tool schema|schema is invalid|invalid (?:parameter|input|argument)|malformed|invalid json/i, 'request_invalid'],
    [/request_timed_out|request timed out|gateway timeout|etimedout|timeout/i, 'timeout'],
    [/econnreset|econnrefused|enotfound|eai_again|connection error/i, 'transport_error'],
    [/empty_model_response|未返回有效内容|没有正文或工具调用/i, 'empty_response'],
    [/input[_\s-]*new[_\s-]*sensitive|image is sensitive/i, 'image_safety'],
  ];
  for (const [pattern, signal] of signals) {
    if (pattern.test(source)) parts.push(`signal_${signal}`);
  }
  return Array.from(new Set(parts)).join(' ') || 'unknown_error';
}

function safeFallbackErrorSummary(error: unknown): string {
  try {
    const sourceMessage = error instanceof Error ? error.message : String(error ?? 'unknown error');
    return buildSafeErrorSummary({ sourceMessage });
  } catch {
    return 'unknown_error';
  }
}

function inferErrorOrigin(input: {
  httpStatus?: number;
  providerCode?: string;
  providerType?: string;
  transportCode?: string;
}): ModelErrorDiagnostics['origin'] {
  if (String(input.transportCode || '').toUpperCase() === 'EMPTY_MODEL_RESPONSE') {
    return 'model_response';
  }
  if (/^(?:ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_)/i.test(String(input.transportCode || ''))) {
    return 'transport';
  }
  if (input.httpStatus || input.providerCode || input.providerType) {
    return 'provider';
  }
  return 'runtime';
}

function captureStackDiagnostics(error: any): { topFrame?: string; fingerprint?: string } {
  let rawStack = '';
  try {
    rawStack = typeof error?.stack === 'string' ? error.stack : '';
  } catch {
    return {};
  }
  const frames = rawStack
    .split(/\r?\n/)
    .slice(1)
    .map(frame => sanitizeStackFrame(frame))
    .filter(Boolean)
    .slice(0, 5);
  if (frames.length === 0) return {};
  const fingerprintMaterial = frames
    .map(frame => frame.replace(/:\d+:\d+\b/g, ':*:*'))
    .join('|');
  return {
    topFrame: frames[0].slice(0, MAX_STRUCTURED_FIELD_LENGTH),
    fingerprint: createHash('sha256').update(fingerprintMaterial).digest('hex').slice(0, 16),
  };
}

function sanitizeStackFrame(value: string): string {
  let frame = String(value || '').replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
  if (!frame) return '';
  frame = frame.replace(/file:\/\//g, '');
  frame = frame.replace(/(?:\/[A-Za-z0-9._-]+)+\/(src|dist|tests)\//g, '$1/');
  frame = frame.replace(/(?:\/[A-Za-z0-9._@+-]+)+\/(node_modules\/)/g, '$1');
  frame = frame.replace(/(?:\/[A-Za-z0-9._-]+)+\/([^/()\s]+:\d+:\d+)/g, '$1');
  return frame.slice(0, MAX_STRUCTURED_FIELD_LENGTH);
}
