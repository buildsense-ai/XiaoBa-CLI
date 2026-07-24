/**
 * External Source CLI command surface (issue #91 + explicit backfill).
 *
 * Operator commands for durable multi-provider admission controls:
 *
 *   xiaoba external-source status [--json]
 *   xiaoba external-source enable <provider> [--scope <path|global>] [--history <mode>]
 *   xiaoba external-source history <provider> <mode>
 *   xiaoba external-source disable <provider>
 *   xiaoba external-source reset <provider>
 *   xiaoba external-source rebaseline <provider> --skip-to-now
 *   xiaoba external-source backfill <provider> --updated-since <duration-or-ISO> [--execute]
 *
 * Commands modify the same durable provider state consumed by Runtime Learning.
 * A running Runtime observes changes at the next scheduling boundary.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Logger } from '../utils/logger';
import { getDistillationHeartbeatConfig } from '../utils/distillation-heartbeat-config';
import type { DistillationHeartbeatConfig, ExternalHistoryMode } from '../utils/distillation-heartbeat-config';
import {
  buildExternalSourceDiagnosticSnapshot,
  formatProviderDiagnosticHuman,
  resolveExternalProviderSourceId,
} from '../utils/external-source-diagnostics';
import {
  ExternalProviderOverrideStore,
  resolveExternalProviderOverridePath,
  type ProviderStatus,
} from '../utils/external-provider-controls';
import { rebaselineExternalProviderWithRecovery } from '../utils/external-source-recovery';
import { LearningEpisodeStore } from '../utils/learning-episode';
import {
  ExternalSessionLogSourceAdapter,
} from '../utils/session-log-source';
import {
  XurlExternalBackfillSource,
  XurlExternalSourceReader,
  type XurlExternalBackfillCatalogSelection,
} from '../utils/xurl-session-log-source';
import { buildXurlSubprocessEnv } from '../utils/xurl-subprocess-env';
import { acquireHeartbeatSchedulerOwnerLock } from '../utils/heartbeat-scheduler-owner-lock';
import { RuntimeLearning } from '../utils/runtime-learning';
import { buildRuntimeLearningStack } from '../utils/runtime-command-support';
import {
  loadExternalSessionLogBackfillState,
  type ExternalSessionLogBackfillRequest,
  type ExternalSessionLogBackfillState,
  type ExternalSessionLogBackfillStatus,
  type ExternalHistoryProgressUpdate,
} from '../utils/session-log-backfill';
import { writeDashboardEnvUpdates } from '../dashboard/settings';

/** Conservative defaults for one explicit backfill operation. */
export const DEFAULT_BACKFILL_MAX_RESOURCES = 50;
export const DEFAULT_BACKFILL_MAX_EVENTS = 500;
export const DEFAULT_BACKFILL_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_BACKFILL_MAX_ELAPSED_MS = 5 * 60 * 1000;

export interface ExternalSourceCommandOptions {
  subcommand: 'status' | 'enable' | 'history' | 'disable' | 'reset' | 'rebaseline' | 'backfill';
  provider?: string;
  json?: boolean;
  scope?: string;
  scopePath?: string;
  history?: string;
  skipToNow?: boolean;
  workingDirectory?: string;
  /** Explicit backfill: duration like 7d or ISO cutoff timestamp. */
  updatedSince?: string;
  /** Explicit backfill: run admission. Default is dry-run. */
  execute?: boolean;
  /** Explicit backfill: reusable operation id for resume. */
  operationId?: string;
  maxResources?: number;
  maxEvents?: number;
  maxBytes?: number;
  maxElapsedMs?: number;
  /** Control-surface command fallback; CLI callers still require configuration. */
  xurlCommand?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Existing owner Runtime used by the connected-device control surface. */
  runtimeLearning?: RuntimeLearning;
  /** Structured report sink used by non-CLI control surfaces. */
  report?: (value: Record<string, unknown>) => void;
  /** Durable progress callback for connected-device control surface. */
  onProgress?: (progress: ExternalHistoryProgressUpdate) => void;
}

export interface ExternalHistoryControlStatus {
  heartbeatEnabled: boolean;
  sourcesEnabled: boolean;
  xurlConfigured: boolean;
  providers: Array<{
    provider: 'codex' | 'pi';
    enabled: boolean;
    historyMode: ExternalHistoryMode;
  }>;
  imports: ExternalHistoryImportStatus[];
}

