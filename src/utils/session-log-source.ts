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
import * as os from 'os';
import { sanitizeProviderErrorMessageForLog } from './provider-error-log-sanitizer';

import {
  DistillationUnit,
  DistillationTurn,
  CrossFileContinuityOptions,
  extractDistillationUnit,
  MAX_CONTINUITY_TURNS,
} from './distillation-unit';
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
  readonly conversationId?: string;
  readonly branchId?: string;
  readonly revision?: string;
}

// ---------------------------------------------------------------------------
// Source cursor
// ---------------------------------------------------------------------------

export interface SourceCursor {
  readonly resourceRef: string;
  readonly position: number;
  readonly processedCount: number;
  readonly discardingOversizedLine?: boolean;
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

export type ExternalSourceFailureClass =
  | 'transient'
  | 'pending'
  | 'protocol'
  | 'permission'
  | 'integrity_conflict'
  | 'quarantine';

export interface ExternalSourceReadFailure {
  readonly failureClass: ExternalSourceFailureClass;
  readonly message: string;
  readonly resourceRef?: string;
  readonly eventIdentities?: readonly SourceEventIdentity[];
}

export interface SourceWorkAccounting {
  /** Stable source events admitted or examined during this read. */
  readonly events: number;
  /** Raw source bytes consumed, including oversized complete records. */
  readonly bytes: number;
  /** Monotonic elapsed time spent in the reader. */
  readonly elapsedMs: number;
}

export interface SessionLogSourceReadResult {
  readonly distillationUnit: DistillationUnit | null;
  readonly distillationUnits?: readonly DistillationUnit[];
  readonly advanced: boolean;
  /**
   * Release this resource from a bounded discovery page even when its cursor
   * did not advance. The durable cursor remains authoritative, so a partial
   * append is retried when the directory iterator reaches the file again.
   */
  readonly releaseResource?: boolean;
  readonly status: SessionLogSourceReadStatus;
  readonly newCursor: SourceCursor;
  readonly eventIdentities?: readonly SourceEventIdentity[];
  readonly failure?: ExternalSourceReadFailure;
  /** Persisted only for external lanes to preserve bounded same-branch continuity. */
  readonly continuityTail?: readonly DistillationTurn[];
  /** Whether the next admitted event still has a known continuity gap behind it. */
  readonly continuityIncomplete?: boolean;
  readonly accounting?: SourceWorkAccounting;
}

// ---------------------------------------------------------------------------
// Read context
// ---------------------------------------------------------------------------

export interface SessionLogSourceReadContext {
  readonly orderedResources: readonly SessionLogSourceResource[];
  /** Remaining per-source allowance for this specific read. */
  readonly remainingBudget?: SourceWorkBudget;
}

export interface SessionLogSourceDiscoveryContext {
  readonly maxResources?: number;
  readonly maxElapsedMs?: number;
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface SessionLogSourceAdapter {
  readonly identity: SessionLogSourceIdentity;
  isEnabled(): boolean;
  /** Reversibly enable/disable without deleting durable source state (issue #87). */
  setEnabled?(nextEnabled: boolean): void;
  /** Durable cursor-state location owned by an external adapter. */
  getCursorStorePath?(): string | undefined;
  /** Explicitly reports whether this adapter has a documented stable reader. */
  getSupportStatus?(): ExternalSourceFormatStatus;
  getUnsupportedReason?(): string | undefined;
  discoverResources(context?: SessionLogSourceDiscoveryContext): readonly SessionLogSourceResource[];
  read(
    resource: SessionLogSourceResource,
    context: SessionLogSourceReadContext,
  ): SessionLogSourceReadResult;
  acknowledge(resource: SessionLogSourceResource, result: SessionLogSourceReadResult): void;
  markFailed(resource: SessionLogSourceResource, error: unknown): void;
  close?(): void;
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

  private discoveryIterator: Generator<string | undefined, void, unknown> | null = null;
  private readonly pendingDiscoveredResources = new Map<string, SessionLogSourceResource>();
  private readonly predecessorByResource = new Map<string, string>();
  private previousDiscoveredResource: string | undefined;

  constructor(private readonly config: DistillationHeartbeatConfig) {}

  isEnabled(): boolean {
    return true;
  }

  discoverResources(context: SessionLogSourceDiscoveryContext = {}): readonly SessionLogSourceResource[] {
    const sessionLogsRoot = resolveSessionLogsRoot(this.config.logsRoot);
    if (!fs.existsSync(sessionLogsRoot) || !fs.statSync(sessionLogsRoot).isDirectory()) {
      return [];
    }
    const maxResources = Math.max(
      1,
      Math.floor(context.maxResources ?? DEFAULT_INTERNAL_SOURCE_BUDGET.maxResourcesPerWake),
    );
    const maxElapsedMs = Math.max(
      1,
      Math.floor(context.maxElapsedMs ?? DEFAULT_INTERNAL_SOURCE_BUDGET.maxElapsedMsPerWake),
    );
    const maxEntriesExamined = Math.max(maxResources, maxResources * 20);
    const startedAt = Date.now();
    let entriesExamined = 0;

    if (!this.discoveryIterator) {
      this.discoveryIterator = iterateJsonlDiscoveryEntries(sessionLogsRoot);
      this.previousDiscoveredResource = undefined;
    }

    while (
      this.pendingDiscoveredResources.size < maxResources
      && entriesExamined < maxEntriesExamined
      && (entriesExamined === 0 || Date.now() - startedAt < maxElapsedMs)
    ) {
      const next = this.discoveryIterator.next();
      entriesExamined++;
      if (next.done) {
        this.discoveryIterator = null;
        this.previousDiscoveredResource = undefined;
        break;
      }
      if (!next.value) continue;
      const filePath = next.value;
      if (this.previousDiscoveredResource) {
        this.predecessorByResource.set(filePath, this.previousDiscoveredResource);
      }
      this.previousDiscoveredResource = filePath;
      this.pendingDiscoveredResources.set(filePath, {
        resourceRef: filePath,
        firstEventIdentity: {
          eventId: filePath,
          position: 0,
        },
      });
    }

    return [...this.pendingDiscoveredResources.values()].slice(0, maxResources);
  }

  read(
    resource: SessionLogSourceResource,
    context: SessionLogSourceReadContext,
  ): SessionLogSourceReadResult {
    const filePath = resource.resourceRef;
    const startedAt = Date.now();
    const state = loadLogCursorState(this.config.stateFilePath);
    const cursor = getCursor(state, filePath);

    let extracted;
    try {
      const orderedFilePaths = context.orderedResources.map(r => r.resourceRef);
      const predecessor = this.predecessorByResource.get(filePath);
      if (predecessor && !orderedFilePaths.includes(predecessor)) {
        orderedFilePaths.unshift(predecessor);
      }
      const crossFileContinuity: CrossFileContinuityOptions = { orderedFilePaths };
      const remaining = context.remainingBudget;
      extracted = extractDistillationUnit(filePath, cursor, {
        crossFileContinuity,
        ...(remaining ? {
          quotas: {
            maxNewBytesPerUnit: Math.max(1, remaining.maxBytesPerWake),
            maxExtractionMs: Math.max(1, remaining.maxElapsedMsPerWake),
          },
        } : {}),
      });
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
          ...(cursor.discardingOversizedLine ? { discardingOversizedLine: true } : {}),
        },
        accounting: { events: 0, bytes: 0, elapsedMs: Date.now() - startedAt },
      };
    }

