import * as fs from 'fs';

export interface SessionToolCallLog {
  id: string;
  name: string;
  arguments: any;
  result: string;
  duration_ms?: number;
}

export interface SessionTurnLogEntry {
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
}

export interface SessionRuntimeLogEntry {
  entry_type: 'runtime';
  timestamp: string;
  session_id: string;
  session_type: string;
  level: string;
  message: string;
}

export interface SessionSubAgentEventLogEntry {
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

export interface LegacySessionTurnLogEntry extends Omit<SessionTurnLogEntry, 'entry_type'> {
  entry_type?: undefined;
}

export type SessionLogEntry = SessionTurnLogEntry | SessionRuntimeLogEntry | SessionSubAgentEventLogEntry;
export type ParsedSessionLogEntry = SessionLogEntry | LegacySessionTurnLogEntry;

export function parseSessionLogContent(content: string): ParsedSessionLogEntry[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

export function readSessionLogFile(filePath: string): ParsedSessionLogEntry[] {
  return parseSessionLogContent(fs.readFileSync(filePath, 'utf-8'));
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
