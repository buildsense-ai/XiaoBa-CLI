import { createHash } from 'crypto';
import { Message } from '../types';
import { estimateTokens } from './token-estimator';
import {
  persistToolResultArtifact,
  ToolResultArtifactStoreOptions,
} from './tool-result-artifact-store';

export const TRUNCATED_READ_FILE_PREFIX = '[truncated_read_file]';
export const FOLDED_READ_FILE_PREFIX = TRUNCATED_READ_FILE_PREFIX;
const LEGACY_FOLDED_READ_FILE_PREFIX = '[folded_read_file]';

export interface ReadFileMessageFoldingOptions {
  enabled: boolean;
  thresholdTokens: number;
  maxPreviewLines: number;
  maxSymbolLines: number;
  keepRecentHistoricalReads: number;
  foldCurrentRun: boolean;
  protectedCurrentRunToolResultIndexes?: ReadonlySet<number>;
  artifactStore?: Partial<ToolResultArtifactStoreOptions>;
}

export interface ReadFileMessageFoldingStats {
  enabled: boolean;
  candidate_count: number;
  current_turn_candidate_count: number;
  folded_count: number;
  folded_current_turn_count: number;
  skipped_recent_count: number;
  skipped_current_turn_count: number;
  protected_current_turn_count: number;
  raw_tokens_est: number;
  folded_tokens_est: number;
  saved_tokens_est: number;
  threshold_tokens: number;
  keep_recent_historical_reads: number;
}

export interface ReadFileMessageFoldingResult {
  messages: Message[];
  stats: ReadFileMessageFoldingStats;
}

interface FoldCandidate {
  index: number;
  message: Message;
  rawText: string;
  rawTokens: number;
  currentRun: boolean;
  toolCall?: NonNullable<Message['tool_calls']>[number];
}

const DEFAULT_OPTIONS: ReadFileMessageFoldingOptions = {
  enabled: true,
  thresholdTokens: 2000,
  maxPreviewLines: 8,
  maxSymbolLines: 18,
  keepRecentHistoricalReads: 0,
  foldCurrentRun: false,
};

export function resolveReadFileMessageFoldingOptions(
  env: NodeJS.ProcessEnv = process.env,
): ReadFileMessageFoldingOptions {
  return {
    enabled: readBooleanEnv(env.XIAOBA_READ_FILE_MESSAGE_FOLDING, DEFAULT_OPTIONS.enabled),
    thresholdTokens: readPositiveIntegerEnv(
      env.XIAOBA_READ_FILE_FOLD_THRESHOLD_TOKENS,
      DEFAULT_OPTIONS.thresholdTokens,
    ),
    maxPreviewLines: readPositiveIntegerEnv(
      env.XIAOBA_READ_FILE_FOLD_PREVIEW_LINES,
      DEFAULT_OPTIONS.maxPreviewLines,
    ),
    maxSymbolLines: readPositiveIntegerEnv(
      env.XIAOBA_READ_FILE_FOLD_SYMBOL_LINES,
      DEFAULT_OPTIONS.maxSymbolLines,
    ),
    keepRecentHistoricalReads: readNonNegativeIntegerEnv(
      env.XIAOBA_READ_FILE_FOLD_KEEP_RECENT,
      DEFAULT_OPTIONS.keepRecentHistoricalReads,
    ),
    foldCurrentRun: DEFAULT_OPTIONS.foldCurrentRun,
  };
}

