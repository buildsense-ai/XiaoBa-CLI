import * as fs from 'fs';
import * as path from 'path';
import { InterruptedTurnState, SessionStore } from '../utils/session-store';

/**
 * Startup scan for conversations whose last turn never reached a terminal
 * state because the worker process died (OOM killer, host reboot).
 *
 * The marker is written by markInterruptedTurn() and cleared on every terminal
 * outcome, so whatever is still on disk after a restart is a turn nobody
 * finished on purpose. This module only decides *which* markers may be
 * resumed; the caller owns the resumption itself.
 */

export interface InterruptedTurnCandidate {
  /** Session key the marker belongs to (used to load the conversation). */
  sessionKey: string;
  topic: string;
  reason: string;
  senderId?: string;
  startedAt: string;
  attempts: number;
}

export interface CollectInterruptedTurnsOptions {
  /** Directory holding `<sessionKey>.json` runtime state files. */
  stateDir: string;
  /**
   * Interruptions older than this are left alone: the user has moved on, and
   * replaying a long-dead turn would be more surprising than staying silent.
   */
  maxAgeMs: number;
  /** Resumption budget; a marker at or above this is never auto-resumed. */
  maxAttempts: number;
  /** Injectable clock for tests. */
  now?: number;
}

/**
 * Records that a turn never reached a terminal state.
 *
 * Writes through SessionStore directly rather than through the session's
 * lifecycle manager: destroy() tears sessions down *before* the shutdown task
 * sweep runs, so a session-scoped write would be dropped exactly when it is
 * needed most. A re-interruption keeps the existing attempt count — a crash
 * loop must not reset the resumption budget.
 */
export function markInterruptedTurn(
  sessionKey: string,
  input: { topic: string; reason: string; senderId?: string },
): boolean {
  const key = String(sessionKey || '').trim();
  const topic = String(input?.topic || '').trim();
  if (!key || !topic) return false;
  try {
    const store = SessionStore.getInstance();
    const state = store.loadRuntimeState(key);
    const previous = state.interruptedTurn;
    const attempts = Number.isFinite(previous?.attempts) && (previous?.attempts ?? 0) > 0
      ? Number(previous?.attempts)
      : 0;
    return store.saveRuntimeState(key, {
      ...state,
      interruptedTurn: {
        topic,
        reason: String(input?.reason || '').trim() || 'unknown',
        ...(input?.senderId ? { senderId: String(input.senderId) } : {}),
        startedAt: new Date().toISOString(),
        attempts,
      },
    });
  } catch {
    return false;
  }
}

/** Clears the interruption marker after any terminal outcome. */
export function clearInterruptedTurn(sessionKey: string): boolean {
  const key = String(sessionKey || '').trim();
  if (!key) return false;
  try {
    const store = SessionStore.getInstance();
    const state = store.loadRuntimeState(key);
    if (!state.interruptedTurn) return false;
    const { interruptedTurn: _discarded, ...rest } = state;
    return store.saveRuntimeState(key, rest);
  } catch {
    return false;
  }
}

/**
 * Retires the marker when the conversation itself went away: the bot was
 * kicked, the group was disbanded, send attempts are being rejected, or the
 * user wiped the history.
 *
 * This is deliberately a separate name from clearInterruptedTurn() so the call
 * sites document *why* the resume is being cancelled — auto-resuming into a
 * dead topic would post into a conversation the bot no longer owns.
 */
export function stopResumingInterruptedTurn(sessionKey: string): boolean {
  return clearInterruptedTurn(sessionKey);
}

/**
 * Classifies a shutdown so the resume notice can say why the turn stopped.
 *
 * The distinction cannot be made from a single reading of the cgroup counter:
 * the value is cumulative for the lifetime of the unit, so a restart after any
 * historical OOM would look like a fresh memory kill. Only a count that grew
 * since this process started belongs to this process.
 *
 * Exported for tests; the cgroup read itself stays at the call site.
 */
