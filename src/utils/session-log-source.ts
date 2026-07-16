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
import { createHash } from 'crypto';
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
import {
  DistillationHeartbeatConfig,
  type ExternalHistoryMode,
} from './distillation-heartbeat-config';
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
  /** Remaining wake admission allowance, expressed as source events. */
  readonly remainingAdmissionEvents?: number;
}

export interface SessionLogSourceDiscoveryContext {
  readonly maxResources?: number;
  readonly maxElapsedMs?: number;
}

export interface ExternalSourceAdmissionConfiguration {
  readonly historyMode: ExternalHistoryMode;
  readonly scope: 'global' | 'path';
  readonly scopePath?: string;
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
  /** Best-effort external reader version diagnostic. */
  getReaderVersion?(): string | undefined;
  /** Configuration under which an external read may be admitted. */
  getExternalAdmissionConfiguration?(): ExternalSourceAdmissionConfiguration;
  /** Admission lane for the next page from this resource. */
  getAdmissionLane?(resource: SessionLogSourceResource): 'continuous' | 'catch-up';
  /** Immutable catch-up target linked to a historical page, when present. */
  getCatchUpTarget?(resource: SessionLogSourceResource): ExternalCatchUpTarget | undefined;
  /** Stable current heads used only by explicit operator rebaseline recovery. */
  observeRecoveryHeads?(): readonly { readonly resourceRef: string; readonly position: number }[];
  discoverResources(context?: SessionLogSourceDiscoveryContext): readonly SessionLogSourceResource[];
  read(
    resource: SessionLogSourceResource,
    context: SessionLogSourceReadContext,
  ): SessionLogSourceReadResult;
  /**
   * Asynchronous, cancellable read boundary for external source lanes
   * (issue #92). When implemented, the Runtime uses this method for
   * bounded concurrent external reads with AbortSignal-based cancellation.
   * Adapters that do not implement this method fall back to synchronous
   * read() wrapped in a microtask.
   */
  readAsync?(
    resource: SessionLogSourceResource,
    context: SessionLogSourceReadContext,
    signal: AbortSignal,
  ): Promise<SessionLogSourceReadResult>;
  acknowledge(resource: SessionLogSourceResource, result: SessionLogSourceReadResult): void;
  markFailed(resource: SessionLogSourceResource, error: unknown): void;
  close?(): void;
}

// ---------------------------------------------------------------------------
// Internal Session Log Source Adapter
// ---------------------------------------------------------------------------

interface InternalLogDiscoveryMetadata {
  runtimeSessionId: string;
}

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
  private readonly previousResourceByRuntimeSession = new Map<string, string>();

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

    if (this.pendingDiscoveredResources.size > 0) {
      return [...this.pendingDiscoveredResources.values()].slice(0, maxResources);
    }
    if (!this.discoveryIterator) {
      this.discoveryIterator = iterateJsonlDiscoveryEntries(sessionLogsRoot);
      this.predecessorByResource.clear();
      this.previousResourceByRuntimeSession.clear();
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
        break;
      }
      if (!next.value) continue;
      const filePath = next.value;
      const resource: SessionLogSourceResource = {
        resourceRef: filePath,
        firstEventIdentity: {
          eventId: filePath,
          position: 0,
        },
      };
      const metadata = readInternalLogDiscoveryMetadata(resource);
      const previous = this.previousResourceByRuntimeSession.get(metadata.runtimeSessionId);
      if (previous) {
        this.predecessorByResource.set(resource.resourceRef, previous);
      }
      this.previousResourceByRuntimeSession.set(metadata.runtimeSessionId, resource.resourceRef);
      this.pendingDiscoveredResources.set(resource.resourceRef, resource);
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
      const predecessor = this.predecessorByResource.get(filePath);
      const orderedFilePaths = predecessor
        ? [predecessor, filePath]
        : context.orderedResources.map(r => r.resourceRef);
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
    this.previousResourceByRuntimeSession.clear();
  }
}