    const fileSizeAfterRead = fs.statSync(filePath).size;
    const waitingForPartialLine = !extracted.advanced
      && extracted.newCursor.byteOffset < fileSizeAfterRead;
    return {
      distillationUnit: extracted.distillationUnit,
      advanced: extracted.advanced,
      // Stable EOF can leave the current discovery page immediately. A
      // partial line is reported as idle, but is also rotated out of the page;
      // its unchanged cursor makes the incomplete tail retryable later.
      ...(!extracted.distillationUnit && !extracted.advanced ? { releaseResource: true } : {}),
      status: extracted.distillationUnit
        ? 'advanced'
        : (extracted.advanced ? 'advanced' : (waitingForPartialLine ? 'idle' : 'exhausted')),
      newCursor: {
        resourceRef: filePath,
        position: extracted.newCursor.byteOffset,
        processedCount: extracted.newCursor.processedTurnCount,
        ...(extracted.newCursor.discardingOversizedLine ? { discardingOversizedLine: true } : {}),
      },
      accounting: {
        events: extracted.newCursor.processedTurnCount - cursor.processedTurnCount,
        bytes: Math.max(0, extracted.newCursor.byteOffset - cursor.byteOffset),
        elapsedMs: Date.now() - startedAt,
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
      ...(result.newCursor.discardingOversizedLine ? { discardingOversizedLine: true } : {}),
    };
    advanceCursor(state, cursor);
    saveLogCursorState(this.config.stateFilePath, state);
    this.pendingDiscoveredResources.delete(resource.resourceRef);
    this.predecessorByResource.delete(resource.resourceRef);
  }

  markFailed(resource: SessionLogSourceResource, error: unknown): void {
    const state = loadLogCursorState(this.config.stateFilePath);
    const existing = getCursor(state, resource.resourceRef);
    markCursorFailed(state, resource.resourceRef, existing.byteOffset, error);
    saveLogCursorState(this.config.stateFilePath, state);
    // Rotate a failing resource behind the rest of the bounded discovery
    // cycle while preserving its cursor for retry on the next traversal.
    this.pendingDiscoveredResources.delete(resource.resourceRef);
    this.predecessorByResource.delete(resource.resourceRef);
  }