export function classifyShutdownReason(
  oomKillsNow: number | undefined,
  oomKillsAtStart: number | undefined,
): 'oom-kill' | 'connector-shutdown' {
  if (oomKillsNow === undefined || oomKillsAtStart === undefined) return 'connector-shutdown';
  if (!Number.isFinite(oomKillsNow) || !Number.isFinite(oomKillsAtStart)) return 'connector-shutdown';
  return oomKillsNow > oomKillsAtStart ? 'oom-kill' : 'connector-shutdown';
}

/**
 * Counts one automatic resumption and returns the new attempt count. Returns 0
 * when there is no marker to count against.
 */
export function noteResumeAttempt(sessionKey: string): number {
  const key = String(sessionKey || '').trim();
  if (!key) return 0;
  try {
    const store = SessionStore.getInstance();
    const state = store.loadRuntimeState(key);
    const marker = state.interruptedTurn;
    if (!marker) return 0;
    const attempts = (Number.isFinite(marker.attempts) ? Number(marker.attempts) : 0) + 1;
    store.saveRuntimeState(key, {
      ...state,
      interruptedTurn: { ...marker, attempts },
    });
    return attempts;
  } catch {
    return 0;
  }
}

export function collectInterruptedTurns(
  options: CollectInterruptedTurnsOptions,
): InterruptedTurnCandidate[] {
  const stateDir = String(options?.stateDir || '').trim();
  if (!stateDir || !fs.existsSync(stateDir)) return [];

  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? Number(options.maxAgeMs) : 0;
  const maxAttempts = Number.isFinite(options.maxAttempts) ? Number(options.maxAttempts) : 0;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const resumable: InterruptedTurnCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const marker = readInterruptedTurn(path.join(stateDir, entry.name));
    if (!marker) continue;
    if (marker.attempts >= maxAttempts) continue;

    const startedAtMs = Date.parse(marker.startedAt);
    // An unparseable timestamp is treated as too old: without a trustworthy
    // age there is no way to tell a fresh crash from a stale tombstone.
    if (!Number.isFinite(startedAtMs)) continue;
    if (now - startedAtMs > maxAgeMs) continue;

    resumable.push({
      sessionKey: sessionKeyFromStateFile(entry.name),
      topic: marker.topic,
      reason: marker.reason,
      ...(marker.senderId ? { senderId: marker.senderId } : {}),
      startedAt: marker.startedAt,
      attempts: marker.attempts,
    });
  }

  resumable.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  return resumable;
}

function readInterruptedTurn(stateFile: string): InterruptedTurnState | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as {
      interruptedTurn?: InterruptedTurnState;
    };
    const marker = parsed?.interruptedTurn;
    if (!marker || typeof marker !== 'object') return undefined;
    if (!String(marker.topic || '').trim()) return undefined;
    if (!String(marker.startedAt || '').trim()) return undefined;
    return {
      topic: String(marker.topic),
      reason: String(marker.reason || 'unknown'),
      ...(marker.senderId ? { senderId: String(marker.senderId) } : {}),
      startedAt: String(marker.startedAt),
      attempts: Number.isFinite(marker.attempts) ? Number(marker.attempts) : 0,
    };
  } catch {
    // A corrupt or half-written state file must never break startup.
    return undefined;
  }
}

// Session state files use keyToFilename() from session-store: every character
// outside [a-zA-Z0-9_-] is replaced with '_'. CatsCo group keys
// ("cc_group:grp_2613") therefore round-trip through this prefix.
const CATSCO_GROUP_PREFIX = 'cc_group_';

function sessionKeyFromStateFile(fileName: string): string {
  const base = fileName.replace(/\.json$/, '');
  if (base.startsWith(CATSCO_GROUP_PREFIX)) {
    return `cc_group:${base.slice(CATSCO_GROUP_PREFIX.length)}`;
  }
  return base;
}
