/**
 * Issue #79 — explicit, bounded External Session Log Backfill.
 *
 * This module introduces an opt-in, operator-triggered backfill service that
 * is deliberately separate from the normal RuntimeLearning wake/heartbeat path.
 * It owns its own durable state and audit trail so historical external logs do
 * not silently become ordinary continuous discovery progress.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DistillationUnit } from './distillation-unit';
import {
  SessionLogSourceIdentity,
  SessionLogSourceResource,
  SourceCursor,
  SourceEventIdentity,
} from './session-log-source';

export interface ExternalSessionLogBackfillRange {
  /** Inclusive monotonic start position inside the chosen source. */
  readonly startPosition: number;
  /** Inclusive monotonic end position inside the chosen source. */
  readonly endPosition: number;
  /** Optional explicit bounded resource selection (for example conversations). */
  readonly resourceRefs?: readonly string[];
}

export interface ExternalSessionLogBackfillLimits {
  readonly maxResources: number;
  readonly maxBytes: number;
  readonly maxElapsedMs: number;
}

export interface ExternalSessionLogBackfillRequest {
  readonly operationId: string;
  readonly triggeredBy: string;
  readonly provider: string;
  readonly sourceId: string;
  readonly range: ExternalSessionLogBackfillRange;
  readonly limits: ExternalSessionLogBackfillLimits;
  /** Deliberate audited exception that reopens exactly one durable tombstone. */
  readonly reopenTombstoneId?: string;
}

export interface ExternalSessionLogBackfillEvent {
  readonly identity: SourceEventIdentity;
  readonly distillationUnit: DistillationUnit | null;
  readonly byteLength: number;
}

export interface ExternalSessionLogBackfillReadResult {
  readonly events: readonly ExternalSessionLogBackfillEvent[];
  readonly status: 'stable' | 'pending';
  readonly exhausted: boolean;
  readonly newCursor: SourceCursor;
}

export interface ExternalSessionLogBackfillSource {
  readonly identity: SessionLogSourceIdentity;
  discoverResources(): readonly SessionLogSourceResource[];
  read(resource: SessionLogSourceResource, cursor: SourceCursor): ExternalSessionLogBackfillReadResult;
}

export interface ExternalSessionLogBackfillIngestResult {
  readonly admittedEpisodeIds: readonly string[];
  /** Present when Runtime intentionally skipped this event due to a tombstone. */
  readonly tombstoneId?: string;
}

export interface ExternalSessionLogBackfillIngestContext {
  readonly operationId: string;
  readonly provider: string;
  readonly sourceId: string;
  readonly triggeredBy: string;
  readonly resource: SessionLogSourceResource;
  readonly eventIdentity: SourceEventIdentity;
}

export type ExternalSessionLogBackfillIngestor = (
  unit: DistillationUnit,
  context: ExternalSessionLogBackfillIngestContext,
) => ExternalSessionLogBackfillIngestResult;

export type ExternalSessionLogBackfillStatus =
  | 'pending'
  | 'running'
  | 'quota_reached'
  | 'source_failed'
  | 'completed';

export interface ExternalSessionLogBackfillFailure {
  readonly resourceRef: string;
  readonly eventId?: string;
  readonly message: string;
  readonly at: string;
}

export interface ExternalSessionLogBackfillMetrics {
  readonly runsStarted: number;
  readonly resourcesDiscovered: number;
  readonly resourcesProcessed: number;
  readonly pendingResources: number;
  readonly failedResources: number;
  readonly ingestedEvents: number;
  readonly duplicateEventsSkipped: number;
  readonly tombstonedEventsSkipped: number;
  readonly admittedEpisodes: number;
  readonly bytesProcessed: number;
}

export interface ExternalSessionLogBackfillState {
  readonly schemaVersion: number;
  readonly operationId: string;
  readonly triggeredBy: string;
  readonly provider: string;
  readonly sourceId: string;
  readonly range: ExternalSessionLogBackfillRange;
  readonly reopenTombstoneId?: string;
  readonly status: ExternalSessionLogBackfillStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly resourceCursors: Record<string, SourceCursor>;
  readonly processedEventIds: Record<string, string | null>;
  readonly failures: readonly ExternalSessionLogBackfillFailure[];
  readonly metrics: ExternalSessionLogBackfillMetrics;
}

