/**
 * Session Log Source — source-neutral input boundary for the Heartbeat Log
 * Distillation Agent (issue #75).
 *
 * Introduces a source-neutral seam inside the existing local Heartbeat Log
 * Distillation Agent. The Runtime routes internal XiaoBa append-only logs
 * through an Internal Session Log Source adapter with no observable
 * regression, and exposes a deterministic fixture adapter through the public
 * RuntimeLearning.wake() path.
 *
 * The adapter contract distinguishes source, provider, and reader identity,
 * leaves stable Source Event Identity, bounded reads, and source provenance
 * representable, and keeps external sources explicitly disabled by default.
 *
 * See CONTEXT.md → "Session Log Source", "Internal Session Log Source",
 * "External Session Log Source", "Session Log Source Adapter",
 * "Source Event Identity".
 */

import * as fs from 'fs';
import * as path from 'path';

import { DistillationUnit, CrossFileContinuityOptions, extractDistillationUnit } from './distillation-unit';
import {
  LogCursorEntry,
  advanceCursor,
  getCursor,
  loadLogCursorState,
  markCursorFailed,
  saveLogCursorState,
} from './log-cursor-state';
import { DistillationHeartbeatConfig } from './distillation-heartbeat-config';
import { Logger } from './logger';

// ---------------------------------------------------------------------------
// Source identity
// ---------------------------------------------------------------------------

export type SessionLogSourceCategory = 'internal' | 'external';

/**
 * Source identity — describes the origin of a log, not an Agent that the
 * Runtime may invoke. This is distinct from External Agent executor identity:
 * the provider names the system that produced the log (e.g. "xiaoba", "pi",
 * "codex", "claude-code"), while the reader names the mechanism used to
 * access it (e.g. "filesystem-jsonl", "xurl", "fixture"). An External Agent
 * executor identity (the agent that runs the review branch) is a separate
 * concept managed by the skill-evolution runtime.
 */
export interface SessionLogSourceIdentity {
  readonly sourceId: string;
  readonly label: string;
  readonly category: SessionLogSourceCategory;
  readonly provider: string;
  readonly reader: string;
}

// ---------------------------------------------------------------------------
// Source Event Identity
// ---------------------------------------------------------------------------

/**
 * Stable provider-scoped identity and monotonic position used to resume a
 * Session Log Source without duplicating or losing events.
 */
export interface SourceEventIdentity {
  readonly eventId: string;
  readonly position: number;
  readonly contentHash?: string;
}

// ---------------------------------------------------------------------------
// Source cursor
// ---------------------------------------------------------------------------

export interface SourceCursor {
  readonly resourceRef: string;
  readonly position: number;
  readonly processedCount: number;
}

// ---------------------------------------------------------------------------
// Discovered resource
// ---------------------------------------------------------------------------

export interface SessionLogSourceResource {
  readonly resourceRef: string;
  readonly firstEventIdentity?: SourceEventIdentity;
}

// ---------------------------------------------------------------------------
// Read result
// ---------------------------------------------------------------------------

export type SessionLogSourceReadStatus = 'idle' | 'advanced' | 'exhausted' | 'disabled' | 'failed';

export interface SessionLogSourceReadResult {
  readonly distillationUnit: DistillationUnit | null;
  readonly advanced: boolean;
  readonly status: SessionLogSourceReadStatus;
  readonly newCursor: SourceCursor;
}

// ---------------------------------------------------------------------------
// Read context
// ---------------------------------------------------------------------------

export interface SessionLogSourceReadContext {
  readonly orderedResources: readonly SessionLogSourceResource[];
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface SessionLogSourceAdapter {
  readonly identity: SessionLogSourceIdentity;
  isEnabled(): boolean;
  discoverResources(): readonly SessionLogSourceResource[];
  read(
    resource: SessionLogSourceResource,
    context: SessionLogSourceReadContext,
  ): SessionLogSourceReadResult;
  acknowledge(resource: SessionLogSourceResource, result: SessionLogSourceReadResult): void;
  markFailed(resource: SessionLogSourceResource, error: unknown): void;
}

// ---------------------------------------------------------------------------
// Internal Session Log Source Adapter
// ---------------------------------------------------------------------------

export class InternalSessionLogSourceAdapter implements SessionLogSourceAdapter {
  readonly identity: SessionLogSourceIdentity = {
    sourceId: 'internal-xiaoba',
    label: 'XiaoBa Internal Session Logs',
    category: 'internal',
    provider: 'xiaoba',
    reader: 'filesystem-jsonl',
  };

