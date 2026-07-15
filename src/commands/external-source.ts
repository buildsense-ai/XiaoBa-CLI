/**
 * External Source CLI command surface (issue #91).
 *
 * Operator commands for durable multi-provider admission controls:
 *
 *   xiaoba external-source status [--json]
 *   xiaoba external-source enable <provider> [--scope <path|global>] [--scope-path <path>]
 *   xiaoba external-source disable <provider>
 *   xiaoba external-source reset <provider>
 *   xiaoba external-source rebaseline <provider> --skip-to-now
 *
 * Commands modify the same durable provider state consumed by Runtime Learning.
 * A running Runtime observes changes at the next scheduling boundary.
 */

import * as fs from 'node:fs';

import { Logger } from '../utils/logger';
import { getDistillationHeartbeatConfig } from '../utils/distillation-heartbeat-config';
import {
  buildDiagnosticSummary,
  formatProviderDiagnosticHuman,
  type ExternalSourceProviderDiagnostic,
  type FailureClass,
} from '../utils/external-source-diagnostics';
import {
  ExternalProviderOverrideStore,
  resolveExternalProviderOverridePath,
  type ProviderStatus,
} from '../utils/external-provider-controls';
import { loadExternalCursorState, resolveExternalCursorStorePath } from '../utils/session-log-source';

export interface ExternalSourceCommandOptions {
  subcommand: 'status' | 'enable' | 'disable' | 'reset' | 'rebaseline';
  provider?: string;
  json?: boolean;
  scope?: string;
  scopePath?: string;
  skipToNow?: boolean;
  workingDirectory?: string;
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
      handleEnable(store, options.provider, options.scope, options.scopePath);
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
      handleRebaseline(store, options.provider, options.skipToNow);
      break;
  }
}

function handleStatus(
  store: ExternalProviderOverrideStore,
  config: ReturnType<typeof getDistillationHeartbeatConfig>,
  json: boolean,
): void {
  const statuses = store.getAllProviderStatuses(config);
  const diagnostics = statuses.map(status => buildProviderDiagnostic(status, config));
  const summary = buildDiagnosticSummary(diagnostics);
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
      overallStatus: summary.overallStatus,
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
  Logger.info(`Overall status: ${summary.overallStatus}`);
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
): void {
  const scopeOption =
    scope === 'path'
      ? { scope: 'path' as const, scopePath: scopePath ?? process.cwd() }
      : undefined;
  store.enableProvider(provider, scopeOption);
  Logger.info(`Provider "${provider}" enabled${scopeOption ? ` (scope: ${scopeOption.scope}${scopeOption.scopePath ? ` ${scopeOption.scopePath}` : ''})` : ''}.`);
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
  provider: string,
  skipToNow: boolean,
): void {
  store.rebaselineProvider(provider, skipToNow);
  Logger.info(`Provider "${provider}" rebaseline recorded (skip-to-now: ${skipToNow}). Watermarks advance at next scheduling boundary.`);
}

function formatStatusJson(status: ProviderStatus) {
  return {
    provider: status.provider,
    enabled: status.enabled,
    source: status.source,
    scope: status.scope,
    ...(status.scopePath ? { scopePath: status.scopePath } : {}),
    admissionGate: status.admissionGate,
    ...(status.rebaselineRequestedAt ? { rebaselineRequestedAt: status.rebaselineRequestedAt } : {}),
  };
}

function buildProviderDiagnostic(
  status: ProviderStatus,
  config: ReturnType<typeof getDistillationHeartbeatConfig>,
): ExternalSourceProviderDiagnostic {
  const sourceId = resolveProviderSourceId(config, status.provider);
  const cursorState = loadExternalCursorState(resolveExternalCursorStorePath({
    provider: status.provider,
    sourceId,
  }));
  const lastSourceReport = readLastSourceReport(config, sourceId);
  const activation = cursorState.activation;
  const resources = Object.values(cursorState.resources);
  const sourceCursors = Object.values(cursorState.cursors)
    .filter(entry => entry.sourceIdentity?.sourceId === sourceId);
  const baselined = sourceCursors.filter(entry => entry.lastStatus === 'activated').length;
  const failureClass = mapFailureClass(lastSourceReport?.failureClass);
  const nextAction = resolveNextAction(activation?.activationBlockedReason, lastSourceReport?.nextAction);

  return {
    provider: status.provider,
    scope: status.scope,
    admissionState: activation?.activationBlocked
      ? 'activation_blocked'
      : !status.enabled || status.admissionGate === 'closed'
        ? 'paused'
        : activation && !activation.initialDiscoveryCompleted
          ? 'activating'
          : 'active',
    ...(lastSourceReport?.readerVersion ? { readerVersion: lastSourceReport.readerVersion } : {}),
    ...(resources.length > 0 || baselined > 0
      ? { activationProgress: { baselined, total: resources.length } }
      : {}),
    ...(lastSourceReport?.cursorProgress
      ? {
        cursorProgress: {
          maxPosition: lastSourceReport.cursorProgress.maxPosition,
          activeResources: lastSourceReport.cursorProgress.activeResources,
          closedResources: lastSourceReport.cursorProgress.closedResources,
        },
      }
      : {}),
    ...(lastSourceReport?.lastSuccessfulReadAt ? { lastSuccessfulReadAt: lastSourceReport.lastSuccessfulReadAt } : {}),
    ...(lastSourceReport?.nextRetryAt ? { nextRetryAt: lastSourceReport.nextRetryAt } : {}),
    ...(failureClass ? { failureClass } : {}),
    quarantined: failureClass === 'quarantine' || (lastSourceReport?.cursorProgress?.quarantinedEvents ?? 0) > 0,
    locked: lastSourceReport?.status === 'locked',
    drainState: lastSourceReport?.drainState === 'draining'
      ? 'draining'
      : lastSourceReport?.status === 'drained'
        ? 'drained'
        : 'idle',
    ...(nextAction ? { nextAction } : {}),
  };
}

function resolveProviderSourceId(
  config: ReturnType<typeof getDistillationHeartbeatConfig>,
  provider: string,
): string {
  const normalizedProvider = provider.trim().toLowerCase();
  const legacySelectedProvider = config.externalSessionLogSelectedProvider?.trim().toLowerCase();
  const legacySelectedSourceId = config.externalSessionLogSelectedSourceId?.trim();
  return config.externalSessionLogEnabledProviders.length === 1
    && legacySelectedProvider === normalizedProvider
    && Boolean(legacySelectedSourceId)
    ? legacySelectedSourceId!
    : `external-${normalizedProvider}`;
}

function readLastSourceReport(
  config: ReturnType<typeof getDistillationHeartbeatConfig>,
  sourceId: string,
): Record<string, any> | undefined {
  try {
    const raw = fs.readFileSync(config.heartbeatRecordPath, 'utf8');
    const record = JSON.parse(raw) as { lastSourceReports?: Record<string, any>[] };
    return record.lastSourceReports?.find(report => report?.sourceId === sourceId);
  } catch {
    return undefined;
  }
}

function mapFailureClass(value: unknown): FailureClass | undefined {
  if (value === 'protocol') return 'protocol_failure';
  if (value === 'integrity_conflict') return 'integrity_conflict';
  if (value === 'quarantine') return 'quarantine';
  if (value === 'permission') return 'permission';
  if (value === 'transient') return 'transient';
  return undefined;
}

function resolveNextAction(
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
