import { Message } from '../types';

export interface CurrentRunToolResultFoldingOptions {
  enabled: boolean;
  keepRecentToolResults: number;
}

const DEFAULT_OPTIONS: CurrentRunToolResultFoldingOptions = {
  enabled: true,
  keepRecentToolResults: 3,
};

const FOLDABLE_TOOL_NAMES = new Set(['read_file', 'execute_shell']);

export function resolveCurrentRunToolResultFoldingOptions(
  env: NodeJS.ProcessEnv = process.env,
): CurrentRunToolResultFoldingOptions {
  return {
    enabled: readBooleanEnv(env.XIAOBA_CURRENT_RUN_TOOL_RESULT_FOLDING, DEFAULT_OPTIONS.enabled),
    keepRecentToolResults: readNonNegativeIntegerEnv(
      env.XIAOBA_CURRENT_RUN_TOOL_RESULT_FOLD_KEEP_RECENT,
      DEFAULT_OPTIONS.keepRecentToolResults,
    ),
  };
}

export function selectProtectedCurrentRunToolResultIndexes(
  messages: Message[],
  options: Partial<CurrentRunToolResultFoldingOptions> = {},
): Set<number> {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  if (!resolved.enabled || resolved.keepRecentToolResults <= 0) {
    return new Set();
  }

  const lastUserIndex = findLastRealUserIndex(messages);
  if (lastUserIndex < 0) return new Set();

  const currentRunToolIndexes: number[] = [];
  messages.forEach((message, index) => {
    if (index <= lastUserIndex) return;
    if (message.role !== 'tool') return;
    if (Array.isArray(message.content)) return;
    if (!FOLDABLE_TOOL_NAMES.has(normalizeToolName(message.name || ''))) return;
    currentRunToolIndexes.push(index);
  });

  return new Set(currentRunToolIndexes.slice(-resolved.keepRecentToolResults));
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

function normalizeToolName(name: string): string {
  const normalized = String(name || '').trim();
  if (['Bash', 'bash', 'Shell', 'shell', 'execute_bash'].includes(normalized)) {
    return 'execute_shell';
  }
  if (normalized === 'Read') return 'read_file';
  return normalized;
}

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return fallback;
}

function readNonNegativeIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
