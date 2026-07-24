import * as fs from 'node:fs';

import type { DistillationHeartbeatConfig, ExternalHistoryMode } from './distillation-heartbeat-config';
import {
  ExternalProviderOverrideStore,
  resolveExternalProviderOverridePath,
  type ProviderStatus,
} from './external-provider-controls';
import {
  emptyExternalCursorState,
  loadExternalCursorState,
  redactExternalSourceDiagnostic,
  resolveExternalCursorStorePath,
  type ExternalCursorState,
  type SessionLogSourceReport,
} from './session-log-source';

/**
 * Issue #94 — External source provider diagnostics for CLI and Dashboard.
 *
 * Exposes provider identity, scope, activation/baseline progress, reader/
 * version, cursor progress, last successful read, next retry, failure class,
 * quarantine, lock, drain, and operator action through a public diagnostic
 * record that both the CLI and Dashboard can consume.
 *
 * This module is intentionally standalone so it is testable before and after
 * #90–#93 integrate the reader wiring. It does not modify existing reader,
 * control, concurrency, or admission semantics.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AdmissionGate = 'open' | 'closed' | 'draining';

export type ActivationState = 'activating' | 'active' | 'paused' | 'activation_blocked';

/** @deprecated Use ActivationState. */
export type AdmissionState = ActivationState;

export type CatchUpState =
  | 'idle'
  | 'inventory'
  | 'catching_up'
  | 'caught_up'
  | 'paused'
  | 'catch_up_blocked';

export type SourceHealth = 'healthy' | 'waiting' | 'attention_required' | 'blocked';

export type FailureClass =
  | 'transient'
  | 'protocol_failure'
  | 'integrity_conflict'
  | 'quarantine'
  | 'permission'
  | 'pending';

export type DrainState = 'idle' | 'reading' | 'draining' | 'drained';

export interface ActivationProgress {
  readonly baselined: number;
  readonly total: number;
}

export interface CursorProgress {
  readonly maxPosition: number;
  readonly activeResources: number;
  readonly closedResources: number;
}

export interface CatchUpProgress {
  readonly catalogGeneration?: number;
  readonly requestedLimit?: number;
  readonly scopeFingerprint?: string;
  readonly targetsTotal: number;
  readonly targetPending: number;
  readonly historicalPendingTargets: number;
  readonly completeTargets: number;
  readonly excludedTargets: number;
  readonly historicalPendingEpisodes: number;
  readonly readyHistoricalEpisodes: number;
  readonly eventExclusions: number;
  readonly resourceExclusions: number;
  readonly rangeExclusions: number;
  readonly quarantineCount: number;
  readonly blockedReason?: string;
  readonly lastSuccessfulProgressAt?: string;
}

export interface ExternalSourceWorkState {
  readonly read: 'idle' | 'reading';
  readonly readyPages: number;
  readonly committing: boolean;
}

export interface ExternalSourceProviderDiagnostic {
  readonly provider: string;
  readonly scope: string;
  readonly admissionGate: AdmissionGate;
  readonly activationState: ActivationState;
  readonly historyMode: ExternalHistoryMode;
  readonly catchUpState: CatchUpState;
  readonly sourceHealth: SourceHealth;
  /** @deprecated Compatibility alias for activationState. */
  readonly admissionState: AdmissionState;
  readonly readerVersion?: string;
  readonly activationProgress?: ActivationProgress;
  readonly cursorProgress?: CursorProgress;
  readonly catchUpProgress: CatchUpProgress;
  readonly lastSuccessfulReadAt?: string;
  readonly nextRetryAt?: string;
  readonly failureClass?: FailureClass;
  readonly quarantined: boolean;
  readonly locked: boolean;
  readonly workState: ExternalSourceWorkState;
  readonly drainState: DrainState;
  readonly nextAction?: string;
}

export interface ExternalSourceProviderStatusInput {
  readonly provider: string;
  readonly scope: string;
  readonly enabled: boolean;
  readonly admissionGate: 'open' | 'closed';
  readonly historyMode?: 'future-only' | 'catch-up';
}

export interface ExternalSourceProviderActivationInput {
  readonly initialDiscoveryCompleted: boolean;
  readonly activationBlocked?: boolean;
  readonly activationBlockedReason?: string;
}

