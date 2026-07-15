import { execFileSync } from 'node:child_process';

import { DistillationUnit } from './distillation-unit';
import {
  ExternalSourceActivationResource,
  ExternalSourceIncrementalDiscoveryRequest,
  ExternalSourceIncrementalDiscoveryResult,
  ExternalSourceRawEvent,
  ExternalSourceReader,
  ExternalSourceReaderResult,
  SessionLogSourceIdentity,
  SessionLogSourceResource,
  SourceCursor,
  SourceEventIdentity,
} from './session-log-source';
import {
  ExternalSessionLogBackfillEvent,
  ExternalSessionLogBackfillReadResult,
  ExternalSessionLogBackfillSource,
} from './session-log-backfill';
import { SessionToolCallLog, SessionTurnLogEntry } from './session-log-schema';

export const XURL_PROTOCOL_VERSION = 1;
export const DEFAULT_XURL_TIMEOUT_MS = 10_000;
export const DEFAULT_XURL_MAX_OUTPUT_BYTES = 256 * 1024;

type XurlDiscoverMode = 'explicit-backfill' | 'incremental';

type XurlMessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

interface XurlProtocolDiscoveryResponse {
  readonly protocolVersion: number;
  readonly provider: string;
  readonly nextPageToken?: string | null;
  readonly activationWatermarkPosition?: number;
  readonly resources: readonly XurlProtocolResource[];
}

interface XurlProtocolReadResponse {
  readonly protocolVersion: number;
  readonly provider: string;
  readonly resourceRef: string;
  readonly status: 'stable' | 'pending';
  readonly exhausted: boolean;
  readonly newPosition: number;
  readonly events: readonly XurlProtocolEvent[];
}

interface XurlProtocolResource {
  readonly resourceRef: string;
  readonly firstEvent: XurlProtocolEventIdentity;
  readonly activationPosition?: number;
}

interface XurlProtocolEventIdentity {
  readonly eventId: string;
  readonly position: number;
  readonly conversationId: string;
  readonly branchId: string;
  readonly revision?: string;
  readonly contentHash?: string;
}

interface XurlProtocolEvent extends XurlProtocolEventIdentity {
  readonly timestamp: string;
  readonly messages: readonly XurlProtocolMessage[];
}

type XurlProtocolMessage =
  | {
    readonly role: 'system' | 'developer' | 'user' | 'assistant';
    readonly content: string;
    readonly final?: boolean;
  }
  | {
    readonly role: 'tool';
    readonly toolCallId: string;
    readonly name: string;
    readonly arguments?: unknown;
    readonly result: string;
    readonly completed: boolean;
  };

export interface XurlProcessRunnerOptions {
  readonly command: string;
  readonly provider: string;
  readonly sourceId: string;
  readonly sourceLabel?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface XurlExternalSourceOptions extends XurlProcessRunnerOptions {}

interface XurlNormalizedReadPage {
  readonly status: 'stable' | 'pending';
  readonly exhausted: boolean;
  readonly newPosition: number;
  readonly events: readonly XurlNormalizedEvent[];
}

interface XurlNormalizedEvent {
  readonly identity: SourceEventIdentity;
  readonly distillationUnit: DistillationUnit;
  readonly byteLength: number;
}

export class XurlExternalSourceReader implements ExternalSourceReader {
  readonly provider: string;
  readonly reader = 'xurl';
  private readonly runner: XurlProcessRunner;

  constructor(options: XurlExternalSourceOptions) {
    this.provider = options.provider;
    this.runner = new XurlProcessRunner(options);
  }

  discoverResources(cursor: SourceCursor | null): readonly SessionLogSourceResource[] {
    return this.discoverIncremental({ cursor }).resources;
  }

  discoverIncremental(
    request: ExternalSourceIncrementalDiscoveryRequest,
  ): ExternalSourceIncrementalDiscoveryResult {
    const page = this.runner.discoverResources('incremental', {
      pageToken: request.pageToken ?? null,
      maxResources: request.maxResources,
    });
    const resources = page.resources.map(resource => ({
      resourceRef: resource.resourceRef,
      firstEventIdentity: toSourceEventIdentity(resource.firstEvent),
    } satisfies SessionLogSourceResource));
    const activationResources = page.resources.map((resource, index) => ({
      resource: resources[index]!,
      activationPosition: typeof resource.activationPosition === 'number'
        ? normalizeActivationPosition(resource.activationPosition)
        : normalizeActivationPosition(resource.firstEvent.position),
    } satisfies ExternalSourceActivationResource));
    return {
      resources,
      activationResources,
      nextPageToken: page.nextPageToken ?? null,
      ...(typeof page.activationWatermarkPosition === 'number'
        ? { activationWatermarkPosition: normalizeActivationPosition(page.activationWatermarkPosition) }
        : {}),
    };
  }