export type ExternalSessionLogBackfillAuditKind =
  | 'started'
  | 'resumed'
  | 'resource_ingested'
  | 'resource_pending'
  | 'resource_duplicate'
  | 'resource_tombstone'
  | 'resource_failed'
  | 'quota_reached'
  | 'pending'
  | 'source_failed'
  | 'completed';

export interface ExternalSessionLogBackfillAuditEntry {
  readonly timestamp: string;
  readonly kind: ExternalSessionLogBackfillAuditKind;
  readonly operationId: string;
  readonly provider: string;
  readonly sourceId: string;
  readonly triggeredBy: string;
  readonly range: ExternalSessionLogBackfillRange;
  readonly reopenTombstoneId?: string;
  readonly status: ExternalSessionLogBackfillStatus;
  readonly resourceRef?: string;
  readonly eventId?: string;
  readonly message?: string;
  readonly metrics: ExternalSessionLogBackfillMetrics;
}

export interface ExternalSessionLogBackfillRunResult {
  readonly status: ExternalSessionLogBackfillStatus;
  readonly discoveredResources: number;
  readonly processedResources: number;
  readonly pendingResources: number;
  readonly failedResources: number;
  readonly ingestedEvents: number;
  readonly duplicateEventsSkipped: number;
  readonly tombstonedEventsSkipped: number;
  readonly admittedEpisodes: number;
  readonly bytesProcessed: number;
  readonly state: ExternalSessionLogBackfillState;
}

export interface ExternalSessionLogBackfillServiceOptions {
  readonly stateFilePath: string;
  readonly auditFilePath: string;
  readonly now?: () => Date;
}

export interface ExternalSessionLogBackfillRunOptions {
  /** Runtime xURL reads may return a complete thread; admit only the named range. */
  readonly filterOutOfRangeEvents?: boolean;
}

export class ExternalSessionLogBackfillService {
  private readonly now: () => Date;

