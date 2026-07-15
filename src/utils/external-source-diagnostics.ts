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

export type AdmissionState = 'activating' | 'active' | 'paused' | 'activation_blocked';

export type FailureClass =
  | 'transient'
  | 'protocol_failure'
  | 'integrity_conflict'
  | 'quarantine'
  | 'permission';

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

export interface ExternalSourceProviderDiagnostic {
  readonly provider: string;
  readonly scope: string;
  readonly historyMode: 'future-only' | 'catch-up';
  readonly admissionState: AdmissionState;
  readonly readerVersion?: string;
  readonly activationProgress?: ActivationProgress;
  readonly cursorProgress?: CursorProgress;
  readonly lastSuccessfulReadAt?: string;
  readonly nextRetryAt?: string;
  readonly failureClass?: FailureClass;
  readonly quarantined: boolean;
  readonly locked: boolean;
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
}

export type DiagnosticOverallStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface ExternalSourceDiagnosticSummary {
  readonly overallStatus: DiagnosticOverallStatus;
  readonly providers: readonly ExternalSourceProviderDiagnostic[];
  readonly activeCount: number;
  readonly activatingCount: number;
  readonly pausedCount: number;
  readonly activationBlockedCount: number;
  readonly failureCount: number;
}

export function buildProviderDiagnosticRecord(args: {
  readonly status: ExternalSourceProviderStatusInput;
  readonly activation?: ExternalSourceProviderActivationInput | null;
  readonly resourcesTotal: number;
  readonly baselined: number;
  readonly sourceReport?: ExternalSourceProviderSourceReportInput;
}): ExternalSourceProviderDiagnostic {
  const failureClass = mapFailureClass(args.sourceReport?.failureClass);
  return {
    provider: args.status.provider,
    scope: args.status.scope,
    historyMode: args.status.historyMode ?? 'future-only',
    admissionState: args.activation?.activationBlocked
      ? 'activation_blocked'
      : !args.status.enabled || args.status.admissionGate === 'closed'
        ? 'paused'
        : args.activation && !args.activation.initialDiscoveryCompleted
          ? 'activating'
          : 'active',
    ...(args.sourceReport?.readerVersion ? { readerVersion: args.sourceReport.readerVersion } : {}),
    ...(args.resourcesTotal > 0 || args.baselined > 0
      ? { activationProgress: { baselined: args.baselined, total: args.resourcesTotal } }
      : {}),
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
    quarantined: failureClass === 'quarantine' || (args.sourceReport?.cursorProgress?.quarantinedEvents ?? 0) > 0,
    locked: args.sourceReport?.status === 'locked',
    drainState: args.sourceReport?.status === 'drained'
      ? 'drained'
      : args.sourceReport?.status === 'draining'
        ? 'draining'
        : 'idle',
    ...(resolveNextAction(args.activation?.activationBlockedReason, args.sourceReport?.nextAction)
      ? { nextAction: resolveNextAction(args.activation?.activationBlockedReason, args.sourceReport?.nextAction) }
      : {}),
  };
}

export function mapFailureClass(value: unknown): FailureClass | undefined {
  if (value === 'protocol') return 'protocol_failure';
  if (value === 'integrity_conflict') return 'integrity_conflict';
  if (value === 'quarantine') return 'quarantine';
  if (value === 'permission') return 'permission';
  if (value === 'transient') return 'transient';
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

// ---------------------------------------------------------------------------
// Human formatting (CLI)
// ---------------------------------------------------------------------------

export function formatProviderDiagnosticHuman(diag: ExternalSourceProviderDiagnostic): string {
  const lines: string[] = [];
  lines.push(`Provider: ${diag.provider}`);
  lines.push(`  Scope: ${diag.scope}`);
  lines.push(`  History mode: ${diag.historyMode}`);
  lines.push(`  State: ${diag.admissionState}`);
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
): ExternalSourceDiagnosticSummary {
  let activeCount = 0;
  let activatingCount = 0;
  let pausedCount = 0;
  let activationBlockedCount = 0;
  let failureCount = 0;

  for (const diag of diagnostics) {
    switch (diag.admissionState) {
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
  if (failureCount > 0 || activationBlockedCount > 0) {
    overallStatus = 'unhealthy';
  } else if (activatingCount > 0 || pausedCount > 0) {
    overallStatus = 'degraded';
  }

  return {
    overallStatus,
    providers: diagnostics,
    activeCount,
    activatingCount,
    pausedCount,
    activationBlockedCount,
    failureCount,
  };
}
