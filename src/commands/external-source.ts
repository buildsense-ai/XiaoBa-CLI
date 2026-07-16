/**
 * External Source CLI command surface (issue #91).
 *
 * Operator commands for durable multi-provider admission controls:
 *
 *   xiaoba external-source status [--json]
 *   xiaoba external-source enable <provider> [--scope <path|global>] [--history <mode>]
 *   xiaoba external-source history <provider> <mode>
 *   xiaoba external-source disable <provider>
 *   xiaoba external-source reset <provider>
 *   xiaoba external-source rebaseline <provider> --skip-to-now
 *
 * Commands modify the same durable provider state consumed by Runtime Learning.
 * A running Runtime observes changes at the next scheduling boundary.
 */

import * as path from 'node:path';

import { Logger } from '../utils/logger';
import { getDistillationHeartbeatConfig } from '../utils/distillation-heartbeat-config';
import type { ExternalHistoryMode } from '../utils/distillation-heartbeat-config';
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
import { XurlExternalSourceReader } from '../utils/xurl-session-log-source';

export interface ExternalSourceCommandOptions {
  subcommand: 'status' | 'enable' | 'history' | 'disable' | 'reset' | 'rebaseline';
  provider?: string;
  json?: boolean;
  scope?: string;
  scopePath?: string;
  history?: string;
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