  constructor(private readonly config: DistillationHeartbeatConfig) {}

  isEnabled(): boolean {
    return true;
  }

  discoverResources(): readonly SessionLogSourceResource[] {
    const sessionLogsRoot = resolveSessionLogsRoot(this.config.logsRoot);
    if (!fs.existsSync(sessionLogsRoot) || !fs.statSync(sessionLogsRoot).isDirectory()) {
      return [];
    }
    return collectJsonlFiles(sessionLogsRoot).map(filePath => ({
      resourceRef: filePath,
      firstEventIdentity: {
        eventId: filePath,
        position: 0,
      },
    }));
  }

  read(
    resource: SessionLogSourceResource,
    context: SessionLogSourceReadContext,
  ): SessionLogSourceReadResult {
    const filePath = resource.resourceRef;
    const state = loadLogCursorState(this.config.stateFilePath);
    const cursor = getCursor(state, filePath);

    let extracted;
    try {
      const orderedFilePaths = context.orderedResources.map(r => r.resourceRef);
      const crossFileContinuity: CrossFileContinuityOptions = { orderedFilePaths };
      extracted = extractDistillationUnit(filePath, cursor, { crossFileContinuity });
    } catch (error) {
      this.markFailed(resource, error);
      return {
        distillationUnit: null,
        advanced: false,
        status: 'failed',
        newCursor: {
          resourceRef: filePath,
          position: cursor.byteOffset,
          processedCount: cursor.processedTurnCount,
        },
      };
    }

    return {
      distillationUnit: extracted.distillationUnit,
      advanced: extracted.advanced,
      status: extracted.distillationUnit ? 'advanced' : (extracted.advanced ? 'advanced' : 'idle'),
      newCursor: {
        resourceRef: filePath,
        position: extracted.newCursor.byteOffset,
        processedCount: extracted.newCursor.processedTurnCount,
      },
    };
  }

  acknowledge(resource: SessionLogSourceResource, result: SessionLogSourceReadResult): void {
    const state = loadLogCursorState(this.config.stateFilePath);
    const cursor: LogCursorEntry = {
      filePath: resource.resourceRef,
      byteOffset: result.newCursor.position,
      processedTurnCount: result.newCursor.processedCount,
      updatedAt: new Date().toISOString(),
      status: 'completed',
    };
    advanceCursor(state, cursor);
    saveLogCursorState(this.config.stateFilePath, state);
  }

  markFailed(resource: SessionLogSourceResource, error: unknown): void {
    const state = loadLogCursorState(this.config.stateFilePath);
    const existing = getCursor(state, resource.resourceRef);
    markCursorFailed(state, resource.resourceRef, existing.byteOffset, error);
    saveLogCursorState(this.config.stateFilePath, state);
  }
}

// ---------------------------------------------------------------------------
// Fixture Session Log Source Adapter
// ---------------------------------------------------------------------------

export class FixtureSessionLogSourceAdapter implements SessionLogSourceAdapter {
  readonly identity: SessionLogSourceIdentity;
  private readonly resources: readonly SessionLogSourceResource[];
  private readonly units: readonly (DistillationUnit | null)[];
  private readonly cursors = new Map<string, SourceCursor>();

  constructor(
    units: readonly (DistillationUnit | null)[],
    options: { identity?: Partial<SessionLogSourceIdentity> } = {},
  ) {
    this.identity = {
      sourceId: options.identity?.sourceId ?? 'fixture-test',
      label: options.identity?.label ?? 'Test Fixture Source',
      category: options.identity?.category ?? 'internal',
      provider: options.identity?.provider ?? 'fixture',
      reader: options.identity?.reader ?? 'fixture',
    };
    this.units = units;
    this.resources = units.map((unit, index) => ({
      resourceRef: `fixture://${this.identity.sourceId}/event-${index}`,
      firstEventIdentity: unit
        ? { eventId: `fixture://${this.identity.sourceId}/event-${index}`, position: 0 }
        : undefined,
    }));
    for (const resource of this.resources) {
      this.cursors.set(resource.resourceRef, {
        resourceRef: resource.resourceRef,
        position: 0,
        processedCount: 0,
      });
    }
  }

