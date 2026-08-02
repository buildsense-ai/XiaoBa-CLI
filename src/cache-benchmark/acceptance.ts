import {
  fingerprintBenchmarkAcceptanceTopology,
  fingerprintBenchmarkWorkloadContract,
  fingerprintConfig,
  fingerprintManifest,
} from './canonical';
import { parseManifest } from './schema';
import type { CacheBenchmarkManifest, CacheBenchmarkResult } from './types';
import { CACHE_BENCHMARK_RESULT_SCHEMA } from './types';

export const CACHE_BENCHMARK_ACCEPTANCE_SCHEMA = 'xiaoba.cache_benchmark_acceptance.v2' as const;
export const REQUIRED_ACCEPTANCE_PROVIDERS = ['newcli', 'deepseek'] as const;
export const MINIMUM_ACCEPTANCE_WARM_CALLS = 24;
export const REQUIRED_ACCEPTANCE_TOPOLOGY_FINGERPRINT =
  'sha256:294bf303208cc8e8416a3ea9294dd0bb25219851d36975bf0e78e6da7119ad29' as const;

export type AcceptanceProviderAlias = typeof REQUIRED_ACCEPTANCE_PROVIDERS[number];
export type CacheBenchmarkAcceptanceReason =
  | 'duplicate_provider'
  | 'unexpected_provider'
  | 'missing_provider'
  | 'provider_identity_mismatch'
  | 'provider_evidence_invalid'
  | 'profile_not_acceptance'
  | 'insufficient_warm_calls'
  | 'provider_not_passed'
  | 'qualifying_rounds_invalid'
  | 'workload_topology_mismatch'
  | 'workload_contract_invalid'
  | 'workload_contract_mismatch'
  | 'config_fingerprint_mismatch'
  | 'artifact_fingerprint_mismatch';

export interface CacheBenchmarkAcceptanceCandidate {
  provider: AcceptanceProviderAlias | string;
  manifest: CacheBenchmarkManifest;
  result: CacheBenchmarkResult;
}

export interface CacheBenchmarkAcceptanceProviderResult {
  provider: AcceptanceProviderAlias;
  status: CacheBenchmarkResult['status'];
  manifest_fingerprint: string;
  config_fingerprint: string;
  ledger_fingerprint: string;
  qualifying_rounds: number[];
  artifact_fingerprint: string | null;
}

export interface CacheBenchmarkAcceptanceResult {
  schema: typeof CACHE_BENCHMARK_ACCEPTANCE_SCHEMA;
  status: 'passed' | 'failed' | 'invalid';
  exit_code: 0 | 1 | 2;
  artifact_fingerprint: string | null;
  workload_contract_fingerprint: string | null;
  providers: CacheBenchmarkAcceptanceProviderResult[];
  reasons: CacheBenchmarkAcceptanceReason[];
}

/**
 * Binds independently scored provider streaks to one acceptance workload and
 * one executable artifact. Callers must obtain `result` from the strict scorer.
 */