export interface ExternalHistoryImportStatus {
  provider: 'codex' | 'pi';
  operationId: string;
  status: ExternalSessionLogBackfillStatus;
  selectedCount: number;
  processedResources: number;
  pendingResources: number;
  failedResources: number;
  resumable: boolean;
  quotaReached: boolean;
  updatedAt: string;
  completedAt: string | null;
}

export function getExternalHistoryControlStatus(
  workingDirectory: string = process.cwd(),
): ExternalHistoryControlStatus {
  const config = getDistillationHeartbeatConfig(workingDirectory);
  const store = new ExternalProviderOverrideStore({
    stateFilePath: resolveExternalProviderOverridePath(config),
  });
  const imports = getExternalHistoryImportStatuses(config);
  return {
    heartbeatEnabled: config.enabled,
    sourcesEnabled: config.externalSessionLogSourcesEnabled,
    xurlConfigured: Boolean(config.externalSessionLogXurlCommand?.trim()),
    providers: (['codex', 'pi'] as const).map(provider => {
      const status = store.getProviderStatus(provider, config);
      return {
        provider,
        enabled: status.enabled,
        historyMode: status.historyMode,
      };
    }),
    imports,
  };
}

export function configureExternalHistoryProviders(
  providers: readonly string[],
  workingDirectory: string = process.cwd(),
): ExternalHistoryControlStatus & { restartRequired: true } {
  const selected = new Set(providers.map(provider => provider.trim().toLowerCase()));
  if (selected.size === 0 || [...selected].some(provider => provider !== 'codex' && provider !== 'pi')) {
    throw new Error('select at least one supported provider: codex or pi');
  }
  const current = getDistillationHeartbeatConfig(workingDirectory);
  const envUpdates = {
    DISTILLATION_HEARTBEAT_ENABLED: 'true',
    XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED: 'true',
    XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS: [...selected].sort().join(','),
    XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND: current.externalSessionLogXurlCommand?.trim() || 'xurl',
    XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE: 'future-only',
  };
  writeDashboardEnvUpdates(workingDirectory, envUpdates);
  for (const [key, value] of Object.entries(envUpdates)) process.env[key] = value;

  const config = getDistillationHeartbeatConfig(workingDirectory);
  const store = new ExternalProviderOverrideStore({
    stateFilePath: resolveExternalProviderOverridePath(config),
  });
  for (const provider of ['codex', 'pi'] as const) {
    if (selected.has(provider)) store.enableProvider(provider, { scope: 'global' }, 'future-only');
    else store.disableProvider(provider);
  }
  return { ...getExternalHistoryControlStatus(workingDirectory), restartRequired: true };
}

/**
 * Map a durable external backfill report to a stable Device RPC error when the
 * operation ended in source_failed or blocked_zero_progress. Structured failure
 * codes (never English messages) drive the mapping so the Web receives a
 * stable external_history_record_too_large for output-limit failures and a
 * stable external_history_source_failed for generic source failures. Returns
 * undefined when the report is not a failure (caller returns it as success).
 */
export function mapExternalBackfillReportToDeviceRpcError(
  report: Record<string, unknown>,
  provider: string,
): {
  ok: false;
  errorCode: string;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
} | undefined {
  const status = String(report.status || '').trim();
  if (status !== 'source_failed' && status !== 'blocked_zero_progress') return undefined;
  const failureCode = String(report.failureCode || '').trim();
  if (failureCode === 'xurl_output_limit') {
    const details = (report.failureDetails as Record<string, unknown> | undefined) ?? {};
    const limitBytes = Number(details.limitBytes);
    const commandKind = typeof details.commandKind === 'string' ? details.commandKind : 'read';
    const safeLimitBytes = Number.isFinite(limitBytes) && limitBytes > 0 ? limitBytes : 0;
    const limitLabel = safeLimitBytes
      ? `（${Math.round(safeLimitBytes / 1024 / 1024 * 10) / 10} MiB）`
      : '';
    return {
      ok: false,
      errorCode: 'external_history_record_too_large',
      message: `历史记录超过安全限制${limitLabel}，该条记录目前无法导入；已完成的历史进度已保留。`,
      retryable: false,
      details: {
        provider,
        limitBytes: safeLimitBytes,
        commandKind,
        // The specific oversized record cannot be retried; it will fail again
        // until ranged read/software support exists. Durable prior progress is
        // preserved for other records.
        resumable: false,
      },
    };
  }
  return {
    ok: false,
    errorCode: 'external_history_source_failed',
    message: '外部历史来源执行失败，请检查来源状态后重试。',
    retryable: true,
    details: { provider, status },
  };
}

