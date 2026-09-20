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

export const ACTIVE_COMMAND_LABEL_MAX_LENGTH = 120;

/**
 * Command labels are rendered into every session's runtime context on the same
 * machine, so before they travel they must be single-line and bounded: a
 * multi-line label could fake new lines inside the trusted resource block.
 * Credential shaping is intentionally out of scope — labels show the
 * operator's own command text as-is; this guard is about the injection surface.
 */
export function sanitizeActiveCommandLabel(label: string): string {
  const collapsed = String(label || '').replace(/\s+/g, ' ').trim();
  return collapsed.length > ACTIVE_COMMAND_LABEL_MAX_LENGTH
    ? `${collapsed.slice(0, ACTIVE_COMMAND_LABEL_MAX_LENGTH - 1)}…`
    : collapsed;
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
