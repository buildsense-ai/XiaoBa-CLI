import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Message } from '../types';
import type { ProviderReportedUsage } from '../types';
import type { ModelAttemptEvent, ModelAttemptSink } from '../providers/provider';
import { resolveContextCacheScope } from '../core/context-lifecycle';
import { fingerprintCanonical } from './canonical';

export const ATTEMPT_JOURNAL_SCHEMA = 'xiaoba.cache_benchmark_attempt_journal.v1' as const;

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
  request_fingerprint: string;
  stable_prefix_fingerprint: string;
  tools_fingerprint: string;
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
      const record = toJournalRecord(event, ++this.sequence);
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
      const parsed = JSON.parse(line) as AttemptJournalRecord;
      if (parsed.schema !== ATTEMPT_JOURNAL_SCHEMA || parsed.sequence !== this.records.length + 1) {
        this.failureCode = 'journal_existing_invalid';
        throw new Error(this.failureCode);
      }
      this.records.push(parsed);
    }
    this.sequence = this.records.length;
  }
}

function toJournalRecord(event: ModelAttemptEvent, sequence: number): AttemptJournalRecord {
  const messages = jsonSnapshot(event.request.messages.map(providerVisibleMessage));
  const tools = jsonSnapshot(event.request.tools);
  const stableMessages = jsonSnapshot(event.request.messages
    .filter(isStableSystemMessage)
    .map(providerVisibleMessage));
  const cache = event.request.cache === undefined
    ? undefined
    : jsonSnapshot(event.request.cache);
  const usage = event.response?.usage;
  return {
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
    } : {}),
  };
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

function isStableSystemMessage(message: Message): boolean {
  if (message.role !== 'system') return false;
  const scope = resolveContextCacheScope(message);
  if (scope === 'epoch' || scope === 'volatile') return false;
  if (scope === 'stable') return true;
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
