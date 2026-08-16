import { createHash } from 'node:crypto';

import { acquireExternalSourceProviderLock } from './external-source-provider-lock';
import type { ExternalSessionLogBackfillRequest } from './session-log-backfill';
import {
  buildExternalEventDedupKey,
  buildExternalStableEventKey,
  completeExternalCatchUpCatalogIfReady,
  loadExternalCursorState,
  redactExternalSourceDiagnostic,
  saveExternalCursorState,
  type ExternalCursorEntry,
  type ExternalCursorState,
  type ExternalReopenedRangeState,
  type ExternalSourceRecoveryAuditEntry,
  type ExternalSourceTombstoneEntry,
  type SessionLogSourceIdentity,
  type SourceEventIdentity,
} from './session-log-source';

export interface ExternalRecoveryHead {
  readonly resourceRef: string;
  readonly position: number;
}

export interface ExternalRecoveryMutationResult {
  readonly changed: boolean;
  readonly tombstones: readonly ExternalSourceTombstoneEntry[];
  readonly historicalTargetIds: readonly string[];
}

export interface ExternalRecoverySource {
  readonly identity: {
    readonly provider: string;
    readonly sourceId: string;
  };
  getCursorStorePath?(): string | undefined;
  observeRecoveryHeads?(): readonly ExternalRecoveryHead[];
}

export interface ExternalProviderRebaselineOptions {
  readonly provider: string;
  readonly skipToNow: boolean;
  readonly historyMode: 'future-only' | 'catch-up';
  readonly sources: readonly ExternalRecoverySource[];
  readonly lockRoot: string;
  readonly episodeStore: {
    abandonHistoricalTarget(targetId: string): unknown;
  };
  readonly recordProviderAudit: () => void;
  readonly now?: () => Date;
}

/**
 * Single audited authority for abandoning unread catch-up work. Cursor recovery
 * state commits first; episode reconciliation and the provider audit replay from
 * that durable state when a prior attempt stopped between stores.
 */
export function rebaselineExternalProviderWithRecovery(
  options: ExternalProviderRebaselineOptions,
): void {
  if (!options.skipToNow) {
    throw new Error('external provider rebaseline requires skip-to-now');
  }
  const provider = options.provider.trim().toLowerCase();
  const sources = options.sources.filter(source => source.identity.provider === provider);
  const now = options.now ?? (() => new Date());
  const providerLock = acquireExternalSourceProviderLock({
    runtimeRoot: options.lockRoot,
    provider,
    operation: 'rebaseline-skip-to-now',
    sourceId: sources[0]?.identity.sourceId,
    now,
  });
  if (!providerLock.acquired) {
    throw new Error(`external source provider lock is busy for ${provider}`);
  }

  try {
    const unfinishedCatchUp = sources.some(source => {
      const storePath = source.getCursorStorePath?.();
      if (!storePath) return false;
      return Object.values(loadExternalCursorState(storePath).catchUpResources)
        .some(resource => (
          resource.status !== 'complete'
          && resource.status !== 'closed'
          && resource.status !== 'abandoned'
        ));
    });
    if (unfinishedCatchUp && options.historyMode !== 'future-only') {
      throw new Error(
        `external provider ${provider} must be in future-only mode before unfinished catch-up can be rebaselined`,
      );
    }

    for (const source of sources) {
      const storePath = source.getCursorStorePath?.();
      if (!storePath) continue;
      abandonExternalCatchUpTargets(
        storePath,
        provider,
        source.identity.sourceId,
        source.observeRecoveryHeads?.() ?? [],
        now(),
      );

      const persisted = loadExternalCursorState(storePath);
      for (const [resourceRef, progress] of Object.entries(persisted.catchUpResources)) {
        if (progress.status !== 'abandoned') continue;
        const targetId = persisted.catchUpTargets[resourceRef]?.targetId;
        if (targetId) options.episodeStore.abandonHistoricalTarget(targetId);
      }
    }
    options.recordProviderAudit();
  } finally {
    providerLock.release();
  }
}

