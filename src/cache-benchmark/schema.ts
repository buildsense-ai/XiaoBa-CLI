import {
  CACHE_BENCHMARK_ATTEMPT_SCHEMA,
  CACHE_BENCHMARK_LEDGER_SCHEMA,
  CACHE_BENCHMARK_MANIFEST_SCHEMA,
  CACHE_BENCHMARK_ROUND_SCHEMA,
  CACHE_READ_SOURCES,
  REQUIRED_CACHE_BENCHMARK_CAPABILITIES,
  CacheBenchmarkAttempt,
  CacheBenchmarkAttestation,
  CacheBenchmarkAttemptMetadata,
  CacheBenchmarkCase,
  CacheBenchmarkLedger,
  CacheBenchmarkLedgerRound,
  CacheBenchmarkCriteria,
  CacheBenchmarkInputError,
  CacheBenchmarkManifest,
  CacheBenchmarkRoundEvidence,
  CacheBenchmarkRoundHeader,
  CacheBenchmarkRun,
  CacheBenchmarkUsage,
  CacheClass,
  CacheReadSource,
  AttemptOutcome,
} from './types';

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const SHA256_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const BARE_SHA256 = /^[a-f0-9]{64}$/;

export function parseManifestJson(source: string): CacheBenchmarkManifest {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new CacheBenchmarkInputError();
  }
  return parseManifest(value);
}

export function parseManifest(value: unknown): CacheBenchmarkManifest {
  const record = exactRecord(value, ['schema', 'suite_id', 'criteria', 'cases']);
  if (record.schema !== CACHE_BENCHMARK_MANIFEST_SCHEMA) invalid();
  const suiteId = identifier(record.suite_id);
  const criteria = parseCriteria(record.criteria);
  if (!Array.isArray(record.cases) || record.cases.length === 0) invalid();
  const cases = record.cases.map(parseCase);
  assertUnique(cases.map(entry => entry.case_id));
  assertHomogeneousCells(cases);
  return {
    schema: CACHE_BENCHMARK_MANIFEST_SCHEMA,
    suite_id: suiteId,
    criteria,
    cases,
  };
}

export function parseLedgerJson(source: string): CacheBenchmarkLedger {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new CacheBenchmarkInputError();
  }
  return parseLedger(value);
}

export function parseLedger(value: unknown): CacheBenchmarkLedger {
  const record = exactRecord(value, ['schema', 'suite_id', 'latest_round', 'rounds']);
  if (record.schema !== CACHE_BENCHMARK_LEDGER_SCHEMA || !Array.isArray(record.rounds)) invalid();
  return {
    schema: CACHE_BENCHMARK_LEDGER_SCHEMA,
    suite_id: identifier(record.suite_id),
    latest_round: positiveInteger(record.latest_round),
    rounds: record.rounds.map(parseLedgerRound),
  };
}

export function parseRoundJsonl(source: string): CacheBenchmarkRoundEvidence {
  const lines = source.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) invalid();
  const values = lines.map(line => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return invalid();
    }
  });
  const header = parseRoundHeader(values[0]);
  const attempts = values.slice(1).map(parseAttempt);
  return { header, attempts };
}

export function parseRoundHeader(value: unknown): CacheBenchmarkRoundHeader {
  const record = exactRecord(value, [
    'schema',
    'suite_id',
    'round',
    'cache_partition_nonce',
    'artifact_fingerprint',
    'manifest_fingerprint',
    'config_fingerprint',
  ]);
  if (record.schema !== CACHE_BENCHMARK_ROUND_SCHEMA) invalid();
  return {
    schema: CACHE_BENCHMARK_ROUND_SCHEMA,
    suite_id: identifier(record.suite_id),
    round: positiveInteger(record.round),
    cache_partition_nonce: partitionNonce(record.cache_partition_nonce),
    artifact_fingerprint: fingerprint(record.artifact_fingerprint),
    manifest_fingerprint: fingerprint(record.manifest_fingerprint),
    config_fingerprint: fingerprint(record.config_fingerprint),
  };
}