  isEnabled(): boolean {
    return true;
  }

  discoverResources(): readonly SessionLogSourceResource[] {
    return this.resources;
  }

  read(
    resource: SessionLogSourceResource,
    _context: SessionLogSourceReadContext,
  ): SessionLogSourceReadResult {
    const cursor = this.cursors.get(resource.resourceRef) ?? {
      resourceRef: resource.resourceRef,
      position: 0,
      processedCount: 0,
    };

    const index = this.resources.findIndex(r => r.resourceRef === resource.resourceRef);
    if (index < 0 || index >= this.units.length) {
      return {
        distillationUnit: null,
        advanced: false,
        status: 'exhausted',
        newCursor: cursor,
      };
    }

    // Each fixture resource yields exactly one distillation unit. A cursor
    // position > 0 means the resource has already been read — return exhausted.
    if (cursor.position > 0) {
      return {
        distillationUnit: null,
        advanced: false,
        status: 'exhausted',
        newCursor: cursor,
      };
    }

    const unit = this.units[index];
    if (!unit) {
      const newCursor: SourceCursor = {
        resourceRef: resource.resourceRef,
        position: cursor.position + 1,
        processedCount: cursor.processedCount,
      };
      this.cursors.set(resource.resourceRef, newCursor);
      return {
        distillationUnit: null,
        advanced: true,
        status: 'idle',
        newCursor,
      };
    }

    const newCursor: SourceCursor = {
      resourceRef: resource.resourceRef,
      position: cursor.position + 1,
      processedCount: cursor.processedCount + unit.newTurns.length,
    };
    this.cursors.set(resource.resourceRef, newCursor);

    return {
      distillationUnit: unit,
      advanced: true,
      status: 'advanced',
      newCursor,
    };
  }

  acknowledge(resource: SessionLogSourceResource, result: SessionLogSourceReadResult): void {
    void resource;
    void result;
  }

