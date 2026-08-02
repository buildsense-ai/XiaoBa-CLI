import { createHash } from 'node:crypto';
import {
  CacheBenchmarkCase,
  CacheBenchmarkLedger,
  CacheBenchmarkManifest,
  CacheBenchmarkRoundEvidence,
  CacheBenchmarkRun,
} from './types';

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  return serializeCanonical(value);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function fingerprintCanonical(value: unknown): string {
  return `sha256:${sha256(canonicalJson(value))}`;
}

export function fingerprintManifest(manifest: CacheBenchmarkManifest): string {
  return fingerprintCanonical(normalizeManifest(manifest));
}

export function fingerprintConfig(manifest: CacheBenchmarkManifest): string {
  if (!manifest.benchmark_profile || !manifest.workload_contract_fingerprint) {
    return fingerprintCanonical(manifest.criteria);
  }
  return fingerprintCanonical({
    benchmark_profile: manifest.benchmark_profile,
    workload_contract_fingerprint: manifest.workload_contract_fingerprint,
    criteria: manifest.criteria,
  });
}

export function fingerprintLedger(ledger: CacheBenchmarkLedger): string {
  return fingerprintCanonical(ledger);
}

export function fingerprintRoundEvidence(round: CacheBenchmarkRoundEvidence): string {
  return fingerprintCanonical({ header: round.header, attempts: round.attempts });
}

/** Recomputes the provider-neutral workload contract from concrete cases. */
export function fingerprintBenchmarkWorkloadContract(
  cases: readonly CacheBenchmarkCase[],
): string {
  const projections = cases.map(entry => ({
    surface: entry.surface,
    task_id: entry.task_id,
    task_fixture_fingerprint: entry.task_fixture_fingerprint,
    oracle_contract_fingerprint: entry.oracle_contract_fingerprint,
    execution_plan_fingerprint: entry.execution_plan_fingerprint,
    scenario_family: entry.scenario_family,
    session_type: entry.session_type,
    execution_role: entry.execution_role,
    capabilities: [...entry.capabilities].sort(compareStrings),
    runs: [...entry.runs].sort(compareRuns),
  })).sort((left, right) => compareStrings(canonicalJson(left), canonicalJson(right)));
  return fingerprintCanonical({
    schema: 'xiaoba.cache_benchmark_workload_contract.v1',
    cases: projections,
  });
}

export function normalizeManifest(manifest: CacheBenchmarkManifest): CacheBenchmarkManifest {
  return {
    ...manifest,
    cases: [...manifest.cases]
      .sort(compareCases)
      .map(entry => ({
        ...entry,
        capabilities: [...entry.capabilities].sort(compareStrings),
        runs: [...entry.runs].sort(compareRuns),
      })),
  };
}

function compareCases(left: CacheBenchmarkCase, right: CacheBenchmarkCase): number {
  return compareStrings(left.case_id, right.case_id);
}

function compareRuns(left: CacheBenchmarkRun, right: CacheBenchmarkRun): number {
  return compareStrings(left.run_id, right.run_id);
}

function serializeCanonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON accepts finite numbers only.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => serializeCanonical(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareStrings);
    return `{${keys.map(key => `${JSON.stringify(key)}:${serializeCanonical(record[key])}`).join(',')}}`;
  }
  throw new TypeError('Canonical JSON accepts JSON values only.');
}

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export type { JsonValue };
