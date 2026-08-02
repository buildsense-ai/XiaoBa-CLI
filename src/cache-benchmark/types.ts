export const CACHE_BENCHMARK_MANIFEST_SCHEMA = 'xiaoba.cache_benchmark_manifest.v1' as const;
export const CACHE_BENCHMARK_LEDGER_SCHEMA = 'xiaoba.cache_benchmark_ledger.v1' as const;
export const CACHE_BENCHMARK_ROUND_SCHEMA = 'xiaoba.cache_benchmark_round.v1' as const;
export const CACHE_BENCHMARK_ATTEMPT_SCHEMA = 'xiaoba.cache_benchmark_attempt.v1' as const;
export const CACHE_BENCHMARK_RESULT_SCHEMA = 'xiaoba.cache_benchmark_result.v1' as const;

export const CACHE_READ_SOURCES = [
  'openai.input_tokens_details.cached_tokens',
  'openai.prompt_tokens_details.cached_tokens',
  'deepseek.prompt_cache_hit_tokens',
  'anthropic.cache_read_input_tokens',
  'provider-compatible-declared',
] as const;

export const REQUIRED_CACHE_BENCHMARK_CAPABILITIES = [
  'identity',
  'group-chat-participants',
  'device-authorization',
  'tools',
  'skills',
  'plan',
  'goal',
  'subagent',
  'memory',
  'runtime-feedback',
  'session-recovery',
] as const;

export type CacheReadSource = typeof CACHE_READ_SOURCES[number];
export type CacheBenchmarkCapability = typeof REQUIRED_CACHE_BENCHMARK_CAPABILITIES[number];
export type ProviderAdapter = 'openai' | 'anthropic';
export type ApiType = 'openai-responses' | 'openai-chat-completions' | 'anthropic-messages';
export type CacheClass = 'cold' | 'warm';
export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled' | 'incomplete' | 'retrying';

export interface CacheBenchmarkCriteria {
  minimum_read_ratio: number;
  consecutive_rounds: number;
  maximum_task_weight: number;
  include_cold_in_primary_ratio: boolean;
}

export interface CacheBenchmarkRun {
  run_id: string;
  required_cold_calls: 1;
  required_warm_calls: number;
}

export interface CacheBenchmarkCase {
  case_id: string;
  provider_instance_id: string;
  provider_adapter: ProviderAdapter;
  model: string;
  api_type: ApiType;
  surface: string;
  task_id: string;
  task_fixture_fingerprint: string;
  cache_read_source: CacheReadSource;
  scenario_family: string;
  session_type: string;
  capabilities: CacheBenchmarkCapability[];
  runs: CacheBenchmarkRun[];
}

export interface CacheBenchmarkManifest {
  schema: typeof CACHE_BENCHMARK_MANIFEST_SCHEMA;
  suite_id: string;
  criteria: CacheBenchmarkCriteria;
  cases: CacheBenchmarkCase[];
}

export interface CacheBenchmarkLedgerRound {
  round: number;
  evidence_fingerprint: string;
}

export interface CacheBenchmarkLedger {
  schema: typeof CACHE_BENCHMARK_LEDGER_SCHEMA;
  suite_id: string;
  latest_round: number;
  rounds: CacheBenchmarkLedgerRound[];
}

export interface CacheBenchmarkRoundHeader {
  schema: typeof CACHE_BENCHMARK_ROUND_SCHEMA;
  suite_id: string;
  round: number;
  artifact_fingerprint: string;
  manifest_fingerprint: string;
  config_fingerprint: string;
}

export interface CacheBenchmarkAttemptMetadata {
  provider_instance_id: string;
  provider_adapter: ProviderAdapter;
  model: string;
  api_type: ApiType;
  surface: string;
  task_id: string;
  task_fixture_fingerprint: string;
  scenario_family: string;
  session_type: string;
}

export interface CacheBenchmarkUsage {
  input_tokens?: number;
  cache_read_tokens?: number;
  cache_read_source: CacheReadSource;
  cache_write_tokens?: number;
}

export interface CacheBenchmarkAttempt {
  schema: typeof CACHE_BENCHMARK_ATTEMPT_SCHEMA;
  suite_id: string;
  round: number;
  attempt_number: number;
  case_id: string;
  run_id: string;
  call_id: string;
  attempt_id: string;
  metadata: CacheBenchmarkAttemptMetadata;
  cache_class: CacheClass;
  outcome: AttemptOutcome;
  usage: CacheBenchmarkUsage;
}

export interface CacheBenchmarkRoundEvidence {
  header: CacheBenchmarkRoundHeader;
  attempts: CacheBenchmarkAttempt[];
}

export type BenchmarkStatus = 'passed' | 'failed' | 'incomplete' | 'invalid' | 'unobservable';

export type BenchmarkReason =
  | 'schema_invalid'
  | 'duplicate_round'
  | 'duplicate_attempt'
  | 'unexpected_attempt_count'
  | 'unknown_case_or_run'
  | 'metadata_mismatch'
  | 'missing_required_run'
  | 'missing_cold_attempt'
  | 'missing_warm_attempt'
  | 'non_terminal_attempt'
  | 'non_succeeded_attempt'
  | 'missing_input_usage'
  | 'non_positive_input'
  | 'invalid_cache_read'
  | 'cache_read_exceeds_input'
  | 'cache_read_not_reported'
  | 'insufficient_positive_tasks'
  | 'minimum_read_ratio_not_met'
  | 'minimum_capped_task_ratio_not_met'
  | 'capability_coverage_incomplete'
  | 'insufficient_consecutive_rounds'
  | 'fingerprint_mismatch';

export type CacheBenchmarkLedgerReason =
  | 'ledger_mismatch'
  | 'ledger_rounds_not_contiguous'
  | 'missing_ledger_round'
  | 'unexpected_evidence_round'
  | 'evidence_fingerprint_mismatch';

export interface CacheBenchmarkCellResult {
  cell_fingerprint: string;
  status: BenchmarkStatus;
  input_tokens: number;
  cache_read_tokens: number;
  raw_read_ratio: number | null;
  capped_task_ratio: number | null;
  positive_task_count: number;
  reasons: BenchmarkReason[];
}

export interface CacheBenchmarkRoundResult {
  round: number;
  artifact_fingerprint: string;
  status: BenchmarkStatus;
  cells: CacheBenchmarkCellResult[];
  reasons: BenchmarkReason[];
}

export interface CacheBenchmarkCoverageResult {
  scope_fingerprint: string;
  status: 'passed' | 'incomplete';
  missing_capabilities: CacheBenchmarkCapability[];
}

export interface CacheBenchmarkResult {
  schema: typeof CACHE_BENCHMARK_RESULT_SCHEMA;
  status: BenchmarkStatus;
  exit_code: 0 | 1 | 2;
  manifest_fingerprint: string;
  config_fingerprint: string;
  ledger_fingerprint: string;
  latest_round: number | null;
  qualifying_rounds: number[];
  rounds: CacheBenchmarkRoundResult[];
  reasons: BenchmarkReason[];
  ledger_reasons: CacheBenchmarkLedgerReason[];
  capability_coverage: CacheBenchmarkCoverageResult[];
}

export class CacheBenchmarkInputError extends Error {
  readonly reason: BenchmarkReason;

  constructor(reason: BenchmarkReason = 'schema_invalid') {
    super('Cache benchmark input is invalid.');
    this.name = 'CacheBenchmarkInputError';
    this.reason = reason;
  }
}