  read(resource: SessionLogSourceResource, cursor: SourceCursor): ExternalSourceReaderResult {
    const page = this.runner.readPage(resource, cursor);
    return {
      events: page.events.map(({ identity, distillationUnit }) => ({
        eventId: identity.eventId,
        position: identity.position,
        contentHash: identity.contentHash,
        conversationId: identity.conversationId,
        branchId: identity.branchId,
        revision: identity.revision,
        distillationUnit,
      } satisfies ExternalSourceRawEvent)),
      status: page.status,
      exhausted: page.exhausted,
      newPosition: page.newPosition,
      byteLength: page.events.reduce((sum, event) => sum + event.byteLength, 0),
    };
  }
}

export class XurlExternalBackfillSource implements ExternalSessionLogBackfillSource {
  readonly identity: SessionLogSourceIdentity;
  private readonly runner: XurlProcessRunner;

  constructor(options: XurlExternalSourceOptions) {
    this.identity = {
      sourceId: requireNonEmptyText('xurl sourceId', options.sourceId),
      label: options.sourceLabel?.trim() || `External Source (${options.provider})`,
      category: 'external',
      provider: requireNonEmptyText('xurl provider', options.provider),
      reader: 'xurl',
    };
    this.runner = new XurlProcessRunner(options);
  }

  discoverResources(): readonly SessionLogSourceResource[] {
    const page = this.runner.discoverResources('explicit-backfill');
    return page.resources.map(resource => ({
      resourceRef: resource.resourceRef,
      firstEventIdentity: toSourceEventIdentity(resource.firstEvent),
    }));
  }