export function parseAttempt(value: unknown): CacheBenchmarkAttempt {
  const record = exactRecord(value, [
    'schema',
    'suite_id',
    'round',
    'attempt_number',
    'case_id',
    'run_id',
    'call_id',
    'attempt_id',
    'metadata',
    'cache_class',
    'outcome',
    'usage',
    'attestation',
  ]);
  if (record.schema !== CACHE_BENCHMARK_ATTEMPT_SCHEMA) invalid();
  return {
    schema: CACHE_BENCHMARK_ATTEMPT_SCHEMA,
    suite_id: identifier(record.suite_id),
    round: positiveInteger(record.round),
    attempt_number: positiveInteger(record.attempt_number),
    case_id: identifier(record.case_id),
    run_id: identifier(record.run_id),
    call_id: identifier(record.call_id),
    attempt_id: identifier(record.attempt_id),
    metadata: parseMetadata(record.metadata),
    cache_class: enumeration(record.cache_class, ['cold', 'warm'] as const),
    outcome: enumeration(record.outcome, ['succeeded', 'failed', 'cancelled', 'incomplete', 'retrying'] as const),
    usage: parseUsage(record.usage),
    attestation: parseAttestation(record.attestation),
  };
}

function parseCriteria(value: unknown): CacheBenchmarkCriteria {
  const record = exactRecord(value, [
    'minimum_read_ratio',
    'consecutive_rounds',
    'maximum_task_weight',
    'include_cold_in_primary_ratio',
  ]);
  if (
    record.minimum_read_ratio !== 0.94
    || record.consecutive_rounds !== 3
    || record.maximum_task_weight !== 0.25
    || record.include_cold_in_primary_ratio !== true
  ) invalid();
  return {
    minimum_read_ratio: 0.94,
    consecutive_rounds: 3,
    maximum_task_weight: 0.25,
    include_cold_in_primary_ratio: true,
  };
}

function parseCase(value: unknown): CacheBenchmarkCase {
  const record = exactRecord(value, [
    'case_id',
    'provider_instance_id',
    'provider_adapter',
    'model',
    'api_type',
    'surface',
    'task_id',
    'task_fixture_fingerprint',
    'oracle_contract_fingerprint',
    'execution_plan_fingerprint',
    'cache_read_source',
    'scenario_family',
    'session_type',
    'capabilities',
    'runs',
  ]);
  if (!Array.isArray(record.runs) || record.runs.length === 0) invalid();
  if (!Array.isArray(record.capabilities) || record.capabilities.length === 0) invalid();
  const runs = record.runs.map(parseRun);
  const providerAdapter = enumeration(record.provider_adapter, ['openai', 'anthropic'] as const);
  const apiType = enumeration(record.api_type, ['openai-responses', 'openai-chat-completions', 'anthropic-messages'] as const);
  const cacheReadSource = enumeration(record.cache_read_source, CACHE_READ_SOURCES);
  assertAdapterContract(providerAdapter, apiType, cacheReadSource);
  const capabilities = record.capabilities.map(capability => enumeration(
    capability,
    REQUIRED_CACHE_BENCHMARK_CAPABILITIES,
  ));
  assertUnique(runs.map(entry => entry.run_id));
  assertUnique(capabilities);
  return {
    case_id: identifier(record.case_id),
    provider_instance_id: providerInstanceIdentifier(record.provider_instance_id),
    provider_adapter: providerAdapter,
    model: modelIdentifier(record.model),
    api_type: apiType,
    surface: identifier(record.surface),
    task_id: identifier(record.task_id),
    task_fixture_fingerprint: fingerprint(record.task_fixture_fingerprint),
    oracle_contract_fingerprint: fingerprint(record.oracle_contract_fingerprint),
    execution_plan_fingerprint: fingerprint(record.execution_plan_fingerprint),
    cache_read_source: cacheReadSource,
    scenario_family: identifier(record.scenario_family),
    session_type: identifier(record.session_type),
    capabilities,
    runs,
  };
}

function parseRun(value: unknown): CacheBenchmarkRun {
  const record = exactRecord(value, ['run_id', 'required_cold_calls', 'required_warm_calls']);
  if (record.required_cold_calls !== 1) invalid();
  return {
    run_id: identifier(record.run_id),
    required_cold_calls: 1,
    required_warm_calls: positiveInteger(record.required_warm_calls),
  };
}

