import * as fs from 'fs';
import * as path from 'path';
import type { ExecutionScope } from '../types/session-identity';
import {
  InterruptedTurnDeviceContext,
  InterruptedTurnExecutionScope,
  InterruptedTurnState,
  SessionStore,
} from '../utils/session-store';

// Re-exported so callers can name the shape they hand to sanitizeDeviceContext
// without reaching into the store module.
export type { InterruptedTurnDeviceContext, InterruptedTurnExecutionScope } from '../utils/session-store';

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
  /** Device metadata captured from the interrupted turn, for rebuilding grants. */
  deviceContext?: InterruptedTurnDeviceContext;
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
  input: {
    topic: string;
    reason: string;
    senderId?: string;
    deviceContext?: InterruptedTurnDeviceContext;
  },
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
    // Prefer this interruption's context; fall back to what a previous marker
    // carried so a crash-loop rewrite does not lose the device access. The
    // value arrives in the stored shape (already whitelisted at capture time),
    // so it is validated rather than re-sanitized.
    const deviceContext = readDeviceContext(input?.deviceContext) ?? previous?.deviceContext;
    return store.saveRuntimeState(key, {
      ...state,
      interruptedTurn: {
        topic,
        reason: String(input?.reason || '').trim() || 'unknown',
        ...(input?.senderId ? { senderId: String(input.senderId) } : {}),
        sessionKey: key,
        startedAt: new Date().toISOString(),
        attempts,
        ...(deviceContext ? { deviceContext } : {}),
      },
    });
  } catch {
    return false;
  }
}

/**
 * Keeps only the device-related metadata keys plus the execution identity, and
 * only when they look like plain JSON of a sane size.
 *
 * `catsco_skill_connectors` is deliberately absent: it carries an actor_token,
 * and ParsedCatsMessage documents connector grants as never being copied into
 * durable history. Everything that reaches the user's computer is described by
 * the keys kept here, so dropping it costs no device capability.
 *
 * Exported for tests.
 */
export function sanitizeDeviceContext(
  metadata: Record<string, unknown> | undefined,
  executionScope?: ExecutionScope,
): InterruptedTurnDeviceContext | undefined {
  const context: InterruptedTurnDeviceContext = {};

  const scope = sanitizeExecutionScope(executionScope);
  if (scope) context.executionScope = scope;

  if (metadata && typeof metadata === 'object') {
    const catscoIdentity = plainObject(metadata.catsco_identity);
    if (catscoIdentity) context.catscoIdentity = catscoIdentity;

    const xiaobaRuntime = plainObject(metadata.xiaoba_runtime);
    if (xiaobaRuntime) context.xiaobaRuntime = xiaobaRuntime;
  }

  if (!context.catscoIdentity && !context.xiaobaRuntime) return undefined;

  // A malformed or oversized payload would bloat a state file the startup scan
  // reads on every boot, so refuse rather than persist something unexpected.
  let serialized: string;
  try {
    serialized = JSON.stringify(context);
  } catch {
    return undefined;
  }
  if (typeof serialized !== 'string' || serialized.length > MAX_DEVICE_CONTEXT_CHARS) {
    return undefined;
  }
  return context;
}

/** Mandatory scope fields; a partial copy would fail its later scope check. */
const REQUIRED_SCOPE_STRINGS = ['source', 'sessionKey', 'topicId', 'topicType', 'actorUserId', 'identityTrust'] as const;
const OPTIONAL_SCOPE_STRINGS = [
  'legacySessionKey',
  'legacyRestoreKey',
  'legacyCleanupKey',
  'agentId',
  'agentBodyId',
  'permissionsSource',
  'deviceOwnerUserId',
  'deviceOwnerSource',
  'channelSource',
] as const;

/**
 * Copies an execution scope as primitives.
 *
 * Only the scope and its own fields are trusted here, and the result is only
 * ever read back by a resume. The state directory is owned by the agent user
 * (files are 0644 but the directory is not writable by anyone else), so a
 * tampered scope would require the ability to run as the agent -- which already
 * implies far more than a forged trust flag.
 */