export interface ExternalSourceProviderSourceReportInput {
  readonly readerVersion?: string;
  readonly cursorProgress?: CursorProgress & { readonly quarantinedEvents?: number };
  readonly lastSuccessfulReadAt?: string;
  readonly nextRetryAt?: string | null;
  readonly failureClass?: string;
  readonly status?: string;
  readonly nextAction?: string;
  readonly workState?: ExternalSourceWorkState;
}

export type DiagnosticOverallStatus = 'healthy' | 'degraded' | 'unhealthy';

export type ExternalSourceOverallReadiness =
  | 'ready'
  | 'ready_with_external_attention'
  | 'not_ready';

export interface ExternalSourceDiagnosticSummary {
  readonly overallStatus: DiagnosticOverallStatus;
  readonly overallReadiness: ExternalSourceOverallReadiness;
  readonly providers: readonly ExternalSourceProviderDiagnostic[];
  readonly activeCount: number;
  readonly activatingCount: number;
  readonly pausedCount: number;
  readonly activationBlockedCount: number;
  readonly failureCount: number;
}

export interface ExternalSourceDiagnosticSnapshot extends ExternalSourceDiagnosticSummary {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
}

export interface ExternalSourceDiagnosticEpisodeInput {
  readonly status: string;
  readonly historicalTarget?: { readonly provider: string };
}

export interface BuildExternalSourceDiagnosticSnapshotOptions {
  readonly config: DistillationHeartbeatConfig;
  readonly providerStatuses?: readonly ProviderStatus[];
  readonly sourceReports?: readonly SessionLogSourceReport[];
  readonly cursorStates?: Readonly<Record<string, ExternalCursorState>>;
  readonly episodes?: readonly ExternalSourceDiagnosticEpisodeInput[];
  readonly generatedAt?: string;
  readonly internalReady?: boolean;
}

export function buildProviderDiagnosticRecord(args: {
  readonly status: ExternalSourceProviderStatusInput;
  readonly activation?: ExternalSourceProviderActivationInput | null;
  readonly resourcesTotal: number;
  readonly baselined: number;
  readonly sourceReport?: ExternalSourceProviderSourceReportInput;
  readonly catchUpProgress?: CatchUpProgress;
  readonly catchUpState?: CatchUpState;
}): ExternalSourceProviderDiagnostic {
  const failureClass = mapFailureClass(args.sourceReport?.failureClass);
  const drainState = args.sourceReport?.status === 'drained'
    ? 'drained'
    : args.sourceReport?.status === 'draining'
      ? 'draining'
      : 'idle';
  const admissionGate: AdmissionGate = drainState === 'draining' || drainState === 'drained'
    ? 'draining'
    : !args.status.enabled || args.status.admissionGate === 'closed'
      ? 'closed'
      : 'open';
  const activationState: ActivationState = args.activation?.activationBlocked
    ? 'activation_blocked'
    : admissionGate !== 'open'
      ? 'paused'
      : args.activation && !args.activation.initialDiscoveryCompleted
        ? 'activating'
        : 'active';
  const catchUpProgress = args.catchUpProgress ?? emptyCatchUpProgress();
  const catchUpState = args.catchUpState ?? deriveCatchUpState({
    historyMode: args.status.historyMode ?? 'future-only',
    admissionGate,
    progress: catchUpProgress,
  });
  const sourceHealth = deriveSourceHealth({
    activationState,
    failureClass,
    catchUpBlocked: catchUpState === 'catch_up_blocked',
    quarantineCount: catchUpProgress.quarantineCount
      + (args.sourceReport?.cursorProgress?.quarantinedEvents ?? 0),
    nextRetryAt: args.sourceReport?.nextRetryAt,
  });
  const nextAction = args.activation?.activationBlockedReason
    ? resolveNextAction(args.activation.activationBlockedReason, undefined)
    : catchUpState === 'catch_up_blocked'
      ? catchUpBlockedNextAction(catchUpProgress.blockedReason)
      : resolveNextAction(undefined, args.sourceReport?.nextAction)
        ?? defaultNextAction(sourceHealth, failureClass, catchUpProgress.quarantineCount);
  return {
    provider: args.status.provider,
    scope: args.status.scope,
    admissionGate,
    activationState,
    historyMode: args.status.historyMode ?? 'future-only',
    catchUpState,
    sourceHealth,
    admissionState: activationState,
    ...(args.sourceReport?.readerVersion ? { readerVersion: args.sourceReport.readerVersion } : {}),
    ...(args.resourcesTotal > 0 || args.baselined > 0
      ? { activationProgress: { baselined: args.baselined, total: args.resourcesTotal } }
      : {}),
    catchUpProgress,
    ...(args.sourceReport?.cursorProgress
      ? {
        cursorProgress: {
          maxPosition: args.sourceReport.cursorProgress.maxPosition,
          activeResources: args.sourceReport.cursorProgress.activeResources,
          closedResources: args.sourceReport.cursorProgress.closedResources,
        },
      }
      : {}),
    ...(args.sourceReport?.lastSuccessfulReadAt ? { lastSuccessfulReadAt: args.sourceReport.lastSuccessfulReadAt } : {}),
    ...(args.sourceReport?.nextRetryAt ? { nextRetryAt: args.sourceReport.nextRetryAt } : {}),
    ...(failureClass ? { failureClass } : {}),
    quarantined: failureClass === 'quarantine'
      || catchUpProgress.quarantineCount > 0
      || (args.sourceReport?.cursorProgress?.quarantinedEvents ?? 0) > 0,
    locked: args.sourceReport?.status === 'locked',
    workState: args.sourceReport?.workState ?? {
      read: 'idle',
      readyPages: 0,
      committing: false,
    },
    drainState,
    ...(nextAction ? { nextAction } : {}),
  };
}

