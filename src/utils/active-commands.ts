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

// scheme://user:password@host — credentials embedded in connection strings.
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):([^/\s@]+)@/gi;
// FOO_TOKEN=… / AWS_SECRET_ACCESS_KEY=… / password: … — word-char keywords with
// an explicit separator (mirrors the keyword charset of the provider log
// sanitizer, so both layers agree on what a credential looks like).
const KEYWORD_VALUE_PATTERN = /([A-Za-z0-9_.-]*(?:token|secret|password|passwd|credential|api[_-]?key|apikey|access[_-]?key)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)([^\s'"]+)/gi;
// The classic space-separated form: `token abc123`, `password hunter2`,
// `--api-key abc123`.
const KEYWORD_SPACE_PATTERN = /\b(token|secret|password|passwd|api[_-]?key|apikey)\s+([^\s'"]+)/gi;
// Authorization headers, with or without a scheme word.
const AUTH_HEADER_PATTERN = /(authorization\s*[:=]\s*)(?:[A-Za-z][A-Za-z0-9+.-]*\s+)?[^\s'"]+/gi;
// Bare Bearer tokens.
const BEARER_TOKEN_PATTERN = /\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
// mysql-style `-p<password>` (at least 4 chars so `tar -pxzf` style flags survive).
const MYSQL_PASSWORD_PATTERN = /(^|\s)-p([^\s'"]{4,})/g;
// Long credential-looking runs (hex/base64 style). Runs with hyphens are only
// redacted past 52 chars so ordinary dated run names stay readable.
const LONG_TOKEN_PATTERN = /[A-Za-z0-9_+=]{32,}|[A-Za-z0-9_=-]{52,}/g;

/**
 * Command labels are rendered into every session's runtime context on the same
 * machine, so before they travel they must be single-line and bounded (a
 * multi-line label could fake new lines inside the trusted resource block) and
 * free of credential material. Redaction mirrors the provider log sanitizer's
 * semantics, plus connection strings and `-p` flags seen in real commands.
 */
export function sanitizeActiveCommandLabel(label: string): string {
  const collapsed = String(label || '').replace(/\s+/g, ' ').trim();
  const redacted = collapsed
    .replace(URL_USERINFO_PATTERN, '$1:***@')
    .replace(KEYWORD_VALUE_PATTERN, '$1$2$3***')
    .replace(KEYWORD_SPACE_PATTERN, '$1 ***')
    .replace(AUTH_HEADER_PATTERN, '$1***')
    .replace(BEARER_TOKEN_PATTERN, '$1 ***')
    .replace(MYSQL_PASSWORD_PATTERN, '$1-p***')
    .replace(LONG_TOKEN_PATTERN, '***');
  return redacted.length > ACTIVE_COMMAND_LABEL_MAX_LENGTH
    ? `${redacted.slice(0, ACTIVE_COMMAND_LABEL_MAX_LENGTH - 1)}…`
    : redacted;
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
