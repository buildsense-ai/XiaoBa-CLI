export const REMOTE_SHELL_MAX_EXECUTION_MS = 300_000;
export const REMOTE_SHELL_RESULT_MARGIN_MS = 10_000;

// The remote synchronous lane is intentionally bounded. Do not silently send a
// 24-hour local command down a 5-minute RPC and pretend that it did not execute.
export function remoteShellTiming(value: unknown): { executionMs: number; rpcMs: number } {
  const parsed = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  const executionMs = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 30_000;
  if (executionMs > REMOTE_SHELL_MAX_EXECUTION_MS) {
    throw new RangeError('远程同步命令最多执行 5 分钟；请将更长任务提交为后台任务并分次读取进度。此命令尚未派发。');
  }
  return { executionMs, rpcMs: Math.max(1, executionMs) + REMOTE_SHELL_RESULT_MARGIN_MS };
}