export function foldHistoricalReadFileMessages(
  messages: Message[],
  options: Partial<ReadFileMessageFoldingOptions> = {},
): ReadFileMessageFoldingResult {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const baseStats = emptyStats(resolved);
  if (!resolved.enabled || messages.length === 0) {
    return { messages, stats: baseStats };
  }

  const lastUserIndex = findLastRealUserIndex(messages);
  if (lastUserIndex < 0) {
    return { messages, stats: baseStats };
  }

  const toolCallsById = collectToolCallsById(messages);
  const candidates: FoldCandidate[] = [];
  let skippedCurrentTurnCount = 0;
  let protectedCurrentTurnCount = 0;

  messages.forEach((message, index) => {
    if (!isReadFileToolResult(message)) return;
    const currentRun = index > lastUserIndex;
    if (currentRun && !resolved.foldCurrentRun) {
      skippedCurrentTurnCount++;
      return;
    }
    if (currentRun && resolved.protectedCurrentRunToolResultIndexes?.has(index)) {
      skippedCurrentTurnCount++;
      protectedCurrentTurnCount++;
      return;
    }

    const rawText = typeof message.content === 'string' ? message.content : '';
    if (!rawText || isAlreadyTruncated(rawText)) return;

    const rawTokens = estimateTokens(rawText);
    if (rawTokens < resolved.thresholdTokens) return;

    const toolCall = message.tool_call_id
      ? toolCallsById.get(message.tool_call_id)
      : undefined;
    candidates.push({ index, message, rawText, rawTokens, currentRun, toolCall });
  });

  const stats = emptyStats(resolved);
  stats.candidate_count = candidates.length;
  stats.current_turn_candidate_count = candidates.filter(candidate => candidate.currentRun).length;
  stats.skipped_current_turn_count = skippedCurrentTurnCount;
  stats.protected_current_turn_count = protectedCurrentTurnCount;

  if (candidates.length === 0) {
    return { messages, stats };
  }

  const historicalCandidates = candidates.filter(candidate => !candidate.currentRun);
  const currentRunCandidates = candidates.filter(candidate => candidate.currentRun);
  const keepRecent = Math.min(resolved.keepRecentHistoricalReads, historicalCandidates.length);
  const candidatesToFold = [
    ...historicalCandidates.slice(0, historicalCandidates.length - keepRecent),
    ...currentRunCandidates,
  ];
  stats.skipped_recent_count = keepRecent;

  if (candidatesToFold.length === 0) {
    return { messages, stats };
  }

  const foldedByIndex = new Map<number, string>();
  for (const candidate of candidatesToFold) {
    const folded = buildFoldedReadFileContent(candidate, resolved);
    foldedByIndex.set(candidate.index, folded);
    stats.folded_count++;
    if (candidate.currentRun) stats.folded_current_turn_count++;
    stats.raw_tokens_est += candidate.rawTokens;
    stats.folded_tokens_est += estimateTokens(folded);
  }
  stats.saved_tokens_est = Math.max(0, stats.raw_tokens_est - stats.folded_tokens_est);

  const foldedMessages = messages.map((message, index) => {
    const folded = foldedByIndex.get(index);
    if (!folded) return message;
    return {
      ...message,
      content: folded,
    };
  });

  return { messages: foldedMessages, stats };
}

function emptyStats(options: ReadFileMessageFoldingOptions): ReadFileMessageFoldingStats {
  return {
    enabled: options.enabled,
    candidate_count: 0,
    current_turn_candidate_count: 0,
    folded_count: 0,
    folded_current_turn_count: 0,
    skipped_recent_count: 0,
    skipped_current_turn_count: 0,
    protected_current_turn_count: 0,
    raw_tokens_est: 0,
    folded_tokens_est: 0,
    saved_tokens_est: 0,
    threshold_tokens: options.thresholdTokens,
    keep_recent_historical_reads: options.keepRecentHistoricalReads,
  };
}

function buildFoldedReadFileContent(
  candidate: FoldCandidate,
  options: ReadFileMessageFoldingOptions,
): string {
  const metadata = extractReadFileMetadata(candidate.rawText, candidate.toolCall);
  const lines = extractNumberedLines(candidate.rawText);
  const previewLines = selectPreviewLines(lines, options.maxPreviewLines);
  const symbolLines = selectSymbolLines(lines, options.maxSymbolLines);
  const hash = createHash('sha256')
    .update(metadata.path || '')
    .update('\0')
    .update(candidate.rawText)
    .digest('hex');
  const artifact = persistToolResultArtifact({
    artifactId: `rf_${hash.slice(0, 16)}`,
    toolName: 'read_file',
    toolCallId: candidate.message.tool_call_id,
    sha256: hash,
    rawText: candidate.rawText,
    store: options.artifactStore,
  });
  const foldedParts = [
    TRUNCATED_READ_FILE_PREFIX,
    `artifact_id: ${artifact.artifactId}`,
    artifact.ref ? `full_output_ref: ${artifact.ref}` : '',
    artifact.filePath ? `full_output_path: ${artifact.filePath}` : '',
    artifact.fileUri ? `full_output_link: ${artifact.fileUri}` : '',
    artifact.writeError ? `full_output_store_error: ${oneLine(artifact.writeError, 300)}` : '',
    metadata.file ? `file: ${metadata.file}` : '',
    metadata.path ? `path: ${metadata.path}` : '',
    metadata.display ? `range: ${metadata.display}` : '',
    metadata.totalLines ? `total_lines: ${metadata.totalLines}` : '',
    `original_chars: ${candidate.rawText.length}`,
    `original_tokens_est: ${candidate.rawTokens}`,
    `sha256: ${hash}`,
    '',
    'summary: Historical read_file output was truncated out of the provider prompt. Use full_output_path/full_output_ref or re-read this file/range before exact edits or quoting.',
    previewLines.length > 0 ? ['preview:', ...previewLines.map(line => `  ${line}`)].join('\n') : '',
    symbolLines.length > 0 ? ['key_symbols:', ...symbolLines.map(line => `  ${line}`)].join('\n') : '',
  ];

  return foldedParts.filter(part => part !== '').join('\n');
}