function parseMetadata(value: unknown): CacheBenchmarkAttemptMetadata {
  const record = exactRecord(value, [
    'provider_instance_id',
    'provider_adapter',
    'model',
    'api_type',
    'surface',
    'task_id',
    'task_fixture_fingerprint',
    'scenario_family',
    'session_type',
  ]);
  const providerAdapter = enumeration(record.provider_adapter, ['openai', 'anthropic'] as const);
  const apiType = enumeration(record.api_type, ['openai-responses', 'openai-chat-completions', 'anthropic-messages'] as const);
  return {
    provider_instance_id: providerInstanceIdentifier(record.provider_instance_id),
    provider_adapter: providerAdapter,
    model: modelIdentifier(record.model),
    api_type: apiType,
    surface: identifier(record.surface),
    task_id: identifier(record.task_id),
    task_fixture_fingerprint: fingerprint(record.task_fixture_fingerprint),
    scenario_family: identifier(record.scenario_family),
    session_type: identifier(record.session_type),
  };
}

function parseLedgerRound(value: unknown): CacheBenchmarkLedgerRound {
  const record = exactRecord(value, ['round', 'evidence_fingerprint']);
  return {
    round: positiveInteger(record.round),
    evidence_fingerprint: fingerprint(record.evidence_fingerprint),
  };
}

function parseUsage(value: unknown): CacheBenchmarkUsage {
  const record = exactRecord(value, [], ['provider_usage']);
  if (!hasOwn(record, 'provider_usage')) return {};
  const raw = exactRecord(record.provider_usage, ['contract'], [
    'input_tokens',
    'prompt_tokens',
    'cached_tokens',
    'cache_write_tokens',
    'prompt_cache_hit_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ]);
  const contract = enumeration(raw.contract, [
    'openai-responses-v1',
    'openai-chat-v1',
    'deepseek-chat-v1',
    'anthropic-messages-v1',
  ] as const);
  const allowedByContract: Record<typeof contract, readonly string[]> = {
    'openai-responses-v1': ['contract', 'input_tokens', 'cached_tokens', 'cache_write_tokens'],
    'openai-chat-v1': ['contract', 'prompt_tokens', 'cached_tokens', 'cache_write_tokens'],
    'deepseek-chat-v1': ['contract', 'prompt_tokens', 'prompt_cache_hit_tokens'],
    'anthropic-messages-v1': [
      'contract',
      'input_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ],
  };
  if (Object.keys(raw).some(key => !allowedByContract[contract].includes(key))) invalid();
  const numeric = (key: string): number | undefined => hasOwn(raw, key)
    ? nonNegativeInteger(raw[key])
    : undefined;
  switch (contract) {
    case 'openai-responses-v1':
      return { provider_usage: {
        contract,
        ...(numeric('input_tokens') === undefined ? {} : { input_tokens: numeric('input_tokens') }),
        ...(numeric('cached_tokens') === undefined ? {} : { cached_tokens: numeric('cached_tokens') }),
        ...(numeric('cache_write_tokens') === undefined ? {} : { cache_write_tokens: numeric('cache_write_tokens') }),
      } };
    case 'openai-chat-v1':
      return { provider_usage: {
        contract,
        ...(numeric('prompt_tokens') === undefined ? {} : { prompt_tokens: numeric('prompt_tokens') }),
        ...(numeric('cached_tokens') === undefined ? {} : { cached_tokens: numeric('cached_tokens') }),
        ...(numeric('cache_write_tokens') === undefined ? {} : { cache_write_tokens: numeric('cache_write_tokens') }),
      } };
    case 'deepseek-chat-v1':
      return { provider_usage: {
        contract,
        ...(numeric('prompt_tokens') === undefined ? {} : { prompt_tokens: numeric('prompt_tokens') }),
        ...(numeric('prompt_cache_hit_tokens') === undefined ? {} : { prompt_cache_hit_tokens: numeric('prompt_cache_hit_tokens') }),
      } };
    case 'anthropic-messages-v1':
      return { provider_usage: {
        contract,
        ...(numeric('input_tokens') === undefined ? {} : { input_tokens: numeric('input_tokens') }),
        ...(numeric('cache_read_input_tokens') === undefined ? {} : { cache_read_input_tokens: numeric('cache_read_input_tokens') }),
        ...(numeric('cache_creation_input_tokens') === undefined ? {} : { cache_creation_input_tokens: numeric('cache_creation_input_tokens') }),
      } };
  }
}

function parseAttestation(value: unknown): CacheBenchmarkAttestation {
  const record = exactRecord(value, [
    'quality_status',
    'safety_status',
    'oracle_contract_fingerprint',
    'execution_plan_fingerprint',
    'stable_prefix_fingerprint',
    'request_fingerprint',
    'observed_capabilities',
  ]);
  if (!Array.isArray(record.observed_capabilities)) invalid();
  const observedCapabilities = record.observed_capabilities.map(capability => enumeration(
    capability,
    REQUIRED_CACHE_BENCHMARK_CAPABILITIES,
  ));
  assertUnique(observedCapabilities);
  return {
    quality_status: enumeration(record.quality_status, ['passed', 'failed', 'unobservable'] as const),
    safety_status: enumeration(record.safety_status, ['passed', 'failed', 'unobservable'] as const),
    oracle_contract_fingerprint: fingerprint(record.oracle_contract_fingerprint),
    execution_plan_fingerprint: fingerprint(record.execution_plan_fingerprint),
    stable_prefix_fingerprint: fingerprint(record.stable_prefix_fingerprint),
    request_fingerprint: fingerprint(record.request_fingerprint),
    observed_capabilities: observedCapabilities,
  };
}

function exactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (!isPlainRecord(value)) invalid();
  const record = value as Record<string, unknown>;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(record);
  if (requiredKeys.some(key => !hasOwn(record, key))) invalid();
  if (keys.some(key => !allowed.has(key))) invalid();
  return record;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) invalid();
  return value as string;
}

function providerInstanceIdentifier(value: unknown): string {
  const result = identifier(value);
  if (SHA256_FINGERPRINT.test(result) || BARE_SHA256.test(result) || result.includes('://')) invalid();
  return result;
}

function modelIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_MODEL_IDENTIFIER.test(value)) invalid();
  if (value.includes('://') || value.startsWith('/') || value.includes('\\')) invalid();
  return value as string;
}