  read(resource: SessionLogSourceResource, cursor: SourceCursor): ExternalSessionLogBackfillReadResult {
    const page = this.runner.readPage(resource, cursor);
    return {
      events: page.events.map(({ identity, distillationUnit, byteLength }) => ({
        identity,
        distillationUnit,
        byteLength,
      } satisfies ExternalSessionLogBackfillEvent)),
      status: page.status,
      exhausted: page.exhausted,
      newCursor: {
        resourceRef: resource.resourceRef,
        position: page.newPosition,
        processedCount: cursor.processedCount + page.events.length,
      },
    };
  }
}

class XurlProcessRunner {
  private readonly command: string;
  private readonly provider: string;
  private readonly sourceId: string;
  private readonly cwd?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: XurlProcessRunnerOptions) {
    this.command = requireNonEmptyText('xurl command', options.command);
    this.provider = requireNonEmptyText('xurl provider', options.provider);
    this.sourceId = requireNonEmptyText('xurl sourceId', options.sourceId);
    this.cwd = options.cwd;
    this.env = options.env;
    this.timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_XURL_TIMEOUT_MS, 'xurl timeoutMs');
    this.maxOutputBytes = normalizePositiveInteger(
      options.maxOutputBytes,
      DEFAULT_XURL_MAX_OUTPUT_BYTES,
      'xurl maxOutputBytes',
    );
  }

  discoverResources(
    mode: XurlDiscoverMode,
    options: { pageToken?: string | null; maxResources?: number } = {},
  ): XurlProtocolDiscoveryResponse {
    const args = ['--mode', mode];
    if (options.pageToken) {
      args.push('--page-token', options.pageToken);
    }
    if (typeof options.maxResources === 'number' && Number.isFinite(options.maxResources) && options.maxResources > 0) {
      args.push('--max-resources', String(Math.floor(options.maxResources)));
    }
    const response = this.invoke('discover', args);
    return validateDiscoveryResponse(response, this.provider);
  }

  readPage(resource: SessionLogSourceResource, cursor: SourceCursor): XurlNormalizedReadPage {
    const response = this.invoke('read', [
      '--resource-ref', requireNonEmptyText('xurl resourceRef', resource.resourceRef),
      '--cursor-position', String(normalizeCursorPosition(cursor.position)),
    ]);
    const page = validateReadResponse(response, this.provider, resource.resourceRef, cursor.position);
    return {
      status: page.status,
      exhausted: page.exhausted,
      newPosition: page.newPosition,
      events: page.events.map(event => normalizeReadEvent(this.provider, resource.resourceRef, event)),
    };
  }

  private invoke(action: 'discover' | 'read', extraArgs: readonly string[]): unknown {
    const args = [
      'session-log-v1',
      action,
      '--protocol-version',
      String(XURL_PROTOCOL_VERSION),
      '--provider',
      this.provider,
      '--source-id',
      this.sourceId,
      ...extraArgs,
    ];

    try {
      const stdout = execFileSync(this.command, args, {
        cwd: this.cwd,
        env: this.env,
        encoding: 'utf8',
        timeout: this.timeoutMs,
        maxBuffer: this.maxOutputBytes,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as string;
      return parseJsonProtocol(stdout);
    } catch (error) {
      throw mapXurlProcessError(action, error, this.timeoutMs, this.maxOutputBytes);
    }
  }
}

function normalizeReadEvent(
  provider: string,
  resourceRef: string,
  event: XurlProtocolEvent,
): XurlNormalizedEvent {
  const identity = toSourceEventIdentity(event);
  return {
    identity,
    distillationUnit: buildDistillationUnit(provider, resourceRef, event),
    byteLength: Buffer.byteLength(JSON.stringify(event), 'utf8'),
  };
}

function buildDistillationUnit(
  provider: string,
  resourceRef: string,
  event: XurlProtocolEvent,
): DistillationUnit {
  const messages = event.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error(`xurl protocol event ${event.eventId} is missing canonical messages`);
  }

  const visible = messages.filter(message => message.role !== 'system' && message.role !== 'developer');
  if (visible.length === 0) {
    throw new Error(`xurl protocol event ${event.eventId} has no canonical user/assistant payload`);
  }

  let userMessage: { content: string } | undefined;
  let assistantMessage: { content: string } | undefined;
  const toolCalls: SessionToolCallLog[] = [];

  for (const message of visible) {
    switch (message.role) {
      case 'user': {
        if (userMessage) {
          throw new Error(`xurl protocol event ${event.eventId} has more than one user message`);
        }
        if (!message.content.trim()) {
          throw new Error(`xurl protocol event ${event.eventId} has an empty user message`);
        }
        userMessage = message;
        break;
      }
      case 'assistant': {
        if (message.final !== true) {
          throw new Error(`xurl protocol event ${event.eventId} has a non-final assistant message`);
        }
        if (assistantMessage) {
          throw new Error(`xurl protocol event ${event.eventId} has more than one final assistant message`);
        }
        assistantMessage = message;
        break;
      }
      case 'tool': {
        if (message.completed !== true) {
          throw new Error(`xurl protocol event ${event.eventId} has an incomplete tool result`);
        }
        toolCalls.push({
          id: requireNonEmptyText('xurl toolCallId', message.toolCallId),
          name: requireNonEmptyText('xurl tool name', message.name),
          arguments: message.arguments ?? {},
          result: String(message.result ?? ''),
        });
        break;
      }
      default:
        throw new Error(`xurl protocol event ${event.eventId} includes an unsupported role`);
    }
  }

  if (!userMessage || !assistantMessage) {
    throw new Error(`xurl protocol event ${event.eventId} is missing a complete user-to-assistant turn`);
  }

  const visibleUserIndex = visible.findIndex(message => message.role === 'user');
  const visibleAssistantIndex = visible.findIndex(message => message.role === 'assistant');
  if (visibleUserIndex < 0 || visibleAssistantIndex < 0 || visibleUserIndex > visibleAssistantIndex) {
    throw new Error(`xurl protocol event ${event.eventId} has an invalid message order`);
  }
  const toolAfterAssistant = visible.slice(visibleAssistantIndex + 1).some(message => message.role === 'tool');
  if (toolAfterAssistant) {
    throw new Error(`xurl protocol event ${event.eventId} places tool output after the final assistant message`);
  }

  const sessionId = `external:${provider}:${event.conversationId}:${event.branchId}`;
  const turn: SessionTurnLogEntry = {
    entry_type: 'turn',
    turn: event.position + 1,
    timestamp: requireIsoTimestamp('xurl event timestamp', event.timestamp),
    session_id: sessionId,
    session_type: 'external',
    user: { text: userMessage.content.trim() },
    assistant: {
      text: assistantMessage.content.trim(),
      tool_calls: toolCalls,
    },
    tokens: {
      prompt: 0,
      completion: 0,
    },
  };

  return {
    filePath: `xurl://${provider}/${encodeURIComponent(resourceRef)}`,
    newTurns: [turn],
    continuityTurns: [],
    byteRange: {
      start: event.position,
      end: event.position + 1,
    },
    generatedAt: turn.timestamp,
  };
}