function extractReadFileMetadata(
  rawText: string,
  toolCall?: NonNullable<Message['tool_calls']>[number],
): {
  file?: string;
  path?: string;
  display?: string;
  totalLines?: string;
} {
  const args = parseToolArguments(toolCall);
  return {
    file: firstNonEmpty(readHeader(rawText, '文件'), readHeader(rawText, 'File'), stringArg(args, 'file_path'), stringArg(args, 'path')),
    path: firstNonEmpty(readHeader(rawText, 'Path'), stringArg(args, 'file_path'), stringArg(args, 'path')),
    display: firstNonEmpty(readHeader(rawText, '显示'), buildDisplayFromArgs(args)),
    totalLines: readHeader(rawText, '总行数'),
  };
}

function collectToolCallsById(messages: Message[]): Map<string, NonNullable<Message['tool_calls']>[number]> {
  const result = new Map<string, NonNullable<Message['tool_calls']>[number]>();
  for (const message of messages) {
    for (const toolCall of message.tool_calls || []) {
      result.set(toolCall.id, toolCall);
    }
  }
  return result;
}

function isReadFileToolResult(message: Message): boolean {
  if (message.role !== 'tool') return false;
  if (Array.isArray(message.content)) return false;
  return normalizeToolName(message.name || '') === 'read_file';
}

function normalizeToolName(name: string): string {
  const normalized = String(name || '').trim();
  if (normalized === 'Read') return 'read_file';
  return normalized;
}

function isAlreadyTruncated(rawText: string): boolean {
  return rawText.startsWith(TRUNCATED_READ_FILE_PREFIX)
    || rawText.startsWith(LEGACY_FOLDED_READ_FILE_PREFIX);
}

function findLastRealUserIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    if (message.__injected) continue;
    if (typeof message.content === 'string' && message.content.startsWith('[transient_')) continue;
    return i;
  }
  return -1;
}

function extractNumberedLines(rawText: string): string[] {
  return rawText
    .split(/\r?\n/)
    .filter(line => /^\s*\d+\s*→\s?/.test(line))
    .map(line => line.trim());
}

function selectPreviewLines(lines: string[], maxPreviewLines: number): string[] {
  if (lines.length <= maxPreviewLines * 2) return lines;
  return [
    ...lines.slice(0, maxPreviewLines),
    '...',
    ...lines.slice(-maxPreviewLines),
  ];
}

function selectSymbolLines(lines: string[], maxSymbolLines: number): string[] {
  const symbolPattern = /\b(export\s+)?(class|interface|type|enum|function|const|let|var|def|async\s+function)\b|^\s*\d+\s*→\s*(public|private|protected)\s+/;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    if (!symbolPattern.test(line)) continue;
    const compact = line.replace(/\s+/g, ' ').trim();
    if (seen.has(compact)) continue;
    seen.add(compact);
    result.push(compact);
    if (result.length >= maxSymbolLines) break;
  }
  return result;
}

function readHeader(rawText: string, label: string): string | undefined {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = rawText.match(new RegExp(`^${escapedLabel}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() || undefined;
}

function parseToolArguments(toolCall?: NonNullable<Message['tool_calls']>[number]): Record<string, unknown> {
  if (!toolCall?.function?.arguments) return {};
  try {
    const parsed = JSON.parse(toolCall.function.arguments);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function buildDisplayFromArgs(args: Record<string, unknown>): string | undefined {
  const offset = Number(args.offset);
  const limit = Number(args.limit);
  if (!Number.isFinite(offset) || offset <= 0) return undefined;
  if (!Number.isFinite(limit) || limit <= 0) return `${Math.floor(offset)}-?`;
  return `${Math.floor(offset)}-${Math.floor(offset + limit - 1)}`;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find(value => Boolean(value && value.trim()));
}

function oneLine(value: string, maxLength: number): string {
  const trimmed = value.replace(/\r?\n/g, ' ; ').trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 20)}...(truncated ${trimmed.length} chars)`;
}

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return fallback;
}

function readPositiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