  markFailed(resource: SessionLogSourceResource, error: unknown): void {
    void error;
    const cursor = this.cursors.get(resource.resourceRef);
    if (cursor) {
      this.cursors.set(resource.resourceRef, {
        ...cursor,
        position: Math.max(0, cursor.position - 1),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// External Source Reader — pluggable seam (implemented by #77–#79)
// ---------------------------------------------------------------------------

/**
 * Pluggable reader that adapts an external system's session data into
 * canonical session-log resources and raw events. Provider-specific
 * implementations (Codex, Pi, Claude Code, xURL) are built in issues
 * #77–#79.
 *
 * The reader is the boundary through which an External Session Log Source
 * discovers resources and reads externally stable events without coupling
 * the Runtime to any specific external API.
 */
export interface ExternalSourceReader {
  readonly provider: string;
  readonly reader: string;

  /**
   * Discover stable resources from the external source.
   *
   * For future-only semantics, only resources whose position exceeds the
   * given cursor's position are returned. A null cursor means the source
   * is freshly enabled — only currently stable/completed ranges are
   * returned (no historical backfill).
   */
  discoverResources(cursor: SourceCursor | null): readonly SessionLogSourceResource[];

  /**
   * Read events from a resource starting at the given cursor position.
   *
   * @param resource - The resource to read.
   * @param cursor - Current cursor within the resource.
   * @returns Events read, whether the range is stable or still pending
   *          (mutable), whether the resource is exhausted, and the new
   *          position after reading.
   */
  read(resource: SessionLogSourceResource, cursor: SourceCursor): ExternalSourceReaderResult;
}

// ---------------------------------------------------------------------------
// External Source Reader result
// ---------------------------------------------------------------------------

export interface ExternalSourceReaderResult {
  readonly events: readonly ExternalSourceRawEvent[];
  /**
   * 'stable' — the returned range is immutable and safe to persist.
   * 'pending' — the range is still mutable and must not advance the cursor.
   */
  readonly status: 'stable' | 'pending';
  /** Whether the resource has been fully consumed. */
  readonly exhausted: boolean;
  /** New monotonic position after reading these events. */
  readonly newPosition: number;
}

// ---------------------------------------------------------------------------
// External Source Raw Event (pre-conversion)
// ---------------------------------------------------------------------------

/**
 * A single raw event from an external source, carrying stable identity
 * before conversion into a DistillationUnit. The adapter uses identity
 * fields for deduplication and source-bound continuity.
 */
export interface ExternalSourceRawEvent {
  readonly eventId: string;
  readonly position: number;
  readonly contentHash?: string;
}

// ---------------------------------------------------------------------------
// External Cursor State (durable persistence per external source)
// ---------------------------------------------------------------------------

export interface ExternalCursorState {
  readonly schemaVersion: number;
  /**
   * Per-resource cursor entries. Keyed by resourceRef so each resource
   * advances independently.
   */
  readonly cursors: Record<string, ExternalCursorEntry>;
  /**
   * Set of processed event IDs (eventId → contentHash). Used for exact
   * deduplication when the same stable event is re-discovered.
   */
  readonly processedEventIds: Record<string, string | undefined>;
  /** ISO timestamp of the last state save. */
  readonly updatedAt: string;
}

export interface ExternalCursorEntry {
  readonly cursor: SourceCursor;
  readonly updatedAt: string;
  /** Status of the last read from this resource. */
  readonly lastStatus?: 'stable' | 'pending' | 'exhausted';
}

export function emptyExternalCursorState(): ExternalCursorState {
  return {
    schemaVersion: 1,
    cursors: {},
    processedEventIds: {},
    updatedAt: new Date().toISOString(),
  };
}

export function loadExternalCursorState(storePath: string): ExternalCursorState {
  if (!fs.existsSync(storePath)) {
    return emptyExternalCursorState();
  }
  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ExternalCursorState>;
    return {
      schemaVersion: parsed.schemaVersion ?? 1,
      cursors: parsed.cursors ?? {},
      processedEventIds: parsed.processedEventIds ?? {},
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    // Corrupt state file — start fresh; the source will re-discover.
    return emptyExternalCursorState();
  }
}

export function saveExternalCursorState(
  storePath: string,
  state: ExternalCursorState,
): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const payload = {
    schemaVersion: 1,
    cursors: state.cursors,
    processedEventIds: state.processedEventIds,
    updatedAt: new Date().toISOString(),
  };
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(tmpPath, storePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup; preserve original error.
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Fixture External Source Reader
// ---------------------------------------------------------------------------

/**
 * A deterministic ExternalSourceReader backed by pre-built
 * DistillationUnits or null slots. Used for fixture-backed regression
 * coverage of the external source work lane.
 *
 * Each unit becomes one external resource/event pair. A null unit
 * represents a pending/mutable range that should not advance the cursor.
 */
export class FixtureExternalSourceReader implements ExternalSourceReader {
  readonly provider: string;
  readonly reader: string;
  private readonly units: readonly (DistillationUnit | null)[];
  private readonly resources: readonly SessionLogSourceResource[];
  private readonly identityOptions: { sourceId?: string; provider?: string };

  constructor(
    units: readonly (DistillationUnit | null)[],
    options: {
      sourceId?: string;
      provider?: string;
      reader?: string;
    } = {},
  ) {
    this.provider = options.provider ?? 'fixture';
    this.reader = options.reader ?? 'fixture';
    this.identityOptions = { sourceId: options.sourceId, provider: this.provider };
    this.units = units;
    this.resources = units.map((unit, index) => ({
      resourceRef: unit
        ? `fixture://${options.sourceId ?? 'fixture-test'}/event-${index}`
        : `fixture://${options.sourceId ?? 'fixture-test'}/pending-${index}`,
      firstEventIdentity: unit
        ? {
            eventId: `fixture://${options.sourceId ?? 'fixture-test'}/event-${index}`,
            position: index,
            contentHash: unit.newTurns.length > 0
              ? `${unit.newTurns.length}-${unit.newTurns[0].session_id ?? ''}`
              : undefined,
          }
        : undefined,
    }));
  }

  discoverResources(cursor: SourceCursor | null): readonly SessionLogSourceResource[] {
    if (cursor === null) {
      // Fresh enablement — return only stable (non-null) resources,
      // no historical backfill. This is the future-only gate.
      return this.resources.filter((_, i) => this.units[i] !== null);
    }

    // Return resources whose position is at or beyond the cursor.
    // A cursor position of N means we've acknowledged up to position N;
    // the next unprocessed resource starts at position N.
    const cursorPosition = cursor.position;
    return this.resources.filter((_, i) => {
      const unit = this.units[i];
      // Only return resources that are: present (stable), and
      // whose position is at or beyond the current cursor.
      if (unit === null) return false;
      const pos = this.resources[i].firstEventIdentity?.position ?? i;
      return pos >= cursorPosition;
    });
  }

  read(
    resource: SessionLogSourceResource,
    cursor: SourceCursor,
  ): ExternalSourceReaderResult {
    const index = this.resources.findIndex(r => r.resourceRef === resource.resourceRef);
    if (index < 0 || index >= this.units.length) {
      return { events: [], status: 'stable', exhausted: true, newPosition: cursor.position };
    }

    const unit = this.units[index];

    // A null unit represents a pending/mutable range.
    if (unit === null) {
      return { events: [], status: 'pending', exhausted: true, newPosition: cursor.position };
    }

    // If cursor already past this resource's position, skip.
    const resourcePosition = resource.firstEventIdentity?.position ?? index;
    if (cursor.position >= resourcePosition + 1) {
      return { events: [], status: 'stable', exhausted: true, newPosition: cursor.position };
    }

    const eventId = resource.firstEventIdentity?.eventId
      ?? `fixture://${this.identityOptions.sourceId ?? 'fixture-test'}/event-${index}`;

    return {
      events: [
        {
          eventId,
          position: resourcePosition,
          contentHash: resource.firstEventIdentity?.contentHash,
        },
      ],
      status: 'stable',
      exhausted: true,
      newPosition: resourcePosition + 1,
    };
  }
}

// ---------------------------------------------------------------------------
// External Session Log Source Adapter (opt-in, with pluggable reader)
// ---------------------------------------------------------------------------

/**
 * External Session Log Source Adapter — a Source Work Lane behind an
 * explicit opt-in (issue #76).
 *
 * Features:
 * - Pluggable ExternalSourceReader seam for #77–#79 (real readers)
 * - Durable external cursor persistence (separate from internal cursor state)
 * - Future-only bounded discovery (no historical backfill on enablement)
 * - Stable event identity and deduplication across restarts
 * - Source-bound continuity (events bound to this provider/source)
 * - Stability gate: pending ranges do not advance the cursor
 * - Disabled by default
 *
 * When no reader is set or the adapter is disabled: behaves as a no-op seam
 * (the existing #75 external stub behavior preserved).
 */
export class ExternalSessionLogSourceAdapter implements SessionLogSourceAdapter {
  readonly identity: SessionLogSourceIdentity;
  private readonly enabled: boolean;
  private readonly reader: ExternalSourceReader | null;
  private readonly cursorStorePath: string;

  constructor(
    options: {
      sourceId: string;
      label?: string;
      provider: string;
      reader?: ExternalSourceReader | string;
      enabled?: boolean;
    },
    cursorStorePath?: string,
  ) {
    const readerObj = typeof options.reader === 'object' ? options.reader : null;
    this.identity = {
      sourceId: options.sourceId,
      label: options.label ?? `External Source (${options.provider})`,
      category: 'external' as const,
      provider: options.provider,
      reader: readerObj?.reader ?? (typeof options.reader === 'string' ? options.reader : 'external'),
    };
    this.enabled = options.enabled ?? false;
    this.reader = readerObj ?? null;
    this.cursorStorePath = cursorStorePath ?? '';
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Set the cursor store path (called during RuntimeLearning construction). */
  setCursorStorePath(storePath: string): void {
    // Only allow setting once if empty; otherwise the path is immutable.
    if (!this.cursorStorePath) {
      (this as any).cursorStorePath = storePath;
    }
  }

  discoverResources(): readonly SessionLogSourceResource[] {
    if (!this.enabled) return [];
    if (!this.reader) return [];

    // Load the durable external cursor for this source.
    // The cursor determines what's "future" for discovery.
    const state = this.cursorStorePath
      ? loadExternalCursorState(this.cursorStorePath)
      : emptyExternalCursorState();
    const cursorEntry = state.cursors[this.identity.sourceId];
    const currentCursor = cursorEntry?.cursor ?? null;

    // Delegate to the reader, which applies future-only filtering
    // based on the cursor. A null cursor means fresh enablement —
    // only stable resources are returned (no backfill), enforced by
    // the reader contract.
    return this.reader.discoverResources(currentCursor);
  }

  read(
    resource: SessionLogSourceResource,
    _context: SessionLogSourceReadContext,
  ): SessionLogSourceReadResult {
    if (!this.enabled || !this.reader) {
      return {
        distillationUnit: null,
        advanced: false,
        status: 'disabled',
        newCursor: {
          resourceRef: resource.resourceRef,
          position: 0,
          processedCount: 0,
        },
      };
    }

    // Load cursor state for this source.
    const state = this.cursorStorePath
      ? loadExternalCursorState(this.cursorStorePath)
      : emptyExternalCursorState();
    const cursorEntry = state.cursors[this.identity.sourceId];
    const currentCursor: SourceCursor = cursorEntry?.cursor ?? {
      resourceRef: resource.resourceRef,
      position: -1,
      processedCount: 0,
    };

    // Create a resource-scoped cursor for the reader.
    const resourceCursor: SourceCursor = {
      resourceRef: resource.resourceRef,
      position: currentCursor.resourceRef === resource.resourceRef
        ? currentCursor.position
        : -1,
      processedCount: currentCursor.resourceRef === resource.resourceRef
        ? currentCursor.processedCount
        : 0,
    };

    let readerResult: ExternalSourceReaderResult;
    try {
      readerResult = this.reader.read(resource, resourceCursor);
    } catch (error) {
      this.markFailed(resource, error);
      return {
        distillationUnit: null,
        advanced: false,
        status: 'failed',
        newCursor: resourceCursor,
      };
    }

    // Pending or empty ranges must not advance the cursor (stability gate).
    if (readerResult.status === 'pending' || readerResult.events.length === 0) {
      return {
        distillationUnit: null,
        advanced: false,
        status: readerResult.exhausted ? 'exhausted' : 'idle',
        newCursor: resourceCursor,
      };
    }

    // Check for exact duplicates against the processed event ID set.
    const newEvents = readerResult.events.filter(event => {
      const existingHash = state.processedEventIds[event.eventId];
      if (existingHash === undefined) return true; // not seen before
      // If contentHash matches, it's an exact duplicate — skip.
      if (event.contentHash !== undefined && existingHash === event.contentHash) return false;
      // Different contentHash (or no contentHash) — treat as new event.
      return true;
    });

    if (newEvents.length === 0) {
      // All events were duplicates — acknowledge advancement but produce
      // no distillation unit.
      const newCursor: SourceCursor = {
        resourceRef: resource.resourceRef,
        position: readerResult.newPosition,
        processedCount: resourceCursor.processedCount,
      };
      return {
        distillationUnit: null,
        advanced: true,
        status: 'advanced',
        newCursor,
      };
    }

    // Associate identity metadata with the resource for the caller.
    // The caller (RuntimeLearning) will use this to construct the
    // DistillationUnit. For now, we return the raw event identity so
    // the adapter can embed it.
    //
    // Actual DistillationUnit construction from external raw events
    // requires a provider-specific converter (#77–#79). For the fixture
    // path, the FixtureExternalSourceReader provides pre-constructed
    // units through the FixtureSessionLogSourceAdapter.

    // Build a new cursor reflecting the advanced position.
    const newCursor: SourceCursor = {
      resourceRef: resource.resourceRef,
      position: readerResult.newPosition,
      processedCount: resourceCursor.processedCount + newEvents.length,
    };

    return {
      distillationUnit: null, // No converter yet — see #77–#79
      advanced: true,
      status: 'advanced',
      newCursor,
    };
  }

  acknowledge(resource: SessionLogSourceResource, result: SessionLogSourceReadResult): void {
    if (!this.cursorStorePath) return;
    try {
      const state = loadExternalCursorState(this.cursorStorePath);

      // Update cursor for this source.
      const updatedCursors = { ...state.cursors };
      updatedCursors[this.identity.sourceId] = {
        cursor: result.newCursor,
        updatedAt: new Date().toISOString(),
        lastStatus: result.status === 'advanced' ? 'stable' : undefined,
      };

      // Register processed event IDs from the resource's firstEventIdentity.
      // In #77–#79, the reader will supply per-event IDs; for now we
      // record the resource-level identity.
      const updatedEventIds = { ...state.processedEventIds };
      if (resource.firstEventIdentity) {
        updatedEventIds[resource.firstEventIdentity.eventId] =
          resource.firstEventIdentity.contentHash ?? '';
      }

      saveExternalCursorState(this.cursorStorePath, {
        ...emptyExternalCursorState(),
        cursors: updatedCursors,
        processedEventIds: updatedEventIds,
      });
    } catch (error) {
      Logger.warning(
        `[ExternalSessionLogSourceAdapter] failed to persist cursor for ${this.identity.sourceId}: ${toErrorMessage(error)}`,
      );
    }
  }

  markFailed(resource: SessionLogSourceResource, error: unknown): void {
    void resource;
    void error;
    Logger.warning(
      `[ExternalSessionLogSourceAdapter] ${this.identity.sourceId} resource failed: ${toErrorMessage(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Source Work Budget (per-source quotas, issue #77)
// ---------------------------------------------------------------------------

/**
 * Per-source work budget for external source lanes. Each source enforces
 * configurable event (resource), byte, and elapsed-time caps per wake so
 * a single chatty or runaway external source cannot starve internal
 * discovery or due settlement/review/retry work.
 *
 * When a quota is reached the source is marked 'quota_reached' and its
 * cursor is left resumable (resources examined but not acknowledged are
 * deferred to the next wake without false cursor advancement).
 */
export interface SourceWorkBudget {
  /** Max resources (e.g. conversations) to examine per wake. */
  readonly maxResourcesPerWake: number;
  /** Max bytes of source data to read per wake. */
  readonly maxBytesPerWake: number;
  /** Max wall-clock milliseconds to spend on this source per wake. */
  readonly maxElapsedMsPerWake: number;
}

/** Production-default budget for external session log sources. */
export const DEFAULT_EXTERNAL_SOURCE_BUDGET: SourceWorkBudget = {
  maxResourcesPerWake: 50,
  maxBytesPerWake: 1_048_576, // 1 MB
  maxElapsedMsPerWake: 30_000, // 30 s
};

// ---------------------------------------------------------------------------
// Source failure state (per-source backoff, issue #77)
// ---------------------------------------------------------------------------

/**
 * Per-source failure tracking for external source lanes. A provider failure
 * (missing reader, malformed data, transient unavailability) records
 * source-specific status, error context, and retry/backoff state WITHOUT
 * blocking internal or other enabled external source lanes.
 *
 * Failures are also isolated from candidate review failure accounting —
 * they never increment the Operational Retry counter or pollute the review
 * failure count.
 */
export interface SourceFailureState {
  /** Consecutive failures since last success. Resets to 0 on success. */
  readonly consecutiveFailures: number;
  /** ISO timestamp of the last failure, or null. */
  readonly lastFailedAt: string | null;
  /** Truncated error message from the last failure, or null. */
  readonly lastError: string | null;
  /**
   * ISO timestamp before which the source is suspended (skipped during
   * discovery). After the deadline, the source is retried on the next wake.
   */
  readonly suspendedUntil: string | null;
}

/**
 * Observable status of a source lane in the most recent discovery pass.
 */
export type SessionLogSourceStatus =
  | 'active'       // Processed normally with no budget/failure condition
  | 'quota_reached' // Per-source budget exhausted; remaining resources deferred
  | 'backoff'       // Source is in failure backoff (suspendedUntil not reached)
  | 'failed'        // Adapter threw on one or more resources this pass
  | 'drained';      // Source skipped due to graceful runtime drain

// ---------------------------------------------------------------------------
// Source report (for RuntimeLearning discovery)
// ---------------------------------------------------------------------------

export interface SessionLogSourceReport {
  readonly sourceId: string;
  readonly category: SessionLogSourceCategory;
  readonly enabled: boolean;
  readonly resourcesDiscovered: number;
  readonly unitsProcessed: number;
  readonly advancedResources: number;
  /** @internal Per-source status (used by source work lane in #77). */
  readonly status?: SessionLogSourceStatus;
  /** @internal Per-source failure state (issue #77). */
  readonly failureState?: SourceFailureState;
  /** @internal Per-source work budget applied (issue #77). */
  readonly budget?: SourceWorkBudget;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function resolveSessionLogsRoot(logsRoot: string): string {
  const normalizedRoot = path.resolve(logsRoot);
  return path.basename(normalizedRoot) === 'sessions'
    ? normalizedRoot
    : path.join(normalizedRoot, 'sessions');
}

function collectJsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectJsonlFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
  }
  return files.sort();
}