function toSourceEventIdentity(event: XurlProtocolEventIdentity): SourceEventIdentity {
  const eventId = requireNonEmptyText('xurl eventId', event.eventId);
  const conversationId = requireNonEmptyText('xurl conversationId', event.conversationId);
  const branchId = requireNonEmptyText('xurl branchId', event.branchId);
  const revision = optionalNonEmptyText(event.revision);
  const contentHash = optionalNonEmptyText(event.contentHash);
  if (!revision && !contentHash) {
    throw new Error(`xurl protocol event ${eventId} must include revision or contentHash`);
  }
  return {
    eventId,
    position: normalizeNonNegativeInteger(event.position, 'xurl event position'),
    conversationId,
    branchId,
    ...(revision ? { revision } : {}),
    ...(contentHash ? { contentHash } : {}),
  };
}

function validateDiscoveryResponse(response: unknown, provider: string): XurlProtocolDiscoveryResponse {
  const candidate = asRecord(response, 'xurl discovery response');
  assertProtocolVersion(candidate.protocolVersion);
  assertProvider(candidate.provider, provider);
  if (!Array.isArray(candidate.resources)) {
    throw new Error('xurl discovery response must include a resources array');
  }
  const nextPageToken = candidate.nextPageToken == null
    ? null
    : requireNonEmptyText('xurl discovery nextPageToken', candidate.nextPageToken);
  const activationWatermarkPosition = candidate.activationWatermarkPosition == null
    ? undefined
    : normalizeNonNegativeInteger(candidate.activationWatermarkPosition, 'xurl discovery activationWatermarkPosition');
  return {
    protocolVersion: XURL_PROTOCOL_VERSION,
    provider,
    ...(nextPageToken ? { nextPageToken } : {}),
    ...(activationWatermarkPosition !== undefined ? { activationWatermarkPosition } : {}),
    resources: candidate.resources.map((resource, index) => {
      const record = asRecord(resource, `xurl discovery resource ${index}`);
      return {
        resourceRef: requireNonEmptyText('xurl resourceRef', record.resourceRef),
        firstEvent: asEventIdentity(record.firstEvent, `xurl discovery resource ${index} firstEvent`),
        ...(record.activationPosition == null
          ? {}
          : { activationPosition: normalizeNonNegativeInteger(record.activationPosition, `xurl discovery resource ${index} activationPosition`) }),
      };
    }),
  };
}

function validateReadResponse(
  response: unknown,
  provider: string,
  resourceRef: string,
  cursorPosition: number,
): XurlProtocolReadResponse {
  const candidate = asRecord(response, 'xurl read response');
  assertProtocolVersion(candidate.protocolVersion);
  assertProvider(candidate.provider, provider);
  if (candidate.resourceRef !== resourceRef) {
    throw new Error(`xurl read response resourceRef mismatch: expected ${resourceRef}`);
  }
  if (candidate.status !== 'stable' && candidate.status !== 'pending') {
    throw new Error('xurl read response status must be stable or pending');
  }
  if (typeof candidate.exhausted !== 'boolean') {
    throw new Error('xurl read response exhausted must be a boolean');
  }
  const newPosition = normalizeNonNegativeInteger(candidate.newPosition, 'xurl read response newPosition');
  if (newPosition < cursorPosition) {
    throw new Error('xurl read response newPosition regressed');
  }
  if (!Array.isArray(candidate.events)) {
    throw new Error('xurl read response must include an events array');
  }
  if (candidate.status === 'pending' && candidate.events.length > 0) {
    throw new Error('xurl read response cannot return stable events for a pending page');
  }
  return {
    protocolVersion: XURL_PROTOCOL_VERSION,
    provider,
    resourceRef,
    status: candidate.status,
    exhausted: candidate.exhausted,
    newPosition,
    events: candidate.events.map((event, index) => asProtocolEvent(event, `xurl read event ${index}`)),
  };
}

function asProtocolEvent(candidate: unknown, label: string): XurlProtocolEvent {
  const record = asRecord(candidate, label);
  const messages = record.messages;
  if (!Array.isArray(messages)) {
    throw new Error(`${label} must include a messages array`);
  }
  return {
    ...asEventIdentity(record, label),
    timestamp: requireIsoTimestamp(`${label} timestamp`, record.timestamp),
    messages: messages.map((message, index) => asProtocolMessage(message, `${label} message ${index}`)),
  };
}

