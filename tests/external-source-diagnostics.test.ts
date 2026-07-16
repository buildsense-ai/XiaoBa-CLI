/**
 * Issue #94 — External source provider diagnostics for CLI and Dashboard.
 *
 * Tests the diagnostic status types and formatting functions that expose
 * provider identity, scope, activation/baseline progress, reader/version,
 * cursor progress, last successful read, next retry, failure class, quarantine,
 * lock, drain, and operator action through the public CLI and Dashboard seams.
 *
 * These tests pass before and after #90–#93 integrate because they test the
 * diagnostic record contract, not the reader wiring.
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  buildExternalSourceDiagnosticSnapshot,
  buildProviderDiagnosticRecord,
  type ExternalSourceProviderDiagnostic,
  type ExternalSourceDiagnosticSummary,
  formatProviderDiagnosticHuman,
  formatProviderDiagnosticJson,
  buildDiagnosticSummary,
  type AdmissionState,
  type FailureClass,
} from '../src/utils/external-source-diagnostics';
import { getDistillationHeartbeatConfig } from '../src/utils/distillation-heartbeat-config';
import { emptyExternalCursorState } from '../src/utils/session-log-source';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiagnostic(overrides: Partial<ExternalSourceProviderDiagnostic> = {}): ExternalSourceProviderDiagnostic {
  const diagnostic: ExternalSourceProviderDiagnostic = {
    provider: 'codex',
    scope: 'global',
    admissionGate: 'open',
    activationState: 'active',
    historyMode: 'future-only',
    catchUpState: 'idle',
    sourceHealth: 'healthy',
    admissionState: 'active',
    readerVersion: 'xurl 1.2.3',
    activationProgress: { baselined: 5, total: 5 },
    cursorProgress: { maxPosition: 10, activeResources: 2, closedResources: 3 },
    catchUpProgress: {
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
    },
    lastSuccessfulReadAt: '2025-01-01T00:00:00Z',
    nextRetryAt: undefined,
    failureClass: undefined,
    quarantined: false,
    locked: false,
    workState: { read: 'idle', readyPages: 0, committing: false },
    drainState: 'idle',
    nextAction: undefined,
    ...overrides,
  };
  if (overrides.admissionState && overrides.activationState === undefined) {
    return { ...diagnostic, activationState: overrides.admissionState };
  }
  if (overrides.activationState && overrides.admissionState === undefined) {
    return { ...diagnostic, admissionState: overrides.activationState };
  }
  return diagnostic;
}

// ---------------------------------------------------------------------------
// Diagnostic record
// ---------------------------------------------------------------------------

describe('external source diagnostics — record fields', () => {
  test('shared snapshot keeps activation, catch-up, and source health orthogonal', () => {
    const config = getDistillationHeartbeatConfig(process.cwd(), {
      ...process.env,
      XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED: 'true',
      XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS: 'codex,claude',
    });
    const baseState = emptyExternalCursorState();
    const state = {
      ...baseState,
      activation: {
        initializedAt: '2026-07-16T00:00:00.000Z',
        mode: 'future-only-resource-baseline' as const,
        initialDiscoveryCompleted: true,
      },
      catchUpCatalog: {
        active: {
          generation: 4,
          status: 'inventory' as const,
          requestedLimit: 64,
          scopeFingerprint: 'a'.repeat(64),
          startedAt: '2026-07-16T00:00:00.000Z',
          observedResourceCount: 4,
          lastObservationCount: 4,
          observedOutputBytes: 512,
          observationCompletedAt: '2026-07-16T00:01:00.000Z',
        },
        lastCompleted: null,
      },
      catchUpTargets: {
        'thread-b': {
          targetId: 'target-b',
          provider: 'codex',
          sourceId: 'external-codex',
          resourceRef: 'thread-b',
          position: 8,
          empty: false,
          prefixDigest: 'b'.repeat(64),
          creationGeneration: 4,
          scopeFingerprint: 'a'.repeat(64),
          observedAt: '2026-07-16T00:00:30.000Z',
        },
      },
      catchUpResources: {
        'thread-a': {
          status: 'target-pending' as const,
          historicalCursor: { resourceRef: 'thread-a', position: -1, processedCount: 0 },
          observedPosition: 4,
          observedGeneration: 4,
          observedScopeFingerprint: 'a'.repeat(64),
          updatedAt: '2026-07-16T00:00:30.000Z',
        },
        'thread-b': {
          status: 'historical-pending' as const,
          historicalCursor: { resourceRef: 'thread-b', position: 3, processedCount: 2 },
          observedPosition: 8,
          observedGeneration: 4,
          observedScopeFingerprint: 'a'.repeat(64),
          updatedAt: '2026-07-16T00:02:00.000Z',
        },
        'thread-c': {
          status: 'complete' as const,
          historicalCursor: { resourceRef: 'thread-c', position: 6, processedCount: 3 },
          observedPosition: 6,
          observedGeneration: 4,
          observedScopeFingerprint: 'a'.repeat(64),
          updatedAt: '2026-07-16T00:03:00.000Z',
        },
        'thread-d': {
          status: 'abandoned' as const,
          historicalCursor: { resourceRef: 'thread-d', position: 1, processedCount: 1 },
          observedPosition: 5,
          observedGeneration: 4,
          observedScopeFingerprint: 'a'.repeat(64),
          updatedAt: '2026-07-16T00:04:00.000Z',
          terminalTombstoneId: 'range-abandonment-1',
        },
      },
      quarantinedEvents: {
        quarantine1: {
          quarantineId: 'quarantine1',
          resourceRef: 'thread-b',
          identity: { eventId: 'event-4', position: 4, contentHash: 'hash-4' },
          failureClass: 'quarantine' as const,
          message: 'redacted',
          detectedAt: '2026-07-16T00:02:30.000Z',
          cursorPosition: 3,
        },
      },
      tombstones: {
        event1: {
          tombstoneId: 'event1',
          kind: 'event-skip' as const,
          resourceRef: 'thread-b',
          identity: { eventId: 'event-5', position: 5, contentHash: 'hash-5' },
          createdAt: '2026-07-16T00:02:45.000Z',
          reason: 'operator skip',
        },
        resource1: {
          tombstoneId: 'resource1',
          kind: 'resource-closure' as const,
          resourceRef: 'thread-c',
          range: { startPosition: 0, endPosition: 6 },
          createdAt: '2026-07-16T00:03:30.000Z',
          reason: 'source deleted',
        },
        'range-abandonment-1': {
          tombstoneId: 'range-abandonment-1',
          kind: 'range-abandonment' as const,
          resourceRef: 'thread-d',
          range: { startPosition: 2, endPosition: 5 },
          createdAt: '2026-07-16T00:04:00.000Z',
          reason: 'rebaseline',
        },
      },
    };

    const snapshot = buildExternalSourceDiagnosticSnapshot({
      config,
      providerStatuses: [{
        provider: 'codex',
        enabled: true,
        source: 'environment',
        scope: 'global',
        admissionGate: 'open',
        historyMode: 'catch-up',
        historyModeSource: 'override',
      }],
      sourceReports: [{
        sourceId: 'external-codex',
        category: 'external',
        enabled: true,
        resourcesDiscovered: 4,
        unitsProcessed: 1,
        advancedResources: 1,
        provider: 'codex',
        reader: 'xurl',
        readerVersion: 'xurl 0.0.27',
        failureClass: 'quarantine',
        requiresOperatorAction: true,
        nextAction: 'retry_or_skip_quarantine',
        workState: { read: 'idle', readyPages: 0, committing: false },
      }],
      cursorStates: { 'external-codex': state },
      episodes: [
        { status: 'historical-pending', historicalTarget: { provider: 'codex' } },
        { status: 'eligible', historicalTarget: { provider: 'codex' } },
      ],
      generatedAt: '2026-07-16T00:05:00.000Z',
    });

    const diagnostic = snapshot.providers[0]!;
    assert.equal(diagnostic.admissionGate, 'open');
    assert.equal(diagnostic.activationState, 'active');
    assert.equal(diagnostic.historyMode, 'catch-up');
    assert.equal(diagnostic.catchUpState, 'inventory');
    assert.equal(diagnostic.sourceHealth, 'attention_required');
    assert.deepEqual(diagnostic.workState, { read: 'idle', readyPages: 0, committing: false });
    assert.deepEqual(diagnostic.catchUpProgress, {
      catalogGeneration: 4,
      requestedLimit: 64,
      scopeFingerprint: 'a'.repeat(64),
      targetsTotal: 4,
      targetPending: 1,
      historicalPendingTargets: 1,
      completeTargets: 1,
      excludedTargets: 1,
      historicalPendingEpisodes: 1,
      readyHistoricalEpisodes: 1,
      eventExclusions: 1,
      resourceExclusions: 1,
      rangeExclusions: 1,
      quarantineCount: 1,
      lastSuccessfulProgressAt: '2026-07-16T00:04:00.000Z',
    });
    assert.equal(snapshot.overallReadiness, 'ready_with_external_attention');
    assert.equal(snapshot.generatedAt, '2026-07-16T00:05:00.000Z');
  });

  test('future-only activation and waiting source health remain independently visible', () => {
    const diag = buildProviderDiagnosticRecord({
      status: {
        provider: 'claude',
        scope: 'global',
        enabled: true,
        admissionGate: 'open',
        historyMode: 'future-only',
      },
      activation: { initialDiscoveryCompleted: false },
      resourcesTotal: 3,
      baselined: 1,
      sourceReport: {
        failureClass: 'pending',
        nextRetryAt: '2026-07-16T01:00:00.000Z',
      },
    });
    assert.equal(diag.admissionGate, 'open');
    assert.equal(diag.activationState, 'activating');
    assert.equal(diag.catchUpState, 'idle');
    assert.equal(diag.sourceHealth, 'waiting');
    assert.equal(diag.nextRetryAt, '2026-07-16T01:00:00.000Z');
  });

  test('same-scope unresolved targets remain visible across catalog generations', () => {
    const base = emptyExternalCursorState();
    const scopeFingerprint = 'a'.repeat(64);
    const snapshot = buildExternalSourceDiagnosticSnapshot({
      config: getDistillationHeartbeatConfig(process.cwd(), {
        ...process.env,
        XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED: 'true',
        XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS: 'codex',
      }),
      providerStatuses: [{
        provider: 'codex', enabled: true, source: 'environment', scope: 'global',
        admissionGate: 'open', historyMode: 'catch-up', historyModeSource: 'override',
      }],
      cursorStates: {
        'external-codex': {
          ...base,
          catchUpCatalog: {
            active: {
              generation: 2,
              status: 'inventory',
              requestedLimit: 16,
              scopeFingerprint,
              startedAt: '2026-07-16T00:00:00.000Z',
              observedResourceCount: 1,
              lastObservationCount: 1,
              observedOutputBytes: 100,
            },
            lastCompleted: null,
          },
          catchUpResources: {
            older: {
              status: 'historical-pending',
              historicalCursor: { resourceRef: 'older', position: 1, processedCount: 1 },
              observedPosition: 4,
              observedGeneration: 1,
              observedScopeFingerprint: scopeFingerprint,
              updatedAt: '2026-07-16T00:00:00.000Z',
            },
            current: {
              status: 'target-pending',
              historicalCursor: { resourceRef: 'current', position: -1, processedCount: 0 },
              observedPosition: 2,
              observedGeneration: 2,
              observedScopeFingerprint: scopeFingerprint,
              updatedAt: '2026-07-16T00:01:00.000Z',
            },
            oldScope: {
              status: 'historical-pending',
              historicalCursor: { resourceRef: 'old-scope', position: -1, processedCount: 0 },
              observedPosition: 2,
              observedGeneration: 1,
              observedScopeFingerprint: 'b'.repeat(64),
              updatedAt: '2026-07-16T00:01:00.000Z',
            },
          },
        },
      },
    });

    assert.equal(snapshot.providers[0]?.catchUpProgress.targetsTotal, 2);
    assert.equal(snapshot.providers[0]?.catchUpProgress.historicalPendingTargets, 1);
    assert.equal(snapshot.providers[0]?.catchUpProgress.targetPending, 1);
  });

  test('catch-up block reports its bounded-cap reason and action', () => {
    const base = emptyExternalCursorState();
    const snapshot = buildExternalSourceDiagnosticSnapshot({
      config: getDistillationHeartbeatConfig(process.cwd(), {
        ...process.env,
        XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED: 'true',
        XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS: 'codex',
      }),
      providerStatuses: [{
        provider: 'codex', enabled: true, source: 'environment', scope: 'global',
        admissionGate: 'open', historyMode: 'catch-up', historyModeSource: 'override',
      }],
      cursorStates: {
        'external-codex': {
          ...base,
          catchUpCatalog: {
            active: {
              generation: 1,
              status: 'catch-up-blocked',
              requestedLimit: 64,
              scopeFingerprint: 'a'.repeat(64),
              startedAt: '2026-07-16T00:00:00.000Z',
              observedResourceCount: 64,
              lastObservationCount: 64,
              observedOutputBytes: 4096,
              blockedAt: '2026-07-16T00:01:00.000Z',
              blockedReason: 'configured catalog resource limit reached',
            },
            lastCompleted: null,
          },
        },
      },
    });

    const diagnostic = snapshot.providers[0]!;
    assert.equal(diagnostic.catchUpState, 'catch_up_blocked');
    assert.equal(diagnostic.sourceHealth, 'blocked');
    assert.equal(diagnostic.catchUpProgress.blockedReason, 'configured catalog resource limit reached');
    assert.match(diagnostic.nextAction ?? '', /catalog cap/i);
  });

  test('domain builder derives an activating provider from status plus activation state', () => {
    const diag = buildProviderDiagnosticRecord({
      status: {
        provider: 'codex',
        scope: 'global',
        enabled: true,
        admissionGate: 'open',
      },
      activation: {
        initialDiscoveryCompleted: false,
      },
      resourcesTotal: 4,
      baselined: 2,
      sourceReport: {
        readerVersion: 'xurl 1.2.3',
        cursorProgress: { maxPosition: 9, activeResources: 2, closedResources: 2 },
      },
    });
    assert.equal(diag.admissionState, 'activating');
    assert.equal(diag.activationProgress?.baselined, 2);
    assert.equal(diag.activationProgress?.total, 4);
  });

  test('a healthy active provider has no failure class or next action', () => {
    const diag = makeDiagnostic();
    assert.equal(diag.admissionState, 'active');
    assert.equal(diag.failureClass, undefined);
    assert.equal(diag.nextAction, undefined);
    assert.equal(diag.quarantined, false);
  });

  test('an activating provider reports baseline progress', () => {
    const diag = makeDiagnostic({
      admissionState: 'activating',
      activationProgress: { baselined: 2, total: 10 },
    });
    assert.equal(diag.admissionState, 'activating');
    assert.equal(diag.activationProgress!.baselined, 2);
    assert.equal(diag.activationProgress!.total, 10);
  });

  test('an activation_blocked provider requires operator action', () => {
    const diag = makeDiagnostic({
      admissionState: 'activation_blocked',
      nextAction: 'Narrow scope or raise the baseline cap, then resume activation.',
    });
    assert.equal(diag.admissionState, 'activation_blocked');
    assert.ok(diag.nextAction);
  });

  test('a paused provider preserves state with no failure', () => {
    const diag = makeDiagnostic({
      admissionState: 'paused',
      failureClass: undefined,
    });
    assert.equal(diag.admissionState, 'paused');
    assert.equal(diag.failureClass, undefined);
  });

  test('domain builder maps source failure and next action codes', () => {
    const diag = buildProviderDiagnosticRecord({
      status: {
        provider: 'claude',
        scope: 'path',
        enabled: true,
        admissionGate: 'open',
      },
      activation: {
        initialDiscoveryCompleted: true,
      },
      resourcesTotal: 1,
      baselined: 1,
      sourceReport: {
        failureClass: 'protocol',
        status: 'locked',
        nextAction: 'repair_source_then_retry',
        cursorProgress: { maxPosition: 3, activeResources: 1, closedResources: 0 },
      },
    });
    assert.equal(diag.failureClass, 'protocol_failure');
    assert.equal(diag.locked, true);
    assert.equal(diag.nextAction, 'Repair the source or reader, then retry.');
  });

  test('a protocol_failure provider has failure class and next action', () => {
    const diag = makeDiagnostic({
      admissionState: 'paused',
      failureClass: 'protocol_failure',
      nextAction: 'Verify xURL output format or run an explicit rebaseline.',
    });
    assert.equal(diag.failureClass, 'protocol_failure');
    assert.ok(diag.nextAction);
  });

  test('an integrity_conflict provider has failure class and next action', () => {
    const diag = makeDiagnostic({
      admissionState: 'paused',
      failureClass: 'integrity_conflict',
      nextAction: 'Repair the xURL renderer or run an explicit rebaseline.',
    });
    assert.equal(diag.failureClass, 'integrity_conflict');
    assert.ok(diag.nextAction);
  });

  test('a quarantined provider reports quarantine state', () => {
    const diag = makeDiagnostic({
      admissionState: 'paused',
      quarantined: true,
      failureClass: 'quarantine',
    });
    assert.equal(diag.quarantined, true);
    assert.equal(diag.failureClass, 'quarantine');
  });

  test('a draining provider reports drain state', () => {
    const diag = makeDiagnostic({
      drainState: 'draining',
    });
    assert.equal(diag.drainState, 'draining');
  });

  test('read, ready-page, and committing state remain separate from drain', () => {
    const diag = buildProviderDiagnosticRecord({
      status: {
        provider: 'codex',
        scope: 'global',
        enabled: true,
        admissionGate: 'open',
      },
      resourcesTotal: 1,
      baselined: 1,
      sourceReport: {
        workState: { read: 'reading', readyPages: 1, committing: true },
        status: 'draining',
      },
    });
    assert.deepEqual(diag.workState, { read: 'reading', readyPages: 1, committing: true });
    assert.equal(diag.drainState, 'draining');
  });

  test('a locked provider reports lock state', () => {
    const diag = makeDiagnostic({
      locked: true,
    });
    assert.equal(diag.locked, true);
  });
});

// ---------------------------------------------------------------------------
// Human formatting
// ---------------------------------------------------------------------------

describe('external source diagnostics — human formatting', () => {
  test('formats a healthy active provider', () => {
    const diag = makeDiagnostic();
    const text = formatProviderDiagnosticHuman(diag);
    assert.ok(text.includes('codex'));
    assert.ok(text.includes('active'));
    assert.ok(text.includes('global'));
  });

  test('formats a provider with failure class and next action', () => {
    const diag = makeDiagnostic({
      admissionState: 'paused',
      failureClass: 'protocol_failure',
      nextAction: 'Run rebaseline.',
    });
    const text = formatProviderDiagnosticHuman(diag);
    assert.ok(text.includes('protocol_failure'));
    assert.ok(text.includes('Run rebaseline.'));
  });

  test('formats activation progress', () => {
    const diag = makeDiagnostic({
      admissionState: 'activating',
      activationProgress: { baselined: 3, total: 10 },
    });
    const text = formatProviderDiagnosticHuman(diag);
    assert.ok(text.includes('activating'));
    assert.ok(/3.*10/.test(text));
  });
});

// ---------------------------------------------------------------------------
// JSON formatting
// ---------------------------------------------------------------------------

describe('external source diagnostics — JSON formatting', () => {
  test('produces valid JSON with all required fields', () => {
    const diag = makeDiagnostic();
    const json = formatProviderDiagnosticJson(diag);
    const parsed = JSON.parse(json);
    assert.equal(parsed.provider, 'codex');
    assert.equal(parsed.admissionState, 'active');
    assert.equal(parsed.scope, 'global');
    assert.equal(parsed.readerVersion, 'xurl 1.2.3');
    assert.equal(parsed.quarantined, false);
    assert.equal(parsed.locked, false);
  });

  test('JSON includes failure class and next action when present', () => {
    const diag = makeDiagnostic({
      failureClass: 'integrity_conflict',
      nextAction: 'Run rebaseline.',
    });
    const parsed = JSON.parse(formatProviderDiagnosticJson(diag));
    assert.equal(parsed.failureClass, 'integrity_conflict');
    assert.equal(parsed.nextAction, 'Run rebaseline.');
  });
});

// ---------------------------------------------------------------------------
// Summary aggregation
// ---------------------------------------------------------------------------

describe('external source diagnostics — summary aggregation', () => {
  test('builds a summary across multiple providers', () => {
    const diagnostics: readonly ExternalSourceProviderDiagnostic[] = [
      makeDiagnostic({ provider: 'codex', admissionState: 'active' }),
      makeDiagnostic({ provider: 'claude', admissionState: 'activating' }),
      makeDiagnostic({ provider: 'pi', admissionState: 'paused', failureClass: 'protocol_failure' }),
    ];
    const summary = buildDiagnosticSummary(diagnostics);
    assert.equal(summary.providers.length, 3);
    assert.equal(summary.activeCount, 1);
    assert.equal(summary.activatingCount, 1);
    assert.equal(summary.pausedCount, 1);
    assert.equal(summary.failureCount, 1);
  });

  test('summary reports overall health status', () => {
    const allHealthy: readonly ExternalSourceProviderDiagnostic[] = [
      makeDiagnostic({ provider: 'codex' }),
      makeDiagnostic({ provider: 'claude' }),
    ];
    const summary = buildDiagnosticSummary(allHealthy);
    assert.equal(summary.overallStatus, 'healthy');
  });

  test('summary reports degraded when a provider is activating', () => {
    const diagnostics: readonly ExternalSourceProviderDiagnostic[] = [
      makeDiagnostic({ provider: 'codex' }),
      makeDiagnostic({ provider: 'claude', admissionState: 'activating' }),
    ];
    const summary = buildDiagnosticSummary(diagnostics);
    assert.equal(summary.overallStatus, 'degraded');
  });

  test('summary reports unhealthy when a provider has a failure', () => {
    const diagnostics: readonly ExternalSourceProviderDiagnostic[] = [
      makeDiagnostic({ provider: 'codex' }),
      makeDiagnostic({ provider: 'claude', failureClass: 'protocol_failure' }),
    ];
    const summary = buildDiagnosticSummary(diagnostics);
    assert.equal(summary.overallStatus, 'unhealthy');
  });

  test('internal failure is the only diagnostic path to not-ready', () => {
    const summary = buildDiagnosticSummary([makeDiagnostic()], false);
    assert.equal(summary.overallReadiness, 'not_ready');
  });
});