  constructor(private readonly options: ExternalSessionLogBackfillServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  run(
    request: ExternalSessionLogBackfillRequest,
    source: ExternalSessionLogBackfillSource,
    ingest: ExternalSessionLogBackfillIngestor,
    options: ExternalSessionLogBackfillRunOptions = {},
  ): ExternalSessionLogBackfillRunResult {
    validateBackfillRequest(request);
    validateBackfillSource(request, source);

    const startedAt = this.now();
    let state = loadExternalSessionLogBackfillState(this.options.stateFilePath)
      ?? createExternalSessionLogBackfillState(request, startedAt);
    state = assertCompatibleState(state, request);

    let metrics = {
      ...state.metrics,
      runsStarted: state.metrics.runsStarted + 1,
      resourcesDiscovered: 0,
    };
    state = {
      ...state,
      status: 'running',
      updatedAt: startedAt.toISOString(),
      metrics,
    };
    saveExternalSessionLogBackfillState(this.options.stateFilePath, state);
    appendExternalSessionLogBackfillAudit(this.options.auditFilePath, {
      timestamp: startedAt.toISOString(),
      kind: state.metrics.runsStarted === 1 ? 'started' : 'resumed',
      operationId: state.operationId,
      provider: state.provider,
      sourceId: state.sourceId,
      triggeredBy: state.triggeredBy,
      range: state.range,
      reopenTombstoneId: state.reopenTombstoneId,
      status: state.status,
      metrics,
    });

    let matchedResources: SessionLogSourceResource[];
    try {
      matchedResources = selectBackfillResources(source.discoverResources(), request.range);
      metrics = {
        ...state.metrics,
        resourcesDiscovered: matchedResources.length,
      };
      state = {
        ...state,
        updatedAt: this.now().toISOString(),
        metrics,
      };
      saveExternalSessionLogBackfillState(this.options.stateFilePath, state);
    } catch (error) {
      const failedAt = this.now();
      state = recordBackfillFailure(state, '__discover__', undefined, error, failedAt);
      state = {
        ...state,
        status: 'source_failed',
        updatedAt: failedAt.toISOString(),
        metrics: {
          ...state.metrics,
          failedResources: state.metrics.failedResources + 1,
        },
      };
      saveExternalSessionLogBackfillState(this.options.stateFilePath, state);
      appendExternalSessionLogBackfillAudit(this.options.auditFilePath, {
        timestamp: failedAt.toISOString(),
        kind: 'source_failed',
        operationId: state.operationId,
        provider: state.provider,
        sourceId: state.sourceId,
        triggeredBy: state.triggeredBy,
        range: state.range,
        reopenTombstoneId: state.reopenTombstoneId,
        status: state.status,
        message: toErrorMessage(error),
        metrics: state.metrics,
      });
      return {
        status: 'source_failed',
        discoveredResources: 0,
        processedResources: 0,
        pendingResources: 0,
        failedResources: 1,
        ingestedEvents: 0,
        duplicateEventsSkipped: 0,
        tombstonedEventsSkipped: 0,
        admittedEpisodes: 0,
        bytesProcessed: 0,
        state,
      };
    }

    let processedResources = 0;
    let pendingResources = 0;
    let failedResources = 0;
    let ingestedEvents = 0;
    let duplicateEventsSkipped = 0;
    let tombstonedEventsSkipped = 0;
    let admittedEpisodes = 0;
    let bytesProcessed = 0;
    let sawPending = false;
    let sawFailure = false;
    let quotaReached = false;
    const matchedResourceRefs = new Set(matchedResources.map(resource => resource.resourceRef));
    const missingRequestedResourceRefs = (request.range.resourceRefs ?? [])
      .filter(resourceRef => !matchedResourceRefs.has(resourceRef));

    if (missingRequestedResourceRefs.length > 0) {
      sawPending = true;
      pendingResources += missingRequestedResourceRefs.length;
      metrics = {
        ...state.metrics,
        pendingResources: state.metrics.pendingResources + missingRequestedResourceRefs.length,
      };
      state = {
        ...state,
        updatedAt: this.now().toISOString(),
        metrics,
      };
      saveExternalSessionLogBackfillState(this.options.stateFilePath, state);
      for (const resourceRef of missingRequestedResourceRefs) {
        appendExternalSessionLogBackfillAudit(this.options.auditFilePath, {
          timestamp: this.now().toISOString(),
          kind: 'resource_pending',
          operationId: state.operationId,
          provider: state.provider,
          sourceId: state.sourceId,
          triggeredBy: state.triggeredBy,
          range: state.range,
          reopenTombstoneId: state.reopenTombstoneId,
          status: state.status,
          resourceRef,
          metrics: state.metrics,
        });
      }
    }

    for (const resource of matchedResources) {
      const now = this.now();
      if (processedResources >= request.limits.maxResources) {
        quotaReached = true;
        break;
      }
      if (now.getTime() - startedAt.getTime() >= request.limits.maxElapsedMs) {
        quotaReached = true;
        break;
      }

      const cursor = state.resourceCursors[resource.resourceRef] ?? {
        resourceRef: resource.resourceRef,
        position: -1,
        processedCount: 0,
      };

      let readResult: ExternalSessionLogBackfillReadResult;
      try {
        readResult = source.read(resource, cursor);
      } catch (error) {
        sawFailure = true;
        failedResources += 1;
        state = recordBackfillFailure(state, resource.resourceRef, undefined, error, now);
        state = {
          ...state,
          updatedAt: now.toISOString(),
          metrics: {
            ...state.metrics,
            failedResources: state.metrics.failedResources + 1,
          },
        };
        metrics = state.metrics;
        saveExternalSessionLogBackfillState(this.options.stateFilePath, state);
        appendExternalSessionLogBackfillAudit(this.options.auditFilePath, {
          timestamp: now.toISOString(),
          kind: 'resource_failed',
          operationId: state.operationId,
          provider: state.provider,
          sourceId: state.sourceId,
          triggeredBy: state.triggeredBy,
          range: state.range,
          reopenTombstoneId: state.reopenTombstoneId,
          status: state.status,
          resourceRef: resource.resourceRef,
          message: toErrorMessage(error),
          metrics: state.metrics,
        });
        continue;
      }

      if (readResult.status === 'pending') {
        sawPending = true;
        pendingResources += 1;
        const updatedMetrics = {
          ...state.metrics,
          pendingResources: state.metrics.pendingResources + 1,
        };
        state = {
          ...state,
          updatedAt: now.toISOString(),
          metrics: updatedMetrics,
        };
        metrics = updatedMetrics;
        saveExternalSessionLogBackfillState(this.options.stateFilePath, state);
        appendExternalSessionLogBackfillAudit(this.options.auditFilePath, {
          timestamp: now.toISOString(),
          kind: 'resource_pending',
          operationId: state.operationId,
          provider: state.provider,
          sourceId: state.sourceId,
          triggeredBy: state.triggeredBy,
          range: state.range,
          reopenTombstoneId: state.reopenTombstoneId,
          status: state.status,
          resourceRef: resource.resourceRef,
          metrics: state.metrics,
        });
        continue;
      }

      const belowReopenedBoundary = request.reopenTombstoneId !== undefined
        && readResult.newCursor.position < request.range.endPosition;
      if (readResult.events.length === 0) {
        if (request.reopenTombstoneId !== undefined) {
          sawPending = true;
          pendingResources += 1;
          metrics = {
            ...state.metrics,
            pendingResources: state.metrics.pendingResources + 1,
          };
          state = {
            ...state,
            updatedAt: now.toISOString(),
            ...(belowReopenedBoundary
              ? {
                resourceCursors: {
                  ...state.resourceCursors,
                  [resource.resourceRef]: readResult.newCursor,
                },
              }
              : {}),
            metrics,
          };
          saveExternalSessionLogBackfillState(this.options.stateFilePath, state);
          appendExternalSessionLogBackfillAudit(this.options.auditFilePath, {
            timestamp: now.toISOString(),
            kind: 'resource_pending',
            operationId: state.operationId,
            provider: state.provider,
            sourceId: state.sourceId,
            triggeredBy: state.triggeredBy,
            range: state.range,
            reopenTombstoneId: state.reopenTombstoneId,
            status: state.status,
            resourceRef: resource.resourceRef,
            metrics: state.metrics,
          });
        }
        continue;
      }

      const hasOutOfRangeEvents = readResult.events.some(
        event => !isBackfillEventInRange(event.identity, request.range),
      );
      if (hasOutOfRangeEvents && !options.filterOutOfRangeEvents) {
        sawFailure = true;
        failedResources += 1;
        state = recordBackfillFailure(
          state,
          resource.resourceRef,
          readResult.events[0]?.identity.eventId,
          new Error('resource returned events outside requested backfill range'),
          now,
        );
        state = {
          ...state,
          updatedAt: now.toISOString(),
          metrics: {
            ...state.metrics,
            failedResources: state.metrics.failedResources + 1,
          },
        };
        metrics = state.metrics;
        saveExternalSessionLogBackfillState(this.options.stateFilePath, state);
        appendExternalSessionLogBackfillAudit(this.options.auditFilePath, {
          timestamp: now.toISOString(),
          kind: 'resource_failed',
          operationId: state.operationId,
          provider: state.provider,
          sourceId: state.sourceId,
          triggeredBy: state.triggeredBy,
          range: state.range,
          reopenTombstoneId: state.reopenTombstoneId,
          status: state.status,
          resourceRef: resource.resourceRef,
          message: 'resource returned events outside requested backfill range',
          metrics: state.metrics,
        });
        continue;
      }
      const eventsInRange = readResult.events.filter(
        event => isBackfillEventInRange(event.identity, request.range),
      );
      if (request.reopenTombstoneId !== undefined && eventsInRange.length === 0) {
        sawPending = true;
        pendingResources += 1;
        metrics = {
          ...state.metrics,
          pendingResources: state.metrics.pendingResources + 1,
        };
        state = {
          ...state,
          updatedAt: now.toISOString(),
          metrics,
        };
        saveExternalSessionLogBackfillState(this.options.stateFilePath, state);
        appendExternalSessionLogBackfillAudit(this.options.auditFilePath, {
          timestamp: now.toISOString(),
          kind: 'resource_pending',
          operationId: state.operationId,
          provider: state.provider,
          sourceId: state.sourceId,
          triggeredBy: state.triggeredBy,
          range: state.range,
          reopenTombstoneId: state.reopenTombstoneId,
          status: state.status,
          resourceRef: resource.resourceRef,
          metrics: state.metrics,
        });
        continue;
      }

      let resourceFailed = false;
      let resourceDuplicates = 0;
      let resourceTombstones = 0;
      let resourceIngested = 0;
      let resourceAdmittedEpisodes = 0;
      let resourceBytes = 0;

      for (const event of eventsInRange) {
        if (bytesProcessed + resourceBytes + event.byteLength > request.limits.maxBytes) {
          quotaReached = true;
          break;
        }

        const nowInLoop = this.now();
        if (nowInLoop.getTime() - startedAt.getTime() >= request.limits.maxElapsedMs) {
          quotaReached = true;
          break;
        }

        resourceBytes += event.byteLength;

        if (isExactBackfillDuplicate(state, request.provider, request.sourceId, event.identity)) {
          resourceDuplicates += 1;
          continue;
        }

        if (!event.distillationUnit) {
          resourceFailed = true;
          sawFailure = true;
          failedResources += 1;
          state = recordBackfillFailure(
            state,
            resource.resourceRef,
            event.identity.eventId,
            new Error('stable backfill event is missing a verified DistillationUnit'),
            nowInLoop,
          );
          state = {
            ...state,
            updatedAt: nowInLoop.toISOString(),
            metrics: {
              ...state.metrics,
              failedResources: state.metrics.failedResources + 1,
            },
          };
          metrics = state.metrics;
          saveExternalSessionLogBackfillState(this.options.stateFilePath, state);
          appendExternalSessionLogBackfillAudit(this.options.auditFilePath, {
            timestamp: nowInLoop.toISOString(),
            kind: 'resource_failed',
            operationId: state.operationId,
            provider: state.provider,
            sourceId: state.sourceId,
            triggeredBy: state.triggeredBy,
            range: state.range,
            reopenTombstoneId: state.reopenTombstoneId,
            status: state.status,
            resourceRef: resource.resourceRef,
            eventId: event.identity.eventId,
            message: 'stable backfill event is missing a verified DistillationUnit',
            metrics: state.metrics,
          });
          break;
        }

        try {
          const ingestion = ingest(event.distillationUnit, {
            operationId: request.operationId,
            provider: request.provider,
            sourceId: request.sourceId,
            triggeredBy: request.triggeredBy,
            resource,
            eventIdentity: event.identity,
          });
          if (ingestion.tombstoneId) {
            resourceTombstones += 1;
          } else {
            resourceIngested += 1;
            resourceAdmittedEpisodes += ingestion.admittedEpisodeIds.length;
          }
          state = markBackfillEventProcessed(state, request.provider, request.sourceId, event.identity);
        } catch (error) {
          resourceFailed = true;
          sawFailure = true;
          failedResources += 1;
          state = recordBackfillFailure(state, resource.resourceRef, event.identity.eventId, error, nowInLoop);
          state = {
            ...state,
            updatedAt: nowInLoop.toISOString(),
            metrics: {
              ...state.metrics,
              failedResources: state.metrics.failedResources + 1,
            },
          };
          metrics = state.metrics;
          saveExternalSessionLogBackfillState(this.options.stateFilePath, state);
          appendExternalSessionLogBackfillAudit(this.options.auditFilePath, {
            timestamp: nowInLoop.toISOString(),
            kind: 'resource_failed',
            operationId: state.operationId,
            provider: state.provider,
            sourceId: state.sourceId,
            triggeredBy: state.triggeredBy,
            range: state.range,
            reopenTombstoneId: state.reopenTombstoneId,
            status: state.status,
            resourceRef: resource.resourceRef,
            eventId: event.identity.eventId,
            message: toErrorMessage(error),
            metrics: state.metrics,
          });
          break;
        }
      }

      if (quotaReached || resourceFailed) {
        break;
      }

      processedResources += 1;
      if (belowReopenedBoundary) {
        sawPending = true;
        pendingResources += 1;
      }
      ingestedEvents += resourceIngested;
      duplicateEventsSkipped += resourceDuplicates;
      tombstonedEventsSkipped += resourceTombstones;
      admittedEpisodes += resourceAdmittedEpisodes;
      bytesProcessed += resourceBytes;

      const updatedMetrics = {
        ...state.metrics,
        resourcesProcessed: state.metrics.resourcesProcessed + 1,
        pendingResources: state.metrics.pendingResources + (belowReopenedBoundary ? 1 : 0),
        ingestedEvents: state.metrics.ingestedEvents + resourceIngested,
        duplicateEventsSkipped: state.metrics.duplicateEventsSkipped + resourceDuplicates,
        tombstonedEventsSkipped: state.metrics.tombstonedEventsSkipped + resourceTombstones,
        admittedEpisodes: state.metrics.admittedEpisodes + resourceAdmittedEpisodes,
        bytesProcessed: state.metrics.bytesProcessed + resourceBytes,
      };
      metrics = updatedMetrics;

      state = {
        ...state,
        updatedAt: this.now().toISOString(),
        resourceCursors: {
          ...state.resourceCursors,
          [resource.resourceRef]: readResult.newCursor,
        },
        metrics: updatedMetrics,
      };
      saveExternalSessionLogBackfillState(this.options.stateFilePath, state);

      const auditKind: ExternalSessionLogBackfillAuditKind = belowReopenedBoundary
        ? 'resource_pending'
        : resourceTombstones > 0
        ? 'resource_tombstone'
        : resourceIngested > 0
        ? 'resource_ingested'
        : 'resource_duplicate';
      appendExternalSessionLogBackfillAudit(this.options.auditFilePath, {
        timestamp: this.now().toISOString(),
        kind: auditKind,
        operationId: state.operationId,
        provider: state.provider,
        sourceId: state.sourceId,
        triggeredBy: state.triggeredBy,
        range: state.range,
        reopenTombstoneId: state.reopenTombstoneId,
        status: state.status,
        resourceRef: resource.resourceRef,
        eventId: readResult.events[0]?.identity.eventId,
        metrics: state.metrics,
      });
    }

    const finishedAt = this.now();
    const finalStatus: ExternalSessionLogBackfillStatus = quotaReached
      ? 'quota_reached'
      : (sawFailure ? 'source_failed' : (sawPending ? 'pending' : 'completed'));

    state = {
      ...state,
      status: finalStatus,
      updatedAt: finishedAt.toISOString(),
      completedAt: finalStatus === 'completed' ? finishedAt.toISOString() : state.completedAt,
      metrics,
    };
    saveExternalSessionLogBackfillState(this.options.stateFilePath, state);

    appendExternalSessionLogBackfillAudit(this.options.auditFilePath, {
      timestamp: finishedAt.toISOString(),
      kind: finalStatus === 'quota_reached'
        ? 'quota_reached'
        : finalStatus === 'pending'
          ? 'pending'
          : finalStatus === 'source_failed'
            ? 'source_failed'
            : 'completed',
      operationId: state.operationId,
      provider: state.provider,
      sourceId: state.sourceId,
      triggeredBy: state.triggeredBy,
      range: state.range,
      reopenTombstoneId: state.reopenTombstoneId,
      status: state.status,
      message: finalStatus === 'source_failed'
        ? 'one or more resources failed; see state.failures'
        : undefined,
      metrics,
    });

    return {
      status: finalStatus,
      discoveredResources: matchedResources.length,
      processedResources,
      pendingResources,
      failedResources,
      ingestedEvents,
      duplicateEventsSkipped,
      tombstonedEventsSkipped,
      admittedEpisodes,
      bytesProcessed,
      state,
    };
  }
}

export function loadExternalSessionLogBackfillState(
  stateFilePath: string,
): ExternalSessionLogBackfillState | null {
  if (!fs.existsSync(stateFilePath)) return null;
  const raw = fs.readFileSync(stateFilePath, 'utf8');
  let parsed: ExternalSessionLogBackfillState;
  try {
    parsed = JSON.parse(raw) as ExternalSessionLogBackfillState;
  } catch (error) {
    throw new Error(`backfill state is corrupt: ${stateFilePath}: ${String(error)}`);
  }
  if (parsed.schemaVersion !== 1 || !parsed.resourceCursors || !parsed.processedEventIds) {
    throw new Error(`backfill state schema is unsupported or malformed: ${stateFilePath}`);
  }
  return {
    ...parsed,
    schemaVersion: parsed.schemaVersion ?? 1,
    completedAt: parsed.completedAt ?? null,
    resourceCursors: parsed.resourceCursors ?? {},
    processedEventIds: parsed.processedEventIds ?? {},
    ...(typeof parsed.reopenTombstoneId === 'string'
      ? { reopenTombstoneId: parsed.reopenTombstoneId }
      : {}),
    failures: parsed.failures ?? [],
    metrics: {
      runsStarted: parsed.metrics?.runsStarted ?? 0,
      resourcesDiscovered: parsed.metrics?.resourcesDiscovered ?? 0,
      resourcesProcessed: parsed.metrics?.resourcesProcessed ?? 0,
      pendingResources: parsed.metrics?.pendingResources ?? 0,
      failedResources: parsed.metrics?.failedResources ?? 0,
      ingestedEvents: parsed.metrics?.ingestedEvents ?? 0,
      duplicateEventsSkipped: parsed.metrics?.duplicateEventsSkipped ?? 0,
      tombstonedEventsSkipped: parsed.metrics?.tombstonedEventsSkipped ?? 0,
      admittedEpisodes: parsed.metrics?.admittedEpisodes ?? 0,
      bytesProcessed: parsed.metrics?.bytesProcessed ?? 0,
    },
  };
}

export function saveExternalSessionLogBackfillState(
  stateFilePath: string,
  state: ExternalSessionLogBackfillState,
): void {
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  const tmpPath = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, stateFilePath);
    fs.chmodSync(stateFilePath, 0o600);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}

