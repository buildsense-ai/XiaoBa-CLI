/** Resource limits for autonomous branch work. Values are intentionally
 * finite: a sidecar must be able to make progress without becoming an
 * unbounded second main agent. */
export interface MemoryBranchBudget {
  maxTurnsPerPass: number;
  maxPasses: number;
  deadlineMs: number;
  maxContextTokens: number;
}

export const DEFAULT_MEMORY_BRANCH_BUDGET: MemoryBranchBudget = {
  maxTurnsPerPass: 8,
  maxPasses: 3,
  deadlineMs: 45_000,
  maxContextTokens: 16_000,
};

export const MEMORY_BRANCH_BUDGET_LIMITS = {
  maxTurnsPerPass: { min: 1, max: 64 },
  maxPasses: { min: 1, max: 8 },
  deadlineMs: { min: 1_000, max: 300_000 },
  maxContextTokens: { min: 2_000, max: 2_000_000 },
} as const;

/** Normalize persisted/user-provided values without allowing unbounded work. */
export function normalizeMemoryBranchBudget(
  input: unknown,
  fallback: MemoryBranchBudget = DEFAULT_MEMORY_BRANCH_BUDGET,
): MemoryBranchBudget {
  const source = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return {
    maxTurnsPerPass: boundedInteger(source.maxTurnsPerPass, fallback.maxTurnsPerPass, MEMORY_BRANCH_BUDGET_LIMITS.maxTurnsPerPass),
    maxPasses: boundedInteger(source.maxPasses, fallback.maxPasses, MEMORY_BRANCH_BUDGET_LIMITS.maxPasses),
    deadlineMs: boundedInteger(source.deadlineMs, fallback.deadlineMs, MEMORY_BRANCH_BUDGET_LIMITS.deadlineMs),
    maxContextTokens: boundedInteger(source.maxContextTokens, fallback.maxContextTokens, MEMORY_BRANCH_BUDGET_LIMITS.maxContextTokens),
  };
}

function boundedInteger(
  value: unknown,
  fallback: number,
  limits: { min: number; max: number },
): number {
  const fallbackValue = Number.isSafeInteger(fallback)
    ? Math.min(limits.max, Math.max(limits.min, fallback))
    : limits.min;
  if (typeof value !== 'number' && typeof value !== 'string') return fallbackValue;
  if (typeof value === 'string' && value.trim() === '') return fallbackValue;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallbackValue;
  const floored = Math.floor(parsed);
  if (floored < limits.min) return fallbackValue;
  return Math.min(limits.max, floored);
}
