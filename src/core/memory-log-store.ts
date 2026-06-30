import * as fs from 'fs';
import * as path from 'path';
import type { SessionToolCallLog, SessionTurnLogEntry } from '../utils/session-log-schema';
import { stripAssistantTranscriptArtifacts } from '../utils/transcript-artifacts';

export interface MemorySearchMatch {
  ref: string;
  hits: string[];
  timestamp: string;
}

export interface MemoryTurnRecord {
  ref: string;
  entry: SessionTurnLogEntry;
  ordinal: number;
  filePath: string;
}

export interface MemorySearchParams {
  keywords: string[];
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export interface ReadMemoryTurnOptions {
  budgetChars?: number;
}

export interface MemoryReadResult {
  ref: string;
  text: string;
  truncated?: boolean;
}

export interface MemoryNeighborsResult {
  turns: MemoryReadResult[];
  omitted?: number;
}

interface LogRoot {
  root: string;
}

interface ParsedRef {
  sessionType: string;
  date: string;
  fileName: string;
  ordinal: number;
}

const DEFAULT_SEARCH_LIMIT = 80;
const MAX_SEARCH_LIMIT = 120;
const DEFAULT_READ_BUDGET_CHARS = 12_000;
const MAX_READ_BUDGET_CHARS = 40_000;
const DEFAULT_NEIGHBORS_BUDGET_CHARS = 20_000;
const MAX_NEIGHBORS_BUDGET_CHARS = 60_000;

export class MemoryLogStore {
  private readonly roots: LogRoot[];

  constructor(private readonly workingDirectory: string) {
    this.roots = resolveLogRoots(workingDirectory).map(root => ({ root }));
  }

  hasRoots(): boolean {
    return this.roots.length > 0;
  }

  async search(params: MemorySearchParams, signal?: AbortSignal): Promise<MemorySearchMatch[]> {
    const keywords = normalizeKeywords(params.keywords);
    if (keywords.length === 0) {
      throw createToolInputError('keywords must contain at least one non-empty string');
    }

    const start = parseTimeBoundary(params.startTime, 'start');
    const end = parseTimeBoundary(params.endTime, 'end');
    if (start !== null && end !== null && start > end) {
      throw createToolInputError('start_time must be earlier than or equal to end_time');
    }

    const limit = clampPositiveInteger(params.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const matches: MemorySearchMatch[] = [];
    for (const root of this.roots) {
      throwIfAborted(signal);
      const files = await collectJsonlFiles(root.root, signal);
      for (const file of files) {
        throwIfAborted(signal);
        const records = await this.readTurnsFromFile(root.root, file, signal);
        for (const record of records) {
          throwIfAborted(signal);
          const timestampMs = timestampForRecord(record);
          if (start !== null && timestampMs < start) continue;
          if (end !== null && timestampMs > end) continue;

          const text = searchableText(record.entry);
          const lower = text.toLowerCase();
          const hits = keywords.filter(keyword => lower.includes(keyword.toLowerCase()));
          if (hits.length === 0) continue;
          matches.push({
            ref: record.ref,
            hits,
            timestamp: timestampForSort(record),
          });
        }
      }
    }

    return matches
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.ref.localeCompare(a.ref))
      .slice(0, limit)
      .map(({ ref, hits }) => ({ ref, hits, timestamp: '' }));
  }

  async readTurn(ref: string, options: ReadMemoryTurnOptions = {}, signal?: AbortSignal): Promise<MemoryReadResult> {
    const record = await this.resolveRef(ref, signal);
    return formatTurnRecord(record, clampPositiveInteger(
      options.budgetChars,
      DEFAULT_READ_BUDGET_CHARS,
      MAX_READ_BUDGET_CHARS,
    ));
  }