export async function runExternalHistoryBackfillControl(options: {
  provider: string;
  updatedSince: string;
  execute?: boolean;
  operationId?: string;
  preferExistingOperation?: boolean;
  workingDirectory?: string;
  runtimeLearning?: RuntimeLearning;
  onProgress?: (progress: ExternalHistoryProgressUpdate) => void;
}): Promise<Record<string, unknown>> {
  if (options.preferExistingOperation && !options.execute && !options.operationId) {
    const normalizedProvider = options.provider.trim().toLowerCase();
    const existing = getExternalHistoryControlStatus(options.workingDirectory).imports
      .find(item => item.provider === normalizedProvider && item.resumable);
    if (existing) {
      return {
        mode: 'resume',
        provider: existing.provider,
        cutoff: options.updatedSince,
        operationId: existing.operationId,
        selectedCount: existing.selectedCount,
        processedResources: existing.processedResources,
        pendingResources: existing.pendingResources,
        failedResources: existing.failedResources,
        status: existing.status,
        resumable: true,
        quotaReached: existing.quotaReached,
        existingOperation: true,
      };
    }
  }
  let report: Record<string, unknown> | undefined;
  await externalSourceCommand({
    subcommand: 'backfill',
    provider: options.provider,
    updatedSince: options.updatedSince,
    execute: options.execute,
    operationId: options.operationId,
    scope: 'global',
    workingDirectory: options.workingDirectory,
    runtimeLearning: options.runtimeLearning,
    xurlCommand: 'xurl',
    ...(options.runtimeLearning ? {
      maxResources: 10,
      maxEvents: 200,
      maxBytes: 2 * 1024 * 1024,
      maxElapsedMs: 45_000,
    } : {}),
    onProgress: options.onProgress,
    report: value => { report = value; },
  });
  if (!report) throw new Error('external history control did not produce a report');
  return report;
}

export async function externalSourceCommand(options: ExternalSourceCommandOptions): Promise<void> {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const config = getDistillationHeartbeatConfig(workingDirectory);
  const store = new ExternalProviderOverrideStore({
    stateFilePath: resolveExternalProviderOverridePath(config),
  });

  switch (options.subcommand) {
    case 'status':
      handleStatus(store, config, options.json ?? false);
      break;
    case 'enable':
      if (!options.provider) {
        Logger.error('enable requires a provider argument');
        process.exitCode = 1;
        return;
      }
      handleEnable(store, options.provider, options.scope, options.scopePath, options.history);
      break;
    case 'history':
      if (!options.provider) {
        Logger.error('history requires a provider argument');
        process.exitCode = 1;
        return;
      }
      if (!store.isProviderEnabled(options.provider, config)) {
        Logger.error(`history requires an enabled provider: ${options.provider}`);
        process.exitCode = 1;
        return;
      }
      handleHistory(store, options.provider, options.history);
      break;
    case 'disable':
      if (!options.provider) {
        Logger.error('disable requires a provider argument');
        process.exitCode = 1;
        return;
      }
      handleDisable(store, options.provider);
      break;
    case 'reset':
      if (!options.provider) {
        Logger.error('reset requires a provider argument');
        process.exitCode = 1;
        return;
      }
      handleReset(store, options.provider);
      break;
    case 'rebaseline':
      if (!options.provider) {
        Logger.error('rebaseline requires a provider argument');
        process.exitCode = 1;
        return;
      }
      if (!options.skipToNow) {
        Logger.error('rebaseline requires --skip-to-now');
        process.exitCode = 1;
        return;
      }
      handleRebaseline(store, config, workingDirectory, options.provider, options.skipToNow);
      break;
    case 'backfill':
      if (!options.provider) {
        throw new Error('backfill requires a provider argument');
      }
      if (!options.updatedSince?.trim()) {
        throw new Error('backfill requires --updated-since <duration-or-ISO>');
      }
      await handleBackfill(store, config, workingDirectory, options);
      break;
  }
}