export function mapFailureClass(value: unknown): FailureClass | undefined {
  if (value === 'protocol') return 'protocol_failure';
  if (value === 'integrity_conflict') return 'integrity_conflict';
  if (value === 'quarantine') return 'quarantine';
  if (value === 'permission') return 'permission';
  if (value === 'transient') return 'transient';
  if (value === 'pending') return 'pending';
  return undefined;
}

export function resolveNextAction(
  activationBlockedReason: string | undefined,
  actionCode: unknown,
): string | undefined {
  if (activationBlockedReason) {
    return 'Narrow scope or raise the baseline cap, then resume activation.';
  }
  switch (actionCode) {
    case 'retry_or_skip_quarantine':
      return 'Retry or skip the quarantined event.';
    case 'repair_source_then_retry':
      return 'Repair the source or reader, then retry.';
    case 'wait_for_retry':
      return 'Wait for the next scheduled retry.';
    case 'retry_next_wake':
      return 'Retry on the next wake.';
    default:
      return undefined;
  }
}

export function buildExternalSourceDiagnosticSnapshot(
  options: BuildExternalSourceDiagnosticSnapshotOptions,
): ExternalSourceDiagnosticSnapshot {
  const sourceReports = options.sourceReports ?? loadHeartbeatSourceReports(options.config.heartbeatRecordPath);
  const statuses = collectProviderStatuses(options.config, options.providerStatuses, sourceReports);
  const episodes = options.episodes ?? loadDiagnosticEpisodes(options.config.learningEpisodeStorePath);
  const providers = statuses.map(status => {
    const sourceReport = sourceReports.find(report => (
      report.category === 'external'
      && normalizeProvider(report.provider ?? report.selectedProvider ?? '') === status.provider
    ));
    const sourceId = sourceReport?.sourceId ?? resolveExternalProviderSourceId(options.config, status.provider);
    let cursorState = options.cursorStates?.[sourceId];
    let cursorStateFailed = false;
    if (!cursorState) {
      try {
        cursorState = loadExternalCursorState(resolveExternalCursorStorePath({
          provider: status.provider,
          sourceId,
        }));
      } catch {
        cursorState = emptyExternalCursorState();
        cursorStateFailed = true;
      }
    }

    const activation = cursorState.activation;
    const resources = Object.values(cursorState.resources);
    const baselined = Object.values(cursorState.cursors)
      .filter(entry => entry.sourceIdentity?.sourceId === sourceId && entry.lastStatus === 'activated')
      .length;
    const catchUpProgress = buildCatchUpProgress(cursorState, status.provider, episodes);
    const catalog = cursorState.catchUpCatalog.active ?? cursorState.catchUpCatalog.lastCompleted;
    const admissionGate: AdmissionGate = sourceReport?.drainState === 'draining'
      || sourceReport?.status === 'drained'
      ? 'draining'
      : status.enabled && status.admissionGate === 'open'
        ? 'open'
        : 'closed';
    const catchUpState = deriveCatchUpState({
      historyMode: status.historyMode,
      admissionGate,
      progress: catchUpProgress,
      catalogStatus: catalog?.status,
    });
    const normalizedSourceReport: ExternalSourceProviderSourceReportInput | undefined = cursorStateFailed
      ? {
        failureClass: 'protocol',
        status: sourceReport?.status,
        nextAction: 'repair_source_then_retry',
      }
      : sourceReport
        ? {
          readerVersion: sourceReport.readerVersion,
          cursorProgress: sourceReport.cursorProgress,
          lastSuccessfulReadAt: sourceReport.lastSuccessfulReadAt,
          nextRetryAt: sourceReport.nextRetryAt,
          failureClass: sourceReport.failureClass,
          status: sourceReport.drainState === 'draining' ? 'draining' : sourceReport.status,
          nextAction: sourceReport.nextAction,
          workState: sourceReport.workState,
        }
        : undefined;

    return buildProviderDiagnosticRecord({
      status: {
        provider: status.provider,
        scope: status.scope,
        enabled: status.enabled,
        admissionGate: status.admissionGate,
        historyMode: status.historyMode,
      },
      activation,
      resourcesTotal: resources.length,
      baselined,
      sourceReport: normalizedSourceReport,
      catchUpProgress,
      catchUpState,
    });
  });
  const summary = buildDiagnosticSummary(providers, options.internalReady);
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    ...summary,
  };
}

