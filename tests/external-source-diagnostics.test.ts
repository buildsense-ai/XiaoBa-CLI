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
  buildProviderDiagnosticRecord,
  type ExternalSourceProviderDiagnostic,
  type ExternalSourceDiagnosticSummary,
  formatProviderDiagnosticHuman,
  formatProviderDiagnosticJson,
  buildDiagnosticSummary,
  type AdmissionState,
  type FailureClass,
} from '../src/utils/external-source-diagnostics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiagnostic(overrides: Partial<ExternalSourceProviderDiagnostic> = {}): ExternalSourceProviderDiagnostic {
  return {
    provider: 'codex',
    scope: 'global',
    admissionState: 'active',
    readerVersion: 'xurl 1.2.3',
    activationProgress: { baselined: 5, total: 5 },
    cursorProgress: { maxPosition: 10, activeResources: 2, closedResources: 3 },
    lastSuccessfulReadAt: '2025-01-01T00:00:00Z',
    nextRetryAt: undefined,
    failureClass: undefined,
    quarantined: false,
    locked: false,
    drainState: 'idle',
    nextAction: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Diagnostic record
// ---------------------------------------------------------------------------

describe('external source diagnostics — record fields', () => {
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
});