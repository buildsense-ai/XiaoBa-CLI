import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Message } from '../types';
import type { ProviderReportedUsage } from '../types';
import type { ModelAttemptEvent, ModelAttemptSink } from '../providers/provider';
import { resolveContextCacheScope } from '../core/context-lifecycle';
import { fingerprintCanonical } from './canonical';
import type { ProviderCacheStrategy } from '../providers/provider-cache-policy';
import type { ReasoningReplayRecoveryAction } from '../providers/deepseek-reasoning-recovery';
import {
  attestProviderRequestDispatch,
  type ProviderRequestDispatchStatus,
} from '../providers/request-dispatch-evidence';

export const ATTEMPT_JOURNAL_SCHEMA = 'xiaoba.cache_benchmark_attempt_journal.v2' as const;

export interface AttemptJournalRecord {
  schema: typeof ATTEMPT_JOURNAL_SCHEMA;
  sequence: number;
  outcome: ModelAttemptEvent['outcome'];
  call_id: string;
  attempt_id: string;
  attempt_number: number;
  provider: ModelAttemptEvent['provider'];
  model: string;
  api_type: ModelAttemptEvent['apiType'];
  stream: boolean;
  request_kind: ModelAttemptEvent['requestKind'];
  request_origin: ModelAttemptEvent['requestOrigin'];
  cache_strategy?: ProviderCacheStrategy;
  request_fingerprint: string;
  stable_prefix_fingerprint: string;
  tools_fingerprint: string;
  tools_count: number;
  session_fingerprint?: string;
  episode_fingerprint?: string;
  input_tokens?: number;
  cache_read_tokens?: number;
  cache_read_source?: string;
  cache_write_tokens?: number;
  provider_usage?: ProviderReportedUsage;
  output_tokens?: number;
  retry_number?: number;
  retry_stop_reason?: string;
  retry_recovery_action?: ReasoningReplayRecoveryAction;
  dispatch_status?: ProviderRequestDispatchStatus;
  previous_record_fingerprint: string;
  record_fingerprint: string;
}

/**
 * Crash-visible synchronous WAL. It is a critical sink: persistence failure
 * aborts before provider invocation, and callers also recheck health at seal.
 */
export class StrictAttemptJournal implements ModelAttemptSink {
  readonly critical = true;
  readonly filePath: string;
  readonly records: AttemptJournalRecord[] = [];
  failureCode?: 'journal_open_failed' | 'journal_write_failed' | 'journal_existing_invalid';
  private fd: number | undefined;
  private sequence = 0;

  constructor(stateDirectory: string, fileName = 'attempt-journal.jsonl') {
    const directory = preparePrivateDirectory(stateDirectory);
    this.filePath = path.join(directory, validateJournalFileName(fileName));
    try {
      this.loadExisting();
      const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
      this.fd = fs.openSync(
        this.filePath,
        fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | noFollow,
        0o600,
      );
      const stat = fs.fstatSync(this.fd);
      if (!stat.isFile()) throw new Error('journal_open_failed');
      assertOwnedByCurrentUser(stat, 'journal_open_failed');
      if (process.platform !== 'win32') {
        fs.fchmodSync(this.fd, 0o600);
      }
      fsyncDirectory(directory);
    } catch {
      this.failureCode = this.failureCode ?? 'journal_open_failed';
    }
  }

  observe(event: ModelAttemptEvent): void {
    if (this.failureCode || this.fd === undefined) {
      throw new Error(this.failureCode || 'journal_write_failed');
    }
    try {
      const record = toJournalRecord(
        event,
        ++this.sequence,
        this.records.at(-1)?.record_fingerprint,
      );
      appendAndSync(this.fd, `${JSON.stringify(record)}\n`);
      this.records.push(record);
    } catch {
      this.failureCode = 'journal_write_failed';
      throw new Error(this.failureCode);
    }
  }

  close(): void {
    if (this.fd === undefined) return;
    try { fs.fsyncSync(this.fd); } catch { this.failureCode = 'journal_write_failed'; }
    try { fs.closeSync(this.fd); } catch { this.failureCode = 'journal_write_failed'; }
    this.fd = undefined;
  }

  assertHealthy(): void {
    if (this.failureCode) throw new Error(this.failureCode);
  }

  private loadExisting(): void {
    if (!fs.existsSync(this.filePath)) return;
    const lstat = fs.lstatSync(this.filePath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      this.failureCode = 'journal_existing_invalid';
      throw new Error(this.failureCode);
    }
    assertOwnedByCurrentUser(lstat, 'journal_existing_invalid');
    if (process.platform !== 'win32' && (lstat.mode & 0o777) !== 0o600) {
      this.failureCode = 'journal_existing_invalid';
      throw new Error(this.failureCode);
    }
    const source = fs.readFileSync(this.filePath, 'utf8');
    if (!source) return;
    if (!source.endsWith('\n')) {
      this.failureCode = 'journal_existing_invalid';
      throw new Error(this.failureCode);
    }
    for (const line of source.split('\n').filter(Boolean)) {
      const parsed = validateJournalRecord(
        JSON.parse(line),
        this.records.length + 1,
        this.records.at(-1)?.record_fingerprint,
      );
      if (!parsed) {
        this.failureCode = 'journal_existing_invalid';
        throw new Error(this.failureCode);
      }
      this.records.push(parsed);
    }
    this.sequence = this.records.length;
  }
}