export function aggregateCacheBenchmarkAcceptance(
  candidates: readonly CacheBenchmarkAcceptanceCandidate[],
): CacheBenchmarkAcceptanceResult {
  const reasons = new Set<CacheBenchmarkAcceptanceReason>();
  const byProvider = new Map<AcceptanceProviderAlias, CacheBenchmarkAcceptanceCandidate>();
  for (const candidate of candidates) {
    if (!isAcceptanceProvider(candidate.provider)) {
      reasons.add('unexpected_provider');
      continue;
    }
    if (byProvider.has(candidate.provider)) {
      reasons.add('duplicate_provider');
      continue;
    }
    byProvider.set(candidate.provider, candidate);
  }
  for (const provider of REQUIRED_ACCEPTANCE_PROVIDERS) {
    if (!byProvider.has(provider)) reasons.add('missing_provider');
  }

  const providerResults: CacheBenchmarkAcceptanceProviderResult[] = [];
  const artifactFingerprints = new Set<string>();
  const workloadFingerprints = new Set<string>();
  const configFingerprints = new Set<string>();
  for (const provider of REQUIRED_ACCEPTANCE_PROVIDERS) {
    const candidate = byProvider.get(provider);
    if (!candidate) continue;
    const manifest = parseManifest(candidate.manifest);
    const { result } = candidate;
    if (result.schema !== CACHE_BENCHMARK_RESULT_SCHEMA) {
      reasons.add('provider_evidence_invalid');
    }
    const expectedManifestFingerprint = fingerprintManifest(manifest);
    const expectedConfigFingerprint = fingerprintConfig(manifest);
    if (!providerIdentityMatches(provider, manifest)
      || result.manifest_fingerprint !== expectedManifestFingerprint) {
      reasons.add('provider_identity_mismatch');
    }
    const actualWorkloadFingerprint = fingerprintBenchmarkWorkloadContract(manifest.cases);
    const actualTopologyFingerprint = fingerprintBenchmarkAcceptanceTopology(manifest.cases);
    if (manifest.benchmark_profile !== 'acceptance' || !manifest.workload_contract_fingerprint) {
      reasons.add('profile_not_acceptance');
    }
    if (manifest.workload_contract_fingerprint !== actualWorkloadFingerprint) {
      reasons.add('workload_contract_invalid');
    }
    if (
      actualTopologyFingerprint !== REQUIRED_ACCEPTANCE_TOPOLOGY_FINGERPRINT
      || !officialCaseIdentitiesMatch(provider, manifest)
      || !officialJoinedScheduleMatches(manifest)
    ) {
      reasons.add('workload_topology_mismatch');
    }
    workloadFingerprints.add(actualWorkloadFingerprint);
    if (manifest.cases.some(entry => entry.execution_role === 'main' && entry.runs.some(
      run => run.required_warm_calls < MINIMUM_ACCEPTANCE_WARM_CALLS,
    ))) reasons.add('insufficient_warm_calls');
    if (result.config_fingerprint !== expectedConfigFingerprint) {
      reasons.add('config_fingerprint_mismatch');
    }
    configFingerprints.add(result.config_fingerprint);
    const resultClaimsPassed = result.status === 'passed' && result.exit_code === 0;
    if (result.status === 'invalid' || result.status === 'unobservable' || result.exit_code === 2) {
      reasons.add('provider_evidence_invalid');
    } else if (!resultClaimsPassed) {
      reasons.add('provider_not_passed');
    }

    let artifactFingerprint: string | null = null;
    if (resultClaimsPassed) {
      const qualifying = new Set(result.qualifying_rounds);
      const qualifyingResults = result.rounds.filter(round => qualifying.has(round.round));
      const providerArtifacts = new Set(qualifyingResults.map(round => round.artifact_fingerprint));
      artifactFingerprint = providerArtifacts.size === 1
        ? [...providerArtifacts][0]
        : null;
      if (
        result.qualifying_rounds.length !== manifest.criteria.consecutive_rounds
        || qualifyingResults.length !== manifest.criteria.consecutive_rounds
        || qualifyingResults.some(round => round.status !== 'passed')
        || !artifactFingerprint
      ) reasons.add('qualifying_rounds_invalid');
    }
    if (artifactFingerprint) artifactFingerprints.add(artifactFingerprint);
    providerResults.push({
      provider,
      status: result.status,
      manifest_fingerprint: result.manifest_fingerprint,
      config_fingerprint: result.config_fingerprint,
      ledger_fingerprint: result.ledger_fingerprint,
      qualifying_rounds: [...result.qualifying_rounds],
      artifact_fingerprint: artifactFingerprint,
    });
  }

  if (workloadFingerprints.size > 1) reasons.add('workload_contract_mismatch');
  if (configFingerprints.size > 1) reasons.add('config_fingerprint_mismatch');
  if (artifactFingerprints.size > 1) reasons.add('artifact_fingerprint_mismatch');
  const sortedReasons = [...reasons].sort(compareStrings);
  const invalid = sortedReasons.some(reason => (
    reason === 'duplicate_provider'
    || reason === 'unexpected_provider'
    || reason === 'missing_provider'
    || reason === 'provider_identity_mismatch'
    || reason === 'provider_evidence_invalid'
    || reason === 'profile_not_acceptance'
    || reason === 'insufficient_warm_calls'
    || reason === 'qualifying_rounds_invalid'
    || reason === 'workload_topology_mismatch'
    || reason === 'workload_contract_invalid'
    || reason === 'workload_contract_mismatch'
    || reason === 'config_fingerprint_mismatch'
    || reason === 'artifact_fingerprint_mismatch'
  ));
  const status = sortedReasons.length === 0 ? 'passed' : invalid ? 'invalid' : 'failed';
  return {
    schema: CACHE_BENCHMARK_ACCEPTANCE_SCHEMA,
    status,
    exit_code: status === 'passed' ? 0 : status === 'invalid' ? 2 : 1,
    artifact_fingerprint: artifactFingerprints.size === 1 ? [...artifactFingerprints][0] : null,
    workload_contract_fingerprint: workloadFingerprints.size === 1 ? [...workloadFingerprints][0] : null,
    providers: providerResults,
    reasons: sortedReasons,
  };
}

