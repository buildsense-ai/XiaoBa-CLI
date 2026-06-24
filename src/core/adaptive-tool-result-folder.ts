import { Message } from '../types';
import { ToolDefinition } from '../types/tool';
import { estimateMessagesTokens, estimateToolsTokens } from './token-estimator';
import {
  foldHistoricalReadFileMessages,
  ReadFileMessageFoldingOptions,
  ReadFileMessageFoldingStats,
} from './read-file-message-folder';
import {
  ExecuteShellMessageFoldingOptions,
  ExecuteShellMessageFoldingStats,
  foldHistoricalExecuteShellMessages,
} from './execute-shell-message-folder';

export interface AdaptiveToolResultFoldingOptions {
  enabled: boolean;
  targetPromptTokens: number;
  minThresholdTokens: number;
  thresholdScale: number;
  maxPasses: number;
}

export interface AdaptiveToolResultFoldingStats {
  enabled: boolean;
  target_prompt_tokens: number;
  min_threshold_tokens: number;
  threshold_scale: number;
  max_passes: number;
  passes: number;
  started_prompt_tokens_est: number;
  finished_prompt_tokens_est: number;
  saved_prompt_tokens_est: number;
  folded_count: number;
  folded_current_turn_count: number;
  saved_tokens_est: number;
  read_file_folded_count: number;
  read_file_saved_tokens_est: number;
  execute_shell_folded_count: number;
  execute_shell_saved_tokens_est: number;
  thresholds_tried: number[];
}

export interface AdaptiveToolResultFoldingResult {
  messages: Message[];
  stats: AdaptiveToolResultFoldingStats;
}

const DEFAULT_OPTIONS: AdaptiveToolResultFoldingOptions = {
  enabled: true,
  targetPromptTokens: 100000,
  minThresholdTokens: 300,
  thresholdScale: 0.5,
  maxPasses: 4,
};

export function resolveAdaptiveToolResultFoldingOptions(
  env: NodeJS.ProcessEnv = process.env,
  defaults: Partial<AdaptiveToolResultFoldingOptions> = {},
): AdaptiveToolResultFoldingOptions {
  const fallback = { ...DEFAULT_OPTIONS, ...defaults };
  return {
    enabled: readBooleanEnv(env.XIAOBA_ADAPTIVE_TOOL_RESULT_FOLDING, fallback.enabled),
    targetPromptTokens: readPositiveIntegerEnv(
      env.XIAOBA_ADAPTIVE_TOOL_RESULT_FOLD_TARGET_PROMPT_TOKENS,
      fallback.targetPromptTokens,
    ),
    minThresholdTokens: readPositiveIntegerEnv(
      env.XIAOBA_ADAPTIVE_TOOL_RESULT_FOLD_MIN_THRESHOLD_TOKENS,
      fallback.minThresholdTokens,
    ),
    thresholdScale: readThresholdScaleEnv(
      env.XIAOBA_ADAPTIVE_TOOL_RESULT_FOLD_THRESHOLD_SCALE,
      fallback.thresholdScale,
    ),
    maxPasses: readPositiveIntegerEnv(
      env.XIAOBA_ADAPTIVE_TOOL_RESULT_FOLD_MAX_PASSES,
      fallback.maxPasses,
    ),
  };
}