function asEventIdentity(candidate: unknown, label: string): XurlProtocolEventIdentity {
  const record = asRecord(candidate, label);
  return {
    eventId: requireNonEmptyText(`${label} eventId`, record.eventId),
    position: normalizeNonNegativeInteger(record.position, `${label} position`),
    conversationId: requireNonEmptyText(`${label} conversationId`, record.conversationId),
    branchId: requireNonEmptyText(`${label} branchId`, record.branchId),
    ...(optionalNonEmptyText(record.revision) ? { revision: optionalNonEmptyText(record.revision)! } : {}),
    ...(optionalNonEmptyText(record.contentHash) ? { contentHash: optionalNonEmptyText(record.contentHash)! } : {}),
  };
}

function asProtocolMessage(candidate: unknown, label: string): XurlProtocolMessage {
  const record = asRecord(candidate, label);
  const role = requireNonEmptyText(`${label} role`, record.role) as XurlMessageRole;
  switch (role) {
    case 'system':
    case 'developer':
    case 'user':
      return {
        role,
        content: requireString(`${label} content`, record.content),
      };
    case 'assistant':
      return {
        role,
        content: requireString(`${label} content`, record.content),
        final: record.final === true,
      };
    case 'tool':
      return {
        role,
        toolCallId: requireNonEmptyText(`${label} toolCallId`, record.toolCallId),
        name: requireNonEmptyText(`${label} name`, record.name),
        arguments: record.arguments,
        result: requireString(`${label} result`, record.result),
        completed: record.completed === true,
      };
    default:
      throw new Error(`${label} has unsupported role ${String(role)}`);
  }
}

function parseJsonProtocol(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) {
    throw new Error('xurl produced an empty response');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`xurl output is not valid protocol-v1 JSON: ${String(error)}`);
  }
}

function mapXurlProcessError(
  action: 'discover' | 'read',
  error: unknown,
  timeoutMs: number,
  maxOutputBytes: number,
): Error {
  const candidate = error as {
    code?: string | number | null;
    status?: number | null;
    signal?: string | null;
    killed?: boolean;
    stderr?: string | Buffer;
    message?: string;
  };
  if (candidate?.code === 'ENOBUFS') {
    return new Error(`xurl ${action} output exceeded ${maxOutputBytes} bytes`);
  }
  if (
    candidate?.code === 'ETIMEDOUT'
    || candidate?.signal === 'SIGTERM'
    || candidate?.signal === 'SIGKILL'
    || candidate?.killed === true
  ) {
    return new Error(`xurl ${action} timed out after ${timeoutMs}ms`);
  }
  const stderr = typeof candidate?.stderr === 'string'
    ? candidate.stderr
    : Buffer.isBuffer(candidate?.stderr)
      ? candidate.stderr.toString('utf8')
      : '';
  const detail = truncateLine((stderr || candidate?.message || '').trim(), 240);
  const exitStatus = candidate?.status ?? candidate?.code ?? 'unknown';
  return new Error(`xurl ${action} exited with status ${String(exitStatus)}${detail ? `: ${detail}` : ''}`);
}

function assertProtocolVersion(value: unknown): void {
  if (value !== XURL_PROTOCOL_VERSION) {
    throw new Error(`unsupported xurl protocol version: ${String(value)}`);
  }
}

function assertProvider(actual: unknown, expected: string): void {
  if (actual !== expected) {
    throw new Error(`xurl provider mismatch: expected ${expected}, got ${String(actual)}`);
  }
}

function asRecord(candidate: unknown, label: string): Record<string, unknown> {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(`${label} must be an object`);
  }
  return candidate as Record<string, unknown>;
}

function requireString(label: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function requireNonEmptyText(label: string, value: unknown): string {
  const text = requireString(label, value).trim();
  if (!text) {
    throw new Error(`${label} must be non-empty`);
  }
  if (text.includes('\u0000')) {
    throw new Error(`${label} must not contain NUL`);
  }
  return text;
}

function optionalNonEmptyText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireNonEmptyText('xurl optional text', value);
}

function normalizePositiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Math.floor(value);
}

function normalizeNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Math.floor(value);
}

function normalizeCursorPosition(value: number): number {
  if (!Number.isFinite(value) || value < -1) {
    throw new Error('xurl cursor position must be >= -1');
  }
  return Math.floor(value);
}

function normalizeActivationPosition(value: number): number {
  if (!Number.isFinite(value) || value < -1) {
    throw new Error('xurl activation position must be >= -1');
  }
  return Math.floor(value);
}

function requireIsoTimestamp(label: string, value: unknown): string {
  const text = requireNonEmptyText(label, value);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return text;
}

function truncateLine(value: string, maxLength: number): string {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
