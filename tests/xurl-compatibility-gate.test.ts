/**
 * Issue #94 — xURL version diagnostics and content-compatibility gate tests.
 *
 * These tests validate the release-gate compatibility behavior:
 *   - Version is diagnostic metadata, not the compatibility decision.
 *   - A compatible version change continues when strict parsing succeeds and
 *     all previously observed normalized ordinal fingerprints remain unchanged.
 *   - Renderer structure incompatibility becomes protocol_failure.
 *   - Historical normalized content mutation becomes integrity_conflict.
 *   - Both pause only the affected provider and preserve cursor/evidence/audit
 *     state.
 *
 * These tests pass before and after #90–#93 integrate because they test the
 * compatibility gate contract, not the reader wiring.
 */
import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  checkFingerprintCompatibility,
  getXurlVersion,
  type FingerprintBaseline,
  type FingerprintObservation,
} from '../src/utils/xurl-compatibility';

// ---------------------------------------------------------------------------
// Version diagnostics
// ---------------------------------------------------------------------------

describe('xurl version diagnostics', () => {
  test('records CLI version output when the command is available', () => {
    const diagnostic = getXurlVersion(process.execPath);
    assert.equal(diagnostic.source, 'cli');
    assert.ok(diagnostic.rawVersion.length > 0);
    assert.match(diagnostic.rawVersion, /^v?\d+/i);
  });

  test('returns unknown source when the command is missing', () => {
    const diagnostic = getXurlVersion('/definitely/missing/xurl-binary');
    assert.equal(diagnostic.source, 'unknown');
    assert.equal(diagnostic.rawVersion, '');
  });
});

// ---------------------------------------------------------------------------
// Fingerprint compatibility
// ---------------------------------------------------------------------------

describe('content-compatibility gate — fingerprint comparison', () => {
  test('returns compatible when all observed fingerprints match baseline', () => {
    const baseline: readonly FingerprintBaseline[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'aaa' },
      { identity: 'codex:thread-001:3-4', contentHash: 'bbb' },
    ];
    const observed: readonly FingerprintObservation[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'aaa' },
      { identity: 'codex:thread-001:3-4', contentHash: 'bbb' },
    ];
    const result = checkFingerprintCompatibility(observed, baseline);
    assert.equal(result.verdict, 'compatible');
  });

  test('returns compatible when new events are added (no historical change)', () => {
    const baseline: readonly FingerprintBaseline[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'aaa' },
    ];
    const observed: readonly FingerprintObservation[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'aaa' },
      { identity: 'codex:thread-001:3-4', contentHash: 'bbb' },
    ];
    const result = checkFingerprintCompatibility(observed, baseline);
    assert.equal(result.verdict, 'compatible');
  });

  test('returns integrity_conflict when a baseline fingerprint content hash changed', () => {
    const baseline: readonly FingerprintBaseline[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'aaa' },
    ];
    const observed: readonly FingerprintObservation[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'CHANGED' },
    ];
    const result = checkFingerprintCompatibility(observed, baseline);
    assert.equal(result.verdict, 'integrity_conflict');
    assert.ok(result.conflicts.length > 0, 'must report conflicting identity');
    assert.equal(result.conflicts[0]!.identity, 'codex:thread-001:1-2');
  });

  test('returns protocol_failure when a baseline identity is missing from observed', () => {
    const baseline: readonly FingerprintBaseline[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'aaa' },
      { identity: 'codex:thread-001:3-4', contentHash: 'bbb' },
    ];
    const observed: readonly FingerprintObservation[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'aaa' },
      // 3-4 is missing — structural change
    ];
    const result = checkFingerprintCompatibility(observed, baseline);
    assert.equal(result.verdict, 'protocol_failure');
    assert.ok(result.missing.length > 0, 'must report missing identity');
    assert.equal(result.missing[0]!.identity, 'codex:thread-001:3-4');
  });

  test('returns integrity_conflict when any conflict exists even if some are also missing', () => {
    const baseline: readonly FingerprintBaseline[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'aaa' },
      { identity: 'codex:thread-001:3-4', contentHash: 'bbb' },
    ];
    const observed: readonly FingerprintObservation[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'CHANGED' },
      // 3-4 missing
    ];
    const result = checkFingerprintCompatibility(observed, baseline);
    // integrity_conflict takes priority over protocol_failure
    assert.equal(result.verdict, 'integrity_conflict');
  });

  test('empty baseline with empty observed is compatible', () => {
    const result = checkFingerprintCompatibility([], []);
    assert.equal(result.verdict, 'compatible');
  });

  test('empty baseline with new observed events is compatible', () => {
    const observed: readonly FingerprintObservation[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'aaa' },
    ];
    const result = checkFingerprintCompatibility(observed, []);
    assert.equal(result.verdict, 'compatible');
  });

  test('provides redacted next-action guidance for failures', () => {
    const baseline: readonly FingerprintBaseline[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'aaa' },
    ];
    const observed: readonly FingerprintObservation[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'CHANGED' },
    ];
    const result = checkFingerprintCompatibility(observed, baseline);
    assert.ok(result.nextAction, 'must provide next-action guidance');
    assert.ok(result.nextAction!.length > 0);
  });

  test('does not include raw content in failure diagnostics (redacted)', () => {
    const baseline: readonly FingerprintBaseline[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'secret-hash-value' },
    ];
    const observed: readonly FingerprintObservation[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'different-hash' },
    ];
    const result = checkFingerprintCompatibility(observed, baseline);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('secret-hash-value'), 'must not leak baseline content hash');
    assert.ok(!serialized.includes('different-hash'), 'must not leak observed content hash');
  });
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

describe('content-compatibility gate — failure classification', () => {
  test('integrity_conflict preserves cursor/evidence/audit state (no destructive action)', () => {
    const baseline: readonly FingerprintBaseline[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'aaa' },
    ];
    const observed: readonly FingerprintObservation[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'CHANGED' },
    ];
    const result = checkFingerprintCompatibility(observed, baseline);
    assert.equal(result.verdict, 'integrity_conflict');
    assert.equal(result.preservesState, true, 'must preserve cursor/evidence/audit state');
    assert.equal(result.requiresOperatorAction, true);
  });

  test('protocol_failure preserves cursor/evidence/audit state', () => {
    const baseline: readonly FingerprintBaseline[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'aaa' },
    ];
    const observed: readonly FingerprintObservation[] = [];
    const result = checkFingerprintCompatibility(observed, baseline);
    assert.equal(result.verdict, 'protocol_failure');
    assert.equal(result.preservesState, true);
  });

  test('compatible does not require operator action', () => {
    const baseline: readonly FingerprintBaseline[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'aaa' },
    ];
    const observed: readonly FingerprintObservation[] = [
      { identity: 'codex:thread-001:1-2', contentHash: 'aaa' },
    ];
    const result = checkFingerprintCompatibility(observed, baseline);
    assert.equal(result.verdict, 'compatible');
    assert.equal(result.requiresOperatorAction, false);
  });
});