function readInternalLogDiscoveryMetadata(
  resource: SessionLogSourceResource,
): InternalLogDiscoveryMetadata {
  const fallback: InternalLogDiscoveryMetadata = {
    runtimeSessionId: `path:${path.resolve(resource.resourceRef)}`,
  };
  let fd: number | null = null;
  try {
    fd = fs.openSync(resource.resourceRef, 'r');
    const size = Math.min(fs.fstatSync(fd).size, 64 * 1024);
    if (size <= 0) return fallback;
    const buffer = Buffer.allocUnsafe(size);
    const bytesRead = fs.readSync(fd, buffer, 0, size, 0);
    const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.entry_type !== 'turn') continue;
      const runtimeSessionId = String(
        parsed.runtime_session_id ?? parsed.runtime_id ?? parsed.session_id ?? '',
      ).trim();
      if (!runtimeSessionId) continue;
      return {
        runtimeSessionId,
      };
    }
  } catch {
    return fallback;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
  return fallback;
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
  /** Resources already baselined in durable state; readers may avoid re-reading them during discovery. */
  readonly knownResourceRefs?: readonly string[];
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

export interface ExternalCatchUpCatalogLimits {
  readonly initialLimit: number;
  readonly maxCatalogResources: number;
  readonly maxOutputBytes: number;
  readonly maxDurationMs: number;
}

export interface ExternalCatchUpCatalogObservationRequest {
  readonly requestedLimit: number;
  readonly knownResourceRefs: readonly string[];
}

export interface ExternalCatchUpCatalogObservation extends ExternalSourceIncrementalDiscoveryResult {
  readonly returnedResourceCount: number;
  readonly outputBytes?: number;
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
   * Provider-native bounded catalog observation used by catch-up. It must
   * observe the first `requestedLimit` resources and must not invent a
   * portable pagination cursor when the provider does not expose one.
   */
  observeCatchUpCatalog?(
    request: ExternalCatchUpCatalogObservationRequest,
  ): ExternalCatchUpCatalogObservation;
  getCatchUpCatalogLimits?(): ExternalCatchUpCatalogLimits;

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
  /**
   * Return one bounded normalized canonical-prefix observation. The adapter
   * persists it and requires the next observation to match before creating a
   * fixed target, without introducing a provider-specific parser in Runtime.
   */
  sampleHistory?(resource: SessionLogSourceResource): ExternalSourceHistorySampleResult;
  sampleHistoryAsync?(
    resource: SessionLogSourceResource,
    signal: AbortSignal,
  ): Promise<ExternalSourceHistorySampleResult>;
  /** Optional async/cancellable read seam for bounded concurrent reads (issue #92). */
  readAsync?(
    resource: SessionLogSourceResource,
    cursor: SourceCursor,
    signal: AbortSignal,
  ): Promise<ExternalSourceReaderResult>;
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

export interface ExternalSourceHistorySampleResult extends ExternalSourceReaderResult {
  /** Highest rendered ordinal observed, including an incomplete tail. */
  readonly observedPosition: number;
  readonly conversationId?: string;
  readonly branchId?: string;
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
  /**
   * Durable activation-blocked flag. When true the provider exceeded an
   * activation limit (catalog size, rendered output, or duration) and the
   * lane admits nothing until an operator narrows scope or raises the cap.
   * Existing baseline progress is retained; the flag is resumable across
   * restarts and never partially admits.
   */
  readonly activationBlocked?: boolean;
  readonly activationBlockedReason?: string;
  readonly activationBlockedAt?: string;
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
  readonly lastSeenScopeFingerprint?: string;
  readonly missingDiscoveryCycles?: number;
  readonly missingSince?: string | null;
  readonly closedAt?: string;
  readonly closedReason?: 'archived_or_deleted';
}

export interface ExternalCatchUpTarget {
  readonly targetId: string;
  readonly provider: string;
  readonly sourceId: string;
  readonly resourceRef: string;
  readonly conversationId?: string;
  readonly branchId?: string;
  /** Highest complete canonical event position; null is an explicit empty target. */
  readonly position: number | null;
  readonly empty: boolean;
  readonly prefixDigest: string;
  readonly creationGeneration: number;
  readonly scopeFingerprint: string;
  readonly observedAt: string;
}

export type ExternalCatchUpResourceStatus =
  | 'target-pending'
  | 'historical-pending'
  | 'complete'
  | 'closed'
  | 'abandoned';

export interface ExternalCatchUpPrefixObservation {
  /** Highest complete canonical event position; null means an empty prefix. */
  readonly position: number | null;
  readonly prefixDigest: string;
  readonly conversationId?: string;
  readonly branchId?: string;
  readonly observedAt: string;
}

/** Mutable catch-up progress kept separate from the immutable target. */
export interface ExternalCatchUpResourceState {
  readonly status: ExternalCatchUpResourceStatus;
  readonly historicalCursor: SourceCursor;
  readonly observedPosition: number;
  /** Latest catalog generation that observed this resource in its active scope. */
  readonly observedGeneration?: number;
  readonly observedScopeFingerprint?: string;
  readonly pendingSample?: ExternalCatchUpPrefixObservation;
  readonly updatedAt: string;
  /** Terminal exclusion that closed this mutable progress record, if any. */
  readonly terminalTombstoneId?: string;
}

export type ExternalCatchUpCatalogGenerationStatus =
  | 'inventory'
  | 'draining'
  | 'caught-up'
  | 'catch-up-blocked'
  | 'invalidated';

export interface ExternalCatchUpCatalogGeneration {
  readonly generation: number;
  readonly status: ExternalCatchUpCatalogGenerationStatus;
  readonly requestedLimit: number;
  readonly scopeFingerprint: string;
  readonly startedAt: string;
  readonly observedResourceCount: number;
  readonly lastObservationCount: number;
  readonly observedOutputBytes: number;
  readonly observationCompletedAt?: string;
  readonly completedAt?: string;
  readonly blockedAt?: string;
  readonly blockedReason?: string;
  readonly invalidatedAt?: string;
}

export interface ExternalCatchUpCatalogState {
  readonly active: ExternalCatchUpCatalogGeneration | null;
  readonly lastCompleted: ExternalCatchUpCatalogGeneration | null;
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

interface ExternalSourceTombstoneBase {
  readonly tombstoneId: string;
  readonly resourceRef: string;
  readonly createdAt: string;
  readonly reason: string;
}

export interface ExternalSourceEventTombstoneEntry extends ExternalSourceTombstoneBase {
  readonly kind: 'event-skip';
  readonly identity: SourceEventIdentity;
}

export interface ExternalSourceRangeTombstoneEntry extends ExternalSourceTombstoneBase {
  readonly kind: 'resource-closure' | 'range-abandonment';
  readonly range: {
    readonly startPosition: number;
    readonly endPosition: number;
  };
  readonly targetId?: string;
}

export type ExternalSourceTombstoneEntry =
  | ExternalSourceEventTombstoneEntry
  | ExternalSourceRangeTombstoneEntry;

export type ExternalSourceRecoveryAction =
  | 'quarantine-retry'
  | 'event-skip'
  | 'resource-close'
  | 'range-abandonment'
  | 'tombstone-reopen'
  | 'reopened-range-complete'
  | 'reopened-range-terminal-exclusion';

/** Append-only, transcript-free operator/recovery audit record. */
export interface ExternalSourceRecoveryAuditEntry {
  readonly auditId: string;
  readonly action: ExternalSourceRecoveryAction;
  readonly provider: string;
  readonly sourceId: string;
  readonly resourceRef: string;
  readonly createdAt: string;
  readonly quarantineId?: string;
  readonly tombstoneId?: string;
  readonly operationId?: string;
  readonly reason?: string;
}

export interface ExternalReopenedRangeState {
  readonly reopenId: string;
  readonly operationId: string;
  readonly tombstoneId: string;
  readonly targetId: string;
  readonly provider: string;
  readonly sourceId: string;
  readonly resourceRef: string;
  readonly range: {
    readonly startPosition: number;
    readonly endPosition: number;
  };
  readonly prefixDigest: string;
  readonly originalTargetId?: string;
  readonly status: 'historical-pending' | 'complete' | 'terminal-excluded';
  readonly terminalTombstoneId?: string;
  readonly createdAt: string;
  readonly completedAt?: string;
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
  readonly recoveryAudit: readonly ExternalSourceRecoveryAuditEntry[];
  readonly reopenedRanges: Record<string, ExternalReopenedRangeState>;
  readonly activation: ExternalSourceActivationState | null;
  readonly discovery: ExternalSourceDiscoveryState | null;
  /** Immutable per-thread boundaries. Existing entries are never replaced. */
  readonly catchUpTargets: Record<string, ExternalCatchUpTarget>;
  /** Mutable historical cursor/lifecycle state, separate from targets. */
  readonly catchUpResources: Record<string, ExternalCatchUpResourceState>;
  /** One durable active catalog generation plus the preceding completed summary. */
  readonly catchUpCatalog: ExternalCatchUpCatalogState;
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
    schemaVersion: 5,
    cursors: {},
    processedEventIds: {},
    processedEventFingerprints: {},
    sourceIdentities: {},
    resources: {},
    quarantinedEvents: {},
    tombstones: {},
    recoveryAudit: [],
    reopenedRanges: {},
    activation: null,
    discovery: null,
    catchUpTargets: {},
    catchUpResources: {},
    catchUpCatalog: { active: null, lastCompleted: null },
    updatedAt: new Date().toISOString(),
  };
}

function normalizeCatchUpTargets(value: unknown): Record<string, ExternalCatchUpTarget> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('external cursor state has invalid catch-up targets');
  }
  const targets: Record<string, ExternalCatchUpTarget> = {};
  for (const [resourceRef, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`external cursor state has invalid catch-up target for ${resourceRef}`);
    }
    const candidate = raw as Partial<ExternalCatchUpTarget>;
    if (
      typeof candidate.targetId !== 'string' || candidate.targetId.length === 0
      || typeof candidate.provider !== 'string' || candidate.provider.length === 0
      || typeof candidate.sourceId !== 'string' || candidate.sourceId.length === 0
      || candidate.resourceRef !== resourceRef
      || (candidate.position !== null
        && (typeof candidate.position !== 'number'
          || !Number.isInteger(candidate.position)
          || candidate.position < 0))
      || candidate.empty !== (candidate.position === null)
      || typeof candidate.prefixDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(candidate.prefixDigest)
      || !Number.isInteger(candidate.creationGeneration)
      || candidate.creationGeneration! < 1
      || typeof candidate.scopeFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(candidate.scopeFingerprint)
      || typeof candidate.observedAt !== 'string'
    ) {
      throw new Error(`external cursor state has invalid catch-up target for ${resourceRef}`);
    }
    const position = candidate.position === null ? null : candidate.position!;
    targets[resourceRef] = {
      targetId: candidate.targetId,
      provider: candidate.provider,
      sourceId: candidate.sourceId,
      resourceRef,
      ...(typeof candidate.conversationId === 'string'
        ? { conversationId: candidate.conversationId }
        : {}),
      ...(typeof candidate.branchId === 'string' ? { branchId: candidate.branchId } : {}),
      position,
      empty: position === null,
      prefixDigest: candidate.prefixDigest,
      creationGeneration: candidate.creationGeneration!,
      scopeFingerprint: candidate.scopeFingerprint,
      observedAt: candidate.observedAt,
    };
  }
  return targets;
}

function normalizeCatchUpResources(value: unknown): Record<string, ExternalCatchUpResourceState> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('external cursor state has invalid catch-up resources');
  }
  const resources: Record<string, ExternalCatchUpResourceState> = {};
  for (const [resourceRef, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`external cursor state has invalid catch-up resource for ${resourceRef}`);
    }
    const candidate = raw as Partial<ExternalCatchUpResourceState>;
    const cursor = candidate.historicalCursor;
    const pendingSample = candidate.pendingSample;
    if (
      candidate.status !== 'target-pending'
      && candidate.status !== 'historical-pending'
      && candidate.status !== 'complete'
      && candidate.status !== 'closed'
      && candidate.status !== 'abandoned'
    ) {
      throw new Error(`external cursor state has invalid catch-up resource for ${resourceRef}`);
    }
    if (
      !cursor
      || cursor.resourceRef !== resourceRef
      || !Number.isInteger(cursor.position)
      || cursor.position < -1
      || !Number.isInteger(cursor.processedCount)
      || cursor.processedCount < 0
      || !Number.isInteger(candidate.observedPosition)
      || candidate.observedPosition! < 0
      || (candidate.observedGeneration !== undefined
        && (!Number.isInteger(candidate.observedGeneration) || candidate.observedGeneration < 1))
      || (candidate.observedScopeFingerprint !== undefined
        && (typeof candidate.observedScopeFingerprint !== 'string'
          || !/^[a-f0-9]{64}$/.test(candidate.observedScopeFingerprint)))
      || ((candidate.observedGeneration === undefined)
        !== (candidate.observedScopeFingerprint === undefined))
      || (pendingSample !== undefined && (
        candidate.status !== 'target-pending'
        || !isValidCatchUpPrefixObservation(pendingSample)
      ))
      || typeof candidate.updatedAt !== 'string'
    ) {
      throw new Error(`external cursor state has invalid catch-up resource for ${resourceRef}`);
    }
    resources[resourceRef] = {
      status: candidate.status,
      historicalCursor: {
        resourceRef,
        position: cursor.position,
        processedCount: cursor.processedCount,
      },
      observedPosition: candidate.observedPosition!,
      ...(candidate.observedGeneration !== undefined
        ? {
          observedGeneration: candidate.observedGeneration,
          observedScopeFingerprint: candidate.observedScopeFingerprint!,
        }
        : {}),
      ...(pendingSample !== undefined ? { pendingSample } : {}),
      updatedAt: candidate.updatedAt,
      ...(typeof candidate.terminalTombstoneId === 'string'
        ? { terminalTombstoneId: candidate.terminalTombstoneId }
        : {}),
    };
  }
  return resources;
}

function normalizeRecoveryAudit(value: unknown): readonly ExternalSourceRecoveryAuditEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('external cursor state has invalid recovery audit');
  }
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('external cursor state has invalid recovery audit');
    }
    const entry = raw as Partial<ExternalSourceRecoveryAuditEntry>;
    if (
      typeof entry.auditId !== 'string'
      || typeof entry.provider !== 'string'
      || typeof entry.sourceId !== 'string'
      || typeof entry.resourceRef !== 'string'
      || typeof entry.createdAt !== 'string'
      || (
        entry.action !== 'quarantine-retry'
        && entry.action !== 'event-skip'
        && entry.action !== 'resource-close'
        && entry.action !== 'range-abandonment'
        && entry.action !== 'tombstone-reopen'
        && entry.action !== 'reopened-range-complete'
        && entry.action !== 'reopened-range-terminal-exclusion'
      )
    ) {
      throw new Error('external cursor state has invalid recovery audit');
    }
    return {
      auditId: entry.auditId,
      action: entry.action,
      provider: entry.provider,
      sourceId: entry.sourceId,
      resourceRef: entry.resourceRef,
      createdAt: entry.createdAt,
      ...(typeof entry.quarantineId === 'string' ? { quarantineId: entry.quarantineId } : {}),
      ...(typeof entry.tombstoneId === 'string' ? { tombstoneId: entry.tombstoneId } : {}),
      ...(typeof entry.operationId === 'string' ? { operationId: entry.operationId } : {}),
      ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
    };
  });
}

