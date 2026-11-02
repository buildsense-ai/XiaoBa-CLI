export const REMOTE_SHELL_MAX_EXECUTION_MS = 300_000;
export const REMOTE_SHELL_RESULT_MARGIN_MS = 10_000;

// The remote synchronous lane is intentionally bounded. Do not silently send a
// 24-hour local command down a 5-minute RPC and pretend that it did not execute.
export function remoteShellTiming(value: unknown): { executionMs: number; rpcMs: number } {
  const parsed = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  const executionMs = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 30_000;
  if (executionMs > REMOTE_SHELL_MAX_EXECUTION_MS) {
    throw new RangeError('单条远程 shell 命令最多同步等待 5 分钟，委派给子智能体也不会放宽此上限。请拆成短命令，或在目标设备启动可独立运行的后台进程/作业后立即返回，再用短命令读取进度。此命令尚未派发。');
  }
  return { executionMs, rpcMs: Math.max(1, executionMs) + REMOTE_SHELL_RESULT_MARGIN_MS };
}