export function isExternalSourceDiagnosticSnapshot(
  value: unknown,
): value is ExternalSourceDiagnosticSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ExternalSourceDiagnosticSnapshot>;
  return candidate.schemaVersion === 1
    && typeof candidate.generatedAt === 'string'
    && (
      candidate.overallReadiness === 'ready'
      || candidate.overallReadiness === 'ready_with_external_attention'
      || candidate.overallReadiness === 'not_ready'
    )
    && Array.isArray(candidate.providers)
    && candidate.providers.every(provider => (
      provider !== null
      && typeof provider === 'object'
      && typeof provider.provider === 'string'
      && typeof provider.admissionGate === 'string'
      && typeof provider.activationState === 'string'
      && typeof provider.historyMode === 'string'
      && typeof provider.catchUpState === 'string'
      && typeof provider.sourceHealth === 'string'
    ));
}

function collectProviderStatuses(
  config: DistillationHeartbeatConfig,
  supplied: readonly ProviderStatus[] | undefined,
  sourceReports: readonly SessionLogSourceReport[],
): ProviderStatus[] {
  let statuses: ProviderStatus[];
  if (supplied) {
    statuses = [...supplied];
  } else {
    try {
      statuses = [...new ExternalProviderOverrideStore({
        stateFilePath: resolveExternalProviderOverridePath(config),
      }).getAllProviderStatuses(config)];
    } catch {
      statuses = config.externalSessionLogEnabledProviders.map(provider => ({
        provider: normalizeProvider(provider),
        enabled: config.externalSessionLogSourcesEnabled,
        source: config.externalSessionLogSourcesEnabled ? 'environment' as const : 'master-off' as const,
        scope: 'global' as const,
        admissionGate: config.externalSessionLogSourcesEnabled ? 'open' as const : 'closed' as const,
        historyMode: config.externalSessionLogHistoryMode,
        historyModeSource: 'environment' as const,
      }));
    }
  }

  const known = new Set(statuses.map(status => status.provider));
  for (const report of sourceReports) {
    if (report.category !== 'external') continue;
    const provider = normalizeProvider(report.provider ?? report.selectedProvider ?? '');
    if (!provider || known.has(provider)) continue;
    known.add(provider);
    statuses.push({
      provider,
      enabled: report.enabled && config.externalSessionLogSourcesEnabled,
      source: config.externalSessionLogSourcesEnabled ? 'environment' : 'master-off',
      scope: 'global',
      admissionGate: report.enabled && config.externalSessionLogSourcesEnabled ? 'open' : 'closed',
      historyMode: config.externalSessionLogHistoryMode,
      historyModeSource: 'environment',
    });
  }
  return statuses.sort((left, right) => left.provider.localeCompare(right.provider));
}

export function resolveExternalProviderSourceId(
  config: DistillationHeartbeatConfig,
  provider: string,
): string {
  const normalizedProvider = normalizeProvider(provider);
  const legacyProvider = normalizeProvider(config.externalSessionLogSelectedProvider ?? '');
  const legacySourceId = config.externalSessionLogSelectedSourceId?.trim();
  return config.externalSessionLogEnabledProviders.length === 1
    && legacyProvider === normalizedProvider
    && Boolean(legacySourceId)
    ? legacySourceId!
    : `external-${normalizedProvider}`;
}

