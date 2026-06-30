import * as fs from 'fs';
import * as path from 'path';
import {
  ParsedSessionLogEntry,
  isSessionTurnEntry,
  readSessionLogFile,
  resolveSessionIdFromEntries,
} from '../utils/session-log-schema';

export interface SessionLogSummary {
  fileId: string;
  sessionId: string;
  sessionType: string;
  relativePath: string;
  updatedAt: string;
  lastTimestamp?: string;
  bytes: number;
  turns: number;
  toolCalls: number;
  failures: number;
  runtimeErrors: number;
  runtimeWarnings: number;
  subagentEvents: number;
}

export interface SessionLogDetail {
  session: SessionLogSummary;
  entries: ParsedSessionLogEntry[];
}

export interface ListRecentSessionLogsOptions {
  root?: string;
  days?: number;
  type?: string;
  limit?: number;
  maxScanned?: number;
}

export function resolveSessionLogsRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const userData = String(env.XIAOBA_ELECTRON_USER_DATA_DIR || env.XIAOBA_USER_DATA_DIR || env.CATSCO_USER_DATA_DIR || '').trim();
  if (userData) return path.join(path.resolve(userData), 'logs', 'sessions');
  return path.resolve(cwd, 'logs', 'sessions');
}

export function listRecentSessionLogs(options: ListRecentSessionLogsOptions = {}): SessionLogSummary[] {
  const root = path.resolve(options.root || resolveSessionLogsRoot());
  const days = clampInteger(options.days, 7, 1, 90);
  const limit = clampInteger(options.limit, 50, 1, 200);
  const maxScanned = clampInteger(options.maxScanned, Math.max(256, limit * 8), 1, 4096);
  const type = normalizeType(options.type);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  if (!fs.existsSync(root)) return [];

  return walkJsonlFiles(root, maxScanned)
    .map(filePath => summarizeSessionLog(root, filePath))
    .filter((summary): summary is SessionLogSummary => Boolean(summary))
    .filter(summary => Date.parse(summary.updatedAt) >= since)
    .filter(summary => type === 'all' || summary.sessionType === type)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit);
}

export function readSessionLogByFileId(fileId: string, root = resolveSessionLogsRoot()): SessionLogDetail | null {
  const resolvedRoot = path.resolve(root);
  const relativePath = decodeFileId(fileId);
  if (!relativePath) return null;
  const filePath = path.resolve(resolvedRoot, relativePath);
  if (!isPathInside(resolvedRoot, filePath) || path.extname(filePath).toLowerCase() !== '.jsonl') return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const session = summarizeSessionLog(resolvedRoot, filePath);
  if (!session) return null;
  return {
    session,
    entries: safeReadSessionLogFile(filePath),
  };
}

function summarizeSessionLog(root: string, filePath: string): SessionLogSummary | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const entries = safeReadSessionLogFile(filePath);
    const relativePath = normalizeRelativePath(path.relative(root, filePath));
    const fallbackSessionId = path.basename(filePath, path.extname(filePath));
    const sessionId = resolveSessionIdFromEntries(entries, fallbackSessionId);
    const sessionType = resolveSessionType(entries, relativePath);
    const counts = countEntries(entries);
    const lastTimestamp = latestEntryTimestamp(entries);
    return {
      fileId: encodeFileId(relativePath),
      sessionId,
      sessionType,
      relativePath,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      ...(lastTimestamp ? { lastTimestamp } : {}),
      bytes: stat.size,
      ...counts,
    };
  } catch (_error) {
    return null;
  }
}

function safeReadSessionLogFile(filePath: string): ParsedSessionLogEntry[] {
  try {
    return readSessionLogFile(filePath);
  } catch (_error) {
    return [];
  }
}

function countEntries(entries: ParsedSessionLogEntry[]): Omit<SessionLogSummary, 'fileId' | 'sessionId' | 'sessionType' | 'relativePath' | 'updatedAt' | 'lastTimestamp' | 'bytes'> {
  let turns = 0;
  let toolCalls = 0;
  let failures = 0;
  let runtimeErrors = 0;
  let runtimeWarnings = 0;
  let subagentEvents = 0;

  for (const entry of entries) {
    if (isSessionTurnEntry(entry)) {
      turns += 1;
      toolCalls += entry.assistant.tool_calls.length;
      let turnFailed = looksLikeFailure(entry.assistant.text);
      for (const toolCall of entry.assistant.tool_calls) {
        if (looksLikeFailure(String(toolCall.result || ''))) turnFailed = true;
      }
      if (turnFailed) failures += 1;
      continue;
    }
    if (entry.entry_type === 'runtime') {
      const level = String(entry.level || '').toLowerCase();
      if (level === 'error' || looksLikeFailure(entry.message)) runtimeErrors += 1;
      else if (level === 'warn' || level === 'warning') runtimeWarnings += 1;
      continue;
    }
    if (entry.entry_type === 'subagent_event') {
      subagentEvents += 1;
    }
  }

  return {
    turns,
    toolCalls,
    failures,
    runtimeErrors,
    runtimeWarnings,
    subagentEvents,
  };
}

function resolveSessionType(entries: ParsedSessionLogEntry[], relativePath: string): string {
  for (const entry of entries) {
    const type = String((entry as any).session_type || '').trim();
    if (type) return normalizeType(type);
  }
  const [firstSegment] = relativePath.split('/');
  return normalizeType(firstSegment);
}

function latestEntryTimestamp(entries: ParsedSessionLogEntry[]): string | undefined {
  let latest = 0;
  for (const entry of entries) {
    const timestamp = String((entry as any).timestamp || '');
    const time = Date.parse(timestamp);
    if (Number.isFinite(time) && time > latest) latest = time;
  }
  return latest > 0 ? new Date(latest).toISOString() : undefined;
}

function walkJsonlFiles(root: string, maxFiles: number): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    if (files.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.jsonl') files.push(filePath);
    }
  };
  visit(root);
  return files;
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join('/');
}

function encodeFileId(relativePath: string): string {
  return Buffer.from(relativePath, 'utf8').toString('base64url');
}

function decodeFileId(fileId: string): string | null {
  const text = String(fileId || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const decoded = Buffer.from(text, 'base64url').toString('utf8');
    if (!decoded || path.isAbsolute(decoded)) return null;
    const parts = decoded.split(/[\\/]+/).filter(Boolean);
    if (!parts.length || parts.some(part => part === '..' || part === '.')) return null;
    return path.join(...parts);
  } catch (_error) {
    return null;
  }
}

function isPathInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeType(value: unknown): string {
  const text = String(value || 'all').trim().toLowerCase();
  return /^[a-z0-9_-]+$/.test(text) ? text : 'all';
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function looksLikeFailure(text: string): boolean {
  return /(error|failed|failure|exception|command not found|not recognized|rate limit|context|失败|错误|异常|找不到|未找到)/i.test(text || '');
}
