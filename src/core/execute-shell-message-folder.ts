import { createHash } from 'crypto';
import { Message } from '../types';
import { estimateTokens } from './token-estimator';
import {
  persistToolResultArtifact,
  ToolResultArtifactStoreOptions,
} from './tool-result-artifact-store';

export const TRUNCATED_EXECUTE_SHELL_PREFIX = '[truncated_execute_shell]';
export const FOLDED_EXECUTE_SHELL_PREFIX = TRUNCATED_EXECUTE_SHELL_PREFIX;
const LEGACY_FOLDED_EXECUTE_SHELL_PREFIX = '[folded_execute_shell]';

export interface ExecuteShellMessageFoldingOptions {
  enabled: boolean;
  thresholdTokens: number;
  maxHeadLines: number;
  maxTailLines: number;
  maxKeyLines: number;
  keepRecentHistoricalShells: number;
  foldCurrentRun: boolean;
  protectedCurrentRunToolResultIndexes?: ReadonlySet<number>;
  artifactStore?: Partial<ToolResultArtifactStoreOptions>;
}

export interface ExecuteShellMessageFoldingStats {
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
  keep_recent_historical_shells: number;
}

export interface ExecuteShellMessageFoldingResult {
  messages: Message[];
  stats: ExecuteShellMessageFoldingStats;
}

interface FoldCandidate {
  index: number;
  message: Message;
  rawText: string;
  rawTokens: number;
  currentRun: boolean;
  toolCall?: NonNullable<Message['tool_calls']>[number];
}

interface ShellMetadata {
  command?: string;
  description?: string;
  timeout?: number;
  cwd?: string;
  status?: 'succeeded' | 'failed' | 'unknown';
  elapsed?: string;
  outputLines?: string;
}

const DEFAULT_OPTIONS: ExecuteShellMessageFoldingOptions = {
  enabled: true,
  thresholdTokens: 2000,
  maxHeadLines: 12,
  maxTailLines: 24,
  maxKeyLines: 32,
  keepRecentHistoricalShells: 0,
  foldCurrentRun: false,
};

export function resolveExecuteShellMessageFoldingOptions(
  env: NodeJS.ProcessEnv = process.env,
): ExecuteShellMessageFoldingOptions {
  return {
    enabled: readBooleanEnv(env.XIAOBA_EXECUTE_SHELL_MESSAGE_FOLDING, DEFAULT_OPTIONS.enabled),
    thresholdTokens: readPositiveIntegerEnv(
      env.XIAOBA_EXECUTE_SHELL_FOLD_THRESHOLD_TOKENS,
      DEFAULT_OPTIONS.thresholdTokens,
    ),
    maxHeadLines: readPositiveIntegerEnv(
      env.XIAOBA_EXECUTE_SHELL_FOLD_HEAD_LINES,
      DEFAULT_OPTIONS.maxHeadLines,
    ),
    maxTailLines: readPositiveIntegerEnv(
      env.XIAOBA_EXECUTE_SHELL_FOLD_TAIL_LINES,
      DEFAULT_OPTIONS.maxTailLines,
    ),
    maxKeyLines: readPositiveIntegerEnv(
      env.XIAOBA_EXECUTE_SHELL_FOLD_KEY_LINES,
      DEFAULT_OPTIONS.maxKeyLines,
    ),
    keepRecentHistoricalShells: readNonNegativeIntegerEnv(
      env.XIAOBA_EXECUTE_SHELL_FOLD_KEEP_RECENT,
      DEFAULT_OPTIONS.keepRecentHistoricalShells,
    ),
    foldCurrentRun: DEFAULT_OPTIONS.foldCurrentRun,
  };
}