export function foldToolResultsTowardPromptBudget(
  messages: Message[],
  tools: ToolDefinition[],
  readFileOptions: ReadFileMessageFoldingOptions,
  executeShellOptions: ExecuteShellMessageFoldingOptions,
  options: Partial<AdaptiveToolResultFoldingOptions> = {},
): AdaptiveToolResultFoldingResult {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const startedPromptTokens = estimatePromptTokens(messages, tools);
  const stats = emptyStats(resolved, startedPromptTokens);
  if (!resolved.enabled || startedPromptTokens <= resolved.targetPromptTokens) {
    return { messages, stats };
  }

  let currentMessages = messages;
  const thresholdsTried = new Set<number>();

  for (let pass = 1; pass <= resolved.maxPasses; pass++) {
    const promptTokensBeforePass = estimatePromptTokens(currentMessages, tools);
    if (promptTokensBeforePass <= resolved.targetPromptTokens) break;

    const threshold = thresholdForPass(
      Math.min(readFileOptions.thresholdTokens, executeShellOptions.thresholdTokens),
      pass,
      resolved,
    );
    if (thresholdsTried.has(threshold)) break;
    thresholdsTried.add(threshold);
    stats.thresholds_tried.push(threshold);

    const readFileResult = foldHistoricalReadFileMessages(currentMessages, {
      ...readFileOptions,
      thresholdTokens: Math.min(readFileOptions.thresholdTokens, threshold),
    });
    currentMessages = readFileResult.messages;

    const shellResult = foldHistoricalExecuteShellMessages(currentMessages, {
      ...executeShellOptions,
      thresholdTokens: Math.min(executeShellOptions.thresholdTokens, threshold),
    });
    currentMessages = shellResult.messages;

    const foldedThisPass = readFileResult.stats.folded_count + shellResult.stats.folded_count;
    addStats(stats, readFileResult.stats, shellResult.stats);
    stats.passes = pass;

    const promptTokensAfterPass = estimatePromptTokens(currentMessages, tools);
    if (promptTokensAfterPass <= resolved.targetPromptTokens) break;
    if (foldedThisPass === 0 && threshold <= resolved.minThresholdTokens) break;
  }

  stats.finished_prompt_tokens_est = estimatePromptTokens(currentMessages, tools);
  stats.saved_prompt_tokens_est = Math.max(0, stats.started_prompt_tokens_est - stats.finished_prompt_tokens_est);
  return { messages: currentMessages, stats };
}

function emptyStats(
  options: AdaptiveToolResultFoldingOptions,
  startedPromptTokens: number,
): AdaptiveToolResultFoldingStats {
  return {
    enabled: options.enabled,
    target_prompt_tokens: options.targetPromptTokens,
    min_threshold_tokens: options.minThresholdTokens,
    threshold_scale: options.thresholdScale,
    max_passes: options.maxPasses,
    passes: 0,
    started_prompt_tokens_est: startedPromptTokens,
    finished_prompt_tokens_est: startedPromptTokens,
    saved_prompt_tokens_est: 0,
    folded_count: 0,
    folded_current_turn_count: 0,
    saved_tokens_est: 0,
    read_file_folded_count: 0,
    read_file_saved_tokens_est: 0,
    execute_shell_folded_count: 0,
    execute_shell_saved_tokens_est: 0,
    thresholds_tried: [],
  };
}

function addStats(
  target: AdaptiveToolResultFoldingStats,
  readFileStats: ReadFileMessageFoldingStats,
  executeShellStats: ExecuteShellMessageFoldingStats,
): void {
  target.folded_count += readFileStats.folded_count + executeShellStats.folded_count;
  target.folded_current_turn_count += readFileStats.folded_current_turn_count + executeShellStats.folded_current_turn_count;
  target.saved_tokens_est += readFileStats.saved_tokens_est + executeShellStats.saved_tokens_est;
  target.read_file_folded_count += readFileStats.folded_count;
  target.read_file_saved_tokens_est += readFileStats.saved_tokens_est;
  target.execute_shell_folded_count += executeShellStats.folded_count;
  target.execute_shell_saved_tokens_est += executeShellStats.saved_tokens_est;
}

function estimatePromptTokens(messages: Message[], tools: ToolDefinition[]): number {
  return estimateMessagesTokens(messages) + estimateToolsTokens(tools);
}

function thresholdForPass(
  baseThreshold: number,
  pass: number,
  options: AdaptiveToolResultFoldingOptions,
): number {
  const scaled = Math.floor(baseThreshold * Math.pow(options.thresholdScale, pass));
  return Math.max(options.minThresholdTokens, scaled);
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

function readThresholdScaleEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : fallback;
}