function normalizeReopenedRanges(value: unknown): Record<string, ExternalReopenedRangeState> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('external cursor state has invalid reopened ranges');
  }
  const reopened: Record<string, ExternalReopenedRangeState> = {};
  for (const [operationId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`external cursor state has invalid reopened range for ${operationId}`);
    }
    const entry = raw as Partial<ExternalReopenedRangeState>;
    const range = entry.range;
    if (
      entry.operationId !== operationId
      || typeof entry.reopenId !== 'string'
      || typeof entry.tombstoneId !== 'string'
      || typeof entry.targetId !== 'string'
      || typeof entry.provider !== 'string'
      || typeof entry.sourceId !== 'string'
      || typeof entry.resourceRef !== 'string'
      || !range
      || !Number.isInteger(range.startPosition)
      || range.startPosition < 0
      || !Number.isInteger(range.endPosition)
      || range.endPosition < range.startPosition
      || typeof entry.prefixDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.prefixDigest)
      || (
        entry.status !== 'historical-pending'
        && entry.status !== 'complete'
        && entry.status !== 'terminal-excluded'
      )
      || typeof entry.createdAt !== 'string'
    ) {
      throw new Error(`external cursor state has invalid reopened range for ${operationId}`);
    }
    reopened[operationId] = {
      reopenId: entry.reopenId,
      operationId,
      tombstoneId: entry.tombstoneId,
      targetId: entry.targetId,
      provider: entry.provider,
      sourceId: entry.sourceId,
      resourceRef: entry.resourceRef,
      range: {
        startPosition: range.startPosition,
        endPosition: range.endPosition,
      },
      prefixDigest: entry.prefixDigest,
      ...(typeof entry.originalTargetId === 'string'
        ? { originalTargetId: entry.originalTargetId }
        : {}),
      status: entry.status,
      ...(typeof entry.terminalTombstoneId === 'string'
        ? { terminalTombstoneId: entry.terminalTombstoneId }
        : {}),
      createdAt: entry.createdAt,
      ...(typeof entry.completedAt === 'string' ? { completedAt: entry.completedAt } : {}),
    };
  }
  return reopened;
}

function isValidCatchUpPrefixObservation(
  value: unknown,
): value is ExternalCatchUpPrefixObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ExternalCatchUpPrefixObservation>;
  return (candidate.position === null
      || (Number.isInteger(candidate.position) && candidate.position! >= 0))
    && typeof candidate.prefixDigest === 'string'
    && /^[a-f0-9]{64}$/.test(candidate.prefixDigest)
    && (candidate.conversationId === undefined || typeof candidate.conversationId === 'string')
    && (candidate.branchId === undefined || typeof candidate.branchId === 'string')
    && isCanonicalIsoTimestamp(candidate.observedAt);
}

function normalizeCatchUpCatalogGeneration(
  value: unknown,
  label: string,
): ExternalCatchUpCatalogGeneration | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`external cursor state has invalid ${label} catch-up generation`);
  }
  const candidate = value as Partial<ExternalCatchUpCatalogGeneration>;
  const validStatus = candidate.status === 'inventory'
    || candidate.status === 'draining'
    || candidate.status === 'caught-up'
    || candidate.status === 'catch-up-blocked'
    || candidate.status === 'invalidated';
  if (
    !Number.isInteger(candidate.generation) || candidate.generation! < 1
    || !validStatus
    || !Number.isInteger(candidate.requestedLimit) || candidate.requestedLimit! < 1
    || typeof candidate.scopeFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(candidate.scopeFingerprint)
    || !isCanonicalIsoTimestamp(candidate.startedAt)
    || !Number.isInteger(candidate.observedResourceCount) || candidate.observedResourceCount! < 0
    || !Number.isInteger(candidate.lastObservationCount) || candidate.lastObservationCount! < 0
    || !Number.isInteger(candidate.observedOutputBytes) || candidate.observedOutputBytes! < 0
    || !isOptionalCanonicalIsoTimestamp(candidate.observationCompletedAt)
    || !isOptionalCanonicalIsoTimestamp(candidate.completedAt)
    || !isOptionalCanonicalIsoTimestamp(candidate.blockedAt)
    || !isOptionalCanonicalIsoTimestamp(candidate.invalidatedAt)
  ) {
    throw new Error(`external cursor state has invalid ${label} catch-up generation`);
  }
  return {
    generation: candidate.generation!,
    status: candidate.status!,
    requestedLimit: candidate.requestedLimit!,
    scopeFingerprint: candidate.scopeFingerprint,
    startedAt: candidate.startedAt,
    observedResourceCount: candidate.observedResourceCount!,
    lastObservationCount: candidate.lastObservationCount!,
    observedOutputBytes: candidate.observedOutputBytes!,
    ...(typeof candidate.observationCompletedAt === 'string'
      ? { observationCompletedAt: candidate.observationCompletedAt }
      : {}),
    ...(typeof candidate.completedAt === 'string' ? { completedAt: candidate.completedAt } : {}),
    ...(typeof candidate.blockedAt === 'string' ? { blockedAt: candidate.blockedAt } : {}),
    ...(typeof candidate.blockedReason === 'string' ? { blockedReason: candidate.blockedReason } : {}),
    ...(typeof candidate.invalidatedAt === 'string' ? { invalidatedAt: candidate.invalidatedAt } : {}),
  };
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isOptionalCanonicalIsoTimestamp(value: unknown): value is string | undefined {
  return value === undefined || isCanonicalIsoTimestamp(value);
}

