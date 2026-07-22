/**
 * Issue #94 — xURL version diagnostics.
 *
 * Per ADR-0043 and the PRD, xURL version is diagnostic metadata, not a
 * compatibility decision.
 */

import { execFileSync } from 'node:child_process';

import { buildXurlSubprocessEnv } from './xurl-subprocess-env';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
  // Least-privilege: when the caller does not provide an explicit env, build
  // one from process.env that excludes unrelated secrets.
  const env = options.env ?? buildXurlSubprocessEnv();
  try {
    const stdout = execFileSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
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