function buildCatchUpProgress(
  state: ExternalCursorState,
  provider: string,
  episodes: readonly ExternalSourceDiagnosticEpisodeInput[],
): CatchUpProgress {
  const catalog = state.catchUpCatalog.active ?? state.catchUpCatalog.lastCompleted;
  const allProgress = Object.values(state.catchUpResources);
  const progress = catalog
    ? allProgress.filter(resource => (
      resource.observedScopeFingerprint === catalog.scopeFingerprint
    ))
    : allProgress;
  const tombstones = Object.values(state.tombstones);
  const historicalEpisodes = episodes.filter(episode => (
    normalizeProvider(episode.historicalTarget?.provider ?? '') === normalizeProvider(provider)
  ));
  const lastSuccessfulProgressAt = latestIsoTimestamp([
    catalog?.observationCompletedAt,
    catalog?.completedAt,
    ...progress.map(resource => resource.updatedAt),
  ]);
  return {
    ...(catalog ? {
      catalogGeneration: catalog.generation,
      requestedLimit: catalog.requestedLimit,
      scopeFingerprint: catalog.scopeFingerprint,
    } : {}),
    targetsTotal: progress.length,
    targetPending: progress.filter(resource => resource.status === 'target-pending').length,
    historicalPendingTargets: progress.filter(resource => resource.status === 'historical-pending').length,
    completeTargets: progress.filter(resource => resource.status === 'complete').length,
    excludedTargets: progress.filter(resource => (
      resource.status === 'closed' || resource.status === 'abandoned'
    )).length,
    historicalPendingEpisodes: historicalEpisodes.filter(episode => episode.status === 'historical-pending').length,
    readyHistoricalEpisodes: historicalEpisodes.filter(episode => episode.status === 'eligible').length,
    eventExclusions: tombstones.filter(tombstone => tombstone.kind === 'event-skip').length,
    resourceExclusions: tombstones.filter(tombstone => tombstone.kind === 'resource-closure').length,
    rangeExclusions: tombstones.filter(tombstone => tombstone.kind === 'range-abandonment').length,
    quarantineCount: Object.keys(state.quarantinedEvents).length,
    ...(catalog?.status === 'catch-up-blocked' && catalog.blockedReason
      ? { blockedReason: redactExternalSourceDiagnostic(catalog.blockedReason, 160) }
      : {}),
    ...(lastSuccessfulProgressAt ? { lastSuccessfulProgressAt } : {}),
  };
}

function emptyCatchUpProgress(): CatchUpProgress {
  return {
    targetsTotal: 0,
    targetPending: 0,
    historicalPendingTargets: 0,
    completeTargets: 0,
    excludedTargets: 0,
    historicalPendingEpisodes: 0,
    readyHistoricalEpisodes: 0,
    eventExclusions: 0,
    resourceExclusions: 0,
    rangeExclusions: 0,
    quarantineCount: 0,
  };
}

function deriveCatchUpState(args: {
  historyMode: ExternalHistoryMode;
  admissionGate: AdmissionGate;
  progress: CatchUpProgress;
  catalogStatus?: string;
}): CatchUpState {
  const unfinished = args.progress.targetPending > 0 || args.progress.historicalPendingTargets > 0;
  const complete = args.catalogStatus === 'caught-up' || (
    args.progress.targetsTotal > 0
    && args.progress.targetsTotal === args.progress.completeTargets + args.progress.excludedTargets
  );
  if (args.historyMode === 'future-only') return unfinished ? 'paused' : 'idle';
  if (args.admissionGate !== 'open' && !complete) return 'paused';
  if (args.catalogStatus === 'catch-up-blocked') return 'catch_up_blocked';
  if (args.catalogStatus === 'caught-up') return 'caught_up';
  if (args.progress.targetPending > 0 || args.catalogStatus === 'inventory' || args.catalogStatus === 'invalidated') {
    return 'inventory';
  }
  if (args.progress.historicalPendingTargets > 0) return 'catching_up';
  if (complete) return 'caught_up';
  return args.admissionGate === 'open' ? 'inventory' : 'paused';
}