function handleStatus(
  store: ExternalProviderOverrideStore,
  config: ReturnType<typeof getDistillationHeartbeatConfig>,
  json: boolean,
): void {
  const statuses = store.getAllProviderStatuses(config);
  const snapshot = buildExternalSourceDiagnosticSnapshot({
    config,
    providerStatuses: statuses,
  });
  const diagnostics = snapshot.providers;
  const masterEnabled = config.externalSessionLogSourcesEnabled;
  const maxConcurrency = config.externalSessionLogMaxConcurrency;
  const legacyProvider = config.externalSessionLogSelectedProvider;
  const usingLegacyFallback =
    legacyProvider && config.externalSessionLogEnabledProviders.length === 1
    && config.externalSessionLogEnabledProviders[0] === legacyProvider.trim().toLowerCase();

  if (json) {
    const output = {
      masterSwitch: masterEnabled ? 'on' : 'off',
      maxConcurrency,
      overallStatus: snapshot.overallStatus,
      overallReadiness: snapshot.overallReadiness,
      ...(usingLegacyFallback ? { legacySelectedProvider: legacyProvider, deprecated: true } : {}),
      providers: statuses.map(formatStatusJson),
      providerStatuses: statuses.map(formatStatusJson),
      providerDiagnostics: diagnostics,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }

  Logger.title('External Source Provider Status');
  Logger.info(`Master switch: ${masterEnabled ? 'on' : 'off'}`);
  Logger.info(`Max concurrency: ${maxConcurrency}`);
  Logger.info(`Overall readiness: ${snapshot.overallReadiness}`);
  if (usingLegacyFallback) {
    Logger.warning(`Using legacy selected provider "${legacyProvider}" (deprecated) — set XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS for multi-provider support.`);
  }

  if (diagnostics.length === 0) {
    Logger.info('No providers configured.');
    return;
  }

  for (const diagnostic of diagnostics) {
    Logger.text(formatProviderDiagnosticHuman(diagnostic));
  }
}

function handleEnable(
  store: ExternalProviderOverrideStore,
  provider: string,
  scope?: string,
  scopePath?: string,
  history?: string,
): void {
  const historyMode = parseHistoryMode(history);
  if (history && !historyMode) {
    Logger.error('history mode must be "future-only" or "catch-up"');
    process.exitCode = 1;
    return;
  }
  const scopeOption =
    scope === 'path'
      ? { scope: 'path' as const, scopePath: scopePath ?? process.cwd() }
      : undefined;
  store.enableProvider(provider, scopeOption, historyMode);
  Logger.info(`Provider "${provider}" enabled${scopeOption ? ` (scope: ${scopeOption.scope}${scopeOption.scopePath ? ` ${scopeOption.scopePath}` : ''})` : ''}${historyMode ? ` (history: ${historyMode})` : ''}.`);
}

function handleHistory(
  store: ExternalProviderOverrideStore,
  provider: string,
  history?: string,
): void {
  const historyMode = parseHistoryMode(history);
  if (!historyMode) {
    Logger.error('history mode must be "future-only" or "catch-up"');
    process.exitCode = 1;
    return;
  }
  store.setProviderHistoryMode(provider, historyMode);
  Logger.info(`Provider "${provider}" history mode set to ${historyMode}.`);
}

function parseHistoryMode(value: string | undefined): ExternalHistoryMode | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'catch-up' || normalized === 'future-only' ? normalized : undefined;
}

function handleDisable(store: ExternalProviderOverrideStore, provider: string): void {
  store.disableProvider(provider);
  Logger.info(`Provider "${provider}" disabled. State preserved; use "enable" to resume.`);
}

function handleReset(store: ExternalProviderOverrideStore, provider: string): void {
  store.resetProvider(provider);
  Logger.info(`Provider "${provider}" reset to environment default.`);
}