function toJournalRecord(
  event: ModelAttemptEvent,
  sequence: number,
  previousRecordFingerprint: string | undefined,
): AttemptJournalRecord {
  const messages = jsonSnapshot(event.request.messages.map(providerVisibleMessage));
  const tools = jsonSnapshot(event.request.tools);
  const stableMessages = jsonSnapshot(takeProviderVisibleStablePrefix(event.request.messages)
    .map(providerVisibleMessage));
  const cache = event.request.cache === undefined
    ? undefined
    : jsonSnapshot(event.request.cache);
  const usage = event.response?.usage;
  const payload: Omit<AttemptJournalRecord, 'record_fingerprint'> = {
    schema: ATTEMPT_JOURNAL_SCHEMA,
    sequence,
    outcome: event.outcome,
    call_id: event.callId,
    attempt_id: event.attemptId,
    attempt_number: event.attemptNumber,
    provider: event.provider,
    model: event.model,
    api_type: event.apiType,
    stream: event.stream,
    request_kind: event.requestKind,
    request_origin: event.requestOrigin,
    ...(event.request.cache ? { cache_strategy: event.request.cache.strategy } : {}),
    request_fingerprint: fingerprintCanonical({
      messages,
      tools,
      ...(cache === undefined ? {} : { cache }),
    }),
    stable_prefix_fingerprint: fingerprintCanonical({
      messages: stableMessages,
      tools,
      ...(cache === undefined ? {} : { cache }),
    }),
    tools_fingerprint: fingerprintCanonical(tools),
    tools_count: event.request.tools.length,
    ...(event.context?.sessionId ? {
      session_fingerprint: fingerprintCanonical(event.context.sessionId),
    } : {}),
    ...(event.context?.episodeId ? {
      episode_fingerprint: fingerprintCanonical(event.context.episodeId),
    } : {}),
    ...(usage?.inputTokensReported === true ? { input_tokens: usage.promptTokens } : {}),
    ...(Object.prototype.hasOwnProperty.call(usage ?? {}, 'cachedReadTokens') ? {
      cache_read_tokens: usage!.cachedReadTokens,
      ...(usage?.cacheReadSource ? { cache_read_source: usage.cacheReadSource } : {}),
    } : {}),
    ...(Object.prototype.hasOwnProperty.call(usage ?? {}, 'cachedWriteTokens') ? {
      cache_write_tokens: usage!.cachedWriteTokens,
    } : {}),
    ...(usage ? { output_tokens: usage.completionTokens } : {}),
    ...(usage?.providerUsage ? { provider_usage: jsonSnapshot(usage.providerUsage) as ProviderReportedUsage } : {}),
    ...(event.retry ? {
      retry_number: event.retry.retryNumber,
      ...(event.retry.stopReason ? { retry_stop_reason: event.retry.stopReason } : {}),
      ...(event.retry.recoveryAction ? {
        retry_recovery_action: event.retry.recoveryAction,
      } : {}),
    } : {}),
    ...(event.outcome === 'retrying'
      && attestProviderRequestDispatch(event.error) === 'not_dispatched'
      ? { dispatch_status: 'not_dispatched' as const }
      : {}),
    previous_record_fingerprint: previousRecordFingerprint
      ?? `sha256:${'0'.repeat(64)}`,
  };
  return {
    ...payload,
    record_fingerprint: fingerprintCanonical(payload),
  };
}