function defaultNextAction(
  sourceHealth: SourceHealth,
  failureClass: FailureClass | undefined,
  quarantineCount: number,
): string | undefined {
  if (failureClass === 'quarantine' || quarantineCount > 0) {
    return 'Retry or skip the quarantined event.';
  }
  if (sourceHealth === 'blocked' || sourceHealth === 'attention_required') {
    return 'Repair the source or reader, then retry.';
  }
  if (sourceHealth === 'waiting') return 'Wait for the next scheduled retry.';
  return undefined;
}

function deriveSourceHealth(args: {
  activationState: ActivationState;
  failureClass: FailureClass | undefined;
  catchUpBlocked: boolean;
  quarantineCount: number;
  nextRetryAt?: string | null;
}): SourceHealth {
  if (args.activationState === 'activation_blocked') return 'blocked';
  if (args.catchUpBlocked) return 'blocked';
  if (args.failureClass === 'protocol_failure' || args.failureClass === 'integrity_conflict') return 'blocked';
  if (args.failureClass === 'quarantine' || args.failureClass === 'permission' || args.quarantineCount > 0) {
    return 'attention_required';
  }
  if (args.failureClass === 'pending' || args.failureClass === 'transient' || args.nextRetryAt) return 'waiting';
  return 'healthy';
}

function catchUpBlockedNextAction(reason: string | undefined): string {
  const normalized = reason?.toLowerCase() ?? '';
  if (/output|bytes?/.test(normalized)) {
    return 'Raise the bounded catch-up output cap or narrow scope, then retry.';
  }
  if (/duration|elapsed|time/.test(normalized)) {
    return 'Raise the bounded catch-up duration cap or narrow scope, then retry.';
  }
  if (/catalog|resources?|limit/.test(normalized)) {
    return 'Raise the bounded catch-up catalog cap or narrow scope, then retry.';
  }
  return 'Review the catch-up block reason, adjust the relevant bounded cap, then retry.';
}