  close(): void {
    try { this.discoveryIterator?.return(); } catch { /* already closed */ }
    this.discoveryIterator = null;
    this.pendingDiscoveredResources.clear();
    this.predecessorByResource.clear();
    this.previousDiscoveredResource = undefined;
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
export type ExternalSourceFormatStatus = 'supported' | 'unsupported' | 'disabled';

export interface ExternalSourceIncrementalDiscoveryRequest {
  readonly cursor: SourceCursor | null;
  readonly pageToken?: string | null;
  readonly maxResources?: number;
}

export interface ExternalSourceActivationResource {
  readonly resource: SessionLogSourceResource;
  /**
   * Future-only activation boundary for this resource, expressed in the same
   * monotonic position space consumed by read().
   */
  readonly activationPosition: number;
}

export interface ExternalSourceIncrementalDiscoveryResult {
  readonly resources: readonly SessionLogSourceResource[];
  readonly activationResources?: readonly ExternalSourceActivationResource[];
  readonly nextPageToken?: string | null;
  readonly activationWatermarkPosition?: number;
}

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
   * Optional pagination-aware discovery used by continuous future-only lanes.
   * Readers that do not implement this hook keep the older one-shot behavior.
   */
  discoverIncremental?(
    request: ExternalSourceIncrementalDiscoveryRequest,
  ): ExternalSourceIncrementalDiscoveryResult;

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
  /** Optional raw byte accounting supplied by a stable provider reader. */
  readonly byteLength?: number;
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
  readonly conversationId?: string;
  readonly branchId?: string;
  readonly revision?: string;
  readonly distillationUnit?: DistillationUnit;
}

// ---------------------------------------------------------------------------
// External Cursor State (durable persistence per external source)
// ---------------------------------------------------------------------------

export interface ExternalSourceActivationState {
  readonly initializedAt: string;
  readonly mode: 'future-only-resource-baseline';
  readonly watermarkPosition?: number;
  readonly initialDiscoveryCompleted: boolean;
}

export interface ExternalSourceDiscoveryState {
  readonly nextPageToken: string | null;
  readonly nextResourceIndex: number;
  readonly updatedAt: string;
  readonly cycle: number;
}

export type ExternalResourceLifecycleStatus = 'active' | 'closed';

export interface ExternalDiscoveredResourceState {
  readonly resource: SessionLogSourceResource;
  readonly continuityTail: readonly DistillationTurn[];
  readonly continuityIncomplete: boolean;
  readonly updatedAt: string;
  readonly lifecycleStatus?: ExternalResourceLifecycleStatus;
  readonly lastSeenAt?: string;
  readonly lastSuccessfulReadAt?: string;
  readonly lastSeenDiscoveryCycle?: number;
  readonly missingDiscoveryCycles?: number;
  readonly missingSince?: string | null;
  readonly closedAt?: string;
  readonly closedReason?: 'archived_or_deleted';
}

export interface ExternalSourceQuarantineEntry {
  readonly quarantineId: string;
  readonly resourceRef: string;
  readonly sourceIdentity?: SessionLogSourceIdentity;
  readonly identity: SourceEventIdentity;
  readonly failureClass: Extract<ExternalSourceFailureClass, 'quarantine' | 'integrity_conflict'>;
  readonly message: string;
  readonly detectedAt: string;
  readonly cursorPosition: number;
}

export interface ExternalSourceTombstoneEntry {
  readonly tombstoneId: string;
  readonly resourceRef: string;
  readonly identity: SourceEventIdentity;
  readonly createdAt: string;
  readonly reason: string;
}

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
  readonly processedEventIds: Record<string, string | null>;
  /**
   * Stable mutation fingerprints keyed without content hash so rereads can
   * fail closed when an event changes under the same provider identity.
   */
  readonly processedEventFingerprints: Record<string, string>;
  readonly sourceIdentities: Record<string, SessionLogSourceIdentity>;
  readonly resources: Record<string, ExternalDiscoveredResourceState>;
  readonly quarantinedEvents: Record<string, ExternalSourceQuarantineEntry>;
  readonly tombstones: Record<string, ExternalSourceTombstoneEntry>;
  readonly activation: ExternalSourceActivationState | null;
  readonly discovery: ExternalSourceDiscoveryState | null;
  /** ISO timestamp of the last state save. */
  readonly updatedAt: string;
}

export interface ExternalCursorEntry {
  readonly cursor: SourceCursor;
  readonly sourceIdentity: SessionLogSourceIdentity;
  readonly updatedAt: string;
  /** Status of the last read from this resource. */
  readonly lastStatus?: 'stable' | 'pending' | 'exhausted' | 'activated';
}

export function emptyExternalCursorState(): ExternalCursorState {
  return {
    schemaVersion: 3,
    cursors: {},
    processedEventIds: {},
    processedEventFingerprints: {},
    sourceIdentities: {},
    resources: {},
    quarantinedEvents: {},
    tombstones: {},
    activation: null,
    discovery: null,
    updatedAt: new Date().toISOString(),
  };
}

export function loadExternalCursorState(storePath: string): ExternalCursorState {
  if (!fs.existsSync(storePath)) return emptyExternalCursorState();
  const raw = fs.readFileSync(storePath, 'utf-8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`external cursor state is corrupt: ${storePath}: ${String(error)}`);
  }
  const schemaVersion = Number(parsed.schemaVersion ?? 1);
  if (!Number.isFinite(schemaVersion) || schemaVersion < 1 || schemaVersion > 3) {
    throw new Error(`external cursor state schema is unsupported: ${String(parsed.schemaVersion)}`);
  }
  if (!parsed.cursors || typeof parsed.cursors !== 'object'
    || !parsed.processedEventIds || typeof parsed.processedEventIds !== 'object'
    || !parsed.sourceIdentities || typeof parsed.sourceIdentities !== 'object') {
    throw new Error(`external cursor state is structurally invalid: ${storePath}`);
  }
  for (const [key, value] of Object.entries(parsed.processedEventIds as Record<string, unknown>)) {
    if (value !== null && typeof value !== 'string') {
      throw new Error(`external cursor state has invalid dedup value for ${key}`);
    }
  }
  const processedEventFingerprints = parsed.processedEventFingerprints
    && typeof parsed.processedEventFingerprints === 'object'
    ? parsed.processedEventFingerprints as Record<string, unknown>
    : {};
  for (const [key, value] of Object.entries(processedEventFingerprints)) {
    if (typeof value !== 'string') {
      throw new Error(`external cursor state has invalid event fingerprint for ${key}`);
    }
  }
  const resources = parsed.resources && typeof parsed.resources === 'object'
    ? parsed.resources as Record<string, unknown>
    : {};
  const normalizedResources: Record<string, ExternalDiscoveredResourceState> = {};
  for (const [resourceRef, value] of Object.entries(resources)) {
    const record = value as Partial<ExternalDiscoveredResourceState> | null;
    if (!record || typeof record !== 'object' || !record.resource || typeof record.resource !== 'object') {
      throw new Error(`external cursor state has invalid resource metadata for ${resourceRef}`);
    }
    normalizedResources[resourceRef] = {
      resource: record.resource as SessionLogSourceResource,
      continuityTail: Array.isArray(record.continuityTail) ? record.continuityTail as DistillationTurn[] : [],
      continuityIncomplete: record.continuityIncomplete === true,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
      lifecycleStatus: record.lifecycleStatus === 'closed' ? 'closed' : 'active',
      ...(typeof record.lastSeenAt === 'string' ? { lastSeenAt: record.lastSeenAt } : {}),
      ...(typeof record.lastSuccessfulReadAt === 'string' ? { lastSuccessfulReadAt: record.lastSuccessfulReadAt } : {}),
      ...(typeof record.lastSeenDiscoveryCycle === 'number' && Number.isFinite(record.lastSeenDiscoveryCycle)
        ? { lastSeenDiscoveryCycle: Math.max(0, Math.floor(record.lastSeenDiscoveryCycle)) }
        : {}),
      ...(typeof record.missingDiscoveryCycles === 'number' && Number.isFinite(record.missingDiscoveryCycles)
        ? { missingDiscoveryCycles: Math.max(0, Math.floor(record.missingDiscoveryCycles)) }
        : {}),
      ...(typeof record.missingSince === 'string' || record.missingSince === null ? { missingSince: record.missingSince } : {}),
      ...(typeof record.closedAt === 'string' ? { closedAt: record.closedAt } : {}),
      ...(record.closedReason === 'archived_or_deleted' ? { closedReason: 'archived_or_deleted' as const } : {}),
    };
  }
  const quarantine = parsed.quarantinedEvents && typeof parsed.quarantinedEvents === 'object'
    ? parsed.quarantinedEvents as Record<string, unknown>
    : {};
  const tombstones = parsed.tombstones && typeof parsed.tombstones === 'object'
    ? parsed.tombstones as Record<string, unknown>
    : {};
  const normalizedQuarantine: Record<string, ExternalSourceQuarantineEntry> = {};
  for (const [quarantineId, value] of Object.entries(quarantine)) {
    const record = value as Partial<ExternalSourceQuarantineEntry> | null;
    if (!record || typeof record !== 'object' || !record.identity || typeof record.identity !== 'object') continue;
    normalizedQuarantine[quarantineId] = {
      quarantineId,
      resourceRef: typeof record.resourceRef === 'string' ? record.resourceRef : 'unknown-resource',
      ...(record.sourceIdentity && typeof record.sourceIdentity === 'object'
        ? { sourceIdentity: record.sourceIdentity as SessionLogSourceIdentity }
        : {}),
      identity: record.identity as SourceEventIdentity,
      failureClass: record.failureClass === 'integrity_conflict' ? 'integrity_conflict' : 'quarantine',
      message: typeof record.message === 'string' ? record.message : 'quarantined external event',
      detectedAt: typeof record.detectedAt === 'string' ? record.detectedAt : new Date().toISOString(),
      cursorPosition: typeof record.cursorPosition === 'number' && Number.isFinite(record.cursorPosition)
        ? Math.floor(record.cursorPosition)
        : -1,
    };
  }
  const normalizedTombstones: Record<string, ExternalSourceTombstoneEntry> = {};
  for (const [tombstoneId, value] of Object.entries(tombstones)) {
    const record = value as Partial<ExternalSourceTombstoneEntry> | null;
    if (!record || typeof record !== 'object' || !record.identity || typeof record.identity !== 'object') continue;
    normalizedTombstones[tombstoneId] = {
      tombstoneId: typeof record.tombstoneId === 'string' ? record.tombstoneId : tombstoneId,
      resourceRef: typeof record.resourceRef === 'string' ? record.resourceRef : 'unknown-resource',
      identity: record.identity as SourceEventIdentity,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
      reason: typeof record.reason === 'string' ? record.reason : 'operator skip',
    };
  }
  const activation = parsed.activation && typeof parsed.activation === 'object'
    ? parsed.activation as Partial<ExternalSourceActivationState>
    : null;
  const discovery = parsed.discovery && typeof parsed.discovery === 'object'
    ? parsed.discovery as Partial<ExternalSourceDiscoveryState>
    : null;
  return {
    schemaVersion: 3,
    cursors: parsed.cursors as Record<string, ExternalCursorEntry>,
    processedEventIds: parsed.processedEventIds as Record<string, string | null>,
    processedEventFingerprints: processedEventFingerprints as Record<string, string>,
    sourceIdentities: parsed.sourceIdentities as Record<string, SessionLogSourceIdentity>,
    resources: normalizedResources,
    quarantinedEvents: normalizedQuarantine,
    tombstones: normalizedTombstones,
    activation: activation
      ? {
        initializedAt: typeof activation.initializedAt === 'string' ? activation.initializedAt : new Date().toISOString(),
        mode: 'future-only-resource-baseline',
        ...(typeof activation.watermarkPosition === 'number' ? { watermarkPosition: Math.floor(activation.watermarkPosition) } : {}),
        initialDiscoveryCompleted: activation.initialDiscoveryCompleted === true,
      }
      : null,
    discovery: discovery
      ? {
        nextPageToken: typeof discovery.nextPageToken === 'string' ? discovery.nextPageToken : null,
        nextResourceIndex: typeof discovery.nextResourceIndex === 'number' && Number.isFinite(discovery.nextResourceIndex)
          ? Math.max(0, Math.floor(discovery.nextResourceIndex))
          : 0,
        updatedAt: typeof discovery.updatedAt === 'string' ? discovery.updatedAt : new Date().toISOString(),
        cycle: typeof discovery.cycle === 'number' && Number.isFinite(discovery.cycle)
          ? Math.max(0, Math.floor(discovery.cycle))
          : 0,
      }
      : null,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

export function saveExternalCursorState(
  storePath: string,
  state: ExternalCursorState,
): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const payload = {
    schemaVersion: 3,
    cursors: state.cursors,
    processedEventIds: state.processedEventIds,
    processedEventFingerprints: state.processedEventFingerprints,
    sourceIdentities: state.sourceIdentities,
    resources: state.resources,
    quarantinedEvents: state.quarantinedEvents,
    tombstones: state.tombstones,
    activation: state.activation,
    discovery: state.discovery,
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
      // Fresh enablement — explicit backfill only. No historical emit on first
      // enablement when no durable cursor exists.
      return [];
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
          distillationUnit: unit ?? undefined,
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
  private enabled: boolean;
  private readonly reader: ExternalSourceReader | null;
  private cursorStorePath: string;

  constructor(
    options: {
      sourceId: string;
      label?: string;
      provider: string;
      reader?: ExternalSourceReader | string;
      cursorStorePath?: string;
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
    this.cursorStorePath = (cursorStorePath
      ?? options.cursorStorePath
      ?? resolveExternalCursorStorePath({
        provider: options.provider,
        sourceId: options.sourceId,
      }))
      ?? '';
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Reversibly enable/disable the adapter without deleting durable source
     * state (issue #87). Disabling preserves cursor/quarantine/tombstone/
   * capsule state for later re-enablement.
   */
  setEnabled(nextEnabled: boolean): void {
    this.enabled = nextEnabled;
  }

  getSupportStatus(): ExternalSourceFormatStatus {
    if (!this.enabled) return 'disabled';
    return this.reader ? 'supported' : 'unsupported';
  }

  getUnsupportedReason(): string | undefined {
    return this.reader ? undefined
      : `provider ${this.identity.provider} has no documented stable reader format; explicit backfill is required`;
  }

  /** Set the cursor store path (called during RuntimeLearning construction). */
  setCursorStorePath(storePath: string): void {
    if (!this.cursorStorePath) {
      this.cursorStorePath = storePath;
    }
  }

  getCursorStorePath(): string | undefined {
    return this.cursorStorePath || undefined;
  }

  discoverResources(context: SessionLogSourceDiscoveryContext = {}): readonly SessionLogSourceResource[] {
    if (!this.enabled) return [];
    if (!this.reader) return [];

    const maxResources = Math.max(1, Math.floor(context.maxResources ?? DEFAULT_EXTERNAL_SOURCE_BUDGET.maxResourcesPerWake));
    const state = this.cursorStorePath
      ? loadExternalCursorState(this.cursorStorePath)
      : emptyExternalCursorState();
    const withIdentity = registerExternalSourceIdentity(state, this.identity);

    if (!withIdentity.activation) {
      if (!hasAnyPersistedExternalProgress(withIdentity, this.identity)) {
        const initialized = this.initializeFutureOnlyActivation(withIdentity, maxResources);
        this.persistExternalState(initialized);
        return [];
      }
      const migrated = {
        ...withIdentity,
        activation: {
          initializedAt: new Date().toISOString(),
          mode: 'future-only-resource-baseline' as const,
          initialDiscoveryCompleted: true,
        },
        discovery: {
          nextPageToken: null,
          nextResourceIndex: 0,
          updatedAt: new Date().toISOString(),
          cycle: 0,
        },
      };
      const selection = selectExternalResourcesForWake(this.refreshDiscoveryPage(migrated, maxResources), maxResources);
      this.persistExternalState(selection.state);
      return selection.resources;
    }

    const discovered = this.refreshDiscoveryPage(withIdentity, maxResources);
    const selection = selectExternalResourcesForWake(discovered, maxResources);
    this.persistExternalState(selection.state);
    return selection.resources;
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

    const state = this.cursorStorePath
      ? loadExternalCursorState(this.cursorStorePath)
      : emptyExternalCursorState();
    const resourceState = state.resources[resource.resourceRef];
    const sourceCursor = readCursorWithSourceIdentityValidation(state, this.identity, resource.resourceRef);
    const resourceCursor: SourceCursor = sourceCursor
      ? { ...sourceCursor, resourceRef: resource.resourceRef }
      : {
          resourceRef: resource.resourceRef,
          position: -1,
          processedCount: 0,
        };

    let readerResult: ExternalSourceReaderResult;
    try {
      readerResult = this.reader.read(resource, resourceCursor);
    } catch (error) {
      const message = redactExternalSourceDiagnostic(error);
      this.markFailed(resource, error);
      return {
        distillationUnit: null,
        advanced: false,
        status: 'failed',
        newCursor: resourceCursor,
        failure: {
          failureClass: classifyExternalSourceFailureMessage(message),
          message,
          resourceRef: resource.resourceRef,
        },
      };
    }

    if (readerResult.status === 'pending' || readerResult.events.length === 0) {
      return {
        distillationUnit: null,
        advanced: false,
        status: readerResult.exhausted ? 'exhausted' : 'idle',
        newCursor: resourceCursor,
      };
    }

    // A durable operator tombstone authorizes crossing this stable event
    // identity even if the provider later changes its revision/hash. Apply it
    // before mutation checks; otherwise a skipped event can never unblock the
    // cursor after an integrity-conflict quarantine.
    const unskippedEvents = readerResult.events.filter(
      event => !isSkippedExternalEvent(state, this.identity, event),
    );
    const conflict = unskippedEvents.find(event => hasExternalEventConflict(state, this.identity, event));
    if (conflict) {
      return {
        distillationUnit: null,
        advanced: false,
        status: 'failed',
        eventIdentities: readerResult.events.map(toEventIdentity),
        newCursor: resourceCursor,
        failure: {
          failureClass: 'integrity_conflict',
          message: redactExternalSourceDiagnostic(`external event changed under the same identity: ${conflict.eventId}`),
          resourceRef: resource.resourceRef,
          eventIdentities: [toEventIdentity(conflict)],
        },
      };
    }

    if (resourceState?.resource.firstEventIdentity?.branchId && unskippedEvents.some(event =>
      event.branchId
      && event.branchId !== resourceState.resource.firstEventIdentity?.branchId)) {
      return {
        distillationUnit: null,
        advanced: false,
        status: 'failed',
        eventIdentities: readerResult.events.map(toEventIdentity),
        newCursor: resourceCursor,
        failure: {
          failureClass: 'integrity_conflict',
          message: redactExternalSourceDiagnostic(`external branch identity changed for ${resource.resourceRef}`),
          resourceRef: resource.resourceRef,
          eventIdentities: readerResult.events.map(toEventIdentity),
        },
      };
    }

    const nonDuplicateEvents = unskippedEvents.filter(
      event => !isDuplicateExternalEvent(state, this.identity, event),
    );
    const accounting: SourceWorkAccounting = {
      events: readerResult.events.length,
      bytes: readerResult.byteLength ?? readerResult.events.reduce(
        (sum, event) => sum + Buffer.byteLength(JSON.stringify(event.distillationUnit ?? event), 'utf8'),
        0,
      ),
      elapsedMs: 0,
    };

    if (nonDuplicateEvents.length === 0) {
      const newCursor: SourceCursor = {
        resourceRef: resource.resourceRef,
        position: readerResult.newPosition,
        processedCount: resourceCursor.processedCount,
      };
      return {
        distillationUnit: null,
        advanced: true,
        status: 'advanced',
        eventIdentities: readerResult.events.map(toEventIdentity),
        newCursor,
        continuityTail: resourceState?.continuityTail,
        continuityIncomplete: resourceState?.continuityIncomplete,
        accounting,
      };
    }

    const missingUnit = nonDuplicateEvents.find(event => !event.distillationUnit);
    if (missingUnit) {
      return {
        distillationUnit: null,
        advanced: false,
        status: 'failed',
        newCursor: resourceCursor,
        eventIdentities: nonDuplicateEvents.map(toEventIdentity),
        failure: {
          failureClass: 'quarantine',
          message: redactExternalSourceDiagnostic(`stable external event is missing a verified DistillationUnit: ${missingUnit.eventId}`),
          resourceRef: resource.resourceRef,
          eventIdentities: [toEventIdentity(missingUnit)],
        },
      };
    }

    const newCursor: SourceCursor = {
      resourceRef: resource.resourceRef,
      position: readerResult.newPosition,
      processedCount: resourceCursor.processedCount + nonDuplicateEvents.length,
    };

    let continuityTail = [...(resourceState?.continuityTail ?? [])];
    const distillationUnits = nonDuplicateEvents.map(event => {
      const unit = (event as ExternalSourceRawEvent & { distillationUnit: DistillationUnit }).distillationUnit;
      const withContinuity: DistillationUnit = {
        ...unit,
        continuityTurns: continuityTail.slice(-MAX_CONTINUITY_TURNS),
      };
      continuityTail = buildExternalContinuityTail(continuityTail, withContinuity.newTurns);
      return withContinuity;
    });

    return {
      distillationUnit: distillationUnits[0] ?? null,
      distillationUnits,
      advanced: true,
      status: 'advanced',
      eventIdentities: nonDuplicateEvents.map(toEventIdentity),
      newCursor,
      continuityTail,
      continuityIncomplete: false,
      accounting,
    };
  }

  acknowledge(resource: SessionLogSourceResource, result: SessionLogSourceReadResult): void {
    if (!this.cursorStorePath) return;
    const state = registerExternalSourceIdentity(loadExternalCursorState(this.cursorStorePath), this.identity);
    const now = new Date().toISOString();

    const updatedCursors = { ...state.cursors };
    const resourceEntry: ExternalCursorEntry = {
      cursor: result.newCursor,
      sourceIdentity: this.identity,
      updatedAt: now,
      lastStatus: result.status === 'advanced'
        ? 'stable'
        : (state.cursors[resource.resourceRef]?.lastStatus ?? 'exhausted'),
    };
    updatedCursors[resource.resourceRef] = resourceEntry;
    updatedCursors[this.identity.sourceId] = resourceEntry;

    const updatedEventIds = { ...state.processedEventIds };
    const updatedFingerprints = { ...state.processedEventFingerprints };
    const identities = result.eventIdentities ?? (resource.firstEventIdentity ? [resource.firstEventIdentity] : []);
    for (const identity of identities) {
      updatedEventIds[buildExternalEventDedupKey(this.identity, identity)] = normalizeContentHash(identity.contentHash);
      updatedFingerprints[buildExternalStableEventKey(this.identity, identity)] = fingerprintEventIdentity(identity);
    }

    const existingResource = state.resources[resource.resourceRef];
    const updatedResources = {
      ...state.resources,
      [resource.resourceRef]: {
        resource,
        continuityTail: result.continuityTail ?? existingResource?.continuityTail ?? [],
        continuityIncomplete: result.continuityIncomplete ?? existingResource?.continuityIncomplete ?? false,
        updatedAt: now,
        lifecycleStatus: existingResource?.lifecycleStatus ?? 'active',
        lastSeenAt: existingResource?.lastSeenAt ?? now,
        lastSeenDiscoveryCycle: existingResource?.lastSeenDiscoveryCycle,
        missingDiscoveryCycles: 0,
        missingSince: null,
        lastSuccessfulReadAt: now,
      },
    };

    const sourceIdentities = {
      ...state.sourceIdentities,
      [this.identity.sourceId]: this.identity,
    };

    saveExternalCursorState(this.cursorStorePath, {
      ...state,
      cursors: updatedCursors,
      sourceIdentities,
      resources: updatedResources,
      processedEventIds: updatedEventIds,
      processedEventFingerprints: updatedFingerprints,
      updatedAt: now,
    });
  }

  markFailed(resource: SessionLogSourceResource, error: unknown): void {
    void resource;
    Logger.warning(
      `[ExternalSessionLogSourceAdapter] ${this.identity.sourceId} resource failed: ${redactExternalSourceDiagnostic(error)}`,
    );
  }

  private initializeFutureOnlyActivation(
    state: ExternalCursorState,
    maxResources: number,
  ): ExternalCursorState {
    const cycle = 1;
    const discovery = this.discoverIncrementalPage(state, null, null, maxResources);
    let withResources = applyExternalDiscoveryPage(state, this.identity, discovery, cycle);
    if (discovery.nextPageToken == null) {
      withResources = finalizeExternalDiscoveryCycle(withResources, cycle);
    }
    return {
      ...withResources,
      activation: {
        initializedAt: new Date().toISOString(),
        mode: 'future-only-resource-baseline',
        ...(typeof discovery.activationWatermarkPosition === 'number'
          ? { watermarkPosition: Math.floor(discovery.activationWatermarkPosition) }
          : {}),
        initialDiscoveryCompleted: discovery.nextPageToken == null,
      },
      discovery: {
        nextPageToken: discovery.nextPageToken ?? null,
        nextResourceIndex: 0,
        updatedAt: new Date().toISOString(),
        cycle,
      },
    };
  }

  private refreshDiscoveryPage(
    state: ExternalCursorState,
    maxResources: number,
  ): ExternalCursorState {
    const discoveryState = state.discovery;
    const startingNewCycle = (discoveryState?.nextPageToken ?? null) == null;
    const cycle = startingNewCycle
      ? Math.max(1, (discoveryState?.cycle ?? 0) + 1)
      : Math.max(1, discoveryState?.cycle ?? 1);
    const discovery = this.discoverIncrementalPage(
      state,
      maxPersistedSourceCursor(state, this.identity),
      discoveryState?.nextPageToken ?? null,
      maxResources,
    );
    let refreshed = applyExternalDiscoveryPage(state, this.identity, discovery, cycle);
    if (discovery.nextPageToken == null) {
      refreshed = finalizeExternalDiscoveryCycle(refreshed, cycle);
    }
    const initialDiscoveryCompleted = state.activation?.initialDiscoveryCompleted === true
      || discovery.nextPageToken == null;
    return {
      ...refreshed,
      activation: state.activation
        ? {
          ...state.activation,
          initialDiscoveryCompleted,
          ...(typeof discovery.activationWatermarkPosition === 'number'
            ? { watermarkPosition: Math.floor(discovery.activationWatermarkPosition) }
            : {}),
        }
        : state.activation,
      discovery: {
        nextPageToken: discovery.nextPageToken ?? null,
        nextResourceIndex: discoveryState?.nextResourceIndex ?? 0,
        updatedAt: new Date().toISOString(),
        cycle,
      },
    };
  }

  private discoverIncrementalPage(
    state: ExternalCursorState,
    cursor: SourceCursor | null,
    pageToken: string | null,
    maxResources: number,
  ): ExternalSourceIncrementalDiscoveryResult {
    if (this.reader?.discoverIncremental) {
      return this.reader.discoverIncremental({
        cursor,
        pageToken,
        maxResources,
      });
    }
    const resources = this.reader?.discoverResources(cursor) ?? [];
    return {
      resources,
      activationResources: resources.map(resource => ({
        resource,
        activationPosition: normalizeActivationPosition(resource.firstEventIdentity?.position),
      })),
      nextPageToken: null,
    };
  }

  private persistExternalState(state: ExternalCursorState): void {
    if (!this.cursorStorePath) return;
    saveExternalCursorState(this.cursorStorePath, state);
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

/** Internal logs receive the same hard lane guarantees as optional sources. */
export const DEFAULT_INTERNAL_SOURCE_BUDGET: SourceWorkBudget = {
  maxResourcesPerWake: 50,
  maxBytesPerWake: 2 * 1024 * 1024,
  maxElapsedMsPerWake: 5_000,
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
  readonly failureClass?: ExternalSourceFailureClass;
  readonly nextRetryAt?: string | null;
  readonly requiresOperatorAction?: boolean;
  readonly resourceRef?: string;
  readonly eventId?: string;
  readonly lastAttemptedAt?: string | null;
  readonly lastSuccessfulReadAt?: string | null;
}

/**
 * Observable status of a source lane in the most recent discovery pass.
 */
export type SessionLogSourceStatus =
  | 'active'       // Processed normally with no budget/failure condition
  | 'quota_reached' // Per-source budget exhausted; remaining resources deferred
  | 'backoff'       // Source is in failure backoff (suspendedUntil not reached)
  | 'failed'        // Adapter threw on one or more resources this pass
  | 'locked'        // Another process owns the provider-scoped single-writer lock
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
  readonly accounting?: SourceWorkAccounting;
  /** Stable-reader support is explicit; unsupported enabled lanes are visible. */
  readonly supportStatus?: ExternalSourceFormatStatus;
  readonly unsupportedReason?: string;
  readonly provider?: string;
  readonly reader?: string;
  readonly selectedProvider?: string;
  readonly cursorProgress?: {
    readonly maxPosition: number;
    readonly activeResources: number;
    readonly closedResources: number;
    readonly quarantinedEvents: number;
    readonly tombstones: number;
  };
  readonly lastSuccessfulReadAt?: string;
  readonly nextRetryAt?: string | null;
  readonly lastError?: string;
  readonly failureClass?: ExternalSourceFailureClass;
  readonly requiresOperatorAction?: boolean;
  readonly nextAction?: 'wait_for_retry' | 'retry_next_wake' | 'repair_source_then_retry' | 'retry_or_skip_quarantine';
  readonly drainState?: 'idle' | 'draining';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function redactExternalSourceDiagnostic(error: unknown, maxLength = 240): string {
  const normalized = sanitizeProviderErrorMessageForLog(error)
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\s]*/g, '<path>')
    .replace(/\/(?:Users|home|tmp|private|var\/log)\/[^\s)]+/g, '<path>')
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function classifyExternalSourceFailureMessage(message: string): ExternalSourceFailureClass {
  const normalized = message.toLowerCase();
  if (/quarantine|external evidence limit|oversized|unsafe/.test(normalized)) return 'quarantine';
  if (/integrity|changed under the same identity|branch identity changed/.test(normalized)) return 'integrity_conflict';
  if (/protocol|json|schema|provider mismatch|unsupported/.test(normalized)) return 'protocol';
  if (/auth|unauthori|forbidden|permission denied|access denied/.test(normalized)) return 'permission';
  if (/pending/.test(normalized)) return 'pending';
  return 'transient';
}

function resolveSessionLogsRoot(logsRoot: string): string {
  const normalizedRoot = path.resolve(logsRoot);
  return path.basename(normalizedRoot) === 'sessions'
    ? normalizedRoot
    : path.join(normalizedRoot, 'sessions');
}

function* iterateJsonlDiscoveryEntries(root: string): Generator<string | undefined, void, unknown> {
  const openDirectories: fs.Dir[] = [];
  try {
    openDirectories.push(fs.opendirSync(root));
    while (openDirectories.length > 0) {
      const current = openDirectories[openDirectories.length - 1]!;
      const entry = current.readSync();
      if (!entry) {
        current.closeSync();
        openDirectories.pop();
        continue;
      }
      const fullPath = path.join(current.path, entry.name);
      if (entry.isDirectory()) {
        try {
          openDirectories.push(fs.opendirSync(fullPath));
        } catch {
          // A disappearing/inaccessible directory is source-local noise. The
          // next complete traversal can retry it.
        }
        yield undefined;
        continue;
      }
      yield entry.isFile() && entry.name.endsWith('.jsonl') ? fullPath : undefined;
    }
  } finally {
    for (const directory of openDirectories.reverse()) {
      try { directory.closeSync(); } catch { /* already closed */ }
    }
  }
}

/**
 * Make source identity values deterministic and safe for filename fragments.
 */
function sanitizeSourceToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'source';
}

/**
 * Default durable cursor store path for adapters that do not explicitly configure
 * a cursor state path.
 */
export function resolveExternalCursorStorePath(args: {
  provider: string;
  sourceId: string;
}): string {
  const configuredRuntimeRoot = [
    process.env.XIAOBA_USER_DATA_DIR,
    process.env.CATSCO_USER_DATA_DIR,
    process.env.XIAOBA_ELECTRON_USER_DATA_DIR,
    process.env.XIAOBA_RUNTIME_ROOT,
  ].map(value => String(value || '').trim()).find(Boolean);
  const cursorRoot = configuredRuntimeRoot
    ? path.join(path.resolve(configuredRuntimeRoot), 'data')
    : path.join(os.tmpdir(), 'xiaoba-external-cursors');
  return path.join(
    cursorRoot,
    sanitizeSourceToken(args.provider),
    `${sanitizeSourceToken(args.sourceId)}.json`,
  );
}

/**
 * Read a persisted source cursor only when the persisted identity matches the
 * adapter identity. If identity drift is detected, we restart from future-only.
 */
function maxPersistedSourceCursor(
  state: ExternalCursorState,
  identity: SessionLogSourceIdentity,
): SourceCursor | null {
  const entries = Object.values(state.cursors).filter(entry =>
    entry.sourceIdentity?.sourceId === identity.sourceId
    && entry.sourceIdentity.provider === identity.provider
    && entry.sourceIdentity.reader === identity.reader,
  );
  if (entries.length === 0) return null;
  return entries.reduce((best, entry) => entry.cursor.position > best.position ? entry.cursor : best, entries[0].cursor);
}

function readCursorWithSourceIdentityValidation(
  state: ExternalCursorState,
  identity: SessionLogSourceIdentity,
  resourceRef?: string,
): SourceCursor | null {
  const entry = (resourceRef ? state.cursors[resourceRef] : undefined)
    ?? state.cursors[identity.sourceId];
  if (!entry) return null;

  if (!entry.sourceIdentity) return null;
  const persisted = entry.sourceIdentity;
  if (
    persisted.sourceId !== identity.sourceId
    || persisted.provider !== identity.provider
    || persisted.category !== identity.category
    || persisted.reader !== identity.reader
  ) {
    return null;
  }

  return entry.cursor;
}

function registerExternalSourceIdentity(
  state: ExternalCursorState,
  identity: SessionLogSourceIdentity,
): ExternalCursorState {
  if (state.sourceIdentities[identity.sourceId]?.provider === identity.provider
    && state.sourceIdentities[identity.sourceId]?.reader === identity.reader) {
    return state;
  }
  return {
    ...state,
    sourceIdentities: {
      ...state.sourceIdentities,
      [identity.sourceId]: identity,
    },
  };
}

function hasAnyPersistedExternalProgress(
  state: ExternalCursorState,
  identity: SessionLogSourceIdentity,
): boolean {
  return Object.values(state.cursors).some(entry =>
    entry.sourceIdentity?.sourceId === identity.sourceId
    && entry.sourceIdentity.provider === identity.provider
    && entry.sourceIdentity.reader === identity.reader,
  ) || Object.keys(state.processedEventIds).length > 0 || Object.keys(state.resources).length > 0;
}

function applyExternalDiscoveryPage(
  state: ExternalCursorState,
  identity: SessionLogSourceIdentity,
  discovery: ExternalSourceIncrementalDiscoveryResult,
  cycle: number,
): ExternalCursorState {
  let nextState = registerExternalSourceIdentity(state, identity);
  const activationResources = discovery.activationResources
    ?? discovery.resources.map(resource => ({
      resource,
      activationPosition: normalizeActivationPosition(resource.firstEventIdentity?.position),
    }));
  const now = new Date().toISOString();
  const nextResources = { ...nextState.resources };
  const nextCursors = { ...nextState.cursors };

  for (const item of activationResources) {
    const existing = nextResources[item.resource.resourceRef];
    nextResources[item.resource.resourceRef] = {
      resource: item.resource,
      continuityTail: existing?.continuityTail ?? [],
      continuityIncomplete: existing?.continuityIncomplete ?? (item.activationPosition > -1),
      updatedAt: now,
      lifecycleStatus: existing?.lifecycleStatus ?? 'active',
      lastSeenAt: now,
      lastSeenDiscoveryCycle: cycle,
      missingDiscoveryCycles: 0,
      missingSince: null,
      ...(existing?.lastSuccessfulReadAt ? { lastSuccessfulReadAt: existing.lastSuccessfulReadAt } : {}),
      ...(existing?.closedAt ? { closedAt: existing.closedAt } : {}),
      ...(existing?.closedReason ? { closedReason: existing.closedReason } : {}),
    };
    const existingCursor = readCursorWithSourceIdentityValidation(nextState, identity, item.resource.resourceRef);
    if (!existingCursor) {
      nextCursors[item.resource.resourceRef] = {
        cursor: {
          resourceRef: item.resource.resourceRef,
          position: item.activationPosition,
          processedCount: 0,
        },
        sourceIdentity: identity,
        updatedAt: now,
        lastStatus: 'activated',
      };
    }
  }

  return {
    ...nextState,
    resources: nextResources,
    cursors: nextCursors,
    updatedAt: now,
  };
}

function finalizeExternalDiscoveryCycle(
  state: ExternalCursorState,
  cycle: number,
): ExternalCursorState {
  const now = new Date().toISOString();
  let changed = false;
  const nextResources: Record<string, ExternalDiscoveredResourceState> = {};
  for (const [resourceRef, resourceState] of Object.entries(state.resources)) {
    if (resourceState.lastSeenDiscoveryCycle === cycle) {
      nextResources[resourceRef] = resourceState;
      continue;
    }
    const missingDiscoveryCycles = (resourceState.missingDiscoveryCycles ?? 0) + 1;
    const shouldClose = missingDiscoveryCycles >= 2;
    nextResources[resourceRef] = {
      ...resourceState,
      lifecycleStatus: shouldClose ? 'closed' : (resourceState.lifecycleStatus ?? 'active'),
      missingDiscoveryCycles,
      missingSince: resourceState.missingSince ?? now,
      ...(shouldClose ? { closedAt: resourceState.closedAt ?? now, closedReason: 'archived_or_deleted' as const } : {}),
      updatedAt: now,
    };
    changed = true;
  }
  if (!changed) return state;
  return {
    ...state,
    resources: nextResources,
    updatedAt: now,
  };
}

function selectExternalResourcesForWake(
  state: ExternalCursorState,
  maxResources: number,
): { state: ExternalCursorState; resources: readonly SessionLogSourceResource[] } {
  const resourceRefs = Object.keys(state.resources)
    .sort()
    .filter(resourceRef => state.resources[resourceRef]?.lifecycleStatus !== 'closed')
    .filter(resourceRef => !hasBlockingQuarantineForResource(state, resourceRef));
  if (resourceRefs.length === 0) return { state, resources: [] };
  const start = state.discovery?.nextResourceIndex ?? 0;
  const count = Math.min(Math.max(0, maxResources), resourceRefs.length);
  const selected: SessionLogSourceResource[] = [];
  for (let offset = 0; offset < count; offset++) {
    const ref = resourceRefs[(start + offset) % resourceRefs.length]!;
    selected.push(state.resources[ref]!.resource);
  }
  const nextIndex = resourceRefs.length === 0 ? 0 : (start + selected.length) % resourceRefs.length;
  return {
    resources: selected,
    state: {
      ...state,
      discovery: {
        nextPageToken: state.discovery?.nextPageToken ?? null,
        nextResourceIndex: nextIndex,
        updatedAt: new Date().toISOString(),
        cycle: state.discovery?.cycle ?? 0,
      },
    },
  };
}

function normalizeActivationPosition(position: number | undefined): number {
  if (!Number.isFinite(position)) return -1;
  return Math.max(-1, Math.floor(position!));
}

function buildExternalContinuityTail(
  priorTail: readonly DistillationTurn[],
  newTurns: readonly DistillationTurn[],
): DistillationTurn[] {
  return [...priorTail, ...newTurns].slice(-MAX_CONTINUITY_TURNS);
}

/**
 * Canonical event identity used for stable external dedup state.
 */
function toEventIdentity(event: ExternalSourceRawEvent): SourceEventIdentity {
  return {
    eventId: event.eventId,
    position: event.position,
    contentHash: event.contentHash,
    conversationId: event.conversationId,
    branchId: event.branchId,
    revision: event.revision,
  };
}

export function buildExternalStableEventKey(
  sourceIdentity: SessionLogSourceIdentity,
  identity: SourceEventIdentity,
): string {
  return [
    sourceIdentity.sourceId,
    sourceIdentity.provider,
    identity.eventId,
    identity.position,
    identity.conversationId ?? '',
    identity.branchId ?? '',
  ].join('::');
}

function fingerprintEventIdentity(identity: SourceEventIdentity): string {
  return [identity.revision ?? '', normalizeContentHash(identity.contentHash) ?? ''].join('::');
}

/**
 * Stable, strict dedup key includes source identity + event identity fields.
 */
export function buildExternalEventDedupKey(
  sourceIdentity: SessionLogSourceIdentity,
  identity: SourceEventIdentity,
): string {
  const conversationPart = identity.conversationId ? `|conversation=${identity.conversationId}` : '';
  const branchPart = identity.branchId ? `|branch=${identity.branchId}` : '';
  const revisionPart = identity.revision ? `|revision=${identity.revision}` : '';
  return [
    sourceIdentity.sourceId,
    sourceIdentity.provider,
    identity.eventId,
    identity.position,
    conversationPart,
    branchPart,
    revisionPart,
    normalizeContentHash(identity.contentHash) ?? '',
  ].join('::');
}

function normalizeContentHash(contentHash: string | undefined): string | null {
  return contentHash ? String(contentHash) : null;
}

function hasExternalEventConflict(
  state: ExternalCursorState,
  sourceIdentity: SessionLogSourceIdentity,
  event: ExternalSourceRawEvent,
): boolean {
  const identity = toEventIdentity(event);
  const storedFingerprint = state.processedEventFingerprints[buildExternalStableEventKey(sourceIdentity, identity)];
  if (!storedFingerprint) return false;
  return storedFingerprint !== fingerprintEventIdentity(identity);
}

function isDuplicateExternalEvent(
  state: ExternalCursorState,
  sourceIdentity: SessionLogSourceIdentity,
  event: ExternalSourceRawEvent,
): boolean {
  const identity = toEventIdentity(event);
  const normalizedHash = normalizeContentHash(identity.contentHash);

  const key = buildExternalEventDedupKey(sourceIdentity, identity);
  if (Object.prototype.hasOwnProperty.call(state.processedEventIds, key)) {
    return state.processedEventIds[key] === normalizedHash;
  }

  // Backward compatibility: allow older states that only keyed by raw event id.
  if (!Object.prototype.hasOwnProperty.call(state.processedEventIds, identity.eventId)) return false;
  return state.processedEventIds[identity.eventId] === normalizedHash;
}

function isSkippedExternalEvent(
  state: ExternalCursorState,
  sourceIdentity: SessionLogSourceIdentity,
  event: ExternalSourceRawEvent,
): boolean {
  const identity = toEventIdentity(event);
  return Object.prototype.hasOwnProperty.call(
    state.tombstones,
    buildExternalStableEventKey(sourceIdentity, identity),
  ) || Object.prototype.hasOwnProperty.call(
    state.tombstones,
    buildExternalEventDedupKey(sourceIdentity, identity),
  );
}

function hasBlockingQuarantineForResource(
  state: ExternalCursorState,
  resourceRef: string,
): boolean {
  return Object.values(state.quarantinedEvents).some(entry => entry.resourceRef === resourceRef);
}

export function listExternalSourceQuarantines(
  storePath: string,
): readonly ExternalSourceQuarantineEntry[] {
  return Object.values(loadExternalCursorState(storePath).quarantinedEvents)
    .sort((left, right) => left.detectedAt.localeCompare(right.detectedAt));
}

export function retryExternalSourceQuarantine(
  storePath: string,
  quarantineId: string,
): boolean {
  const state = loadExternalCursorState(storePath);
  if (!state.quarantinedEvents[quarantineId]) return false;
  const nextQuarantine = { ...state.quarantinedEvents };
  delete nextQuarantine[quarantineId];
  saveExternalCursorState(storePath, {
    ...state,
    quarantinedEvents: nextQuarantine,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

export function skipExternalSourceQuarantine(
  storePath: string,
  quarantineId: string,
  reason: string,
): boolean {
  const state = loadExternalCursorState(storePath);
  const entry = state.quarantinedEvents[quarantineId];
  if (!entry) return false;
  const sourceIdentity = entry.sourceIdentity ?? Object.values(state.sourceIdentities).find(identity => (
    quarantineId.startsWith(`${identity.sourceId}::${identity.provider}::`)
  ));
  if (!sourceIdentity) return false;
  const nextQuarantine = { ...state.quarantinedEvents };
  delete nextQuarantine[quarantineId];
  const tombstoneKey = buildExternalStableEventKey(sourceIdentity, entry.identity);
  saveExternalCursorState(storePath, {
    ...state,
    quarantinedEvents: nextQuarantine,
    tombstones: {
      ...state.tombstones,
      [tombstoneKey]: {
        tombstoneId: quarantineId,
        resourceRef: entry.resourceRef,
        identity: entry.identity,
        createdAt: new Date().toISOString(),
        reason: redactExternalSourceDiagnostic(reason || 'operator skip'),
      },
    },
    updatedAt: new Date().toISOString(),
  });
  return true;
}

/**
 * Close an external resource locally after the operator confirms the upstream
 * resource has been deleted or archived. Closing preserves the resource's
 * cursor, Capsules, Episodes, Capabilities, and Transition Audits — it only
 * marks the resource so it is no longer selected for future reads (issue #87).
 */
export function closeExternalResource(
  storePath: string,
  resourceRef: string,
  reason: 'deleted' | 'archived' | 'operator',
): boolean {
  const state = loadExternalCursorState(storePath);
  const resource = state.resources[resourceRef];
  if (!resource) return false;
  if (resource.lifecycleStatus === 'closed') return false;
  const now = new Date().toISOString();
  const nextResources = {
    ...state.resources,
    [resourceRef]: {
      ...resource,
      lifecycleStatus: 'closed' as const,
      closedAt: resource.closedAt ?? now,
      closedReason: 'archived_or_deleted' as const,
      updatedAt: now,
    },
  };
  saveExternalCursorState(storePath, {
    ...state,
    resources: nextResources,
    updatedAt: now,
  });
  return true;
}

/**
 * Operator-triggered discovery-cycle finalization. Closes any resource that
 * has been missing for at least two discovery cycles (issue #87). Exposed so
 * a runtime can advance the lifecycle without waiting for the next wake.
 */
export function finalizeExternalDiscoveryCycleForStore(
  storePath: string,
  cycle: number,
): ExternalCursorState {
  const state = loadExternalCursorState(storePath);
  const next = finalizeExternalDiscoveryCycle(state, cycle);
  if (next !== state) saveExternalCursorState(storePath, next);
  return next;
}
