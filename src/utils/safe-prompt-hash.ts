import { createHash, createHmac, randomBytes } from 'crypto';
import { Logger } from './logger';

type Jsonish = string | number | boolean | null | Jsonish[] | { [key: string]: Jsonish };

export interface SafePromptHashMeta {
  boundary: string;
  requestId?: string;
  sessionId?: string;
  surface?: string;
  turn?: number;
  provider?: string;
  model?: string;
  stream?: boolean;
}

export interface SafePromptHashInput {
  messages?: unknown;
  tools?: unknown;
  system?: unknown;
  body?: unknown;
  extra?: Record<string, unknown>;
}

const HASH_LENGTH = 16;

export function createSafePromptHashRequestId(): string {
  return `ph_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

export function logSafePromptHash(meta: SafePromptHashMeta, input: SafePromptHashInput): void {
  if (!isSafePromptHashEnabled()) return;

  Logger.info(`[SAFE_PROMPT_HASH] ${JSON.stringify(buildSafePromptHashPayload(meta, input))}`);
}

export function buildSafePromptHashPayload(meta: SafePromptHashMeta, input: SafePromptHashInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    boundary: meta.boundary,
    request_id: meta.requestId,
    session_id: meta.sessionId,
    session_hash: meta.sessionId ? digest(meta.sessionId) : undefined,
    surface: meta.surface,
    turn: meta.turn,
    provider: meta.provider,
    model: meta.model,
    stream: meta.stream,
  };

  if (input.system !== undefined) {
    const text = stableStringify(input.system);
    payload.system = {
      len: text.length,
      hash: digest(text),
    };
  }

  if (input.messages !== undefined) {
    payload.messages = summarizeMessages(input.messages);
  }

  if (input.tools !== undefined) {
    payload.tools = summarizeTools(input.tools);
  }

  if (input.body !== undefined) {
    const text = stableStringify(input.body);
    payload.body = {
      len: text.length,
      hash: digest(text),
    };
  }

  if (input.extra) {
    payload.extra = sanitizeExtra(input.extra);
  }

  return stripUndefined(payload) as Record<string, unknown>;
}

export function isSafePromptHashEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.XIAOBA_SAFE_PROMPT_HASH || '');
}

function summarizeMessages(messages: unknown): Record<string, unknown> {
  if (!Array.isArray(messages)) {
    const text = stableStringify(messages);
    return {
      kind: typeOf(messages),
      len: text.length,
      hash: digest(text),
    };
  }

  const normalized = messages.map(normalizeMessage);
  const currentUserIndex = findCurrentUserIndex(messages);
  const segmented = normalized.map((message, index) => ({
    ...message,
    index,
    segment: classifyMessageSegment(messages[index], index, currentUserIndex),
  }));
  const items = normalized.map((message, index) => ({
    index,
    role: message.role,
    name: message.name,
    segment: segmented[index].segment,
    content_kind: message.contentKind,
    content_len: message.contentLen,
    content_hash: message.contentHash,
    tool_call_count: message.toolCallCount,
    tool_calls_hash: message.toolCallsHash,
    tool_call_id_hash: message.toolCallIdHash,
  }));

  return {
    count: messages.length,
    roles: normalized.map(message => message.role).join(','),
    total_content_len: normalized.reduce((sum, message) => sum + message.contentLen, 0),
    hash: digest(normalized),
    segments: summarizeMessageSegments(segmented),
    prefixes: summarizeMessagePrefixes(normalized),
    tail: summarizeMessageTail(normalized),
    items,
  };
}

function normalizeMessage(message: unknown): Record<string, any> {
  if (!isRecord(message)) {
    const text = stableStringify(message);
    return {
      role: typeOf(message),
      contentKind: typeOf(message),
      contentLen: text.length,
      contentHash: digest(text),
      toolCallCount: 0,
      toolCallsHash: undefined,
      toolCallIdHash: undefined,
      normalized: text,
    };
  }

  const role = typeof message.role === 'string' ? message.role : '';
  const name = typeof message.name === 'string' ? message.name : undefined;
  const content = message.content;
  const contentText = stableStringify(content);
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : undefined;
  const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined;

  return {
    role,
    name,
    contentKind: Array.isArray(content) ? 'array' : typeOf(content),
    contentLen: contentText.length,
    contentHash: digest(contentText),
    toolCallCount: toolCalls?.length ?? 0,
    toolCallsHash: toolCalls ? digest(toolCalls) : undefined,
    toolCallIdHash: toolCallId ? digest(toolCallId) : undefined,
    normalized: {
      role,
      name,
      tool_call_id: toolCallId,
      content,
      tool_calls: toolCalls,
    },
  };
}

function summarizeTools(tools: unknown): Record<string, unknown> {
  if (!Array.isArray(tools)) {
    const text = stableStringify(tools);
    return {
      kind: typeOf(tools),
      len: text.length,
      hash: digest(text),
    };
  }

  const normalized = tools.map(normalizeTool);
  const names = normalized.map(tool => tool.name);

  return {
    count: tools.length,
    names,
    total_len: normalized.reduce((sum, tool) => sum + tool.len, 0),
    hash: digest(normalized.map(tool => tool.normalized)),
    items: normalized.map(tool => ({
      name: tool.name,
      len: tool.len,
      description_len: tool.descriptionLen,
      schema_len: tool.schemaLen,
      hash: tool.hash,
    })),
  };
}

function summarizeMessageSegments(messages: Array<Record<string, any>>): Record<string, unknown> {
  const segments: Record<string, Array<Record<string, any>>> = {};
  for (const message of messages) {
    const segment = message.segment || 'unknown';
    if (!segments[segment]) segments[segment] = [];
    segments[segment].push(message);
  }

  const result: Record<string, unknown> = {};
  for (const [segment, group] of Object.entries(segments)) {
    result[segment] = {
      count: group.length,
      roles: countValues(group.map(item => item.role)),
      total_content_len: group.reduce((sum, item) => sum + Number(item.contentLen || 0), 0),
      tool_call_count: group.reduce((sum, item) => sum + Number(item.toolCallCount || 0), 0),
      first_index: group[0]?.index,
      last_index: group[group.length - 1]?.index,
      hash: digest(group.map(item => item.normalized)),
    };
  }
  return result;
}

function summarizeMessagePrefixes(messages: Array<Record<string, any>>): Array<Record<string, unknown>> {
  if (messages.length === 0) return [];
  const checkpoints = uniqueNumbers([
    1,
    2,
    4,
    8,
    16,
    32,
    64,
    128,
    messages.length,
  ]).filter(count => count > 0 && count <= messages.length);

  return checkpoints.map(count => {
    const slice = messages.slice(0, count);
    return {
      count,
      roles: slice.map(message => message.role).join(','),
      total_content_len: slice.reduce((sum, message) => sum + Number(message.contentLen || 0), 0),
      hash: digest(slice.map(message => message.normalized)),
    };
  });
}

function summarizeMessageTail(messages: Array<Record<string, any>>): Record<string, unknown> {
  const count = Math.min(8, messages.length);
  const slice = messages.slice(messages.length - count);
  return {
    count,
    start_index: messages.length - count,
    roles: slice.map(message => message.role).join(','),
    total_content_len: slice.reduce((sum, message) => sum + Number(message.contentLen || 0), 0),
    hash: digest(slice.map(message => message.normalized)),
  };
}

function classifyMessageSegment(raw: unknown, index: number, currentUserIndex: number): string {
  if (!isRecord(raw)) return 'unknown';
  const role = typeof raw.role === 'string' ? raw.role : '';
  const content = typeof raw.content === 'string' ? raw.content : '';

  if (role === 'system' && content.startsWith('[transient_skills_list]')) {
    return 'skills';
  }
  if (isTransientMessage(raw)) {
    return 'transient';
  }
  if (raw.__runtimeObservation) {
    return 'runtime_observation';
  }
  if (index === currentUserIndex) {
    return 'current_user';
  }
  if (role === 'system') {
    return 'system';
  }
  if (role === 'tool') {
    return 'tool_result';
  }
  if (role === 'assistant' && Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
    return 'assistant_tool_call';
  }
  return 'history';
}

function isTransientMessage(message: Record<string, any>): boolean {
  if (message.__injected || message.__runtimeFeedback) return true;
  if (message.role !== 'system' || typeof message.content !== 'string') return false;
  return message.content.startsWith('[transient_');
}

function findCurrentUserIndex(messages: unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    if (message.role !== 'user') continue;
    if (message.__injected || message.__runtimeFeedback) continue;
    if (typeof message.content === 'string' && message.content.startsWith('[transient_')) continue;
    return index;
  }
  return -1;
}

function normalizeTool(tool: unknown): Record<string, any> {
  const record = isRecord(tool) ? tool : {};
  const functionRecord = isRecord(record.function) ? record.function : {};
  const name = typeof record.name === 'string'
    ? record.name
    : typeof functionRecord.name === 'string'
      ? functionRecord.name
      : '';
  const description = typeof record.description === 'string'
    ? record.description
    : typeof functionRecord.description === 'string'
      ? functionRecord.description
      : '';
  const schema = record.parameters ?? functionRecord.parameters ?? {};
  const normalized = {
    name,
    description,
    parameters: schema,
  };
  const schemaText = stableStringify(schema);
  return {
    name,
    descriptionLen: description.length,
    schemaLen: schemaText.length,
    len: stableStringify(normalized).length,
    hash: digest(normalized),
    normalized,
  };
}

function sanitizeExtra(extra: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      sanitized[key] = value;
      continue;
    }
    const text = stableStringify(value);
    sanitized[key] = {
      kind: typeOf(value),
      len: text.length,
      hash: digest(text),
    };
  }
  return sanitized;
}

function digest(value: unknown): string {
  const text = typeof value === 'string' ? value : stableStringify(value);
  const salt = process.env.XIAOBA_SAFE_PROMPT_HASH_SALT || '';
  const hash = salt
    ? createHmac('sha256', salt).update(text).digest('hex')
    : createHash('sha256').update(text).digest('hex');
  return hash.slice(0, HASH_LENGTH);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(toStableJson(value));
}

function toStableJson(value: unknown): Jsonish {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toStableJson);
  if (!isRecord(value)) return String(value);

  const result: { [key: string]: Jsonish } = {};
  for (const key of Object.keys(value).sort()) {
    const current = value[key];
    if (typeof current === 'undefined' || typeof current === 'function') continue;
    result[key] = toStableJson(current);
  }
  return result;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, current] of Object.entries(value)) {
    if (typeof current === 'undefined') continue;
    result[key] = stripUndefined(current);
  }
  return result;
}

function countValues(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) {
    const key = value || 'unknown';
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}