function latestIsoTimestamp(values: readonly (string | undefined)[]): string | undefined {
  return values
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function loadHeartbeatSourceReports(recordPath: string): readonly SessionLogSourceReport[] {
  try {
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as { lastSourceReports?: unknown };
    return Array.isArray(record.lastSourceReports)
      ? record.lastSourceReports as SessionLogSourceReport[]
      : [];
  } catch {
    return [];
  }
}

function loadDiagnosticEpisodes(storePath: string): readonly ExternalSourceDiagnosticEpisodeInput[] {
  try {
    const state = JSON.parse(fs.readFileSync(storePath, 'utf8')) as { episodes?: unknown };
    if (!state.episodes || typeof state.episodes !== 'object' || Array.isArray(state.episodes)) return [];
    return Object.values(state.episodes as Record<string, ExternalSourceDiagnosticEpisodeInput>);
  } catch {
    return [];
  }
}

function normalizeProvider(value: string): string {
  return value.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Human formatting (CLI)
// ---------------------------------------------------------------------------

export function formatProviderDiagnosticHuman(diag: ExternalSourceProviderDiagnostic): string {
  const lines: string[] = [];
  lines.push(`Provider: ${diag.provider}`);
  lines.push(`  Scope: ${diag.scope}`);
  lines.push(`  Admission gate: ${diag.admissionGate}`);
  lines.push(`  Activation: ${diag.activationState}`);
  lines.push(`  History mode: ${diag.historyMode}`);
  lines.push(`  Catch-up: ${diag.catchUpState}`);
  lines.push(`  Source health: ${diag.sourceHealth}`);
  lines.push(
    `  Work: read=${diag.workState.read}, ready-pages=${diag.workState.readyPages}, committing=${diag.workState.committing ? 'yes' : 'no'}`,
  );
  if (diag.readerVersion) {
    lines.push(`  Reader version: ${diag.readerVersion}`);
  }
  if (diag.activationProgress) {
    const { baselined, total } = diag.activationProgress;
    lines.push(`  Baseline progress: ${baselined}/${total}`);
  }
  if (diag.cursorProgress) {
    const cp = diag.cursorProgress;
    lines.push(`  Cursor: position=${cp.maxPosition}, active=${cp.activeResources}, closed=${cp.closedResources}`);
  }
  const hp = diag.catchUpProgress;
  if (diag.historyMode === 'catch-up' || hp.targetsTotal > 0) {
    if (hp.catalogGeneration !== undefined) {
      lines.push(`  Catalog: generation=${hp.catalogGeneration}, limit=${hp.requestedLimit ?? 0}`);
    }
    lines.push(
      `  Historical targets: total=${hp.targetsTotal}, target-pending=${hp.targetPending}, `
      + `historical-pending=${hp.historicalPendingTargets}, complete=${hp.completeTargets}, excluded=${hp.excludedTargets}`,
    );
    lines.push(
      `  Historical episodes: pending=${hp.historicalPendingEpisodes}, ready=${hp.readyHistoricalEpisodes}`,
    );
    lines.push(
      `  Exclusions: events=${hp.eventExclusions}, resources=${hp.resourceExclusions}, ranges=${hp.rangeExclusions}`,
    );
    lines.push(`  Quarantine: ${hp.quarantineCount}`);
    if (hp.blockedReason) {
      lines.push(`  Catch-up block: ${hp.blockedReason}`);
    }
    if (hp.lastSuccessfulProgressAt) {
      lines.push(`  Last historical progress: ${hp.lastSuccessfulProgressAt}`);
    }
  }
  if (diag.lastSuccessfulReadAt) {
    lines.push(`  Last read: ${diag.lastSuccessfulReadAt}`);
  }
  if (diag.nextRetryAt) {
    lines.push(`  Next retry: ${diag.nextRetryAt}`);
  }
  if (diag.failureClass) {
    lines.push(`  Failure: ${diag.failureClass}`);
  }
  if (diag.quarantined) {
    lines.push(`  Quarantined: yes`);
  }
  if (diag.locked) {
    lines.push(`  Locked: yes`);
  }
  lines.push(`  Drain: ${diag.drainState}`);
  if (diag.nextAction) {
    lines.push(`  Next action: ${diag.nextAction}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON formatting (CLI --json and Dashboard)
// ---------------------------------------------------------------------------

export function formatProviderDiagnosticJson(diag: ExternalSourceProviderDiagnostic): string {
  return JSON.stringify(diag, null, 2);
}

// ---------------------------------------------------------------------------
// Summary aggregation
// ---------------------------------------------------------------------------

export function buildDiagnosticSummary(
  diagnostics: readonly ExternalSourceProviderDiagnostic[],
  internalReady = true,
): ExternalSourceDiagnosticSummary {
  let activeCount = 0;
  let activatingCount = 0;
  let pausedCount = 0;
  let activationBlockedCount = 0;
  let failureCount = 0;

  for (const diag of diagnostics) {
    switch (diag.activationState) {
      case 'active':
        activeCount++;
        break;
      case 'activating':
        activatingCount++;
        break;
      case 'paused':
        pausedCount++;
        break;
      case 'activation_blocked':
        activationBlockedCount++;
        break;
    }
    if (diag.failureClass) {
      failureCount++;
    }
  }

  let overallStatus: DiagnosticOverallStatus = 'healthy';
  if (diagnostics.some(diagnostic => (
    diagnostic.activationState === 'activation_blocked'
    || diagnostic.catchUpState === 'catch_up_blocked'
    || diagnostic.sourceHealth === 'attention_required'
    || diagnostic.sourceHealth === 'blocked'
    || diagnostic.failureClass === 'protocol_failure'
    || diagnostic.failureClass === 'integrity_conflict'
    || diagnostic.failureClass === 'quarantine'
    || diagnostic.failureClass === 'permission'
  ))) {
    overallStatus = 'unhealthy';
  } else if (
    activatingCount > 0
    || pausedCount > 0
    || diagnostics.some(diagnostic => diagnostic.sourceHealth === 'waiting')
  ) {
    overallStatus = 'degraded';
  }

  const needsExternalAttention = diagnostics.some(diagnostic => (
    diagnostic.activationState === 'activation_blocked'
    || diagnostic.catchUpState === 'catch_up_blocked'
    || diagnostic.sourceHealth === 'attention_required'
    || diagnostic.sourceHealth === 'blocked'
  ));
  const overallReadiness: ExternalSourceOverallReadiness = !internalReady
    ? 'not_ready'
    : needsExternalAttention
      ? 'ready_with_external_attention'
      : 'ready';

  return {
    overallStatus,
    overallReadiness,
    providers: diagnostics,
    activeCount,
    activatingCount,
    pausedCount,
    activationBlockedCount,
    failureCount,
  };
}
