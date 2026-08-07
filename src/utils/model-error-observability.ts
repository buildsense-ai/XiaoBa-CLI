import { createHash } from 'crypto';
import { sanitizeProviderErrorMessageForLog } from './provider-error-log-sanitizer';

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
  response_id?: string;
  terminal_event?: string;
  failure_phase?: string;
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
  const existing = readModelErrorDiagnostics(error);
  const responseError = error?.response?.data?.error;
  const nestedError = error?.error;
  const httpStatus = firstNumber(
    existing?.http_status,
    error?.response?.status,
    error?.status,
    nestedError?.status,
    extractStatusFromText(error?.message),
  );
  const providerCode = firstText(
    existing?.provider_code,
    responseError?.code,
    error?.response?.data?.code,
    nestedError?.code,
  );
  const transportCode = firstText(error?.code, error?.cause?.code);
  const providerType = firstText(
    existing?.provider_type,
    responseError?.type,
    error?.response?.data?.type,
    nestedError?.type,
  );
  const requestId = firstText(
    existing?.request_id,
    error?.response?.data?.request_id,
    responseError?.request_id,
    error?.request_id,
    error?.requestId,
    error?.response?.headers?.['x-request-id'],
    error?.headers?.['x-request-id'],
  );
  const responseId = firstText(
    existing?.response_id,
    error?.responseId,
    error?.response_id,
    responseError?.response_id,
  );
  const terminalEvent = firstText(existing?.terminal_event, error?.terminalEvent);
  const failurePhase = firstText(existing?.failure_phase, error?.failurePhase);
  const sourceMessage = firstText(
    responseError?.message,
    error?.response?.data?.message,
    nestedError?.message,
    error?.message,
    error,
  ) || 'unknown error';
  const errorSummary = sanitizeProviderErrorMessageForLog(sourceMessage);
  const errorName = firstText(existing?.error_name, error?.name);
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
    response_id: responseId,
    terminal_event: terminalEvent,
    failure_phase: failurePhase,
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
  return {
    ...(safeText(input.provider) && { provider: safeText(input.provider) }),
    ...(safeText(input.model) && { model: safeText(input.model) }),
    ...(input.phase && { phase: input.phase }),
    ...(input.origin && { origin: input.origin }),
    ...(typeof input.http_status === 'number' && { http_status: input.http_status }),
    ...(safeText(input.provider_code) && { provider_code: safeText(input.provider_code) }),
    ...(safeText(input.provider_type) && { provider_type: safeText(input.provider_type) }),
    ...(safeText(input.request_id) && { request_id: safeText(input.request_id) }),
    ...(safeText(input.response_id) && { response_id: safeText(input.response_id) }),
    ...(safeText(input.terminal_event) && { terminal_event: safeText(input.terminal_event) }),
    ...(safeText(input.failure_phase) && { failure_phase: safeText(input.failure_phase) }),
    ...(safeText(input.error_name) && { error_name: safeText(input.error_name) }),
    ...(safeText(input.top_frame) && { top_frame: safeText(input.top_frame) }),
    ...(safeText(input.stack_fingerprint) && { stack_fingerprint: safeText(input.stack_fingerprint) }),
    error_summary: sanitizeProviderErrorMessageForLog(input.error_summary || 'unknown error'),
    fingerprint: safeText(input.fingerprint) || buildModelErrorFingerprint({
      provider: input.provider,
      model: input.model,
      http_status: input.http_status,
      provider_code: input.provider_code,
      provider_type: input.provider_type,
      error_summary: input.error_summary || 'unknown error',
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

function safeText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_STRUCTURED_FIELD_LENGTH);
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
  const match = String(value || '').match(/(?:API错误|HTTP|status(?:\s*code)?)\s*[\(:= ]\s*(\d{3})\b/i);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeFallbackErrorSummary(error: unknown): string {
  try {
    return sanitizeProviderErrorMessageForLog(
      error instanceof Error ? error.message : String(error ?? 'unknown error'),
    );
  } catch {
    return 'unknown error';
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
