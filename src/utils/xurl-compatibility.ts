/**
 * Issue #94 — xURL version diagnostics and content-compatibility gate.
 *
 * Per ADR-0043 and the PRD, xURL version is diagnostic metadata, not the
 * compatibility decision. On a version change, the provider continues only
 * when the strict parser succeeds and existing normalized event fingerprints
 * remain unchanged. Structural incompatibility becomes `protocol_failure`;
 * historical content mutation becomes `integrity_conflict`. Both pause only
 * the affected provider and preserve cursor/evidence/audit state.
 *
 * This module is intentionally standalone so it is testable before and after
 * #90–#93 integrate the reader wiring.
 */

import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CompatibilityVerdict = 'compatible' | 'protocol_failure' | 'integrity_conflict';

export interface FingerprintBaseline {
  /** Stable identity: provider:thread[:branch]:ordinalStart-ordinalEnd */
  readonly identity: string;
  /** SHA-256 content hash from the rendered Timeline parser. */
  readonly contentHash: string;
}

export interface FingerprintObservation extends FingerprintBaseline {}

export interface CompatibilityConflict {
  readonly identity: string;
  readonly baselineHash: string;
  readonly observedHash: string;
}

export interface CompatibilityMissing {
  readonly identity: string;
}

export interface CompatibilityGateResult {
  readonly verdict: CompatibilityVerdict;
  readonly conflicts: readonly CompatibilityConflict[];
  readonly missing: readonly CompatibilityMissing[];
  /** Whether cursor/evidence/audit state must be preserved (always true for failures). */
  readonly preservesState: boolean;
  readonly requiresOperatorAction: boolean;
  /** Redacted next-action guidance for operators. */
  readonly nextAction?: string;
}

export interface XurlVersionDiagnostic {
  readonly rawVersion: string;
  readonly obtainedAt: string;
  readonly source: 'cli' | 'unknown';
}

// ---------------------------------------------------------------------------
// Version diagnostics
// ---------------------------------------------------------------------------

/**
 * Query `xurl --version` for diagnostic metadata. Version is recorded per
 * provider for diagnosis but is NOT the compatibility decision. A version
 * change alone neither grants compatibility nor forces a rebaseline.
 *
 * Returns a diagnostic record on success, or a record with `source: 'unknown'`
 * when xURL is missing or fails. Never throws — missing xURL is a source-local
 * support failure, not a runtime crash.
 */
export function getXurlVersion(
  command: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): XurlVersionDiagnostic {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const obtainedAt = new Date().toISOString();
  try {
    const stdout = execFileSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env,
    }) as string;
    return {
      rawVersion: stdout.trim(),
      obtainedAt,
      source: 'cli',
    };
  } catch {
    return {
      rawVersion: '',
      obtainedAt,
      source: 'unknown',
    };
  }
}

// ---------------------------------------------------------------------------
// Content-compatibility gate
// ---------------------------------------------------------------------------

/**
 * Compare observed normalized event fingerprints against a baseline.
 *
 * - `compatible`: all baseline identities are present with unchanged hashes.
 *   New events (not in baseline) are allowed — they are future-only growth.
 * - `integrity_conflict`: a baseline identity is present but its content hash
 *   changed. This is historical content mutation and takes priority over
 *   protocol_failure.
 * - `protocol_failure`: a baseline identity is missing from the observed set.
 *   This is structural incompatibility.
 *
 * Both failure verdicts preserve cursor/evidence/audit state and require
 * operator action (repair or explicit rebaseline).
 */
export function checkFingerprintCompatibility(
  observed: readonly FingerprintObservation[],
  baseline: readonly FingerprintBaseline[],
): CompatibilityGateResult {
  if (baseline.length === 0) {
    return {
      verdict: 'compatible',
      conflicts: [],
      missing: [],
      preservesState: true,
      requiresOperatorAction: false,
    };
  }

  const baselineMap = new Map<string, string>();
  for (const entry of baseline) {
    baselineMap.set(entry.identity, entry.contentHash);
  }

  const observedMap = new Map<string, string>();
  for (const entry of observed) {
    observedMap.set(entry.identity, entry.contentHash);
  }

  const conflicts: CompatibilityConflict[] = [];
  const missing: CompatibilityMissing[] = [];

  for (const [identity, baselineHash] of baselineMap) {
    const observedHash = observedMap.get(identity);
    if (observedHash === undefined) {
      missing.push({ identity });
    } else if (observedHash !== baselineHash) {
      // Redacted: only store that a conflict occurred, not the raw hash values
      conflicts.push({
        identity,
        baselineHash: '[redacted]',
        observedHash: '[redacted]',
      });
    }
  }

  if (conflicts.length > 0) {
    return {
      verdict: 'integrity_conflict',
      conflicts,
      missing,
      preservesState: true,
      requiresOperatorAction: true,
      nextAction:
        'Historical content mutation detected. Repair the xURL renderer or run an explicit rebaseline to skip the changed interval.',
    };
  }

  if (missing.length > 0) {
    return {
      verdict: 'protocol_failure',
      conflicts,
      missing,
      preservesState: true,
      requiresOperatorAction: true,
      nextAction:
        'Renderer structure incompatibility detected. Verify xURL output format or run an explicit rebaseline.',
    };
  }

  return {
    verdict: 'compatible',
    conflicts: [],
    missing: [],
    preservesState: true,
    requiresOperatorAction: false,
  };
}