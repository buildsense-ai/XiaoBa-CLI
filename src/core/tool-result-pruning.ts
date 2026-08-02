import { createHash } from 'node:crypto';
import type { Message } from '../types';
import { annotateContextMessage, isTransientContextMessage } from './context-lifecycle';
import { estimateMessagesTokens } from './token-estimator';

export const TOOL_RESULT_PRUNED_PREFIX = '[tool_result_pruned]';

export interface ToolResultPruningOptions {
  phase: 'pre_turn' | 'mid_turn' | 'restore';
  countThreshold?: number;
  tokenThreshold?: number;
  targetCount?: number;
  targetTokens?: number;
  recentResultsToProtect?: number;
}

export interface ToolResultPruningResult {
  messages: Message[];
  pruned: boolean;
  prunedCount: number;
  rawCountBefore: number;
  rawCountAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  charsRemoved: number;
}

const DEFAULT_COUNT_THRESHOLD = 250;
const DEFAULT_TOKEN_THRESHOLD = 60_000;
const DEFAULT_TARGET_COUNT = 100;
const DEFAULT_TARGET_TOKENS = 30_000;
const DEFAULT_RECENT_RESULTS_TO_PROTECT = 4;
const PRUNED_HEAD_CHARS = 512;
const PRUNED_TAIL_CHARS = 256;

/**
 * Deterministically replace stale tool payloads while preserving the tool-call
 * protocol boundary, identity, hash, and enough evidence to retrieve them.
 * The active mid-turn episode is never pruned.
 */
export function pruneStaleToolResults(
  messages: Message[],
  options: ToolResultPruningOptions,
): ToolResultPruningResult {
  const rawIndexes = messages.flatMap((message, index) => (
    isRawToolResult(message) ? [index] : []
  ));
  const rawCountBefore = rawIndexes.length;
  const tokensBefore = toolResultTokens(messages, rawIndexes);
  const empty = {
    messages,
    pruned: false,
    prunedCount: 0,
    rawCountBefore,
    rawCountAfter: rawCountBefore,
    tokensBefore,
    tokensAfter: tokensBefore,
    charsRemoved: 0,
  };

  const countThreshold = positiveInteger(options.countThreshold, DEFAULT_COUNT_THRESHOLD);
  const tokenThreshold = positiveInteger(options.tokenThreshold, DEFAULT_TOKEN_THRESHOLD);
  if (rawCountBefore < countThreshold && tokensBefore < tokenThreshold) return empty;

  const protectedIndexes = resolveProtectedIndexes(messages, rawIndexes, options);
  const targetCount = Math.min(
    Math.max(0, positiveInteger(options.targetCount, DEFAULT_TARGET_COUNT)),
    countThreshold,
  );
  const targetTokens = Math.min(
    positiveInteger(options.targetTokens, DEFAULT_TARGET_TOKENS),
    tokenThreshold,
  );
  const output = [...messages];
  let rawCountAfter = rawCountBefore;
  let tokensAfter = tokensBefore;
  let prunedCount = 0;
  let charsRemoved = 0;

  for (const index of rawIndexes) {
    if (rawCountAfter <= targetCount && tokensAfter <= targetTokens) break;
    if (protectedIndexes.has(index)) continue;
    const source = messages[index];
    const raw = source.content as string;
    const replacement = buildPrunedToolResult(source, raw);
    const beforeTokens = estimateMessagesTokens([source]);
    const afterTokens = estimateMessagesTokens([replacement]);
    output[index] = replacement;
    rawCountAfter -= 1;
    tokensAfter = Math.max(0, tokensAfter - beforeTokens + afterTokens);
    prunedCount += 1;
    charsRemoved += Math.max(0, raw.length - String(replacement.content || '').length);
  }

  if (prunedCount === 0) return empty;
  return {
    messages: output,
    pruned: true,
    prunedCount,
    rawCountBefore,
    rawCountAfter,
    tokensBefore,
    tokensAfter,
    charsRemoved,
  };
}

function resolveProtectedIndexes(
  messages: Message[],
  rawIndexes: number[],
  options: ToolResultPruningOptions,
): Set<number> {
  if (options.phase === 'mid_turn') {
    const activeEpisodeId = findLatestEpisodeId(messages);
    if (activeEpisodeId) {
      return new Set(rawIndexes.filter(index => messages[index].__episodeId === activeEpisodeId));
    }
  }
  const protectedCount = positiveInteger(
    options.recentResultsToProtect,
    DEFAULT_RECENT_RESULTS_TO_PROTECT,
  );
  return new Set(rawIndexes.slice(-protectedCount));
}

function buildPrunedToolResult(message: Message, raw: string): Message {
  const hash = createHash('sha256').update(raw).digest('hex');
  const content = [
    TOOL_RESULT_PRUNED_PREFIX,
    message.name ? `tool_name: ${message.name}` : '',
    message.tool_call_id ? `tool_call_id: ${message.tool_call_id}` : '',
    `original_chars: ${raw.length}`,
    `sha256: ${hash}`,
    'omission: stale tool output was pruned from durable context.',
    'recovery: re-run the tool or re-read its source before relying on omitted details.',
    '',
    'head:',
    raw.slice(0, PRUNED_HEAD_CHARS),
    '',
    'tail:',
    raw.slice(-PRUNED_TAIL_CHARS),
  ].filter(part => part !== '').join('\n');
  return annotateContextMessage(
    { ...message, content },
    {
      source: 'tool_result_prune',
      lifecycle: 'episode',
      cacheScope: 'epoch',
      persistence: 'durable',
      ...(message.__episodeId ? { epoch: message.__episodeId } : {}),
    },
  );
}

function isRawToolResult(message: Message): boolean {
  return message.role === 'tool'
    && typeof message.content === 'string'
    && !message.content.startsWith(TOOL_RESULT_PRUNED_PREFIX)
    && !isTransientContextMessage(message);
}

function toolResultTokens(messages: Message[], indexes: number[]): number {
  return indexes.reduce((sum, index) => sum + estimateMessagesTokens([messages[index]]), 0);
}

function findLatestEpisodeId(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].__episodeId) return messages[index].__episodeId;
  }
  return undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 0 ? Math.floor(value!) : fallback;
}
