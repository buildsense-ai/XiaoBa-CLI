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

export function registerActiveCommand(entry: ActiveCommandEntry): void {
  if (!Number.isInteger(entry.pid) || entry.pid <= 0) return;
  activeCommands.set(entry.pid, entry);
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