function normalizeCatchUpCatalog(value: unknown): ExternalCatchUpCatalogState {
  if (value === undefined) return { active: null, lastCompleted: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('external cursor state has invalid catch-up catalog');
  }
  const candidate = value as Partial<ExternalCatchUpCatalogState>;
  return {
    active: normalizeCatchUpCatalogGeneration(candidate.active, 'active'),
    lastCompleted: normalizeCatchUpCatalogGeneration(candidate.lastCompleted, 'completed'),
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
  if (!Number.isFinite(schemaVersion) || schemaVersion < 1 || schemaVersion > 5) {
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
      ...(typeof record.lastSeenScopeFingerprint === 'string'
        && /^[a-f0-9]{64}$/.test(record.lastSeenScopeFingerprint)
        ? { lastSeenScopeFingerprint: record.lastSeenScopeFingerprint }
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
  if (
    parsed.tombstones !== undefined
    && (!parsed.tombstones || typeof parsed.tombstones !== 'object' || Array.isArray(parsed.tombstones))
  ) {
    throw new Error('external cursor state has invalid external source tombstones');
  }
  const tombstones = (parsed.tombstones ?? {}) as Record<string, unknown>;
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
    if (
      !record
      || typeof record !== 'object'
      || typeof record.tombstoneId !== 'string'
      || record.tombstoneId.length === 0
      || typeof record.resourceRef !== 'string'
      || record.resourceRef.length === 0
      || typeof record.createdAt !== 'string'
      || typeof record.reason !== 'string'
    ) {
      throw new Error(`external cursor state has invalid external source tombstone for ${tombstoneId}`);
    }
    const base = {
      tombstoneId: record.tombstoneId,
      resourceRef: record.resourceRef,
      createdAt: record.createdAt,
      reason: record.reason,
    };
    if ('identity' in record && record.identity && typeof record.identity === 'object') {
      const identity = record.identity as Partial<SourceEventIdentity>;
      if (
        record.kind !== 'event-skip'
        || typeof identity.eventId !== 'string'
        || identity.eventId.length === 0
        || !Number.isInteger(identity.position)
        || identity.position! < 0
      ) {
        throw new Error(`external cursor state has invalid external source tombstone for ${tombstoneId}`);
      }
      normalizedTombstones[tombstoneId] = {
        ...base,
        kind: 'event-skip',
        identity: record.identity as SourceEventIdentity,
      };
      continue;
    }
    if (
      (record.kind === 'resource-closure' || record.kind === 'range-abandonment')
      && 'range' in record
      && record.range
      && typeof record.range === 'object'
    ) {
      const range = record.range as { startPosition?: unknown; endPosition?: unknown };
      if (
        Number.isInteger(range.startPosition)
        && Number(range.startPosition) >= 0
        && Number.isInteger(range.endPosition)
        && Number(range.endPosition) >= Number(range.startPosition)
      ) {
        normalizedTombstones[tombstoneId] = {
          ...base,
          kind: record.kind,
          range: {
            startPosition: Number(range.startPosition),
            endPosition: Number(range.endPosition),
          },
          ...('targetId' in record && typeof record.targetId === 'string'
            ? { targetId: record.targetId }
            : {}),
        };
        continue;
      }
    }
    throw new Error(`external cursor state has invalid external source tombstone for ${tombstoneId}`);
  }
  const activation = parsed.activation && typeof parsed.activation === 'object'
    ? parsed.activation as Partial<ExternalSourceActivationState>
    : null;
  const discovery = parsed.discovery && typeof parsed.discovery === 'object'
    ? parsed.discovery as Partial<ExternalSourceDiscoveryState>
    : null;
  const catchUpTargets = normalizeCatchUpTargets(parsed.catchUpTargets);
  const catchUpResources = normalizeCatchUpResources(parsed.catchUpResources);
  const recoveryAudit = normalizeRecoveryAudit(parsed.recoveryAudit);
  const reopenedRanges = normalizeReopenedRanges(parsed.reopenedRanges);
  const catchUpCatalog = normalizeCatchUpCatalog(parsed.catchUpCatalog);
  return {
    schemaVersion: 5,
    cursors: parsed.cursors as Record<string, ExternalCursorEntry>,
    processedEventIds: parsed.processedEventIds as Record<string, string | null>,
    processedEventFingerprints: processedEventFingerprints as Record<string, string>,
    sourceIdentities: parsed.sourceIdentities as Record<string, SessionLogSourceIdentity>,
    resources: normalizedResources,
    quarantinedEvents: normalizedQuarantine,
    tombstones: normalizedTombstones,
    recoveryAudit,
    reopenedRanges,
    activation: activation
      ? {
        initializedAt: typeof activation.initializedAt === 'string' ? activation.initializedAt : new Date().toISOString(),
        mode: 'future-only-resource-baseline',
        ...(typeof activation.watermarkPosition === 'number' ? { watermarkPosition: Math.floor(activation.watermarkPosition) } : {}),
        initialDiscoveryCompleted: activation.initialDiscoveryCompleted === true,
        ...(activation.activationBlocked === true ? { activationBlocked: true } : {}),
        ...(typeof activation.activationBlockedReason === 'string' && activation.activationBlockedReason
          ? { activationBlockedReason: activation.activationBlockedReason }
          : {}),
        ...(typeof activation.activationBlockedAt === 'string' && activation.activationBlockedAt
          ? { activationBlockedAt: activation.activationBlockedAt }
          : {}),
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
    catchUpTargets,
    catchUpResources,
    catchUpCatalog,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

export function saveExternalCursorState(
  storePath: string,
  state: ExternalCursorState,
): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const payload = {
    schemaVersion: 5,
    cursors: state.cursors,
    processedEventIds: state.processedEventIds,
    processedEventFingerprints: state.processedEventFingerprints,
    sourceIdentities: state.sourceIdentities,
    resources: state.resources,
    quarantinedEvents: state.quarantinedEvents,
    tombstones: state.tombstones,
    recoveryAudit: state.recoveryAudit,
    reopenedRanges: state.reopenedRanges,
    activation: state.activation,
    discovery: state.discovery,
    catchUpTargets: state.catchUpTargets,
    catchUpResources: state.catchUpResources,
    catchUpCatalog: state.catchUpCatalog,
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
  private readonly scope: { scope: 'global' | 'path'; scopePath?: string };
  private readonly historyMode: ExternalHistoryMode;
  private readonly now: () => Date;
  private cursorStorePath: string;

  constructor(
    options: {
      sourceId: string;
      label?: string;
      provider: string;
      reader?: ExternalSourceReader | string;
      cursorStorePath?: string;
      enabled?: boolean;
      scope?: { scope: 'global' | 'path'; scopePath?: string };
      historyMode?: ExternalHistoryMode;
      now?: () => Date;
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
    this.scope = options.scope ?? { scope: 'global' };
    this.historyMode = options.historyMode ?? 'future-only';
    this.now = options.now ?? (() => new Date());
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

  getReaderVersion(): string | undefined {
    const candidate = this.reader as { version?: string } | null;
    return typeof candidate?.version === 'string' && candidate.version.trim()
      ? candidate.version
      : undefined;
  }

  getExternalAdmissionConfiguration(): ExternalSourceAdmissionConfiguration {
    return {
      historyMode: this.historyMode,
      scope: this.scope.scope,
      ...(this.scope.scopePath ? { scopePath: this.scope.scopePath } : {}),
    };
  }

  getAdmissionLane(resource: SessionLogSourceResource): 'continuous' | 'catch-up' {
    if (!this.cursorStorePath || this.historyMode !== 'catch-up') return 'continuous';
    const state = loadExternalCursorState(this.cursorStorePath);
    return state.catchUpResources[resource.resourceRef]?.status === 'historical-pending'
      ? 'catch-up'
      : 'continuous';
  }

  getCatchUpTarget(resource: SessionLogSourceResource): ExternalCatchUpTarget | undefined {
    if (!this.cursorStorePath) return undefined;
    return loadExternalCursorState(this.cursorStorePath).catchUpTargets[resource.resourceRef];
  }

  observeRecoveryHeads(): readonly { readonly resourceRef: string; readonly position: number }[] {
    if (!this.cursorStorePath || !this.reader?.sampleHistory) return [];
    const state = loadExternalCursorState(this.cursorStorePath);
    const heads: Array<{ resourceRef: string; position: number }> = [];
    for (const [resourceRef, progress] of Object.entries(state.catchUpResources)) {
      if (
        progress.status === 'complete'
        || progress.status === 'closed'
        || progress.status === 'abandoned'
      ) continue;
      const resource = state.resources[resourceRef]?.resource;
      if (!resource) continue;
      const sample = this.reader.sampleHistory(resource);
      if (sample.status !== 'stable') {
        throw new Error(`external recovery head is still pending for ${resourceRef}`);
      }
      const eventHead = sample.events.reduce(
        (highest, event) => Math.max(highest, event.position),
        -1,
      );
      heads.push({
        resourceRef,
        position: Math.max(
          progress.observedPosition,
          sample.observedPosition,
          eventHead,
          normalizeActivationPosition(resource.firstEventIdentity?.position),
        ),
      });
    }
    return heads;
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
    let withIdentity = registerExternalSourceIdentity(state, this.identity);
    withIdentity = this.invalidateCatchUpCatalogForScopeChange(withIdentity);

    // A durably activation-blocked provider admits nothing until an operator
    // narrows scope or raises the cap. The flag is resumable and never partially
    // admits; existing baseline progress and evidence are retained.
    if (withIdentity.activation?.activationBlocked === true) {
      this.persistExternalState(withIdentity);
      return [];
    }

    if (this.historyMode === 'catch-up') {
      return this.discoverCatchUpResources(withIdentity, maxResources);
    }

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
          cycle: withIdentity.discovery?.cycle ?? 0,
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
    context: SessionLogSourceReadContext,
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
    const catchUpResource = state.catchUpResources[resource.resourceRef];
    const historicalRead = this.historyMode === 'catch-up'
      && catchUpResource?.status === 'historical-pending';
    const sourceCursor = historicalRead
      ? catchUpResource.historicalCursor
      : readCursorWithSourceIdentityValidation(state, this.identity, resource.resourceRef);
    const resourceCursor: SourceCursor = sourceCursor
      ? { ...sourceCursor, resourceRef: resource.resourceRef }
      : {
          resourceRef: resource.resourceRef,
          position: -1,
          processedCount: 0,
        };

    let readerResult: ExternalSourceReaderResult;
    try {
      readerResult = historicalRead && this.reader.sampleHistory
        ? this.reader.sampleHistory(resource)
        : this.reader.read(resource, resourceCursor);
      if (historicalRead) {
        readerResult = this.limitHistoricalReadToTarget(resource, state, resourceCursor, readerResult, context);
      }
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

    return this.materializeExternalReadResult(resource, state, resourceState, resourceCursor, readerResult);
  }

  async readAsync(
    resource: SessionLogSourceResource,
    context: SessionLogSourceReadContext,
    signal: AbortSignal,
  ): Promise<SessionLogSourceReadResult> {
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
    const catchUpResource = state.catchUpResources[resource.resourceRef];
    const historicalRead = this.historyMode === 'catch-up'
      && catchUpResource?.status === 'historical-pending';
    const sourceCursor = historicalRead
      ? catchUpResource.historicalCursor
      : readCursorWithSourceIdentityValidation(state, this.identity, resource.resourceRef);
    const resourceCursor: SourceCursor = sourceCursor
      ? { ...sourceCursor, resourceRef: resource.resourceRef }
      : {
          resourceRef: resource.resourceRef,
          position: -1,
          processedCount: 0,
        };

    let readerResult: ExternalSourceReaderResult;
    try {
      if (historicalRead && this.reader.sampleHistoryAsync) {
        readerResult = await this.reader.sampleHistoryAsync(resource, signal);
      } else if (historicalRead && this.reader.sampleHistory) {
        readerResult = await Promise.resolve().then(() => this.reader!.sampleHistory!(resource));
      } else {
        readerResult = this.reader.readAsync
          ? await this.reader.readAsync(resource, resourceCursor, signal)
          : await Promise.resolve().then(() => this.reader!.read(resource, resourceCursor));
      }
      if (historicalRead) {
        readerResult = this.limitHistoricalReadToTarget(resource, state, resourceCursor, readerResult, context);
      }
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

    return this.materializeExternalReadResult(resource, state, resourceState, resourceCursor, readerResult);
  }

  private limitHistoricalReadToTarget(
    resource: SessionLogSourceResource,
    state: ExternalCursorState,
    resourceCursor: SourceCursor,
    readerResult: ExternalSourceReaderResult,
    context: SessionLogSourceReadContext,
  ): ExternalSourceReaderResult {
    const target = state.catchUpTargets[resource.resourceRef];
    if (!target || target.position === null) {
      throw new Error(`catch-up target is missing for ${resource.resourceRef}`);
    }
    if (readerResult.status !== 'stable') return readerResult;
    const prefix = readerResult.events
      .filter(event => event.position <= target.position!)
      .sort((a, b) => a.position - b.position);
    if (buildExternalCatchUpPrefixDigest(prefix) !== target.prefixDigest) {
      throw new Error(`external catch-up prefix changed for ${resource.resourceRef}`);
    }
    const unread = prefix.filter(event => event.position > resourceCursor.position);
    const maxEvents = context.remainingAdmissionEvents === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(context.remainingAdmissionEvents));
    const remainingBytes = context.remainingBudget?.maxBytesPerWake;
    const maxBytes = remainingBytes === undefined || remainingBytes <= 0
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(remainingBytes));
    const admitted: ExternalSourceRawEvent[] = [];
    let admittedBytes = 0;
    for (const event of unread) {
      if (admitted.length >= maxEvents) break;
      const eventBytes = Buffer.byteLength(JSON.stringify(event.distillationUnit ?? event), 'utf8');
      if (admittedBytes + eventBytes > maxBytes) break;
      admitted.push(event);
      admittedBytes += eventBytes;
    }
    const newPosition = admitted.length > 0
      ? admitted[admitted.length - 1]!.position
      : resourceCursor.position;
    return {
      ...readerResult,
      events: admitted,
      newPosition: Math.min(newPosition, target.position),
      exhausted: admitted.length === unread.length && newPosition >= target.position,
      byteLength: admittedBytes,
    };
  }

  private materializeExternalReadResult(
    resource: SessionLogSourceResource,
    state: ExternalCursorState,
    resourceState: ExternalDiscoveredResourceState | undefined,
    resourceCursor: SourceCursor,
    readerResult: ExternalSourceReaderResult,
  ): SessionLogSourceReadResult {
    if (readerResult.status === 'pending' || readerResult.events.length === 0) {
      return {
        distillationUnit: null,
        advanced: false,
        status: readerResult.exhausted ? 'exhausted' : 'idle',
        newCursor: resourceCursor,
      };
    }

    const unskippedEvents = readerResult.events.filter(
      event => !isSkippedExternalEvent(state, this.identity, resource.resourceRef, event),
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
    if (
      this.historyMode === 'catch-up'
      && state.catchUpResources[resource.resourceRef]?.status === 'historical-pending'
    ) {
      this.acknowledgeHistoricalPage(resource, result, state);
      return;
    }
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
        lastSeenScopeFingerprint: existingResource?.lastSeenScopeFingerprint,
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

  private acknowledgeHistoricalPage(
    resource: SessionLogSourceResource,
    result: SessionLogSourceReadResult,
    state: ExternalCursorState,
  ): void {
    if (!this.cursorStorePath) return;
    const target = state.catchUpTargets[resource.resourceRef];
    const progress = state.catchUpResources[resource.resourceRef];
    if (!target || target.position === null || !progress) {
      throw new Error(`catch-up target state is missing for ${resource.resourceRef}`);
    }
    const now = this.now().toISOString();
    const complete = result.newCursor.position >= target.position;
    const updatedEventIds = { ...state.processedEventIds };
    const updatedFingerprints = { ...state.processedEventFingerprints };
    const identities = result.eventIdentities ?? [];
    for (const identity of identities) {
      updatedEventIds[buildExternalEventDedupKey(this.identity, identity)] = normalizeContentHash(identity.contentHash);
      updatedFingerprints[buildExternalStableEventKey(this.identity, identity)] = fingerprintEventIdentity(identity);
    }

    const updatedCursors = { ...state.cursors };
    if (complete) {
      const existing = readCursorWithSourceIdentityValidation(state, this.identity, resource.resourceRef);
      const continuousCursor: SourceCursor = existing && existing.position > target.position
        ? existing
        : {
          resourceRef: resource.resourceRef,
          position: target.position,
          processedCount: Math.max(existing?.processedCount ?? 0, result.newCursor.processedCount),
        };
      const entry: ExternalCursorEntry = {
        cursor: continuousCursor,
        sourceIdentity: this.identity,
        updatedAt: now,
        lastStatus: 'stable',
      };
      updatedCursors[resource.resourceRef] = entry;
      updatedCursors[this.identity.sourceId] = entry;
    }

    const existingResource = state.resources[resource.resourceRef];
    const acknowledgedState: ExternalCursorState = {
      ...state,
      cursors: updatedCursors,
      processedEventIds: updatedEventIds,
      processedEventFingerprints: updatedFingerprints,
      resources: {
        ...state.resources,
        [resource.resourceRef]: {
          resource,
          continuityTail: result.continuityTail ?? existingResource?.continuityTail ?? [],
          continuityIncomplete: result.continuityIncomplete ?? false,
          updatedAt: now,
          lifecycleStatus: existingResource?.lifecycleStatus ?? 'active',
          lastSeenAt: existingResource?.lastSeenAt ?? now,
          lastSeenDiscoveryCycle: existingResource?.lastSeenDiscoveryCycle,
          lastSeenScopeFingerprint: existingResource?.lastSeenScopeFingerprint,
          missingDiscoveryCycles: 0,
          missingSince: null,
          lastSuccessfulReadAt: now,
        },
      },
      catchUpResources: {
        ...state.catchUpResources,
        [resource.resourceRef]: {
          ...progress,
          status: complete ? 'complete' : 'historical-pending',
          historicalCursor: result.newCursor,
          updatedAt: now,
        },
      },
      updatedAt: now,
    };
    saveExternalCursorState(
      this.cursorStorePath,
      completeExternalCatchUpCatalogIfReady(acknowledgedState, this.now),
    );
  }

  markFailed(resource: SessionLogSourceResource, error: unknown): void {
    void resource;
    Logger.warning(
      `[ExternalSessionLogSourceAdapter] ${this.identity.sourceId} resource failed: ${redactExternalSourceDiagnostic(error)}`,
    );
  }

  private discoverCatchUpResources(
    state: ExternalCursorState,
    maxResources: number,
  ): readonly SessionLogSourceResource[] {
    const scopeFingerprint = buildExternalCatchUpScopeFingerprint(
      this.identity.provider,
      this.identity.sourceId,
      this.scope,
    );
    const limits = this.resolveCatchUpCatalogLimits();
    let nextState = this.ensureCatchUpCatalogGeneration(state, scopeFingerprint, limits);
    let generation = nextState.catchUpCatalog.active;
    if (!generation || generation.status === 'catch-up-blocked' || generation.status === 'invalidated') {
      this.persistExternalState(nextState);
      return [];
    }

    if (generation.status === 'inventory') {
      const elapsedMs = Math.max(0, this.now().getTime() - Date.parse(generation.startedAt));
      if (elapsedMs > limits.maxDurationMs) {
        nextState = this.blockCatchUpCatalog(
          nextState,
          `catch-up catalog duration exceeded limit: ${elapsedMs} > ${limits.maxDurationMs}`,
        );
        this.persistExternalState(nextState);
        return [];
      }

      // Persist generation ownership before invoking the provider so a crash
      // resumes the same limit and generation rather than starting over.
      this.persistExternalState(nextState);
      let observation: ExternalCatchUpCatalogObservation;
      try {
        observation = this.observeCatchUpCatalog(nextState, generation.requestedLimit);
      } catch (error) {
        if (!isActivationBlockedError(error)) throw error;
        nextState = this.blockCatchUpCatalog(nextState, redactExternalSourceDiagnostic(error));
        this.persistExternalState(nextState);
        return [];
      }
      if (!this.reader?.observeCatchUpCatalog && observation.nextPageToken != null) {
        nextState = this.blockCatchUpCatalog(
          nextState,
          'catch-up catalog pagination requires an explicit expanding-limit observation contract',
        );
        this.persistExternalState(nextState);
        return [];
      }

      nextState = applyExternalDiscoveryPage(
        nextState,
        this.identity,
        observation,
        generation.generation,
        false,
        scopeFingerprint,
      );
      nextState = this.recordCatchUpCatalogMembership(
        nextState,
        observation.resources,
        generation.generation,
        scopeFingerprint,
      );
      const now = this.now().toISOString();
      const observedOutputBytes = generation.observedOutputBytes + Math.max(0, observation.outputBytes ?? 0);
      const observedResourceCount = Object.values(nextState.catchUpResources)
        .filter(resource => resource.observedGeneration === generation!.generation)
        .length;
      const returnedCount = Math.max(0, Math.floor(observation.returnedResourceCount));
      let active: ExternalCatchUpCatalogGeneration = {
        ...generation,
        observedResourceCount,
        lastObservationCount: returnedCount,
        observedOutputBytes,
      };
      if (observedOutputBytes > limits.maxOutputBytes) {
        nextState = {
          ...nextState,
          catchUpCatalog: { ...nextState.catchUpCatalog, active },
        };
        nextState = this.blockCatchUpCatalog(
          nextState,
          `catch-up catalog output exceeded limit: ${observedOutputBytes} > ${limits.maxOutputBytes}`,
        );
      } else if (returnedCount >= generation.requestedLimit) {
        if (generation.requestedLimit >= limits.maxCatalogResources) {
          nextState = {
            ...nextState,
            catchUpCatalog: { ...nextState.catchUpCatalog, active },
          };
          nextState = this.blockCatchUpCatalog(
            nextState,
            `catch-up catalog reached configured limit without proving exhaustion: ${limits.maxCatalogResources}`,
          );
        } else {
          active = {
            ...active,
            requestedLimit: Math.min(
              limits.maxCatalogResources,
              Math.max(generation.requestedLimit + 1, generation.requestedLimit * 2),
            ),
          };
          nextState = {
            ...nextState,
            catchUpCatalog: { ...nextState.catchUpCatalog, active },
          };
        }
      } else {
        active = {
          ...active,
          status: 'draining',
          observationCompletedAt: now,
        };
        nextState = {
          ...nextState,
          catchUpCatalog: { ...nextState.catchUpCatalog, active },
        };
      }
      nextState = {
        ...nextState,
        discovery: {
          nextPageToken: null,
          nextResourceIndex: nextState.discovery?.nextResourceIndex ?? 0,
          updatedAt: now,
          cycle: generation.generation,
        },
      };
      nextState = completeExternalCatchUpCatalogIfReady(nextState, this.now);
      this.persistExternalState(nextState);
      generation = nextState.catchUpCatalog.active;
      if (!generation || generation.status === 'catch-up-blocked') return [];
      return mergeResourceSelections(
        this.selectContinuousCatchUpResources(nextState, generation, maxResources),
        this.selectKnownContinuousResources(nextState, generation, maxResources),
        maxResources,
      );
    }

    const candidate = this.selectCatchUpResource(nextState, generation, maxResources);
    if (!candidate) {
      nextState = completeExternalCatchUpCatalogIfReady(nextState, this.now);
      this.persistExternalState(nextState);
      return mergeResourceSelections(
        this.selectContinuousCatchUpResources(nextState, generation, maxResources),
        this.selectKnownContinuousResources(nextState, generation, maxResources),
        maxResources,
      );
    }
    const resource = candidate.resource;

    const existingTarget = nextState.catchUpTargets[resource.resourceRef];
    if (existingTarget) {
      if (!nextState.catchUpResources[resource.resourceRef]) {
        nextState = {
          ...nextState,
          catchUpResources: {
            ...nextState.catchUpResources,
            [resource.resourceRef]: {
              status: existingTarget.empty ? 'complete' : 'historical-pending',
              historicalCursor: {
                resourceRef: resource.resourceRef,
                position: -1,
                processedCount: 0,
              },
              observedPosition: existingTarget.position
                ?? normalizeActivationPosition(resource.firstEventIdentity?.position),
              observedGeneration: generation.generation,
              observedScopeFingerprint: scopeFingerprint,
              updatedAt: this.now().toISOString(),
            },
          },
        };
      }
      this.persistExternalState(nextState);
      return mergeResourceSelections(
        [resource],
        this.selectKnownContinuousResources(nextState, generation, maxResources, resource.resourceRef),
        maxResources,
      );
    }

    if (!this.reader?.sampleHistory) {
      nextState = this.withPendingCatchUpSample(
        nextState,
        resource,
        undefined,
        generation.generation,
        scopeFingerprint,
      );
      nextState = this.advanceCatchUpResourceSelection(nextState);
      this.persistExternalState(nextState);
      return this.selectKnownContinuousResources(nextState, generation, maxResources);
    }
    const sample = this.reader.sampleHistory(resource);
    if (sample.status !== 'stable') {
      nextState = this.withPendingCatchUpSample(
        nextState,
        resource,
        sample.observedPosition,
        generation.generation,
        scopeFingerprint,
      );
      nextState = this.advanceCatchUpResourceSelection(nextState);
      this.persistExternalState(nextState);
      return this.selectKnownContinuousResources(nextState, generation, maxResources);
    }

    const events = [...sample.events].sort((a, b) => a.position - b.position);
    const targetPosition = events.length > 0 ? events[events.length - 1]!.position : null;
    const observedPosition = Math.max(
      0,
      sample.observedPosition,
      normalizeActivationPosition(resource.firstEventIdentity?.position),
      targetPosition ?? 0,
    );
    const prefixDigest = buildExternalCatchUpPrefixDigest(events);
    const lastIdentity = events[events.length - 1];
    const pendingSample: ExternalCatchUpPrefixObservation = {
      position: targetPosition,
      prefixDigest,
      ...(sample.conversationId ?? lastIdentity?.conversationId ?? resource.firstEventIdentity?.conversationId
        ? {
          conversationId: sample.conversationId
            ?? lastIdentity?.conversationId
            ?? resource.firstEventIdentity?.conversationId,
        }
        : {}),
      ...(sample.branchId ?? lastIdentity?.branchId ?? resource.firstEventIdentity?.branchId
        ? {
          branchId: sample.branchId
            ?? lastIdentity?.branchId
            ?? resource.firstEventIdentity?.branchId,
        }
        : {}),
      observedAt: this.now().toISOString(),
    };
    const previousSample = nextState.catchUpResources[resource.resourceRef]?.pendingSample;
    if (!previousSample || !catchUpPrefixObservationsMatch(previousSample, pendingSample)) {
      nextState = this.withPendingCatchUpSample(
        nextState,
        resource,
        observedPosition,
        generation.generation,
        scopeFingerprint,
        pendingSample,
      );
      nextState = this.advanceCatchUpResourceSelection(nextState);
      this.persistExternalState(nextState);
      return this.selectKnownContinuousResources(nextState, generation, maxResources);
    }
    const targetId = createHash('sha256').update(JSON.stringify([
      this.identity.provider,
      this.identity.sourceId,
      resource.resourceRef,
      generation.generation,
      scopeFingerprint,
      targetPosition,
      prefixDigest,
    ])).digest('hex');
    const target: ExternalCatchUpTarget = {
      targetId,
      provider: this.identity.provider,
      sourceId: this.identity.sourceId,
      resourceRef: resource.resourceRef,
      ...(lastIdentity?.conversationId ?? resource.firstEventIdentity?.conversationId
        ? { conversationId: lastIdentity?.conversationId ?? resource.firstEventIdentity?.conversationId }
        : {}),
      ...(lastIdentity?.branchId ?? resource.firstEventIdentity?.branchId
        ? { branchId: lastIdentity?.branchId ?? resource.firstEventIdentity?.branchId }
        : {}),
      position: targetPosition,
      empty: targetPosition === null,
      prefixDigest,
      creationGeneration: generation.generation,
      scopeFingerprint,
      observedAt: this.now().toISOString(),
    };
    const now = this.now().toISOString();
    const catchUpResource: ExternalCatchUpResourceState = {
      status: target.empty ? 'complete' : 'historical-pending',
      historicalCursor: {
        resourceRef: resource.resourceRef,
        position: -1,
        processedCount: 0,
      },
      observedPosition,
      observedGeneration: generation.generation,
      observedScopeFingerprint: scopeFingerprint,
      updatedAt: now,
    };
    const cursors = { ...nextState.cursors };
    const existingCursor = readCursorWithSourceIdentityValidation(
      nextState,
      this.identity,
      resource.resourceRef,
    );
    const continuousPosition = Math.max(
      existingCursor?.position ?? -1,
      target.position ?? observedPosition,
    );
    const entry: ExternalCursorEntry = {
      cursor: {
        resourceRef: resource.resourceRef,
        // The continuous lane starts above the immutable target immediately;
        // historical progress uses its separate cursor and can be paused.
        position: continuousPosition,
        processedCount: existingCursor?.processedCount ?? 0,
      },
      sourceIdentity: this.identity,
      updatedAt: now,
      lastStatus: 'activated',
    };
    cursors[resource.resourceRef] = entry;
    cursors[this.identity.sourceId] = entry;
    nextState = {
      ...nextState,
      cursors,
      catchUpTargets: {
        ...nextState.catchUpTargets,
        [resource.resourceRef]: target,
      },
      catchUpResources: {
        ...nextState.catchUpResources,
        [resource.resourceRef]: catchUpResource,
      },
      updatedAt: now,
    };
    nextState = completeExternalCatchUpCatalogIfReady(nextState, this.now);
    this.persistExternalState(nextState);
    return this.selectKnownContinuousResources(nextState, generation, maxResources, resource.resourceRef);
  }

  private resolveCatchUpCatalogLimits(): ExternalCatchUpCatalogLimits {
    const configured = this.reader?.getCatchUpCatalogLimits?.();
    const maxCatalogResources = normalizePositiveCatalogLimit(
      configured?.maxCatalogResources,
      2_048,
    );
    return {
      initialLimit: Math.min(
        maxCatalogResources,
        normalizePositiveCatalogLimit(configured?.initialLimit, 100),
      ),
      maxCatalogResources,
      maxOutputBytes: normalizePositiveCatalogLimit(configured?.maxOutputBytes, 4 * 1024 * 1024),
      maxDurationMs: normalizePositiveCatalogLimit(configured?.maxDurationMs, 60_000),
    };
  }

  private ensureCatchUpCatalogGeneration(
    state: ExternalCursorState,
    scopeFingerprint: string,
    limits: ExternalCatchUpCatalogLimits,
  ): ExternalCursorState {
    const active = state.catchUpCatalog.active;
    const now = this.now().toISOString();
    if (active && active.scopeFingerprint !== scopeFingerprint && active.status !== 'invalidated') {
      return {
        ...state,
        catchUpCatalog: {
          ...state.catchUpCatalog,
          active: {
            ...active,
            status: 'invalidated',
            invalidatedAt: now,
          },
        },
        updatedAt: now,
      };
    }
    if (
      active
      && active.scopeFingerprint === scopeFingerprint
      && active.status !== 'caught-up'
      && active.status !== 'invalidated'
    ) {
      return state;
    }

    const highestGeneration = Math.max(
      0,
      active?.generation ?? 0,
      state.catchUpCatalog.lastCompleted?.generation ?? 0,
      ...Object.values(state.catchUpTargets).map(target => target.creationGeneration),
      ...Object.values(state.catchUpResources).map(resource => resource.observedGeneration ?? 0),
    );
    const generation = active === null && highestGeneration > 0
      && state.catchUpCatalog.lastCompleted === null
      ? highestGeneration
      : highestGeneration + 1;
    const nextActive: ExternalCatchUpCatalogGeneration = {
      generation: Math.max(1, generation),
      status: 'inventory',
      requestedLimit: limits.initialLimit,
      scopeFingerprint,
      startedAt: now,
      observedResourceCount: 0,
      lastObservationCount: 0,
      observedOutputBytes: 0,
    };
    return {
      ...state,
      catchUpCatalog: {
        active: nextActive,
        lastCompleted: active?.status === 'caught-up'
          ? active
          : state.catchUpCatalog.lastCompleted,
      },
      updatedAt: now,
    };
  }

  private invalidateCatchUpCatalogForScopeChange(state: ExternalCursorState): ExternalCursorState {
    const active = state.catchUpCatalog.active;
    if (!active || active.status === 'invalidated') return state;
    const scopeFingerprint = buildExternalCatchUpScopeFingerprint(
      this.identity.provider,
      this.identity.sourceId,
      this.scope,
    );
    if (active.scopeFingerprint === scopeFingerprint) return state;
    const now = this.now().toISOString();
    if (active.status === 'caught-up') {
      return {
        ...state,
        catchUpCatalog: {
          active: null,
          lastCompleted: active,
        },
        updatedAt: now,
      };
    }
    return {
      ...state,
      catchUpCatalog: {
        ...state.catchUpCatalog,
        active: {
          ...active,
          status: 'invalidated',
          invalidatedAt: now,
        },
      },
      updatedAt: now,
    };
  }

  private observeCatchUpCatalog(
    state: ExternalCursorState,
    requestedLimit: number,
  ): ExternalCatchUpCatalogObservation {
    if (this.reader?.observeCatchUpCatalog) {
      return this.reader.observeCatchUpCatalog({
        requestedLimit,
        knownResourceRefs: Object.keys(state.resources),
      });
    }
    const discovery = this.discoverIncrementalPage(state, null, null, requestedLimit);
    return {
      ...discovery,
      returnedResourceCount: discovery.resources.length,
    };
  }

  private recordCatchUpCatalogMembership(
    state: ExternalCursorState,
    resources: readonly SessionLogSourceResource[],
    generation: number,
    scopeFingerprint: string,
  ): ExternalCursorState {
    const now = this.now().toISOString();
    const catchUpResources = { ...state.catchUpResources };
    for (const resource of resources) {
      const existing = catchUpResources[resource.resourceRef];
      const target = state.catchUpTargets[resource.resourceRef];
      catchUpResources[resource.resourceRef] = {
        status: existing?.status ?? (target ? (target.empty ? 'complete' : 'historical-pending') : 'target-pending'),
        historicalCursor: existing?.historicalCursor ?? {
          resourceRef: resource.resourceRef,
          position: -1,
          processedCount: 0,
        },
        observedPosition: Math.max(
          0,
          existing?.observedPosition ?? 0,
          normalizeActivationPosition(resource.firstEventIdentity?.position),
        ),
        observedGeneration: generation,
        observedScopeFingerprint: scopeFingerprint,
        ...(existing?.terminalTombstoneId
          ? { terminalTombstoneId: existing.terminalTombstoneId }
          : {}),
        updatedAt: now,
      };
    }
    return {
      ...state,
      catchUpResources,
      updatedAt: now,
    };
  }

  private selectCatchUpResource(
    state: ExternalCursorState,
    generation: ExternalCatchUpCatalogGeneration,
    maxResources: number,
  ): ExternalDiscoveredResourceState | undefined {
    if (maxResources <= 0) return undefined;
    const candidates = Object.entries(state.catchUpResources)
      .filter(([, resource]) => resource.status !== 'complete')
      .filter(([, resource]) => (
        resource.observedGeneration === generation.generation
        || resource.observedScopeFingerprint === generation.scopeFingerprint
      ))
      .filter(([resourceRef]) => state.resources[resourceRef]?.lifecycleStatus !== 'closed')
      .filter(([resourceRef]) => !hasBlockingQuarantineForResource(state, resourceRef))
      .sort(([leftRef, left], [rightRef, right]) => {
        if (left.status !== right.status) return left.status === 'target-pending' ? -1 : 1;
        return leftRef.localeCompare(rightRef);
      });
    const resourceRef = candidates.length > 0
      ? candidates[(state.discovery?.nextResourceIndex ?? 0) % candidates.length]?.[0]
      : undefined;
    return resourceRef ? state.resources[resourceRef] : undefined;
  }

  private advanceCatchUpResourceSelection(state: ExternalCursorState): ExternalCursorState {
    const now = this.now().toISOString();
    return {
      ...state,
      discovery: {
        nextPageToken: null,
        nextResourceIndex: (state.discovery?.nextResourceIndex ?? 0) + 1,
        updatedAt: now,
        cycle: state.catchUpCatalog.active?.generation ?? state.discovery?.cycle ?? 0,
      },
      updatedAt: now,
    };
  }

  private selectContinuousCatchUpResources(
    state: ExternalCursorState,
    generation: ExternalCatchUpCatalogGeneration,
    maxResources: number,
  ): readonly SessionLogSourceResource[] {
    if (maxResources <= 0) return [];
    return Object.entries(state.catchUpResources)
      .filter(([, resource]) => resource.status === 'complete')
      .filter(([, resource]) => resource.observedGeneration === generation.generation)
      .filter(([resourceRef]) => state.resources[resourceRef]?.lifecycleStatus !== 'closed')
      .filter(([resourceRef]) => !hasBlockingQuarantineForResource(state, resourceRef))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, maxResources)
      .flatMap(([resourceRef]) => {
        const resource = state.resources[resourceRef]?.resource;
        return resource ? [resource] : [];
      });
  }

  private selectKnownContinuousResources(
    state: ExternalCursorState,
    generation: ExternalCatchUpCatalogGeneration,
    maxResources: number,
    excludedResourceRef?: string,
  ): readonly SessionLogSourceResource[] {
    if (maxResources <= 0) return [];
    return Object.entries(state.resources)
      .filter(([resourceRef, resource]) => resourceRef !== excludedResourceRef
        && resource.lifecycleStatus !== 'closed'
        && resource.lastSeenScopeFingerprint === generation.scopeFingerprint)
      .filter(([resourceRef]) => state.catchUpTargets[resourceRef] === undefined)
      .filter(([resourceRef]) => state.catchUpResources[resourceRef]?.status !== 'historical-pending')
      .filter(([resourceRef]) => state.cursors[resourceRef] !== undefined)
      .filter(([resourceRef]) => !hasBlockingQuarantineForResource(state, resourceRef))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, maxResources)
      .map(([, resource]) => resource.resource);
  }

  private blockCatchUpCatalog(
    state: ExternalCursorState,
    reason: string,
  ): ExternalCursorState {
    const active = state.catchUpCatalog.active;
    if (!active) return state;
    const now = this.now().toISOString();
    return {
      ...state,
      catchUpCatalog: {
        ...state.catchUpCatalog,
        active: {
          ...active,
          status: 'catch-up-blocked',
          blockedAt: now,
          blockedReason: redactExternalSourceDiagnostic(reason),
        },
      },
      updatedAt: now,
    };
  }

  private withPendingCatchUpSample(
    state: ExternalCursorState,
    resource: SessionLogSourceResource,
    observedPosition = normalizeActivationPosition(resource.firstEventIdentity?.position),
    observedGeneration?: number,
    observedScopeFingerprint?: string,
    pendingSample?: ExternalCatchUpPrefixObservation,
  ): ExternalCursorState {
    const now = this.now().toISOString();
    const existing = state.catchUpResources[resource.resourceRef];
    return {
      ...state,
      catchUpResources: {
        ...state.catchUpResources,
        [resource.resourceRef]: {
          status: 'target-pending',
          historicalCursor: existing?.historicalCursor ?? {
            resourceRef: resource.resourceRef,
            position: -1,
            processedCount: 0,
          },
          observedPosition: Math.max(0, observedPosition),
          ...(observedGeneration !== undefined && observedScopeFingerprint
            ? { observedGeneration, observedScopeFingerprint }
            : existing?.observedGeneration !== undefined && existing.observedScopeFingerprint
              ? {
                observedGeneration: existing.observedGeneration,
                observedScopeFingerprint: existing.observedScopeFingerprint,
              }
              : {}),
          ...(pendingSample
            ? { pendingSample }
            : {}),
          updatedAt: now,
        },
      },
      updatedAt: now,
    };
  }

  private initializeFutureOnlyActivation(
    state: ExternalCursorState,
    maxResources: number,
  ): ExternalCursorState {
    const cycle = 1;
    let discovery: ExternalSourceIncrementalDiscoveryResult;
    try {
      discovery = this.discoverIncrementalPage(state, null, null, maxResources);
    } catch (error) {
      if (isActivationBlockedError(error)) {
        const now = new Date().toISOString();
        return {
          ...state,
          activation: {
            initializedAt: now,
            mode: 'future-only-resource-baseline',
            initialDiscoveryCompleted: false,
            activationBlocked: true,
            activationBlockedReason: redactExternalSourceDiagnostic(error),
            activationBlockedAt: now,
          },
          discovery: {
            nextPageToken: null,
            nextResourceIndex: 0,
            updatedAt: now,
            cycle,
          },
        };
      }
      throw error;
    }
    const withResources = applyExternalDiscoveryPageAndFinalize(
      state,
      this.identity,
      discovery,
      cycle,
      true,
      buildExternalCatchUpScopeFingerprint(this.identity.provider, this.identity.sourceId, this.scope),
      this.scope.scope === 'path',
    );
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
    const refreshed = applyExternalDiscoveryPageAndFinalize(
      state,
      this.identity,
      discovery,
      cycle,
      true,
      buildExternalCatchUpScopeFingerprint(this.identity.provider, this.identity.sourceId, this.scope),
      this.scope.scope === 'path',
    );
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
        knownResourceRefs: Object.keys(state.resources),
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
  readonly readerVersion?: string;
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

/**
 * Detects an xURL activation-blocked error by its marker property without
 * importing the reader module (avoids a circular dependency).
 */
function isActivationBlockedError(error: unknown): boolean {
  return error != null && typeof error === 'object'
    && (error as Record<string, unknown>).xurlActivationBlocked === true;
}

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
  if (/auth|unauthori|forbidden|permission denied|access denied/.test(normalized)) return 'permission';
  if (/protocol|json|schema|provider mismatch|unsupported|frontmatter|timeline|ordinal|rendered|heading|uri mismatch|thread mismatch|catalog/.test(normalized)) return 'protocol';
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
  const entriesFor = (directory: string): fs.Dirent[] => fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : (left.name > right.name ? 1 : 0));
  const stack: Array<{ directory: string; entries: fs.Dirent[]; offset: number }> = [{
    directory: root,
    entries: entriesFor(root),
    offset: 0,
  }];

  while (stack.length > 0) {
    const current = stack[stack.length - 1]!;
    const entry = current.entries[current.offset++];
    if (!entry) {
      stack.pop();
      continue;
    }
    const fullPath = path.join(current.directory, entry.name);
    if (entry.isDirectory()) {
      try {
        stack.push({ directory: fullPath, entries: entriesFor(fullPath), offset: 0 });
      } catch {
        // A disappearing/inaccessible directory is source-local noise. The
        // next complete traversal can retry it.
      }
      yield undefined;
      continue;
    }
    yield entry.isFile() && entry.name.endsWith('.jsonl') ? fullPath : undefined;
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
  const directEntry = resourceRef ? state.cursors[resourceRef] : undefined;
  const hasResourceScopedState = resourceRef !== undefined && (
    Object.keys(state.resources).length > 0
    || Object.keys(state.cursors).some(key => key !== identity.sourceId)
  );
  // The source-id cursor is a legacy single-resource compatibility alias. It
  // must never baseline a newly discovered second resource at another
  // thread's position.
  const entry = directEntry ?? (hasResourceScopedState ? undefined : state.cursors[identity.sourceId]);
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
  baselineNewResources = true,
  scopeFingerprint?: string,
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
      ...(scopeFingerprint ? { lastSeenScopeFingerprint: scopeFingerprint } : {}),
      missingDiscoveryCycles: 0,
      missingSince: null,
      ...(existing?.lastSuccessfulReadAt ? { lastSuccessfulReadAt: existing.lastSuccessfulReadAt } : {}),
      ...(existing?.closedAt ? { closedAt: existing.closedAt } : {}),
      ...(existing?.closedReason ? { closedReason: existing.closedReason } : {}),
    };
    const existingCursor = readCursorWithSourceIdentityValidation(nextState, identity, item.resource.resourceRef);
    const directCursor = nextState.cursors[item.resource.resourceRef];
    if (baselineNewResources && !directCursor) {
      const promotableLegacyCursor = existingCursor?.resourceRef === item.resource.resourceRef
        ? existingCursor
        : null;
      nextCursors[item.resource.resourceRef] = {
        cursor: promotableLegacyCursor
          ? { ...promotableLegacyCursor, resourceRef: item.resource.resourceRef }
          : {
            resourceRef: item.resource.resourceRef,
            position: item.activationPosition,
            processedCount: 0,
          },
        sourceIdentity: identity,
        updatedAt: now,
        lastStatus: promotableLegacyCursor
          ? (nextState.cursors[identity.sourceId]?.lastStatus ?? 'activated')
          : 'activated',
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

function applyExternalDiscoveryPageAndFinalize(
  state: ExternalCursorState,
  identity: SessionLogSourceIdentity,
  discovery: ExternalSourceIncrementalDiscoveryResult,
  cycle: number,
  baselineNewResources: boolean,
  scopeFingerprint: string,
  preserveMissingResources: boolean,
): ExternalCursorState {
  const discovered = applyExternalDiscoveryPage(
    state,
    identity,
    discovery,
    cycle,
    baselineNewResources,
    scopeFingerprint,
  );
  return discovery.nextPageToken == null
    ? finalizeExternalDiscoveryCycle(discovered, cycle, preserveMissingResources)
    : discovered;
}

function finalizeExternalDiscoveryCycle(
  state: ExternalCursorState,
  cycle: number,
  preserveMissingResources = false,
): ExternalCursorState {
  const now = new Date().toISOString();
  let changed = false;
  const nextResources: Record<string, ExternalDiscoveredResourceState> = {};
  for (const [resourceRef, resourceState] of Object.entries(state.resources)) {
    if (resourceState.lastSeenDiscoveryCycle === cycle) {
      nextResources[resourceRef] = resourceState;
      continue;
    }
    if (preserveMissingResources) {
      nextResources[resourceRef] = resourceState;
      continue;
    }
    const missingDiscoveryCycles = (resourceState.missingDiscoveryCycles ?? 0) + 1;
    nextResources[resourceRef] = {
      ...resourceState,
      // Discovery absence is not proof of deletion or archival. Only an
      // explicit lifecycle command/protocol signal may move a resource to
      // `closed`; completed discovery cycles retain resumable state.
      lifecycleStatus: resourceState.lifecycleStatus ?? 'active',
      missingDiscoveryCycles,
      missingSince: resourceState.missingSince ?? now,
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
  const currentDiscoveryCycle = state.discovery?.cycle;
  const resourceRefs = Object.keys(state.resources)
    .sort()
    .filter(resourceRef => state.resources[resourceRef]?.lifecycleStatus !== 'closed')
    // Scope changes preserve old resource state but only resources observed in
    // the current scoped discovery cycle are eligible for continuous reads.
    .filter(resourceRef => currentDiscoveryCycle === undefined
      || state.resources[resourceRef]?.lastSeenDiscoveryCycle === currentDiscoveryCycle)
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

function mergeResourceSelections(
  primary: readonly SessionLogSourceResource[],
  secondary: readonly SessionLogSourceResource[],
  maxResources: number,
): readonly SessionLogSourceResource[] {
  const selected = new Map<string, SessionLogSourceResource>();
  for (const resource of [...primary, ...secondary]) {
    if (selected.size >= Math.max(0, maxResources)) break;
    if (!selected.has(resource.resourceRef)) selected.set(resource.resourceRef, resource);
  }
  return [...selected.values()];
}

function normalizePositiveCatalogLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

function catchUpPrefixObservationsMatch(
  left: ExternalCatchUpPrefixObservation,
  right: ExternalCatchUpPrefixObservation,
): boolean {
  return left.position === right.position
    && left.prefixDigest === right.prefixDigest
    && left.conversationId === right.conversationId
    && left.branchId === right.branchId;
}

function isResolvedCatchUpResource(
  state: ExternalCursorState,
  resource: ExternalCatchUpResourceState,
): boolean {
  return resource.status === 'complete'
    || (
      (resource.status === 'closed' || resource.status === 'abandoned')
      && typeof resource.terminalTombstoneId === 'string'
      && resource.terminalTombstoneId.length > 0
      && Object.values(state.tombstones).some(
        tombstone => tombstone.tombstoneId === resource.terminalTombstoneId,
      )
    );
}

export function completeExternalCatchUpCatalogIfReady(
  state: ExternalCursorState,
  now: () => Date,
): ExternalCursorState {
  const active = state.catchUpCatalog.active;
  if (!active || active.status !== 'draining' || !active.observationCompletedAt) return state;
  const unresolved = Object.values(state.catchUpResources).some(resource => (
    resource.observedScopeFingerprint === active.scopeFingerprint
    && !isResolvedCatchUpResource(state, resource)
  ));
  if (unresolved) return state;
  const completedAt = now().toISOString();
  return {
    ...state,
    catchUpCatalog: {
      ...state.catchUpCatalog,
      active: {
        ...active,
        status: 'caught-up',
        completedAt,
      },
    },
    updatedAt: completedAt,
  };
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

export function buildExternalCatchUpPrefixDigest(
  events: readonly Pick<ExternalSourceRawEvent, 'eventId' | 'position' | 'conversationId' | 'branchId' | 'contentHash'>[],
): string {
  const digest = createHash('sha256');
  for (const event of [...events].sort((a, b) => a.position - b.position)) {
    digest.update(JSON.stringify([
      event.eventId,
      event.position,
      event.conversationId ?? null,
      event.branchId ?? null,
      normalizeContentHash(event.contentHash),
    ]));
    digest.update('\n');
  }
  return digest.digest('hex');
}

export function buildExternalCatchUpScopeFingerprint(
  provider: string,
  sourceId: string,
  scope: { scope: 'global' | 'path'; scopePath?: string },
): string {
  return createHash('sha256').update(JSON.stringify([
    provider,
    sourceId,
    scope.scope,
    scope.scopePath ?? null,
  ])).digest('hex');
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
  resourceRef: string,
  event: ExternalSourceRawEvent,
): boolean {
  const identity = toEventIdentity(event);
  const stableKey = buildExternalStableEventKey(sourceIdentity, identity);
  const dedupKey = buildExternalEventDedupKey(sourceIdentity, identity);
  return Object.entries(state.tombstones).some(([key, tombstone]) => {
    if (tombstone.resourceRef !== resourceRef) return false;
    if (tombstone.kind === 'event-skip') {
      return key === stableKey
        || key === dedupKey
        || (
          tombstone.identity.eventId === identity.eventId
          && tombstone.identity.position === identity.position
          && (tombstone.identity.conversationId ?? '') === (identity.conversationId ?? '')
          && (tombstone.identity.branchId ?? '') === (identity.branchId ?? '')
        );
    }
    return identity.position >= tombstone.range.startPosition
      && identity.position <= tombstone.range.endPosition;
  });
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