function sanitizeExecutionScope(scope: unknown): InterruptedTurnExecutionScope | undefined {
  const record = plainObject(scope);
  if (!record) return undefined;

  const out: Record<string, string | number | boolean> = {};
  for (const key of REQUIRED_SCOPE_STRINGS) {
    const value = record[key];
    if (typeof value !== 'string' || !value) return undefined;
    out[key] = value;
  }
  for (const key of OPTIONAL_SCOPE_STRINGS) {
    const value = record[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  const channelSeq = record.channelSeq;
  if (typeof channelSeq === 'number' && Number.isFinite(channelSeq)) out.channelSeq = channelSeq;
  const isTrusted = record.isTrusted;
  if (typeof isTrusted === 'boolean') out.isTrusted = isTrusted;
  else out.isTrusted = (out.identityTrust as string) === 'server_canonical';

  return out as unknown as InterruptedTurnExecutionScope;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Bound on the persisted device context; identity metadata is a few hundred bytes. */
const MAX_DEVICE_CONTEXT_CHARS = 32 * 1024;

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
 * Reads the OOM kill counter out of /proc/vmstat content.
 *
 * The cgroup's memory.events.oom_kill is NOT a usable source on the deployed
 * workers: the unit runs with MemoryMax=infinity, so the cgroup never trips its
 * own limit and the counter stays at zero even when the host OOM killer reaps
 * a 3.4GB child (verified on worker-bot-bot-bot-9308: memory.max=max,
 * memory.events oom_kill=0, /proc/vmstat oom_kill=3 after three real kills).
 * /proc/vmstat is cumulative and readable without privileges; dmesg would say
 * the same but needs CAP_SYSLOG.
 *
 * Exported for tests; the file read stays at the call site.
 */
export function parseOomKillCount(vmstatText: string): number | undefined {
  if (typeof vmstatText !== 'string' || !vmstatText) return undefined;
  const raw = (vmstatText.match(/^oom_kill\s+(\d+)$/m) || [])[1];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Classifies a shutdown so the resume notice can say why the turn stopped.
 *
 * The distinction cannot be made from a single reading of the counter: the
 * value is cumulative for the host, so a restart after any historical OOM would
 * look like a fresh memory kill. Only a count that grew since this process
 * started belongs to this process.
 *
 * Known limit: the counter is host-wide, so an unrelated process being reaped
 * during our lifetime also reads as 'oom-kill'. On a worker host our own node
 * process is the dominant memory consumer, so this stays accurate in practice
 * and is still far better than never detecting a kill at all.
 *
 * Exported for tests; the read itself stays at the call site.
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
    // Only committed state files end in '.json'. saveRuntimeState() stages its
    // payload in a '<key>.json.<pid>.tmp' sibling and renames it into place, so
    // an in-flight temp file cannot match this suffix and is never read as a
    // marker.
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
      sessionKey: marker.sessionKey || sessionKeyFromStateFile(entry.name),
      topic: marker.topic,
      reason: marker.reason,
      ...(marker.senderId ? { senderId: marker.senderId } : {}),
      startedAt: marker.startedAt,
      attempts: marker.attempts,
      ...(marker.deviceContext ? { deviceContext: marker.deviceContext } : {}),
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
    const deviceContext = readDeviceContext(marker.deviceContext);
    return {
      topic: String(marker.topic),
      reason: String(marker.reason || 'unknown'),
      ...(marker.senderId ? { senderId: String(marker.senderId) } : {}),
      ...(marker.sessionKey ? { sessionKey: String(marker.sessionKey) } : {}),
      startedAt: String(marker.startedAt),
      attempts: Number.isFinite(marker.attempts) ? Number(marker.attempts) : 0,
      ...(deviceContext ? { deviceContext } : {}),
    };
  } catch {
    // A corrupt or half-written state file must never break startup.
    return undefined;
  }
}

/**
 * Validates the stored shape on the way back in. The same size bound as the
 * write path keeps a hand-edited or truncated state file from feeding a huge
 * object into the resume.
 */
function readDeviceContext(value: unknown): InterruptedTurnDeviceContext | undefined {
  const record = plainObject(value);
  if (!record) return undefined;
  const context: InterruptedTurnDeviceContext = {};
  const scope = sanitizeExecutionScope(record.executionScope);
  if (scope) context.executionScope = scope;
  const catscoIdentity = plainObject(record.catscoIdentity);
  if (catscoIdentity) context.catscoIdentity = catscoIdentity;
  const xiaobaRuntime = plainObject(record.xiaobaRuntime);
  if (xiaobaRuntime) context.xiaobaRuntime = xiaobaRuntime;
  if (!context.catscoIdentity && !context.xiaobaRuntime) return undefined;
  try {
    if (JSON.stringify(context).length > MAX_DEVICE_CONTEXT_CHARS) return undefined;
  } catch {
    return undefined;
  }
  return context;
}

// Session state files use keyToFilename() from session-store: every character
// outside [a-zA-Z0-9_-] is replaced with '_'. Only a single ':' can be put
// back, and only when the prefix is unambiguous.
//
// This is a LAST-RESORT fallback for markers written before the key was stored
// in the marker itself. 'cc_user:usr38' and 'session:v2:catscompany:p2p:...'
// both lose every ':' to the same '_', so reconstruction is not generally
// possible -- new markers carry their sessionKey instead of relying on this.
const CATSCO_GROUP_PREFIX = 'cc_group_';
const CATSCO_USER_PREFIX = 'cc_user_';

function sessionKeyFromStateFile(fileName: string): string {
  const base = fileName.replace(/\.json$/, '');
  if (base.startsWith(CATSCO_GROUP_PREFIX)) {
    return `cc_group:${base.slice(CATSCO_GROUP_PREFIX.length)}`;
  }
  if (base.startsWith(CATSCO_USER_PREFIX)) {
    return `cc_user:${base.slice(CATSCO_USER_PREFIX.length)}`;
  }
  return base;
}