export function foldHistoricalExecuteShellMessages(
  messages: Message[],
  options: Partial<ExecuteShellMessageFoldingOptions> = {},
): ExecuteShellMessageFoldingResult {
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
    if (!isExecuteShellToolResult(message)) return;
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
  const keepRecent = Math.min(resolved.keepRecentHistoricalShells, historicalCandidates.length);
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
    const folded = buildFoldedExecuteShellContent(candidate, resolved);
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

function emptyStats(options: ExecuteShellMessageFoldingOptions): ExecuteShellMessageFoldingStats {
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
    keep_recent_historical_shells: options.keepRecentHistoricalShells,
  };
}

function buildFoldedExecuteShellContent(
  candidate: FoldCandidate,
  options: ExecuteShellMessageFoldingOptions,
): string {
  const metadata = extractShellMetadata(candidate.rawText, candidate.toolCall);
  const lines = candidate.rawText.split(/\r?\n/);
  const headLines = selectHeadLines(lines, options.maxHeadLines);
  const tailLines = selectTailLines(lines, options.maxTailLines, options.maxHeadLines);
  const keyLines = selectKeyLines(lines, options.maxKeyLines);
  const hash = createHash('sha256')
    .update(metadata.command || '')
    .update('\0')
    .update(candidate.rawText)
    .digest('hex');
  const artifact = persistToolResultArtifact({
    artifactId: `sh_${hash.slice(0, 16)}`,
    toolName: 'execute_shell',
    toolCallId: candidate.message.tool_call_id,
    sha256: hash,
    rawText: candidate.rawText,
    store: options.artifactStore,
  });

  const foldedParts = [
    TRUNCATED_EXECUTE_SHELL_PREFIX,
    `artifact_id: ${artifact.artifactId}`,
    artifact.ref ? `full_output_ref: ${artifact.ref}` : '',
    artifact.filePath ? `full_output_path: ${artifact.filePath}` : '',
    artifact.fileUri ? `full_output_link: ${artifact.fileUri}` : '',
    artifact.writeError ? `full_output_store_error: ${oneLine(artifact.writeError, 300)}` : '',
    metadata.command ? `command: ${oneLine(metadata.command, 1600)}` : '',
    metadata.description ? `description: ${oneLine(metadata.description, 400)}` : '',
    metadata.cwd ? `cwd: ${metadata.cwd}` : '',
    metadata.timeout ? `timeout_ms: ${metadata.timeout}` : '',
    metadata.status ? `status: ${metadata.status}` : '',
    metadata.elapsed ? `elapsed: ${metadata.elapsed}` : '',
    metadata.outputLines ? `output_lines: ${metadata.outputLines}` : '',
    `original_chars: ${candidate.rawText.length}`,
    `original_lines: ${lines.length}`,
    `original_tokens_est: ${candidate.rawTokens}`,
    `sha256: ${hash}`,
    '',
    'summary: Historical execute_shell output was truncated out of the provider prompt. Use full_output_path/full_output_ref, re-run the command, or inspect logs before relying on omitted lines.',
    headLines.length > 0 ? ['head:', ...headLines.map(line => `  ${line}`)].join('\n') : '',
    tailLines.length > 0 ? ['tail:', ...tailLines.map(line => `  ${line}`)].join('\n') : '',
    keyLines.length > 0 ? ['key_lines:', ...keyLines.map(line => `  ${line}`)].join('\n') : '',
  ];

  return foldedParts.filter(part => part !== '').join('\n');
}

