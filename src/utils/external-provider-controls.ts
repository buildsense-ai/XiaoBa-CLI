/**
 * Durable multi-provider admission controls and activation lifecycle (issue #91).
 *
 * This module owns the durable per-provider override state and the resolution
 * logic that combines environment defaults, durable overrides, and the global
 * master switch into the effective enabled provider set.
 *
 * Precedence (see PRD → "Durable Runtime Overrides"):
 *
 *   global master switch off
 *     > durable provider override
 *       > environment startup default
 *
 * Once an operator explicitly enables or disables a provider, restart
 * preserves that decision. `reset` removes the durable override and returns
 * the provider to its environment default.
 *
 * See CONTEXT.md → "Enabled External Provider Set", "External Provider Admission Gate".
 * See docs/prd/multi-provider-external-session-log-xurl.md → "Durable Runtime Overrides".
 */

import * as fs from 'fs';
import * as path from 'path';

import type {
  DistillationHeartbeatConfig,
  ExternalHistoryMode,
} from './distillation-heartbeat-config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Provider admission gate state: open admits new work, closed pauses it. */
export type ProviderAdmissionGateState = 'open' | 'closed';

/** Provider scope: global sees all xURL-visible threads, path narrows to one project path. */
export type ProviderScope = 'global' | 'path';

/** The source of truth for a provider's enabled state. */
export type ProviderEnabledSource = 'environment' | 'override' | 'master-off';

export type ProviderHistoryModeSource = 'environment' | 'override';

/** Durable per-provider override entry. */
export interface ProviderOverrideEntry {
  readonly enabled: boolean;
  readonly scope: ProviderScope;
  readonly scopePath?: string;
  readonly admissionGate: ProviderAdmissionGateState;
  readonly historyMode?: ExternalHistoryMode;
  readonly rebaselineRequestedAt?: string;
  readonly updatedAt: string;
}

/** Append-only audit entry for explicit rebaseline operations. */
export interface RebaselineAuditEntry {
  readonly provider: string;
  readonly operation: 'rebaseline';
  readonly skipToNow: boolean;
  readonly timestamp: string;
}

/** Durable override state persisted to disk. */
export interface ExternalProviderOverrideState {
  readonly version: number;
  readonly providers: Record<string, ProviderOverrideEntry>;
  readonly rebaselineAudit: RebaselineAuditEntry[];
}