  async readNeighbors(
    ref: string,
    options: { previous?: number; next?: number; budgetChars?: number } = {},
    signal?: AbortSignal,
  ): Promise<MemoryNeighborsResult> {
    const parsed = parseCanonicalRef(ref);
    const filePath = this.resolveFilePath(parsed);
    const root = this.rootForFile(filePath);
    const records = await this.readTurnsFromFile(root, filePath, signal);
    const targetIndex = records.findIndex(record => record.ordinal === parsed.ordinal);
    if (targetIndex < 0) {
      throw createToolInputError(`memory ref not found: ${ref}`);
    }

    const previous = clampNonNegativeInteger(options.previous, 1, 20);
    const next = clampNonNegativeInteger(options.next, 1, 20);
    const totalBudget = clampPositiveInteger(
      options.budgetChars,
      DEFAULT_NEIGHBORS_BUDGET_CHARS,
      MAX_NEIGHBORS_BUDGET_CHARS,
    );
    const selected = records.slice(
      Math.max(0, targetIndex - previous),
      Math.min(records.length, targetIndex + next + 1),
    );

    const included = new Map<number, MemoryReadResult>();
    let used = 0;
    let omitted = 0;

    const target = records[targetIndex];
    const targetResult = formatTurnRecord(target, totalBudget);
    included.set(target.ordinal, targetResult);
    used += targetResult.text.length;

    const candidates = selected
      .filter(record => record.ordinal !== target.ordinal)
      .sort((a, b) => Math.abs(a.ordinal - target.ordinal) - Math.abs(b.ordinal - target.ordinal));

    for (const record of candidates) {
      const full = formatTurnRecord(record, MAX_READ_BUDGET_CHARS);
      if (used + full.text.length > totalBudget) {
        omitted++;
        continue;
      }
      included.set(record.ordinal, full);
      used += full.text.length;
    }

    const turns = selected
      .filter(record => included.has(record.ordinal))
      .map(record => included.get(record.ordinal)!);
    return {
      turns,
      ...(omitted > 0 && { omitted }),
    };
  }

  private async resolveRef(ref: string, signal?: AbortSignal): Promise<MemoryTurnRecord> {
    const parsed = parseCanonicalRef(ref);
    const filePath = this.resolveFilePath(parsed);
    const root = this.rootForFile(filePath);
    const records = await this.readTurnsFromFile(root, filePath, signal);
    const record = records.find(item => item.ordinal === parsed.ordinal);
    if (!record) {
      throw createToolInputError(`memory ref not found: ${ref}`);
    }
    return record;
  }

  private resolveFilePath(ref: ParsedRef): string {
    for (const root of this.roots) {
      const candidate = path.resolve(root.root, ref.sessionType, ref.date, ref.fileName);
      if (isSameOrInside(root.root, candidate) && fs.existsSync(candidate)) {
        return candidate;
      }
    }
    throw createToolInputError(`memory file not found for ref: ${formatRef(ref)}`);
  }

  private rootForFile(filePath: string): string {
    const root = this.roots.find(candidate => isSameOrInside(candidate.root, filePath));
    if (!root) {
      throw createToolInputError(`memory file is outside configured roots: ${filePath}`);
    }
    return root.root;
  }

  private async readTurnsFromFile(root: string, filePath: string, signal?: AbortSignal): Promise<MemoryTurnRecord[]> {
    throwIfAborted(signal);
    let content = '';
    try {
      content = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      return [];
    }

    const relative = path.relative(root, filePath).replace(/\\/g, '/');
    const parts = relative.split('/');
    if (parts.length !== 3) return [];
    const [sessionType, date, fileName] = parts;
    const records: MemoryTurnRecord[] = [];
    let ordinal = 0;
    for (const line of content.split(/\r?\n/)) {
      throwIfAborted(signal);
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed?.entry_type !== 'turn') continue;
      if (!hasTurnShape(parsed)) continue;
      ordinal++;
      records.push({
        ref: `${sessionType}/${date}/${fileName}#${ordinal}`,
        entry: parsed,
        ordinal,
        filePath,
      });
    }
    return records;
  }
}

export function jsonToolResult(value: unknown): string {
  return JSON.stringify(value);
}