function handleRebaseline(
  store: ExternalProviderOverrideStore,
  config: ReturnType<typeof getDistillationHeartbeatConfig>,
  workingDirectory: string,
  provider: string,
  skipToNow: boolean,
): void {
  const normalizedProvider = provider.trim().toLowerCase();
  const sourceId = resolveExternalProviderSourceId(config, normalizedProvider);
  const scope = store.getProviderScope(normalizedProvider);
  const historyMode = store.getProviderHistoryMode(normalizedProvider, config).mode;
  const reader = config.externalSessionLogXurlCommand
    ? new XurlExternalSourceReader({
      command: config.externalSessionLogXurlCommand,
      provider: normalizedProvider,
      sourceId,
      scope: scope.scope,
      scopePath: scope.scopePath,
      cwd: workingDirectory,
      // Least-privilege env: xurl subprocesses receive only OS essentials,
      // never unrelated model/CatsCo secrets or parent-only XiaoBa config.
      env: buildXurlSubprocessEnv(),
    })
    : undefined;
  const source = new ExternalSessionLogSourceAdapter({
    sourceId,
    label: `${normalizedProvider} Session Logs`,
    provider: normalizedProvider,
    reader,
    enabled: true,
    scope,
    historyMode,
  });
  rebaselineExternalProviderWithRecovery({
    provider: normalizedProvider,
    skipToNow,
    historyMode,
    sources: [source],
    lockRoot: path.dirname(config.learningEpisodeStorePath),
    episodeStore: new LearningEpisodeStore(config.learningEpisodeStorePath),
    recordProviderAudit: () => store.rebaselineProvider(normalizedProvider, skipToNow),
  });
  Logger.info(`Provider "${provider}" rebaseline completed (skip-to-now: ${skipToNow}).`);
}

async function handleBackfill(
  store: ExternalProviderOverrideStore,
  config: DistillationHeartbeatConfig,
  workingDirectory: string,
  options: ExternalSourceCommandOptions,
): Promise<void> {
  const now = options.now?.() ?? new Date();
  const provider = requireNonEmpty('provider', options.provider).trim().toLowerCase();
  const cutoff = parseUpdatedSince(requireNonEmpty('updated-since', options.updatedSince), now);
  const limits = resolveBackfillLimits(options);
  const scope = resolveBackfillScope(store, provider, options.scope, options.scopePath, workingDirectory);
  const sourceId = resolveExternalProviderSourceId(config, provider);
  const xurlCommand = options.xurlCommand?.trim()
    || config.externalSessionLogXurlCommand?.trim();
  if (!xurlCommand) {
    throw new Error('xurl command is missing; set XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND');
  }

  const source = new XurlExternalBackfillSource({
    command: xurlCommand,
    provider,
    sourceId,
    sourceLabel: `${provider} Session Logs`,
    scope: scope.scope,
    scopePath: scope.scopePath,
    cwd: workingDirectory,
    // Least-privilege env: xurl subprocesses receive only OS essentials,
    // never unrelated model/CatsCo secrets or parent-only XiaoBa config.
    env: buildXurlSubprocessEnv(),
  });

  const selection = source.selectCatalogResourcesByUpdatedSince(cutoff);
  const resolvedOperation = resolveBackfillOperation({
    config,
    provider,
    sourceId,
    cutoff,
    selection,
    requestedOperationId: options.operationId,
    scope,
  });

  const reportBase = {
    mode: options.execute ? 'execute' as const : 'dry-run' as const,
    provider,
    sourceId,
    cutoff: selection.cutoff,
    selectedCount: resolvedOperation.resourceRefs.length,
    discoveredCount: selection.discoveredCount,
    excludedMissingUpdatedAt: selection.excludedMissingUpdatedAt,
    excludedInvalidUpdatedAt: selection.excludedInvalidUpdatedAt,
    excludedBeforeCutoff: selection.excludedBeforeCutoff,
    operationId: resolvedOperation.operationId,
    scope: scope.scope,
    limits,
    range: {
      startPosition: 0,
      endPosition: Number.MAX_SAFE_INTEGER,
      resourceCount: resolvedOperation.resourceRefs.length,
    },
    resumable: true,
    quotaReached: false,
  };

  if (!options.execute) {
    emitBackfillReport(options, reportBase, {
      note: 'Dry-run only. Pass --execute to admit the selected complete stable history.',
    });
    return;
  }

  if (resolvedOperation.resourceRefs.length === 0) {
    emitBackfillReport(options, {
      ...reportBase,
      status: 'completed',
      processedResources: 0,
      ingestedEvents: 0,
      resumable: false,
      quotaReached: false,
    }, {
      note: 'No selected resources; nothing to execute.',
    });
    return;
  }

  source.restrictToResourceRefs(resolvedOperation.resourceRefs);

  const runBackfill = async (runtime: RuntimeLearning): Promise<void> => {
    const request: ExternalSessionLogBackfillRequest = {
      operationId: resolvedOperation.operationId,
      triggeredBy: options.runtimeLearning
        ? 'operator:webapp-external-history'
        : 'operator:external-source-backfill',
      provider,
      sourceId,
      range: {
        startPosition: 0,
        endPosition: Number.MAX_SAFE_INTEGER,
        resourceRefs: resolvedOperation.resourceRefs,
      },
      limits: {
        maxResources: limits.maxResources,
        maxBytes: limits.maxBytes,
        maxElapsedMs: limits.maxElapsedMs,
        maxEvents: limits.maxEvents,
      },
    };

    const result = await runtime.runExternalBackfill(request, source, {
      onProgress: options.onProgress,
    });
    const status = result.backfill.status;
    const quotaReached = status === 'quota_reached';
    const resumable = status === 'quota_reached'
      || status === 'pending'
      || status === 'running'
      || status === 'source_failed'
      || status === 'blocked_zero_progress';

    emitBackfillReport(options, {
      ...reportBase,
      status,
      processedResources: result.backfill.processedResources,
      pendingResources: result.backfill.pendingResources,
      failedResources: result.backfill.failedResources,
      ingestedEvents: result.backfill.ingestedEvents,
      duplicateEventsSkipped: result.backfill.duplicateEventsSkipped,
      admittedEpisodes: result.backfill.admittedEpisodes,
      bytesProcessed: result.backfill.bytesProcessed,
      resumable,
      quotaReached,
      ...(result.backfill.failureCode ? { failureCode: result.backfill.failureCode } : {}),
      ...(result.backfill.failureDetails ? { failureDetails: result.backfill.failureDetails } : {}),
    }, {
      note: quotaReached
        ? 'Quota reached; resume the same operation to continue.'
        : status === 'blocked_zero_progress'
          ? 'Blocked with zero progress (operator-actionable, resumable). Inspect failures/quarantine or raise bounds, then retry the same operation.'
        : status === 'completed'
          ? 'Backfill completed for the selected resource set.'
          : `Backfill finished with status ${status}.`,
    });

    if (status === 'source_failed' && !options.report) process.exitCode = 1;
  };

  if (options.runtimeLearning) {
    await runBackfill(options.runtimeLearning);
    return;
  }

  const ownerLock = acquireHeartbeatSchedulerOwnerLock({
    runtimeRoot: workingDirectory,
    command: process.argv.join(' '),
    env: process.env,
  });
  if (!ownerLock.acquired) {
    throw new Error(
      `writable Runtime already owned by pid=${ownerLock.existing.pid}; refuse to race a running Dashboard owner`,
    );
  }

  try {
    const runtime = buildRuntimeLearningStack(workingDirectory, config, {
      clock: options.now,
      skillEvolutionOptions: { logEnabled: false },
      // Explicit backfill supplies its own XurlExternalBackfillSource.
      sessionLogSources: [],
    }).runtimeLearning;
    await runBackfill(runtime);
  } finally {
    ownerLock.release();
  }
}