function extractShellMetadata(
  rawText: string,
  toolCall?: NonNullable<Message['tool_calls']>[number],
): ShellMetadata {
  const args = parseToolArguments(toolCall);
  return {
    command: firstNonEmpty(stringArg(args, 'command'), readCommand(rawText)),
    description: stringArg(args, 'description'),
    timeout: numberArg(args, 'timeout'),
    cwd: firstNonEmpty(
      stringArg(args, 'cwd'),
      stringArg(args, 'workingDirectory'),
      readField(rawText, 'cwd'),
      readField(rawText, 'cwd_after'),
      readField(rawText, 'cwd_before'),
    ),
    status: readStatus(rawText),
    elapsed: firstNonEmpty(readHeader(rawText, 'Elapsed'), readDuration(rawText)),
    outputLines: firstNonEmpty(readHeader(rawText, 'Output lines'), readOutputLines(rawText)),
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

function isExecuteShellToolResult(message: Message): boolean {
  if (message.role !== 'tool') return false;
  if (Array.isArray(message.content)) return false;
  return normalizeToolName(message.name || '') === 'execute_shell';
}

function normalizeToolName(name: string): string {
  const normalized = String(name || '').trim();
  if (['Bash', 'bash', 'Shell', 'shell', 'execute_bash'].includes(normalized)) {
    return 'execute_shell';
  }
  return normalized;
}

function isAlreadyTruncated(rawText: string): boolean {
  return rawText.startsWith(TRUNCATED_EXECUTE_SHELL_PREFIX)
    || rawText.startsWith(LEGACY_FOLDED_EXECUTE_SHELL_PREFIX);
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

function selectHeadLines(lines: string[], maxHeadLines: number): string[] {
  return lines.slice(0, maxHeadLines).map(trimForFoldedOutput);
}

function selectTailLines(lines: string[], maxTailLines: number, headLineCount: number): string[] {
  if (lines.length <= headLineCount + maxTailLines) return [];
  return lines.slice(-maxTailLines).map(trimForFoldedOutput);
}

function selectKeyLines(lines: string[], maxKeyLines: number): string[] {
  const keyPattern = /\b(error|warn|warning|fail|failed|failure|exception|traceback|fatal|panic|timeout|timed out|denied|not found|cannot|can't|undefined|typeerror|assertionerror|npm err|exit code)\b|(^|\s)(ERR!|FAIL|ERROR|WARN)(\s|$)|([A-Za-z]:\\|\/)[^\s:]+:\d+/i;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    if (!keyPattern.test(line)) continue;
    const compact = trimForFoldedOutput(line);
    if (!compact || seen.has(compact)) continue;
    seen.add(compact);
    result.push(compact);
    if (result.length >= maxKeyLines) break;
  }
  return result;
}

function readCommand(rawText: string): string | undefined {
  const command = readField(rawText, 'command');
  if (command) return command;
  const lines = rawText.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('$ ')) return line.slice(2).trim() || undefined;
  }
  return undefined;
}

function readStatus(rawText: string): ShellMetadata['status'] {
  const status = readField(rawText, 'status');
  if (status === 'succeeded' || status === 'failed') return status;
  if (status === 'timed_out' || status === 'aborted') return 'failed';
  if (/^Command succeeded:/m.test(rawText)) return 'succeeded';
  if (/^Command failed:/m.test(rawText)) return 'failed';
  return 'unknown';
}

function readField(rawText: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = rawText.match(new RegExp(`^${escapedKey}:\\s*(.*)$`, 'm'));
  return match?.[1]?.trim() || undefined;
}

function readHeader(rawText: string, label: string): string | undefined {
  return readField(rawText, label);
}

function readDuration(rawText: string): string | undefined {
  const durationMs = readField(rawText, 'duration_ms');
  return durationMs ? `${durationMs}ms` : undefined;
}

function readOutputLines(rawText: string): string | undefined {
  const stdoutLines = Number(readField(rawText, 'stdout_lines'));
  const stderrLines = Number(readField(rawText, 'stderr_lines'));
  if (!Number.isFinite(stdoutLines) && !Number.isFinite(stderrLines)) return undefined;
  return String((Number.isFinite(stdoutLines) ? stdoutLines : 0)
    + (Number.isFinite(stderrLines) ? stderrLines : 0));
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

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = Number(args[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find(value => Boolean(value && value.trim()));
}

function oneLine(value: string, maxLength: number): string {
  return trimForFoldedOutput(value.replace(/\r?\n/g, ' ; '), maxLength);
}

function trimForFoldedOutput(line: string, maxLength = 500): string {
  const trimmed = line.replace(/\s+$/g, '');
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