function validateJournalRecord(
  value: unknown,
  expectedSequence: number,
  previousRecordFingerprint: string | undefined,
): AttemptJournalRecord | undefined {
  if (!isPlainRecord(value)) return undefined;
  const record = value as Record<string, unknown>;
  const required = [
    'schema', 'sequence', 'outcome', 'call_id', 'attempt_id', 'attempt_number',
    'provider', 'model', 'api_type', 'stream', 'request_kind', 'request_origin',
    'request_fingerprint', 'stable_prefix_fingerprint', 'tools_fingerprint',
    'tools_count', 'previous_record_fingerprint', 'record_fingerprint',
  ];
  const optional = [
    'cache_strategy', 'session_fingerprint', 'episode_fingerprint',
    'input_tokens', 'cache_read_tokens', 'cache_read_source', 'cache_write_tokens',
    'provider_usage', 'output_tokens', 'retry_number', 'retry_stop_reason',
    'retry_recovery_action',
    'dispatch_status',
  ];
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.prototype.hasOwnProperty.call(record, key))) return undefined;
  if (Object.keys(record).some(key => !allowed.has(key))) return undefined;
  if (record.schema !== ATTEMPT_JOURNAL_SCHEMA || record.sequence !== expectedSequence) return undefined;
  if (!isModelRequestKind(record.request_kind)) return undefined;
  if (!isModelRequestOrigin(record.request_origin)) return undefined;
  if (!requestKindOriginMatches(record.request_kind, record.request_origin)) return undefined;
  if (!['started', 'succeeded', 'retrying', 'failed', 'cancelled'].includes(String(record.outcome))) {
    return undefined;
  }
  if (!['openai', 'anthropic'].includes(String(record.provider))) return undefined;
  if (!['openai-responses', 'openai-chat-completions', 'anthropic-messages'].includes(String(record.api_type))) {
    return undefined;
  }
  if (typeof record.stream !== 'boolean' || !isPositiveInteger(record.attempt_number)) return undefined;
  if (!isNonNegativeInteger(record.tools_count)) return undefined;
  for (const key of ['call_id', 'attempt_id', 'model'] as const) {
    if (typeof record[key] !== 'string' || record[key].length === 0) return undefined;
  }
  for (const key of [
    'request_fingerprint', 'stable_prefix_fingerprint', 'tools_fingerprint',
    'previous_record_fingerprint', 'record_fingerprint',
  ] as const) {
    if (!isFingerprint(record[key])) return undefined;
  }
  const expectedPrevious = previousRecordFingerprint ?? `sha256:${'0'.repeat(64)}`;
  if (record.previous_record_fingerprint !== expectedPrevious) return undefined;
  if (record.cache_strategy !== undefined && !isCacheStrategy(record.cache_strategy)) return undefined;
  if (
    record.dispatch_status !== undefined
    && (record.dispatch_status !== 'not_dispatched' || record.outcome !== 'retrying')
  ) return undefined;
  if (
    record.retry_recovery_action !== undefined
    && (
      record.outcome !== 'retrying'
      || ![
        'reasoning_replay_include',
        'reasoning_replay_omit',
        'reasoning_history_degrade',
      ].includes(String(record.retry_recovery_action))
    )
  ) return undefined;
  for (const key of ['session_fingerprint', 'episode_fingerprint'] as const) {
    if (record[key] !== undefined && !isFingerprint(record[key])) return undefined;
  }
  for (const key of [
    'input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'retry_number',
  ] as const) {
    if (record[key] !== undefined && !isNonNegativeInteger(record[key])) return undefined;
  }
  const { record_fingerprint: actualFingerprint, ...payload } = record;
  if (actualFingerprint !== fingerprintCanonical(payload)) return undefined;
  return record as unknown as AttemptJournalRecord;
}

function isModelRequestKind(value: unknown): value is ModelAttemptEvent['requestKind'] {
  return value === 'main_inference'
    || value === 'checkpoint_compaction'
    || value === 'memory_branch_inference'
    || value === 'subagent_inference';
}

function isModelRequestOrigin(value: unknown): value is ModelAttemptEvent['requestOrigin'] {
  return value === 'main' || value === 'memory_branch' || value === 'subagent';
}

function requestKindOriginMatches(
  kind: ModelAttemptEvent['requestKind'],
  origin: ModelAttemptEvent['requestOrigin'],
): boolean {
  return kind === 'checkpoint_compaction'
    || (kind === 'main_inference' && origin === 'main')
    || (kind === 'memory_branch_inference' && origin === 'memory_branch')
    || (kind === 'subagent_inference' && origin === 'subagent');
}

function isCacheStrategy(value: unknown): value is ProviderCacheStrategy {
  return value === 'anthropic-cache-bypassed'
    || value === 'anthropic-compatible-no-markers'
    || value === 'anthropic-explicit-stable-prefix'
    || value === 'openai-cache-bypassed'
    || value === 'openai-compatible-automatic-prefix'
    || value === 'openai-prompt-cache-key'
    || value === 'openai-explicit-stable-prefix';
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function providerVisibleMessage(message: Message): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.name ? { name: message.name } : {}),
    ...(message.providerContent ? { provider_content: message.providerContent } : {}),
    ...(message.providerState ? { provider_state: message.providerState } : {}),
  };
}

function takeProviderVisibleStablePrefix(messages: readonly Message[]): Message[] {
  const prefix: Message[] = [];
  for (const message of messages) {
    if (!isStablePrefixMessage(message)) break;
    prefix.push(message);
  }
  return prefix;
}

function isStablePrefixMessage(message: Message): boolean {
  const scope = resolveContextCacheScope(message);
  if (scope === 'epoch' || scope === 'volatile') return false;
  return !(typeof message.content === 'string'
    && /^(?:\[(?:transient_[^\]]+|compact_boundary)\])/.test(message.content));
}

function preparePrivateDirectory(value: string): string {
  const directory = path.resolve(value);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('journal_open_failed');
  assertOwnedByCurrentUser(stat, 'journal_open_failed');
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  return directory;
}

function validateJournalFileName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === '.' || value === '..') {
    throw new Error('journal_open_failed');
  }
  return value;
}

function assertOwnedByCurrentUser(stat: fs.Stats, code: string): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(code);
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function appendAndSync(fd: number, source: string): void {
  const buffer = Buffer.from(source, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
  }
  fs.fsyncSync(fd);
}

function jsonSnapshot(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