function emitBackfillReport(
  options: ExternalSourceCommandOptions,
  report: Record<string, unknown>,
  extra: { note: string },
): void {
  if (options.report) {
    options.report({ ...report, note: extra.note });
    return;
  }
  writeBackfillReport(report, options.json ?? false, extra);
}

function resolveBackfillLimits(options: ExternalSourceCommandOptions): {
  maxResources: number;
  maxEvents: number;
  maxBytes: number;
  maxElapsedMs: number;
} {
  return {
    maxResources: normalizePositiveLimit(options.maxResources, DEFAULT_BACKFILL_MAX_RESOURCES, 'max-resources'),
    maxEvents: normalizePositiveLimit(options.maxEvents, DEFAULT_BACKFILL_MAX_EVENTS, 'max-events'),
    maxBytes: normalizePositiveLimit(options.maxBytes, DEFAULT_BACKFILL_MAX_BYTES, 'max-bytes'),
    maxElapsedMs: normalizePositiveLimit(options.maxElapsedMs, DEFAULT_BACKFILL_MAX_ELAPSED_MS, 'max-elapsed'),
  };
}

function resolveBackfillScope(
  store: ExternalProviderOverrideStore,
  provider: string,
  scopeOption: string | undefined,
  scopePathOption: string | undefined,
  workingDirectory: string,
): { scope: 'global' | 'path'; scopePath?: string } {
  if (scopeOption === 'path') {
    return {
      scope: 'path',
      scopePath: scopePathOption?.trim() || workingDirectory,
    };
  }
  if (scopeOption === 'global' || scopeOption === undefined) {
    if (scopeOption === undefined) {
      const stored = store.getProviderScope(provider);
      if (stored.scope === 'path') {
        return { scope: 'path', scopePath: stored.scopePath };
      }
    }
    return { scope: 'global' };
  }
  throw new Error('scope must be "global" or "path"');
}