function providerIdentityMatches(
  provider: AcceptanceProviderAlias,
  manifest: CacheBenchmarkManifest,
): boolean {
  if (!manifest.suite_id.startsWith(`xiaoba-online-${provider}-`)) return false;
  const primaryCases = manifest.cases.filter(entry => entry.execution_role === 'main');
  if (primaryCases.length === 0) return false;
  const instances = new Set(primaryCases.map(entry => entry.provider_instance_id));
  if (instances.size !== 1) return false;
  if (provider === 'newcli') {
    return [...instances].every(value => /^newcli:openai-responses:endpoint-[a-f0-9]{32}$/u.test(value))
      && primaryCases.every(entry => (
        entry.provider_adapter === 'openai'
        && entry.api_type === 'openai-responses'
        && entry.cache_read_source === 'openai.input_tokens_details.cached_tokens'
      ));
  }
  return [...instances].every(value => /^deepseek:openai-chat-completions:endpoint-[a-f0-9]{32}$/u.test(value))
    && primaryCases.every(entry => (
      entry.provider_adapter === 'openai'
      && entry.api_type === 'openai-chat-completions'
      && (
        entry.cache_read_source === 'openai.prompt_tokens_details.cached_tokens'
        || entry.cache_read_source === 'deepseek.prompt_cache_hit_tokens'
      )
    ));
}

function officialCaseIdentitiesMatch(
  provider: AcceptanceProviderAlias,
  manifest: CacheBenchmarkManifest,
): boolean {
  return manifest.cases.every(entry => entry.case_id === [
    provider,
    entry.task_id,
    entry.execution_role === 'main' ? 'main' : 'memory',
  ].join('-'));
}

function officialJoinedScheduleMatches(manifest: CacheBenchmarkManifest): boolean {
  const casesByTask = new Map<string, CacheBenchmarkManifest['cases']>();
  for (const entry of manifest.cases) {
    const entries = casesByTask.get(entry.task_id) ?? [];
    entries.push(entry);
    casesByTask.set(entry.task_id, entries);
  }
  return [...casesByTask.values()].every(entries => {
    const main = entries.find(entry => entry.execution_role === 'main');
    const branch = entries.find(entry => entry.execution_role === 'memory_branch');
    if (!main || !branch || entries.length !== 2 || main.runs.length !== branch.runs.length) return false;
    return main.runs.every((mainRun, index) => {
      const branchRun = branch.runs[index];
      return mainRun.run_id === branchRun.run_id
        && mainRun.required_cold_calls === branchRun.required_cold_calls
        && mainRun.required_warm_calls === branchRun.required_warm_calls;
    });
  });
}

function isAcceptanceProvider(value: string): value is AcceptanceProviderAlias {
  return (REQUIRED_ACCEPTANCE_PROVIDERS as readonly string[]).includes(value);
}

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