export function appendExternalSessionLogBackfillAudit(
  auditFilePath: string,
  entry: ExternalSessionLogBackfillAuditEntry,
): void {
  fs.mkdirSync(path.dirname(auditFilePath), { recursive: true });
  fs.appendFileSync(auditFilePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(auditFilePath, 0o600);
}

function createExternalSessionLogBackfillState(
  request: ExternalSessionLogBackfillRequest,
  now: Date,
): ExternalSessionLogBackfillState {
  return {
    schemaVersion: 1,
    operationId: request.operationId,
    triggeredBy: request.triggeredBy,
    provider: request.provider,
    sourceId: request.sourceId,
    range: cloneBackfillRange(request.range),
    ...(request.reopenTombstoneId
      ? { reopenTombstoneId: request.reopenTombstoneId }
      : {}),
    status: 'pending',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    completedAt: null,
    resourceCursors: {},
    processedEventIds: {},
    failures: [],
    metrics: {
      runsStarted: 0,
      resourcesDiscovered: 0,
      resourcesProcessed: 0,
      pendingResources: 0,
      failedResources: 0,
      ingestedEvents: 0,
      duplicateEventsSkipped: 0,
      tombstonedEventsSkipped: 0,
      admittedEpisodes: 0,
      bytesProcessed: 0,
    },
  };
}

function assertCompatibleState(
  state: ExternalSessionLogBackfillState,
  request: ExternalSessionLogBackfillRequest,
): ExternalSessionLogBackfillState {
  if (state.operationId !== request.operationId) {
    throw new Error(`backfill state belongs to ${state.operationId}, not ${request.operationId}`);
  }
  if (state.provider !== request.provider || state.sourceId !== request.sourceId) {
    throw new Error('backfill request source/provider does not match existing operation state');
  }
  if (
    state.range.startPosition !== request.range.startPosition
    || state.range.endPosition !== request.range.endPosition
    || !sameResourceRefSet(state.range.resourceRefs, request.range.resourceRefs)
  ) {
    throw new Error('backfill request range does not match existing operation state');
  }
  if ((state.reopenTombstoneId ?? '') !== (request.reopenTombstoneId ?? '')) {
    throw new Error('backfill request tombstone reopen does not match existing operation state');
  }
  return state;
}

function validateBackfillRequest(request: ExternalSessionLogBackfillRequest): void {
  if (!request.operationId.trim()) throw new Error('backfill operationId is required');
  if (!request.triggeredBy.trim()) throw new Error('backfill triggeredBy is required');
  if (!request.provider.trim()) throw new Error('backfill provider is required');
  if (!request.sourceId.trim()) throw new Error('backfill sourceId is required');
  if (request.reopenTombstoneId !== undefined && !request.reopenTombstoneId.trim()) {
    throw new Error('backfill reopenTombstoneId must not be empty');
  }
  if (request.range.startPosition < 0) throw new Error('backfill startPosition must be >= 0');
  if (request.range.endPosition < request.range.startPosition) {
    throw new Error('backfill endPosition must be >= startPosition');
  }
  if (request.limits.maxResources <= 0) throw new Error('backfill maxResources must be > 0');
  if (request.limits.maxBytes <= 0) throw new Error('backfill maxBytes must be > 0');
  if (request.limits.maxElapsedMs <= 0) throw new Error('backfill maxElapsedMs must be > 0');
}

function validateBackfillSource(
  request: ExternalSessionLogBackfillRequest,
  source: ExternalSessionLogBackfillSource,
): void {
  if (source.identity.category !== 'external') {
    throw new Error(`backfill source ${source.identity.sourceId} must be external`);
  }
  if (source.identity.provider !== request.provider) {
    throw new Error(`backfill provider mismatch: ${request.provider} != ${source.identity.provider}`);
  }
  if (source.identity.sourceId !== request.sourceId) {
    throw new Error(`backfill source mismatch: ${request.sourceId} != ${source.identity.sourceId}`);
  }
}

function selectBackfillResources(
  resources: readonly SessionLogSourceResource[],
  range: ExternalSessionLogBackfillRange,
): SessionLogSourceResource[] {
  const allowedRefs = range.resourceRefs ? new Set(range.resourceRefs) : null;
  return [...resources]
    .filter((resource) => {
      if (!resource.firstEventIdentity) return false;
      if (allowedRefs) return allowedRefs.has(resource.resourceRef);
      const position = resource.firstEventIdentity.position;
      return position >= range.startPosition && position <= range.endPosition;
    })
    .sort((left, right) => {
      const leftPos = left.firstEventIdentity?.position ?? Number.MAX_SAFE_INTEGER;
      const rightPos = right.firstEventIdentity?.position ?? Number.MAX_SAFE_INTEGER;
      if (leftPos !== rightPos) return leftPos - rightPos;
      return left.resourceRef.localeCompare(right.resourceRef);
    });
}

function markBackfillEventProcessed(
  state: ExternalSessionLogBackfillState,
  provider: string,
  sourceId: string,
  identity: SourceEventIdentity,
): ExternalSessionLogBackfillState {
  return {
    ...state,
    processedEventIds: {
      ...state.processedEventIds,
      [backfillEventKey(provider, sourceId, identity)]: normalizeContentHash(identity.contentHash),
    },
  };
}

function isExactBackfillDuplicate(
  state: ExternalSessionLogBackfillState,
  provider: string,
  sourceId: string,
  identity: SourceEventIdentity,
): boolean {
  const key = backfillEventKey(provider, sourceId, identity);
  const legacyRecord = state.processedEventIds[identity.eventId];
  if (Object.prototype.hasOwnProperty.call(state.processedEventIds, key)) {
    return state.processedEventIds[key] === normalizeContentHash(identity.contentHash);
  }

  // Backward compatibility for older persisted states.
  if (!Object.prototype.hasOwnProperty.call(state.processedEventIds, identity.eventId)) {
    return false;
  }

  return legacyRecord === normalizeContentHash(identity.contentHash);
}

function isBackfillEventInRange(identity: SourceEventIdentity, range: ExternalSessionLogBackfillRange): boolean {
  return identity.position >= range.startPosition && identity.position <= range.endPosition;
}

function backfillEventKey(provider: string, sourceId: string, identity: SourceEventIdentity): string {
  return [
    provider,
    sourceId,
    identity.eventId,
    identity.position,
    identity.contentHash ?? '',
    identity.conversationId ?? '',
    identity.branchId ?? '',
    identity.revision ?? '',
  ].join('::');
}

function recordBackfillFailure(
  state: ExternalSessionLogBackfillState,
  resourceRef: string,
  eventId: string | undefined,
  error: unknown,
  now: Date,
): ExternalSessionLogBackfillState {
  return {
    ...state,
    updatedAt: now.toISOString(),
    failures: [
      ...state.failures,
      {
        resourceRef,
        eventId,
        message: toErrorMessage(error),
        at: now.toISOString(),
      },
    ],
  };
}

function cloneBackfillRange(range: ExternalSessionLogBackfillRange): ExternalSessionLogBackfillRange {
  return {
    startPosition: range.startPosition,
    endPosition: range.endPosition,
    resourceRefs: range.resourceRefs ? [...range.resourceRefs] : undefined,
  };
}

function sameResourceRefSet(
  left?: readonly string[],
  right?: readonly string[],
): boolean {
  const a = [...(left ?? [])].sort();
  const b = [...(right ?? [])].sort();
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function normalizeContentHash(contentHash: string | undefined): string | null {
  return contentHash ?? null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