function resolveBackfillOperation(args: {
  config: DistillationHeartbeatConfig;
  provider: string;
  sourceId: string;
  cutoff: Date;
  selection: XurlExternalBackfillCatalogSelection;
  requestedOperationId?: string;
  scope: { scope: 'global' | 'path'; scopePath?: string };
}): { operationId: string; resourceRefs: string[] } {
  const selectedRefs = args.selection.selected.map(resource => resource.resourceRef).sort();
  const operationId = args.requestedOperationId?.trim()
    || buildDeterministicOperationId({
      provider: args.provider,
      sourceId: args.sourceId,
      cutoff: args.cutoff.toISOString(),
      scope: args.scope.scope,
      // Scope path participates in identity but is never printed.
      scopePathFingerprint: args.scope.scopePath
        ? createHash('sha256').update(args.scope.scopePath, 'utf8').digest('hex').slice(0, 12)
        : 'global',
      resourceRefs: selectedRefs,
    });

  const paths = getExternalBackfillOperationPaths(args.config, args.provider, args.sourceId, operationId);
  const existing = fs.existsSync(paths.stateFilePath)
    ? loadExternalSessionLogBackfillState(paths.stateFilePath)
    : null;
  if (existing) {
    if (existing.provider !== args.provider || existing.sourceId !== args.sourceId) {
      throw new Error('existing backfill operation does not match provider/source');
    }
    const preserved = existing.range.resourceRefs ? [...existing.range.resourceRefs].sort() : selectedRefs;
    return { operationId, resourceRefs: preserved };
  }
  return { operationId, resourceRefs: selectedRefs };
}

function getExternalBackfillOperationPaths(
  config: DistillationHeartbeatConfig,
  provider: string,
  sourceId: string,
  operationId: string,
): { stateFilePath: string; auditFilePath: string } {
  const backfillRoot = path.join(
    getExternalBackfillRoot(config),
    toStablePathComponent(provider),
    toStablePathComponent(sourceId),
  );
  const operationStem = toStablePathComponent(operationId);
  return {
    stateFilePath: path.join(backfillRoot, `${operationStem}.state.json`),
    auditFilePath: path.join(backfillRoot, `${operationStem}.audit.jsonl`),
  };
}

function getExternalHistoryImportStatuses(
  config: DistillationHeartbeatConfig,
): ExternalHistoryImportStatus[] {
  const states = loadExternalHistoryStates(config);
  return (['codex', 'pi'] as const).flatMap(provider => {
    const providerStates = states
      .filter(state => state.provider === provider)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const latest = providerStates[0];
    if (!latest) return [];

    const selectedRefs = latest.range.resourceRefs ?? [];
    const processedRefs = new Set<string>();
    for (const state of providerStates) {
      for (const [resourceRef, resourceState] of Object.entries(state.resourceStates)) {
        if (resourceState.status === 'processed') processedRefs.add(resourceRef);
      }
    }
    const selectedCount = selectedRefs.length || latest.metrics.resourcesDiscovered;
    const processedResources = selectedRefs.length > 0
      ? selectedRefs.filter(resourceRef => processedRefs.has(resourceRef)).length
      : Math.min(selectedCount, latest.metrics.resourcesProcessed);

    return [{
      provider,
      operationId: latest.operationId,
      status: latest.status,
      selectedCount,
      processedResources,
      pendingResources: Math.max(0, selectedCount - processedResources),
      failedResources: latest.metrics.failedResources,
      resumable: latest.status !== 'completed',
      quotaReached: latest.status === 'quota_reached',
      updatedAt: latest.updatedAt,
      completedAt: latest.completedAt,
    }];
  });
}