function fingerprint(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_FINGERPRINT.test(value)) invalid();
  return value as string;
}

function partitionNonce(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) invalid();
  return value;
}

function positiveInteger(value: unknown): number {
  const result = integer(value);
  if (result <= 0) invalid();
  return result;
}

function nonNegativeInteger(value: unknown): number {
  const result = integer(value);
  if (result < 0) invalid();
  return result;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid();
  return value as number;
}

function enumeration<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid();
  return value as T;
}

function assertUnique(values: string[]): void {
  if (new Set(values).size !== values.length) invalid();
}

function assertHomogeneousCells(cases: CacheBenchmarkCase[]): void {
  const sourcesByCell = new Map<string, string>();
  for (const entry of cases) {
    const key = [
      entry.provider_instance_id,
      entry.provider_adapter,
      entry.model,
      entry.api_type,
      entry.surface,
    ].join('\0');
    const existing = sourcesByCell.get(key);
    if (existing !== undefined && existing !== entry.cache_read_source) invalid();
    sourcesByCell.set(key, entry.cache_read_source);
  }
}

function assertAdapterContract(
  providerAdapter: 'openai' | 'anthropic',
  apiType: 'openai-responses' | 'openai-chat-completions' | 'anthropic-messages',
  cacheReadSource: CacheReadSource,
): void {
  const allowed = providerAdapter === 'openai' && apiType === 'openai-responses'
    ? ['openai.input_tokens_details.cached_tokens']
    : providerAdapter === 'openai' && apiType === 'openai-chat-completions'
      ? [
        'openai.prompt_tokens_details.cached_tokens',
        'deepseek.prompt_cache_hit_tokens',
      ]
      : providerAdapter === 'anthropic' && apiType === 'anthropic-messages'
        ? ['anthropic.cache_read_input_tokens']
        : [];
  if (!allowed.includes(cacheReadSource)) invalid();
}

function invalid(): never {
  throw new CacheBenchmarkInputError();
}

export type {
  AttemptOutcome,
  CacheClass,
  CacheReadSource,
};