export function listExternalSourceTombstones(
  storePath: string,
): readonly ExternalSourceTombstoneEntry[] {
  return Object.values(loadExternalCursorState(storePath).tombstones)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function listExternalSourceRecoveryAudit(
  storePath: string,
): readonly ExternalSourceRecoveryAuditEntry[] {
  return [...loadExternalCursorState(storePath).recoveryAudit]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function retryExternalSourceQuarantineWithAudit(
  storePath: string,
  provider: string,
  sourceId: string,
  quarantineId: string,
  now: Date,
): boolean {
  const state = loadExternalCursorState(storePath);
  const entry = state.quarantinedEvents[quarantineId];
  if (!entry) return false;
  const quarantinedEvents = { ...state.quarantinedEvents };
  delete quarantinedEvents[quarantineId];
  const createdAt = now.toISOString();
  const audit = recoveryAudit({
    action: 'quarantine-retry',
    provider,
    sourceId,
    resourceRef: entry.resourceRef,
    quarantineId,
    createdAt,
  });
  const nextState: ExternalCursorState = {
    ...state,
    quarantinedEvents,
    recoveryAudit: appendAudit(state.recoveryAudit, audit),
    updatedAt: createdAt,
  };
  saveExternalCursorState(storePath, nextState);
  return true;
}

export function skipExternalSourceQuarantineWithAudit(
  storePath: string,
  provider: string,
  sourceId: string,
  quarantineId: string,
  reason: string,
  now: Date,
): boolean {
  const state = loadExternalCursorState(storePath);
  const entry = state.quarantinedEvents[quarantineId];
  if (!entry) return false;
  const sourceIdentity = entry.sourceIdentity
    ?? state.sourceIdentities[sourceId]
    ?? Object.values(state.sourceIdentities).find(identity => identity.provider === provider);
  if (!sourceIdentity) return false;

  const quarantinedEvents = { ...state.quarantinedEvents };
  delete quarantinedEvents[quarantineId];
  const createdAt = now.toISOString();
  const safeReason = redactExternalSourceDiagnostic(reason || 'operator skip');
  const tombstoneKey = buildExternalStableEventKey(sourceIdentity, entry.identity);
  const tombstone: ExternalSourceTombstoneEntry = {
    tombstoneId: quarantineId,
    kind: 'event-skip',
    resourceRef: entry.resourceRef,
    identity: entry.identity,
    createdAt,
    reason: safeReason,
  };
  const audit = recoveryAudit({
    action: 'event-skip',
    provider,
    sourceId,
    resourceRef: entry.resourceRef,
    quarantineId,
    tombstoneId: quarantineId,
    createdAt,
    reason: safeReason,
  });
  const nextState: ExternalCursorState = {
    ...state,
    quarantinedEvents,
    tombstones: {
      ...state.tombstones,
      [tombstoneKey]: tombstone,
    },
    recoveryAudit: appendAudit(state.recoveryAudit, audit),
    updatedAt: createdAt,
  };
  saveExternalCursorState(storePath, nextState);
  return true;
}

export function closeExternalSourceResourceWithAudit(
  storePath: string,
  provider: string,
  sourceId: string,
  resourceRef: string,
  reason: 'deleted' | 'archived',
  now: Date,
): ExternalRecoveryMutationResult {
  const state = loadExternalCursorState(storePath);
  const resource = state.resources[resourceRef];
  if (!resource || resource.lifecycleStatus === 'closed') return noMutation();

  const createdAt = now.toISOString();
  const progress = state.catchUpResources[resourceRef];
  const target = state.catchUpTargets[resourceRef];
  const startPosition = Math.max(0, (progress?.historicalCursor.position ?? -1) + 1);
  const endPosition = Math.max(
    startPosition - 1,
    target?.position ?? progress?.observedPosition ?? startPosition - 1,
  );
  const tombstone = endPosition >= startPosition
    ? rangeTombstone({
      kind: 'resource-closure',
      provider,
      sourceId,
      resourceRef,
      startPosition,
      endPosition,
      targetId: target?.targetId,
      reason: `operator confirmed resource ${reason}`,
      createdAt,
    })
    : undefined;
  const audit = recoveryAudit({
    action: 'resource-close',
    provider,
    sourceId,
    resourceRef,
    tombstoneId: tombstone?.tombstoneId,
    createdAt,
    reason: `operator confirmed resource ${reason}`,
  });

  const nextState: ExternalCursorState = {
    ...state,
    resources: {
      ...state.resources,
      [resourceRef]: {
        ...resource,
        lifecycleStatus: 'closed',
        closedAt: resource.closedAt ?? createdAt,
        closedReason: 'archived_or_deleted',
        updatedAt: createdAt,
      },
    },
    catchUpResources: progress
      ? {
        ...state.catchUpResources,
        [resourceRef]: {
          ...progress,
          status: progress.status === 'complete' ? 'complete' : 'closed',
          updatedAt: createdAt,
          ...(tombstone ? { terminalTombstoneId: tombstone.tombstoneId } : {}),
        },
      }
      : state.catchUpResources,
    tombstones: tombstone
      ? { ...state.tombstones, [tombstone.tombstoneId]: tombstone }
      : state.tombstones,
    recoveryAudit: appendAudit(state.recoveryAudit, audit),
    updatedAt: createdAt,
  };
  saveExternalCursorState(
    storePath,
    completeExternalCatchUpCatalogIfReady(nextState, () => now),
  );
  return {
    changed: true,
    tombstones: tombstone ? [tombstone] : [],
    historicalTargetIds: target && progress?.status !== 'complete' ? [target.targetId] : [],
  };
}

export function abandonExternalCatchUpTargets(
  storePath: string,
  provider: string,
  sourceId: string,
  heads: readonly ExternalRecoveryHead[],
  now: Date,
): ExternalRecoveryMutationResult {
  const state = loadExternalCursorState(storePath);
  const headByResource = new Map(heads.map(head => [head.resourceRef, head.position]));
  const createdAt = now.toISOString();
  const catchUpResources = { ...state.catchUpResources };
  const cursors = { ...state.cursors };
  const tombstones = { ...state.tombstones };
  let recoveryAudit: readonly ExternalSourceRecoveryAuditEntry[] = [...state.recoveryAudit];
  const createdTombstones: ExternalSourceTombstoneEntry[] = [];
  const historicalTargetIds: string[] = [];
  let changed = false;

  for (const [resourceRef, progress] of Object.entries(state.catchUpResources)) {
    if (progress.status === 'complete' || progress.status === 'closed' || progress.status === 'abandoned') {
      continue;
    }
    const target = state.catchUpTargets[resourceRef];
    const headPosition = Math.max(
      progress.observedPosition,
      target?.position ?? -1,
      headByResource.get(resourceRef) ?? -1,
    );
    const startPosition = Math.max(0, progress.historicalCursor.position + 1);
    const endPosition = Math.max(startPosition, headPosition);
    const tombstone = rangeTombstone({
      kind: 'range-abandonment',
      provider,
      sourceId,
      resourceRef,
      startPosition,
      endPosition,
      targetId: target?.targetId,
      reason: 'abandoned/skip-to-now',
      createdAt,
    });
    tombstones[tombstone.tombstoneId] = tombstone;
    createdTombstones.push(tombstone);
    catchUpResources[resourceRef] = {
      ...progress,
      status: 'abandoned',
      terminalTombstoneId: tombstone.tombstoneId,
      observedPosition: Math.max(progress.observedPosition, headPosition),
      updatedAt: createdAt,
    };

    const existingCursor = state.cursors[resourceRef];
    const sourceIdentity = existingCursor?.sourceIdentity
      ?? state.sourceIdentities[sourceId];
    if (sourceIdentity) {
      const cursor: ExternalCursorEntry = {
        cursor: {
          resourceRef,
          position: Math.max(existingCursor?.cursor.position ?? -1, headPosition),
          processedCount: existingCursor?.cursor.processedCount ?? 0,
        },
        sourceIdentity,
        updatedAt: createdAt,
        lastStatus: 'activated',
      };
      cursors[resourceRef] = cursor;
      cursors[sourceId] = cursor;
    }

    const audit = recoveryAuditEntryForTombstone(
      'range-abandonment',
      provider,
      sourceId,
      resourceRef,
      tombstone,
      createdAt,
    );
    recoveryAudit = appendAudit(recoveryAudit, audit);
    if (target) historicalTargetIds.push(target.targetId);
    changed = true;
  }

  if (!changed) return noMutation();
  const nextState: ExternalCursorState = {
    ...state,
    cursors,
    catchUpResources,
    tombstones,
    recoveryAudit,
    updatedAt: createdAt,
  };
  saveExternalCursorState(
    storePath,
    completeExternalCatchUpCatalogIfReady(nextState, () => now),
  );
  return { changed, tombstones: createdTombstones, historicalTargetIds };
}

export function prepareExternalTombstoneReopen(
  storePath: string,
  request: ExternalSessionLogBackfillRequest,
  tombstoneId: string,
  now: Date,
): ExternalReopenedRangeState {
  const state = loadExternalCursorState(storePath);
  const existing = state.reopenedRanges[request.operationId];
  if (existing) {
    assertCompatibleReopen(existing, request, tombstoneId);
    return existing;
  }
  const tombstone = Object.values(state.tombstones)
    .find(entry => entry.tombstoneId === tombstoneId);
  if (!tombstone) throw new Error(`external source tombstone not found: ${tombstoneId}`);
  const refs = request.range.resourceRefs ?? [];
  if (refs.length !== 1 || refs[0] !== tombstone.resourceRef) {
    throw new Error('tombstone reopen must name exactly the tombstoned resource');
  }
  assertRangeReopensTombstone(request, tombstone);

  const createdAt = now.toISOString();
  const targetId = hashId('reopened-target', [
    request.provider,
    request.sourceId,
    request.operationId,
    tombstoneId,
    request.range.startPosition,
    request.range.endPosition,
    tombstone.resourceRef,
  ]);
  const reopened: ExternalReopenedRangeState = {
    reopenId: hashId('tombstone-reopen', [targetId]),
    operationId: request.operationId,
    tombstoneId,
    targetId,
    provider: request.provider,
    sourceId: request.sourceId,
    resourceRef: tombstone.resourceRef,
    range: {
      startPosition: request.range.startPosition,
      endPosition: request.range.endPosition,
    },
    prefixDigest: hashId('reopened-prefix', [
      request.provider,
      request.sourceId,
      tombstone.resourceRef,
      request.range.startPosition,
      request.range.endPosition,
      tombstoneId,
    ]),
    ...('targetId' in tombstone && tombstone.targetId
      ? { originalTargetId: tombstone.targetId }
      : {}),
    status: 'historical-pending',
    createdAt,
  };
  const audit = recoveryAudit({
    action: 'tombstone-reopen',
    provider: request.provider,
    sourceId: request.sourceId,
    resourceRef: tombstone.resourceRef,
    tombstoneId,
    operationId: request.operationId,
    createdAt,
    reason: `bounded reopen ${request.range.startPosition}-${request.range.endPosition}`,
  });
  saveExternalCursorState(storePath, {
    ...state,
    reopenedRanges: {
      ...state.reopenedRanges,
      [request.operationId]: reopened,
    },
    recoveryAudit: appendAudit(state.recoveryAudit, audit),
    updatedAt: createdAt,
  });
  return reopened;
}

export function completeExternalTombstoneReopen(
  storePath: string,
  operationId: string,
  now: Date,
  terminalTombstoneId?: string,
): ExternalReopenedRangeState | undefined {
  const state = loadExternalCursorState(storePath);
  const reopened = state.reopenedRanges[operationId];
  if (!reopened) return undefined;
  if (reopened.status === 'complete' || reopened.status === 'terminal-excluded') return reopened;
  const completedAt = now.toISOString();
  const durableTerminalTombstoneId = terminalTombstoneId ?? reopened.terminalTombstoneId;
  const completed: ExternalReopenedRangeState = {
    ...reopened,
    status: durableTerminalTombstoneId ? 'terminal-excluded' : 'complete',
    ...(durableTerminalTombstoneId
      ? { terminalTombstoneId: durableTerminalTombstoneId }
      : {}),
    completedAt,
  };
  const audit = recoveryAudit({
    action: durableTerminalTombstoneId
      ? 'reopened-range-terminal-exclusion'
      : 'reopened-range-complete',
    provider: reopened.provider,
    sourceId: reopened.sourceId,
    resourceRef: reopened.resourceRef,
    tombstoneId: durableTerminalTombstoneId ?? reopened.tombstoneId,
    operationId,
    createdAt: completedAt,
  });
  saveExternalCursorState(storePath, {
    ...state,
    reopenedRanges: {
      ...state.reopenedRanges,
      [operationId]: completed,
    },
    recoveryAudit: appendAudit(state.recoveryAudit, audit),
    updatedAt: completedAt,
  });
  return completed;
}

export function recordExternalTombstoneReopenTerminalExclusion(
  storePath: string,
  operationId: string,
  tombstoneId: string,
  now: Date,
): ExternalReopenedRangeState {
  const state = loadExternalCursorState(storePath);
  const reopened = state.reopenedRanges[operationId];
  if (!reopened) {
    throw new Error(`external reopened range not found: ${operationId}`);
  }
  if (reopened.terminalTombstoneId) return reopened;
  const updated: ExternalReopenedRangeState = {
    ...reopened,
    terminalTombstoneId: tombstoneId,
  };
  saveExternalCursorState(storePath, {
    ...state,
    reopenedRanges: {
      ...state.reopenedRanges,
      [operationId]: updated,
    },
    updatedAt: now.toISOString(),
  });
  return updated;
}

export function findBlockingExternalSourceTombstone(
  state: ExternalCursorState,
  sourceIdentity: SessionLogSourceIdentity,
  resourceRef: string,
  identity: SourceEventIdentity,
  reopenedTombstoneId?: string,
): ExternalSourceTombstoneEntry | undefined {
  const stableKey = buildExternalStableEventKey(sourceIdentity, identity);
  const dedupKey = buildExternalEventDedupKey(sourceIdentity, identity);
  return Object.entries(state.tombstones).find(([key, tombstone]) => {
    if (tombstone.tombstoneId === reopenedTombstoneId) return false;
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
  })?.[1];
}

function assertRangeReopensTombstone(
  request: ExternalSessionLogBackfillRequest,
  tombstone: ExternalSourceTombstoneEntry,
): void {
  if (tombstone.kind === 'event-skip') {
    if (
      request.range.startPosition !== tombstone.identity.position
      || request.range.endPosition !== tombstone.identity.position
    ) {
      throw new Error('an exact-event tombstone must be reopened at its exact position');
    }
    return;
  }
  if (
    request.range.startPosition < tombstone.range.startPosition
    || request.range.endPosition > tombstone.range.endPosition
  ) {
    throw new Error('reopened backfill range must stay within the named tombstone');
  }
}

function assertCompatibleReopen(
  existing: ExternalReopenedRangeState,
  request: ExternalSessionLogBackfillRequest,
  tombstoneId: string,
): void {
  if (
    existing.tombstoneId !== tombstoneId
    || existing.provider !== request.provider
    || existing.sourceId !== request.sourceId
    || existing.range.startPosition !== request.range.startPosition
    || existing.range.endPosition !== request.range.endPosition
    || request.range.resourceRefs?.length !== 1
    || request.range.resourceRefs[0] !== existing.resourceRef
  ) {
    throw new Error('backfill operation does not match its durable tombstone reopen');
  }
}

function rangeTombstone(args: {
  kind: 'resource-closure' | 'range-abandonment';
  provider: string;
  sourceId: string;
  resourceRef: string;
  startPosition: number;
  endPosition: number;
  targetId?: string;
  reason: string;
  createdAt: string;
}): ExternalSourceTombstoneEntry {
  const tombstoneId = hashId(args.kind, [
    args.provider,
    args.sourceId,
    args.resourceRef,
    args.startPosition,
    args.endPosition,
    args.targetId ?? null,
  ]);
  return {
    tombstoneId,
    kind: args.kind,
    resourceRef: args.resourceRef,
    range: {
      startPosition: args.startPosition,
      endPosition: args.endPosition,
    },
    ...(args.targetId ? { targetId: args.targetId } : {}),
    createdAt: args.createdAt,
    reason: redactExternalSourceDiagnostic(args.reason),
  };
}

function recoveryAuditEntryForTombstone(
  action: 'range-abandonment',
  provider: string,
  sourceId: string,
  resourceRef: string,
  tombstone: ExternalSourceTombstoneEntry,
  createdAt: string,
): ExternalSourceRecoveryAuditEntry {
  return recoveryAudit({
    action,
    provider,
    sourceId,
    resourceRef,
    tombstoneId: tombstone.tombstoneId,
    createdAt,
    reason: tombstone.reason,
  });
}

function recoveryAudit(
  entry: Omit<ExternalSourceRecoveryAuditEntry, 'auditId'>,
): ExternalSourceRecoveryAuditEntry {
  return {
    ...entry,
    auditId: hashId('recovery-audit', [
      entry.action,
      entry.provider,
      entry.sourceId,
      entry.resourceRef,
      entry.quarantineId ?? null,
      entry.tombstoneId ?? null,
      entry.operationId ?? null,
      entry.createdAt,
      entry.reason ?? null,
    ]),
  };
}

function appendAudit(
  existing: readonly ExternalSourceRecoveryAuditEntry[],
  entry: ExternalSourceRecoveryAuditEntry,
): readonly ExternalSourceRecoveryAuditEntry[] {
  if (!existing.some(candidate => candidate.auditId === entry.auditId)) {
    return [...existing, entry];
  }
  let collision = 1;
  let auditId = entry.auditId;
  do {
    auditId = hashId('recovery-audit-collision', [entry.auditId, existing.length, collision]);
    collision += 1;
  } while (existing.some(candidate => candidate.auditId === auditId));
  return [...existing, { ...entry, auditId }];
}

function hashId(namespace: string, values: readonly unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify([namespace, ...values]))
    .digest('hex');
}

function noMutation(): ExternalRecoveryMutationResult {
  return { changed: false, tombstones: [], historicalTargetIds: [] };
}
