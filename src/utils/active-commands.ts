/**
 * Global registry of shell commands currently running under this runtime.
 *
 * The resource-awareness layer uses it to tell the model what heavy work is
 * already in flight on this machine — across sessions, turns and sub-agents.
 * Entries are purely informational; nothing here limits execution.
 */

export interface ActiveCommandEntry {
  /**
   * Process id. On POSIX platforms the command runs as a process-group leader,
   * so this is also the process group id used for RSS sampling and cancellation.
   */
  pid: number;
  /** Short one-line label describing the command. */
  label: string;
  /** Epoch ms when the command was spawned. */
  startedAt: number;
  platform: NodeJS.Platform;
}

const activeCommands = new Map<number, ActiveCommandEntry>();

const SECRET_PATTERN = /(authorization|bearer|token|secret|password|passwd|api[_-]?key)(\s*[:=]\s*|\s+)([^\s'"]+)/gi;
// Long credential-looking runs (hex/base64 style). Runs with hyphens are only
// redacted past 52 chars so ordinary dated run names stay readable.
const LONG_TOKEN_PATTERN = /[A-Za-z0-9_+=]{32,}|[A-Za-z0-9_=-]{52,}/g;

/**
 * Command labels are rendered into every session's runtime context on the same
 * machine, so credential-looking fragments must not travel with them.
 */
export function sanitizeActiveCommandLabel(label: string): string {
  return String(label || '')
    .replace(SECRET_PATTERN, '$1$2***')
    .replace(LONG_TOKEN_PATTERN, '***');
}

export function registerActiveCommand(entry: ActiveCommandEntry): void {
  if (!Number.isInteger(entry.pid) || entry.pid <= 0) return;
  activeCommands.set(entry.pid, { ...entry, label: sanitizeActiveCommandLabel(entry.label) });
}

export function unregisterActiveCommand(pid: number | undefined): void {
  if (typeof pid !== 'number') return;
  activeCommands.delete(pid);
}

export function listActiveCommands(): ActiveCommandEntry[] {
  return [...activeCommands.values()].sort((left, right) => left.startedAt - right.startedAt);
}

export function clearActiveCommandsForTest(): void {
  activeCommands.clear();
}
