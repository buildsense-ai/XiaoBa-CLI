/** Shared local-search and RPC budgets; no routing/permission side effects. */
export const GREP_DEFAULT_TIMEOUT_MS = 15_000;
export const GREP_MIN_TIMEOUT_MS = 100;
export const GREP_MAX_TIMEOUT_MS = 30_000;
export const GREP_RPC_GRACE_MS = 5_000;

export function resolveGrepSearchTimeoutMs(value?: unknown): number {
  if (value === undefined) return GREP_DEFAULT_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isInteger(value)
    || value < GREP_MIN_TIMEOUT_MS || value > GREP_MAX_TIMEOUT_MS) {
    throw new RangeError(`grep timeout_ms must be an integer between ${GREP_MIN_TIMEOUT_MS} and ${GREP_MAX_TIMEOUT_MS}`);
  }
  return value;
}

/** The receiver's execution deadline plus a small result-transport allowance. */
export function resolveGrepRpcTimeoutMs(value?: unknown): number {
  return resolveGrepSearchTimeoutMs(value) + GREP_RPC_GRACE_MS;
}