export function jsonToolError(message: string): string {
  return JSON.stringify({ error: message });
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const text = String(item || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result.slice(0, 32);
}

function resolveLogRoots(workingDirectory: string): string[] {
  const roots = [
    path.resolve(workingDirectory, 'logs', 'sessions'),
    path.resolve(process.cwd(), 'logs', 'sessions'),
  ];
  return Array.from(new Set(roots)).filter(root => {
    try {
      return fs.existsSync(root) && fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

async function collectJsonlFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const files: Array<{ file: string; mtimeMs: number }> = [];
  await walk(root, files, signal);
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(item => item.file);
}

async function walk(dir: string, files: Array<{ file: string; mtimeMs: number }>, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    throwIfAborted(signal);
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files, signal);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    try {
      const stat = await fs.promises.stat(fullPath);
      files.push({ file: fullPath, mtimeMs: stat.mtimeMs });
    } catch {
      // ignore unreadable files
    }
  }
}

function parseCanonicalRef(ref: string): ParsedRef {
  const match = String(ref || '').trim().match(/^([^/\\#]+)\/(\d{4}-\d{2}-\d{2})\/([^/\\#]+\.jsonl)#(\d+)$/);
  if (!match) {
    throw createToolInputError('ref must look like <session_type>/<yyyy-mm-dd>/<jsonl-file-name>#<episodeOrdinal>');
  }
  const ordinal = Number(match[4]);
  if (!Number.isInteger(ordinal) || ordinal <= 0) {
    throw createToolInputError('ref episode ordinal must be a positive integer');
  }
  return {
    sessionType: match[1],
    date: match[2],
    fileName: match[3],
    ordinal,
  };
}

function formatRef(ref: ParsedRef): string {
  return `${ref.sessionType}/${ref.date}/${ref.fileName}#${ref.ordinal}`;
}

function searchableText(entry: SessionTurnLogEntry): string {
  return [
    entry.user?.text || '',
    stripAssistantTranscriptArtifacts(entry.assistant?.text || ''),
    ...(entry.assistant?.tool_calls || []).flatMap(toolCall => [
      toolCall.name || '',
      normalizeToolArgument(toolCall.arguments),
      toolCall.result || '',
    ]),
  ].join('\n');
}

function normalizeToolArgument(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value || '');
  }
}

function formatTurnRecord(record: MemoryTurnRecord, budgetChars: number): MemoryReadResult {
  const builder = new BudgetTextBuilder(budgetChars);
  builder.appendLine(`REF: ${record.ref}`);
  builder.appendSection('USER', record.entry.user?.text || '');
  builder.appendSection(
    'ASSISTANT_FINAL',
    stripAssistantTranscriptArtifacts(record.entry.assistant?.text || ''),
  );
  builder.appendSection('TOOL_CALLS_AND_RESULTS', formatToolCalls(record.entry.assistant?.tool_calls || []));
  return {
    ref: record.ref,
    text: builder.toString(),
    ...(builder.truncated && { truncated: true }),
  };
}

function formatToolCalls(toolCalls: SessionToolCallLog[]): string {
  if (!toolCalls.length) return '(none)';
  return toolCalls.map((toolCall, index) => [
    `#${index + 1} ${toolCall.name}`,
    'arguments:',
    normalizeToolArgument(toolCall.arguments),
    'result:',
    toolCall.result || '',
  ].join('\n')).join('\n\n');
}

class BudgetTextBuilder {
  private readonly parts: string[] = [];
  truncated = false;

  constructor(private remaining: number) {}

  appendLine(line: string): void {
    this.append(`${line}\n`);
  }

  appendSection(label: string, text: string): void {
    this.append(`\n${label}:\n`);
    this.append(String(text || ''));
    this.append('\n');
  }

  append(value: string): void {
    if (this.remaining <= 0) {
      this.truncated = true;
      return;
    }
    if (value.length <= this.remaining) {
      this.parts.push(value);
      this.remaining -= value.length;
      return;
    }
    const marker = `\n...[truncated field, original ${value.length} chars]\n`;
    const keep = Math.max(0, this.remaining - marker.length);
    this.parts.push(value.slice(0, keep));
    this.parts.push(marker);
    this.remaining = 0;
    this.truncated = true;
  }

  toString(): string {
    return this.parts.join('').trimEnd();
  }
}

function timestampForRecord(record: MemoryTurnRecord): number {
  const fromEntry = Date.parse(record.entry.timestamp || '');
  if (Number.isFinite(fromEntry)) return fromEntry;
  const parsed = parseCanonicalRef(record.ref);
  const fromPath = Date.parse(`${parsed.date}T12:00:00.000Z`);
  return Number.isFinite(fromPath) ? fromPath : 0;
}

function timestampForSort(record: MemoryTurnRecord): string {
  const ms = timestampForRecord(record);
  if (ms > 0) return new Date(ms).toISOString();
  return '';
}

function parseTimeBoundary(value: string | undefined, mode: 'start' | 'end'): number | null {
  const text = String(value || '').trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T${mode === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`
    : text;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw createToolInputError(`${mode}_time is not a valid date/time`);
  }
  return parsed;
}

function clampPositiveInteger(value: unknown, defaultValue: number, maxValue: number): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, maxValue);
}

function clampNonNegativeInteger(value: unknown, defaultValue: number, maxValue: number): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return defaultValue;
  return Math.min(parsed, maxValue);
}

function hasTurnShape(value: any): value is SessionTurnLogEntry {
  return value?.entry_type === 'turn'
    && typeof value.timestamp === 'string'
    && typeof value.session_id === 'string'
    && typeof value.session_type === 'string'
    && typeof value.user?.text === 'string'
    && typeof value.assistant?.text === 'string'
    && Array.isArray(value.assistant?.tool_calls);
}

function createToolInputError(message: string): Error {
  const error = new Error(message);
  (error as any).errorCode = 'INVALID_TOOL_ARGUMENTS';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('memory search aborted');
    error.name = 'AbortError';
    throw error;
  }
}

function isSameOrInside(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const relative = path.relative(resolvedParent, resolvedChild);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
