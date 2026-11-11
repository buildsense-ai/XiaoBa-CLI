import * as fs from 'fs';

/**
 * Stable, route-derived agent provenance for a session-log stream. It is
 * separate from session_id so legacy group session keys can remain compatible
 * while CatsLog can index the target agent without inspecting log text.
 */
export interface SessionLogAgentIdentity {
  agent_id: string;
  agent_body_id?: string;
  trust: 'server_canonical' | 'legacy_context' | 'untrusted';
  source?: string;
}

interface SessionLogIdentityFields {
  agent_identity?: SessionLogAgentIdentity;
}

export interface SessionToolCallLog {
  id: string;
  name: string;
  arguments: any;
  result: string;
  duration_ms?: number;
}

export interface SessionPromptFileLog {
  path: string;
  sha256: string;
  short_hash: string;
  bytes: number;
  chars: number;
  lines: number;
}

export interface SessionPromptTurnLog {
  source: string;
  prompt_version: string;
  system_hash: string;
  system_chars: number;
  bundle_hash: string;
  bundle_file_count: number;
}

export interface SessionAttachmentLog {
  name: string;
  type?: string;
  url?: string;
  reference?: string;
  sha256?: string;
  media_type?: string;
}

export interface SessionInputMetadata {
  source?: string;
  messageId?: string;
  senderId?: string;
  attachments?: SessionAttachmentLog[];
}

export interface SessionTranscriptContent {
  text: string;
  attachments?: SessionAttachmentLog[];
}

/** Explicit payloads only: never serialize a Message, provider state or execution grants. */
export type SessionTranscriptEvent =
  | ({ type: 'input_received'; input_id: string; source?: string; message_id?: string; sender_id?: string } & SessionTranscriptContent)
  | { type: 'run_started' }
  | ({ type: 'input_consumed'; input_ids: string[]; kind: 'root' | 'pending' | 'runtime_observation'; source?: string } & SessionTranscriptContent)
  | { type: 'input_deferred'; input_ids: string[]; reason: 'cancelled_during_handoff' }
  | { type: 'assistant_message'; text: string; phase: 'reply' | 'tool_prelude' | 'partial' | 'runtime_reply'; model_call: number }
  | { type: 'runtime_observation'; source: string; text: string }
  | { type: 'model_failed'; model_call: number; error_name: string }
  | { type: 'tool_started'; call_id: string; name: string; arguments: string }
  | { type: 'tool_finished'; call_id: string; name: string; result: string; attachments?: SessionAttachmentLog[]; duration_ms: number }
  | { type: 'run_finished'; status: 'completed' | 'failed' | 'cancelled'; error_name?: string };

export interface SessionTranscriptLogEntry extends SessionLogIdentityFields {
  entry_type: 'transcript';
  schema_version: 1;
  event_id: string;
  stream_id: string;
  seq: number;
  run_id?: string;
  timestamp: string;
  session_id: string;
  session_type: string;
  event: SessionTranscriptEvent;
}

export interface SessionTurnLogEntry extends SessionLogIdentityFields {
  run_id?: string;
  entry_type: 'turn';
  turn: number;
  timestamp: string;
  session_id: string;
  session_type: string;
  user: {
    text: string;
    images?: string[];
    runtime_feedback?: string[];
    runtime_observation_source?: string;
  };
  assistant: {
    text: string;
    tool_calls: SessionToolCallLog[];
  };
  tokens: {
    prompt: number;
    completion: number;
  };
  prompt?: SessionPromptTurnLog;
}

export interface SessionRuntimeLogEntry extends SessionLogIdentityFields {
  entry_type: 'runtime';
  timestamp: string;
  session_id: string;
  session_type: string;
  level: string;
  message: string;
  event?: SessionRuntimeLogEvent;
}

export interface SessionRuntimeLogEvent {
  type: string;
  payload?: Record<string, unknown>;
}

/** Structured diagnostics for a turn that actually exited with taskOutcome=failed. */
export interface TurnErrorPayload {
  error_code: string;
  category: string;
  classification_confidence?: 'high' | 'medium' | 'low';
  outcome?: 'conversation_interrupted';
  phase?: string;
  error_origin?: 'provider' | 'transport' | 'runtime' | 'model_response';
  recovery_action?: string;
  retry_strategy?: string;
  model?: string | null;
  provider?: string | null;
  http_status?: number | null;
  provider_code?: string;
  provider_type?: string;
  provider_request_id?: string;
  provider_response_id?: string;
  terminal_event?: string;
  provider_failure_phase?: string;
  error_fingerprint?: string;
  stack_fingerprint?: string;
  top_frame?: string;
  error_summary?: string;
  attempt_count?: number;
  retry_count?: number;
  retry_stop_reason?: string;
  retry_elapsed_ms?: number;
  turn_elapsed_ms?: number;
  partial_progress_preserved?: boolean;
  episode_id?: string;
  model_call_id?: string;
  model_attempt_id?: string;
  model_attempt_number?: number;
  turn?: number;
}