/** Observable provider status used by CLI and Dashboard surfaces. */
export interface ProviderStatus {
  readonly provider: string;
  readonly enabled: boolean;
  readonly source: ProviderEnabledSource;
  readonly scope: ProviderScope;
  readonly scopePath?: string;
  readonly admissionGate: ProviderAdmissionGateState;
  readonly historyMode: ExternalHistoryMode;
  readonly historyModeSource: ProviderHistoryModeSource;
  readonly historyModeDiagnostic?: string;
  readonly rebaselineRequestedAt?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyState(): ExternalProviderOverrideState {
  return { version: 1, providers: {}, rebaselineAudit: [] };
}

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function ensureStateDir(stateFilePath: string): void {
  const dir = path.dirname(stateFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Durable per-provider override store. Loads and persists a JSON state file
 * that survives Runtime restart. All mutations are atomic writes.
 */
export class ExternalProviderOverrideStore {
  private readonly stateFilePath: string;
  private readonly now: () => Date;

  constructor(options: { stateFilePath: string; now?: () => Date }) {
    this.stateFilePath = options.stateFilePath;
    this.now = options.now ?? (() => new Date());
  }

  /** Load the durable override state from disk, returning empty state if absent. */
  load(): ExternalProviderOverrideState {
    try {
      if (!fs.existsSync(this.stateFilePath)) return emptyState();
      const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<ExternalProviderOverrideState>;
      if (!parsed || typeof parsed !== 'object') return emptyState();
      return {
        version: parsed.version ?? 1,
        providers: parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {},
        rebaselineAudit: Array.isArray(parsed.rebaselineAudit) ? parsed.rebaselineAudit : [],
      };
    } catch {
      return emptyState();
    }
  }

  /** Atomically persist override state to disk. */
  save(state: ExternalProviderOverrideState): void {
    ensureStateDir(this.stateFilePath);
    const tmp = `${this.stateFilePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, this.stateFilePath);
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve the effective enabled provider set considering precedence:
   * master switch off → empty set; durable override → override; env → default.
   */
  resolveEnabledProviders(config: DistillationHeartbeatConfig): readonly string[] {
    if (!config.externalSessionLogSourcesEnabled) return [];
    const envProviders = new Set(config.externalSessionLogEnabledProviders);
    const state = this.load();
    const result = new Set<string>();

    // Start from environment defaults
    for (const p of envProviders) {
      result.add(p);
    }

    // Apply durable overrides
    for (const [provider, entry] of Object.entries(state.providers)) {
      if (entry.enabled) {
        result.add(provider);
      } else {
        result.delete(provider);
      }
    }

    return [...result].sort();
  }

  /**
   * Check whether a specific provider is effectively enabled after resolution.
   */
  isProviderEnabled(provider: string, config: DistillationHeartbeatConfig): boolean {
    const normalized = normalizeProvider(provider);
    return this.resolveEnabledProviders(config).includes(normalized);
  }

  /**
   * Resolve the effective scope for a provider: override scope if present,
   * otherwise the default global scope.
   */
  getProviderScope(provider: string): { scope: ProviderScope; scopePath?: string } {
    const normalized = normalizeProvider(provider);
    const entry = this.load().providers[normalized];
    if (entry) {
      return { scope: entry.scope, scopePath: entry.scopePath };
    }
    return { scope: 'global' };
  }

  getProviderHistoryMode(
    provider: string,
    config: DistillationHeartbeatConfig,
  ): { mode: ExternalHistoryMode; source: ProviderHistoryModeSource; diagnostic?: string } {
    const normalized = normalizeProvider(provider);
    const override = this.load().providers[normalized]?.historyMode;
    if (override === 'catch-up' || override === 'future-only') {
      return { mode: override, source: 'override' };
    }
    return {
      mode: config.externalSessionLogHistoryMode,
      source: 'environment',
      ...(config.externalSessionLogHistoryModeDiagnostic
        ? { diagnostic: config.externalSessionLogHistoryModeDiagnostic }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Enable a provider with an optional scope override. Creates a durable
   * override that takes precedence over the environment default.
   */
  enableProvider(
    provider: string,
    scope?: { scope: ProviderScope; scopePath?: string },
    historyMode?: ExternalHistoryMode,
  ): void {
    const normalized = normalizeProvider(provider);
    const state = this.load();
    const existing = state.providers[normalized];
    const now = this.now().toISOString();
    state.providers[normalized] = {
      enabled: true,
      scope: scope?.scope ?? existing?.scope ?? 'global',
      scopePath: scope?.scopePath ?? existing?.scopePath,
      admissionGate: 'open',
      historyMode: historyMode ?? existing?.historyMode,
      rebaselineRequestedAt: existing?.rebaselineRequestedAt,
      updatedAt: now,
    };
    this.save(state);
  }

  /**
   * Disable a provider. Creates a durable override that pauses new admission
   * without deleting cursor, evidence, quarantine, or audit state.
   */
  disableProvider(provider: string): void {
    const normalized = normalizeProvider(provider);
    const state = this.load();
    const existing = state.providers[normalized];
    const now = this.now().toISOString();
    state.providers[normalized] = {
      enabled: false,
      scope: existing?.scope ?? 'global',
      scopePath: existing?.scopePath,
      admissionGate: 'closed',
      historyMode: existing?.historyMode,
      rebaselineRequestedAt: existing?.rebaselineRequestedAt,
      updatedAt: now,
    };
    this.save(state);
  }

  /**
   * Reset a provider: remove the durable override and return the provider
   * to its environment startup default.
   */
  resetProvider(provider: string): void {
    const normalized = normalizeProvider(provider);
    const state = this.load();
    delete state.providers[normalized];
    this.save(state);
  }

  /** Persist a provider-specific history policy without changing its identity. */
  setProviderHistoryMode(provider: string, historyMode: ExternalHistoryMode): void {
    const normalized = normalizeProvider(provider);
    const state = this.load();
    const existing = state.providers[normalized];
    const now = this.now().toISOString();
    state.providers[normalized] = {
      enabled: existing?.enabled ?? true,
      scope: existing?.scope ?? 'global',
      scopePath: existing?.scopePath,
      admissionGate: existing?.admissionGate ?? 'open',
      historyMode,
      rebaselineRequestedAt: existing?.rebaselineRequestedAt,
      updatedAt: now,
    };
    this.save(state);
  }

  /**
   * Explicit rebaseline: record an operator audit entry and mark the
   * rebaseline request. The actual watermark advance happens at the next
   * Runtime scheduling boundary; this operation never deletes prior local
   * evidence.
   */
  rebaselineProvider(provider: string, skipToNow: boolean): void {
    const normalized = normalizeProvider(provider);
    const state = this.load();
    const now = this.now().toISOString();
    const existing = state.providers[normalized];
    const newProviders = { ...state.providers };
    newProviders[normalized] = {
      enabled: existing?.enabled ?? true,
      scope: existing?.scope ?? 'global',
      scopePath: existing?.scopePath,
      admissionGate: existing?.admissionGate ?? 'open',
      historyMode: existing?.historyMode,
      rebaselineRequestedAt: now,
      updatedAt: now,
    };
    this.save({
      version: state.version,
      providers: newProviders,
      rebaselineAudit: [
        ...state.rebaselineAudit,
        { provider: normalized, operation: 'rebaseline', skipToNow, timestamp: now },
      ],
    });
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /**
   * Get the observable status for one provider through the public seam.
   */
  getProviderStatus(provider: string, config: DistillationHeartbeatConfig): ProviderStatus {
    const normalized = normalizeProvider(provider);
    const history = this.getProviderHistoryMode(normalized, config);

    if (!config.externalSessionLogSourcesEnabled) {
      return {
        provider: normalized,
        enabled: false,
        source: 'master-off',
        scope: 'global',
        admissionGate: 'closed',
        historyMode: history.mode,
        historyModeSource: history.source,
        ...(history.diagnostic ? { historyModeDiagnostic: history.diagnostic } : {}),
      };
    }

    const state = this.load();
    const entry = state.providers[normalized];

    if (entry) {
      return {
        provider: normalized,
        enabled: entry.enabled,
        source: 'override',
        scope: entry.scope,
        scopePath: entry.scopePath,
        admissionGate: entry.admissionGate,
        historyMode: history.mode,
        historyModeSource: history.source,
        ...(history.diagnostic ? { historyModeDiagnostic: history.diagnostic } : {}),
        rebaselineRequestedAt: entry.rebaselineRequestedAt,
      };
    }

    const enabledFromEnv = config.externalSessionLogEnabledProviders.includes(normalized);
    return {
      provider: normalized,
      enabled: enabledFromEnv,
      source: 'environment',
      scope: 'global',
      admissionGate: enabledFromEnv ? 'open' : 'closed',
      historyMode: history.mode,
      historyModeSource: history.source,
      ...(history.diagnostic ? { historyModeDiagnostic: history.diagnostic } : {}),
    };
  }

  /**
   * Get the observable status for all known providers (environment defaults
   * plus durable overrides).
   */
  getAllProviderStatuses(config: DistillationHeartbeatConfig): readonly ProviderStatus[] {
    const state = this.load();
    const allProviders = new Set<string>();

    // Include environment default providers even when the master switch is off,
    // so the status surface can report them as 'master-off'.
    for (const p of config.externalSessionLogEnabledProviders) {
      allProviders.add(p);
    }

    for (const p of Object.keys(state.providers)) {
      allProviders.add(p);
    }

    return [...allProviders].sort().map(p => this.getProviderStatus(p, config));
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the durable override state file path from the runtime config.
 * Placed alongside other durable external source state.
 */
export function resolveExternalProviderOverridePath(config: DistillationHeartbeatConfig): string {
  return path.join(
    path.dirname(config.learningEpisodeStorePath),
    'external-provider-overrides.json',
  );
}