function loadExternalHistoryStates(
  config: DistillationHeartbeatConfig,
): ExternalSessionLogBackfillState[] {
  const root = getExternalBackfillRoot(config);
  if (!fs.existsSync(root)) return [];

  const states: ExternalSessionLogBackfillState[] = [];
  for (const providerEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!providerEntry.isDirectory()) continue;
    const providerRoot = path.join(root, providerEntry.name);
    for (const sourceEntry of fs.readdirSync(providerRoot, { withFileTypes: true })) {
      if (!sourceEntry.isDirectory()) continue;
      const sourceRoot = path.join(providerRoot, sourceEntry.name);
      for (const stateEntry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
        if (!stateEntry.isFile() || !stateEntry.name.endsWith('.state.json')) continue;
        try {
          const state = loadExternalSessionLogBackfillState(path.join(sourceRoot, stateEntry.name));
          if (state) states.push(state);
        } catch (error) {
          Logger.warning(`Skipping unreadable external history state: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  return states;
}

function getExternalBackfillRoot(config: DistillationHeartbeatConfig): string {
  return path.join(path.dirname(config.learningEpisodeStorePath), 'external-session-log-backfills');
}

function buildDeterministicOperationId(parts: {
  provider: string;
  sourceId: string;
  cutoff: string;
  scope: string;
  scopePathFingerprint: string;
  resourceRefs: readonly string[];
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(parts), 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `backfill-${parts.provider}-${digest}`;
}

function writeBackfillReport(
  report: Record<string, unknown>,
  json: boolean,
  extra: { note: string },
): void {
  // Never include transcript text, resourceRefs, or unsanitized scope paths.
  const safe: Record<string, unknown> = {
    ...report,
    note: extra.note,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
    return;
  }
  Logger.title('External Source Backfill');
  Logger.info(`Mode: ${String(safe.mode)}`);
  Logger.info(`Provider: ${String(safe.provider)}`);
  Logger.info(`Cutoff: ${String(safe.cutoff)}`);
  Logger.info(`Selected: ${String(safe.selectedCount)} (discovered ${String(safe.discoveredCount)})`);
  Logger.info(
    `Excluded: missing=${String(safe.excludedMissingUpdatedAt)} invalid=${String(safe.excludedInvalidUpdatedAt)} beforeCutoff=${String(safe.excludedBeforeCutoff)}`,
  );
  Logger.info(`Operation ID: ${String(safe.operationId)}`);
  Logger.info(`Scope: ${String(safe.scope)}`);
  const limits = safe.limits as {
    maxResources: number;
    maxEvents: number;
    maxBytes: number;
    maxElapsedMs: number;
  };
  Logger.info(
    `Limits: resources=${limits.maxResources} events=${limits.maxEvents} bytes=${limits.maxBytes} elapsedMs=${limits.maxElapsedMs}`,
  );
  if (safe.status !== undefined) {
    Logger.info(`Status: ${String(safe.status)}`);
    Logger.info(`Resumable: ${String(safe.resumable)} quotaReached: ${String(safe.quotaReached)}`);
  }
  Logger.info(extra.note);
}

/**
 * Parse `--updated-since` as either a relative duration (`7d`, `12h`, `30m`, `45s`)
 * or a canonical ISO-8601 timestamp. Future cutoffs are rejected.
 */
export function parseUpdatedSince(value: string, now: Date): Date {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('updated-since is required');
  }

  const durationMatch = /^(\d+)([dhms])$/i.exec(trimmed);
  if (durationMatch) {
    const amount = Number(durationMatch[1]);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('updated-since duration must be a positive integer with unit d/h/m/s');
    }
    const unit = durationMatch[2]!.toLowerCase();
    const unitMs =
      unit === 'd' ? 86_400_000
        : unit === 'h' ? 3_600_000
          : unit === 'm' ? 60_000
            : 1_000;
    return new Date(now.getTime() - amount * unitMs);
  }

  if (!isCanonicalIsoTimestamp(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new Error('updated-since must be a duration like 7d or a canonical ISO timestamp');
  }
  const parsed = new Date(trimmed);
  if (parsed.getTime() > now.getTime()) {
    throw new Error('updated-since must not be in the future');
  }
  return parsed;
}

function isCanonicalIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function normalizePositiveLimit(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return Math.floor(value);
}

function requireNonEmpty(label: string, value: string | undefined): string {
  const text = value?.trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function toStablePathComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'op';
}

function formatStatusJson(status: ProviderStatus) {
  return {
    provider: status.provider,
    enabled: status.enabled,
    source: status.source,
    scope: status.scope,
    admissionGate: status.admissionGate,
    historyMode: status.historyMode,
    historyModeSource: status.historyModeSource,
    ...(status.historyModeDiagnostic ? { historyModeDiagnostic: status.historyModeDiagnostic } : {}),
    ...(status.rebaselineRequestedAt ? { rebaselineRequestedAt: status.rebaselineRequestedAt } : {}),
  };
}