export interface SessionSubAgentEventLogEntry extends SessionLogIdentityFields {
  entry_type: 'subagent_event';
  timestamp: string;
  session_id: string;
  session_type: string;
  subagent: {
    id: string;
    name?: string;
    type?: string;
    status?: string;
    seq: number;
  };
  event: {
    type: string;
    summary: string;
    payload?: Record<string, unknown>;
  };
}

export interface SessionPromptTraceLogEntry extends SessionLogIdentityFields {
  entry_type: 'prompt_trace';
  timestamp: string;
  session_id: string;
  session_type: string;
  prompt: {
    source: string;
    prompt_version: string;
    prompts_dir: string;
    generated_at: string;
    system: {
      sha256: string;
      short_hash: string;
      chars: number;
      lines: number;
    };
    bundle: {
      sha256: string;
      short_hash: string;
      file_count: number;
      files: SessionPromptFileLog[];
    };
    loaded_files: string[];
  };
}

export interface LegacySessionTurnLogEntry extends Omit<SessionTurnLogEntry, 'entry_type'> {
  entry_type?: undefined;
}

export type SessionLogEntry =
  | SessionTurnLogEntry
  | SessionRuntimeLogEntry
  | SessionSubAgentEventLogEntry
  | SessionPromptTraceLogEntry
  | SessionTranscriptLogEntry;
export type ParsedSessionLogEntry = SessionLogEntry | LegacySessionTurnLogEntry;

export interface SessionLogParseIssue {
  line: number;
  kind: 'invalid_json' | 'invalid_entry';
}

/** Strict by default; local retrieval may recover valid lines with explicit diagnostics. */
export function parseSessionLogContent(
  content: string,
  options: { tolerant?: boolean; onIssue?: (issue: SessionLogParseIssue) => void } = {},
): ParsedSessionLogEntry[] {
  const entries: ParsedSessionLogEntry[] = [];
  content.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (!options.tolerant) throw error;
      options.onIssue?.({ line: index + 1, kind: 'invalid_json' });
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      if (!options.tolerant) throw new Error(`Invalid session log entry at line ${index + 1}`);
      options.onIssue?.({ line: index + 1, kind: 'invalid_entry' });
      return;
    }
    entries.push(value as ParsedSessionLogEntry);
  });
  return entries;
}

export function readSessionLogFile(filePath: string, options: Parameters<typeof parseSessionLogContent>[1] = {}): ParsedSessionLogEntry[] {
  return parseSessionLogContent(fs.readFileSync(filePath, 'utf-8'), options);
}

export function isSessionTurnEntry(entry: ParsedSessionLogEntry): entry is SessionTurnLogEntry | LegacySessionTurnLogEntry {
  if (entry.entry_type === 'turn') return hasSessionTurnShape(entry);
  if (entry.entry_type !== undefined) return false;
  return hasSessionTurnShape(entry);
}

function hasSessionTurnShape(entry: ParsedSessionLogEntry): entry is SessionTurnLogEntry | LegacySessionTurnLogEntry {
  const candidate = entry as Partial<SessionTurnLogEntry>;
  return typeof candidate.turn === 'number'
    && typeof candidate.timestamp === 'string'
    && typeof candidate.session_id === 'string'
    && typeof candidate.session_type === 'string'
    && typeof candidate.user?.text === 'string'
    && typeof candidate.assistant?.text === 'string'
    && Array.isArray(candidate.assistant?.tool_calls)
    && typeof candidate.tokens?.prompt === 'number'
    && typeof candidate.tokens?.completion === 'number';
}

export function getSessionIdFromEntry(entry: ParsedSessionLogEntry): string | undefined {
  return typeof entry.session_id === 'string' && entry.session_id.trim()
    ? entry.session_id
    : undefined;
}

export function resolveSessionIdFromEntries(
  entries: ParsedSessionLogEntry[],
  fallbackSessionId: string,
): string {
  for (const entry of entries) {
    const sessionId = getSessionIdFromEntry(entry);
    if (sessionId) return sessionId;
  }
  return fallbackSessionId;
}

export function readSessionIdFromJsonl(filePath: string): string | undefined {
  try {
    const firstLine = fs.readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean);
    if (!firstLine) return undefined;
    return getSessionIdFromEntry(JSON.parse(firstLine));
  } catch {
    return undefined;
  }
}
