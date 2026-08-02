import {
  fingerprintCanonical,
  fingerprintConfig,
  fingerprintLedger,
  fingerprintManifest,
  fingerprintRoundEvidence,
} from './canonical';
import { parseAttempt, parseLedger, parseManifest, parseRoundHeader } from './schema';
import {
  BenchmarkReason,
  BenchmarkStatus,
  CacheBenchmarkAttempt,
  CacheBenchmarkCapability,
  CacheBenchmarkCase,
  CacheBenchmarkCellResult,
  CacheBenchmarkCoverageResult,
  CacheBenchmarkLedger,
  CacheBenchmarkLedgerReason,
  CacheBenchmarkManifest,
  CacheBenchmarkResult,
  CacheBenchmarkRoundEvidence,
  CacheBenchmarkRoundResult,
  CacheBenchmarkRequestKind,
  CacheBenchmarkTrafficClass,
  CacheReadSource,
  CACHE_BENCHMARK_RESULT_SCHEMA,
  REQUIRED_CACHE_BENCHMARK_CAPABILITIES,
} from './types';

interface ExpectedRun {
  caseEntry: CacheBenchmarkCase;
  requiredColdCalls: number;
  requiredWarmCalls: number;
}

interface TaskTotals {
  input: number;
  read: number;
}

interface CellAccumulator {
  fingerprint: string;
  trafficClass: CacheBenchmarkTrafficClass;
  reasons: Set<BenchmarkReason>;
  input: number;
  read: number;
  tasks: Map<string, TaskTotals>;
  coldInput: number;
  coldRead: number;
  allInput: number;
  allRead: number;
  requestKinds: Map<CacheBenchmarkRequestKind, RequestKindTotals>;
}

interface RequestKindTotals {
  input: number;
  read: number;
  coldInput: number;
  coldRead: number;
  allInput: number;
  allRead: number;
}

interface TaskCallOrder {
  cells: Set<CellAccumulator>;
  firstMainInferenceIndex?: number;
  lastMemoryBranchIndex?: number;
}

const STATUS_PRECEDENCE: Record<BenchmarkStatus, number> = {
  passed: 0,
  failed: 1,
  incomplete: 2,
  unobservable: 3,
  invalid: 4,
};

export function scoreCacheBenchmark(
  manifestInput: CacheBenchmarkManifest,
  ledgerInput: CacheBenchmarkLedger,
  roundInputs: CacheBenchmarkRoundEvidence[],
): CacheBenchmarkResult {
  const manifest = parseManifest(manifestInput);
  const ledger = parseLedger(ledgerInput);
  const manifestFingerprint = fingerprintManifest(manifest);
  const configFingerprint = fingerprintConfig(manifest);
  const ledgerFingerprint = fingerprintLedger(ledger);
  const rounds = roundInputs.map(round => ({
    header: parseRoundHeader(round.header),
    attempts: round.attempts.map(parseAttempt),
  }));
  const roundResults = rounds
    .map(round => scoreRound(manifest, round, manifestFingerprint, configFingerprint))
    .sort((left, right) => left.round - right.round);
  const latestRoundInput = rounds.reduce<CacheBenchmarkRoundEvidence | undefined>((latest, round) => (
    !latest || round.header.round > latest.header.round ? round : latest
  ), undefined);
  const capabilityCoverage = buildCapabilityCoverage(manifest, latestRoundInput?.attempts ?? []);
  const ledgerReasons = validateLedger(manifest, ledger, rounds);

  if (ledgerReasons.length > 0) {
    return buildResult({
      manifestFingerprint,
      configFingerprint,
      ledgerFingerprint,
      rounds: roundResults,
      capabilityCoverage,
      status: 'invalid',
      reasons: [],
      ledgerReasons,
      qualifyingRounds: [],
    });
  }

  const latest = roundResults[roundResults.length - 1];
  if (latest && (latest.status === 'invalid' || latest.status === 'unobservable')) {
    return buildResult({
      manifestFingerprint,
      configFingerprint,
      ledgerFingerprint,
      rounds: roundResults,
      capabilityCoverage,
      status: latest.status,
      reasons: latest.reasons,
      ledgerReasons: [],
      qualifyingRounds: [],
    });
  }

  if (capabilityCoverage.some(entry => entry.status === 'incomplete')) {
    return buildResult({
      manifestFingerprint,
      configFingerprint,
      ledgerFingerprint,
      rounds: roundResults,
      capabilityCoverage,
      status: 'incomplete',
      reasons: ['capability_coverage_incomplete'],
      ledgerReasons: [],
      qualifyingRounds: [],
    });
  }

  const suffix = latestPassingSuffix(roundResults);
  const requiredCount = manifest.criteria.consecutive_rounds;
  if (suffix.length >= requiredCount) {
    const latestRequired = suffix.slice(-requiredCount);
    if (manifest.benchmark_profile === 'calibration') {
      return buildResult({
        manifestFingerprint,
        configFingerprint,
        ledgerFingerprint,
        rounds: roundResults,
        capabilityCoverage,
        status: 'incomplete',
        reasons: ['calibration_only'],
        ledgerReasons: [],
        qualifyingRounds: latestRequired.map(round => round.round),
      });
    }
    return buildResult({
      manifestFingerprint,
      configFingerprint,
      ledgerFingerprint,
      rounds: roundResults,
      capabilityCoverage,
      status: 'passed',
      reasons: [],
      ledgerReasons: [],
      qualifyingRounds: latestRequired.map(round => round.round),
    });
  }

  if (latest && latest.status !== 'passed') {
    return buildResult({
      manifestFingerprint,
      configFingerprint,
      ledgerFingerprint,
      rounds: roundResults,
      capabilityCoverage,
      status: latest.status,
      reasons: latest.reasons,
      ledgerReasons: [],
      qualifyingRounds: [],
    });
  }

  if (manifest.benchmark_profile === 'calibration') {
    return buildResult({
      manifestFingerprint,
      configFingerprint,
      ledgerFingerprint,
      rounds: roundResults,
      capabilityCoverage,
      status: 'incomplete',
      reasons: ['calibration_only'],
      ledgerReasons: [],
      qualifyingRounds: suffix.map(round => round.round),
    });
  }

  return buildResult({
    manifestFingerprint,
    configFingerprint,
    ledgerFingerprint,
    rounds: roundResults,
    capabilityCoverage,
    status: 'incomplete',
    reasons: ['insufficient_consecutive_rounds'],
    ledgerReasons: [],
    qualifyingRounds: suffix.map(round => round.round),
  });
}

function validateLedger(
  manifest: CacheBenchmarkManifest,
  ledger: CacheBenchmarkLedger,
  rounds: CacheBenchmarkRoundEvidence[],
): CacheBenchmarkLedgerReason[] {
  const reasons = new Set<CacheBenchmarkLedgerReason>();
  if (ledger.suite_id !== manifest.suite_id) reasons.add('ledger_mismatch');
  if (ledger.rounds.length !== ledger.latest_round) reasons.add('ledger_rounds_not_contiguous');
  for (let index = 0; index < ledger.rounds.length; index += 1) {
    if (ledger.rounds[index].round !== index + 1) reasons.add('ledger_rounds_not_contiguous');
  }

  const roundsByNumber = new Map<number, CacheBenchmarkRoundEvidence>();
  const cachePartitionNonces = new Set<string>();
  for (const round of rounds) {
    if (roundsByNumber.has(round.header.round)) reasons.add('unexpected_evidence_round');
    roundsByNumber.set(round.header.round, round);
    if (cachePartitionNonces.has(round.header.cache_partition_nonce)) {
      reasons.add('duplicate_cache_partition_nonce');
    }
    cachePartitionNonces.add(round.header.cache_partition_nonce);
    if (round.header.round < 1 || round.header.round > ledger.latest_round) {
      reasons.add('unexpected_evidence_round');
    }
  }
  for (const ledgerRound of ledger.rounds) {
    const evidence = roundsByNumber.get(ledgerRound.round);
    if (!evidence) {
      reasons.add('missing_ledger_round');
      continue;
    }
    if (fingerprintRoundEvidence(evidence) !== ledgerRound.evidence_fingerprint) {
      reasons.add('evidence_fingerprint_mismatch');
    }
  }
  if (rounds.length > ledger.rounds.length) reasons.add('unexpected_evidence_round');
  return uniqueSorted([...reasons]);
}

function scoreRound(
  manifest: CacheBenchmarkManifest,
  round: CacheBenchmarkRoundEvidence,
  manifestFingerprint: string,
  configFingerprint: string,
): CacheBenchmarkRoundResult {
  const roundReasons = new Set<BenchmarkReason>();
  if (
    round.header.suite_id !== manifest.suite_id
    || round.header.manifest_fingerprint !== manifestFingerprint
    || round.header.config_fingerprint !== configFingerprint
  ) roundReasons.add('fingerprint_mismatch');

  const expectedRuns = buildExpectedRuns(manifest);
  const attemptsByRun = new Map<string, CacheBenchmarkAttempt[]>();
  const stablePrefixByRun = new Map<string, string>();
  const taskCallOrder = new Map<string, TaskCallOrder>();
  const cellByCase = new Map<string, CellAccumulator>();
  const cells = new Map<string, CellAccumulator>();
  for (const caseEntry of manifest.cases) {
    const fingerprint = fingerprintCell(caseEntry);
    let cell = cells.get(fingerprint);
    if (!cell) {
      const trafficClass = trafficClassForRole(caseEntry.execution_role);
      cell = {
        fingerprint,
        trafficClass,
        reasons: new Set(),
        input: 0,
        read: 0,
        tasks: new Map(),
        coldInput: 0,
        coldRead: 0,
        allInput: 0,
        allRead: 0,
        requestKinds: new Map((trafficClass === 'primary'
          ? ['main_inference', 'checkpoint_compaction'] as const
          : ['memory_branch_inference'] as const
        ).map(kind => [kind, emptyRequestKindTotals()])),
      };
      cells.set(fingerprint, cell);
    }
    cellByCase.set(caseEntry.case_id, cell);
  }

  const attemptIds = new Set<string>();
  const attemptNumbers = new Set<number>();
  const journalLinkageInvalidAttemptIds = validateJournalLinkage(round.attempts);
  const retryChainInvalidAttemptIds = validateTransparentRetryChains(round.attempts);
  for (let attemptIndex = 0; attemptIndex < round.attempts.length; attemptIndex += 1) {
    const attempt = round.attempts[attemptIndex];
    const expected = expectedRuns.get(runKey(attempt.case_id, attempt.run_id));
    if (!expected) {
      roundReasons.add('unknown_case_or_run');
      continue;
    }
    const cell = cellByCase.get(expected.caseEntry.case_id)!;
    if (
      attemptIds.has(attempt.attempt_id)
      || attemptNumbers.has(attempt.attempt_number)
    ) cell.reasons.add('duplicate_attempt');
    attemptIds.add(attempt.attempt_id);
    attemptNumbers.add(attempt.attempt_number);

    if (
      attempt.suite_id !== round.header.suite_id
      || attempt.round !== round.header.round
      || attempt.attempt_number !== attemptIndex + 1
      || attempt.attempt_role !== expected.caseEntry.execution_role
      || !requestKindMatchesRole(attempt, expected.caseEntry.execution_role)
      || !metadataMatches(attempt, expected.caseEntry)
      || journalLinkageInvalidAttemptIds.has(attempt.attempt_id)
    ) cell.reasons.add('metadata_mismatch');
    if (retryChainInvalidAttemptIds.has(attempt.attempt_id)) {
      cell.reasons.add('retry_chain_invalid');
    }
    if (
      attempt.outcome === 'retrying'
      && attempt.attempt_role === 'main'
      && attempt.dispatch_status !== 'not_dispatched'
    ) {
      cell.reasons.add('retry_not_provably_pre_dispatch');
    }
    const normalizedUsage = normalizeProviderUsage(attempt.usage.provider_usage);
    if (normalizedUsage.source !== undefined
      && normalizedUsage.source !== expected.caseEntry.cache_read_source) {
      cell.reasons.add('metadata_mismatch');
    }
    const key = runKey(attempt.case_id, attempt.run_id);
    const runAttempts = attemptsByRun.get(key) ?? [];
    runAttempts.push(attempt);
    attemptsByRun.set(key, runAttempts);
    const orderKey = [
      expected.caseEntry.task_id,
      attempt.run_id,
      attempt.logical_call,
    ].join('\0');
    const order = taskCallOrder.get(orderKey) ?? { cells: new Set<CellAccumulator>() };
    order.cells.add(cell);
    if (attempt.request_kind === 'memory_branch_inference') order.lastMemoryBranchIndex = attemptIndex;
    else if (
      attempt.request_kind === 'main_inference'
      && order.firstMainInferenceIndex === undefined
    ) order.firstMainInferenceIndex = attemptIndex;
    taskCallOrder.set(orderKey, order);
    scoreAttempt(attempt, cell, expected.caseEntry);
    if (attempt.request_kind === 'main_inference') {
      const stablePrefix = attempt.attestation.stable_prefix_fingerprint;
      const previousStablePrefix = stablePrefixByRun.get(key);
      if (previousStablePrefix !== undefined && previousStablePrefix !== stablePrefix) {
        cell.reasons.add('stable_prefix_drift');
      } else {
        stablePrefixByRun.set(key, stablePrefix);
      }
    }
  }

  for (const order of taskCallOrder.values()) {
    if (
      order.firstMainInferenceIndex !== undefined
      && order.lastMemoryBranchIndex !== undefined
      && order.lastMemoryBranchIndex > order.firstMainInferenceIndex
    ) {
      for (const cell of order.cells) cell.reasons.add('attempt_order_mismatch');
    }
  }

  if (buildCapabilityCoverage(manifest, round.attempts).some(entry => entry.status === 'incomplete')) {
    roundReasons.add('capability_attestation_incomplete');
  }

  for (const [key, expected] of expectedRuns) {
    const cell = cellByCase.get(expected.caseEntry.case_id)!;
    const attempts = attemptsByRun.get(key) ?? [];
    if (attempts.length === 0) {
      cell.reasons.add('missing_required_run');
      continue;
    }
    const expectedLogicalCalls = expected.requiredColdCalls + expected.requiredWarmCalls;
    const attemptsByLogicalCall = new Map<number, CacheBenchmarkAttempt[]>();
    for (const attempt of attempts) {
      const group = attemptsByLogicalCall.get(attempt.logical_call) ?? [];
      group.push(attempt);
      attemptsByLogicalCall.set(attempt.logical_call, group);
    }
    if (attempts.some((attempt, index) => (
      index > 0 && attempt.logical_call < attempts[index - 1].logical_call
    ))) {
      cell.reasons.add('attempt_order_mismatch');
    }
    for (let logicalCall = 1; logicalCall <= expectedLogicalCalls; logicalCall += 1) {
      const group = attemptsByLogicalCall.get(logicalCall) ?? [];
      if (group.length === 0) {
        cell.reasons.add(logicalCall <= expected.requiredColdCalls
          ? 'missing_cold_attempt'
          : 'missing_warm_attempt');
        continue;
      }
      const expectedClass: CacheBenchmarkAttempt['cache_class'] = logicalCall <= expected.requiredColdCalls
        ? 'cold'
        : 'warm';
      if (group.some(attempt => attempt.cache_class !== expectedClass)) {
        cell.reasons.add('metadata_mismatch');
      }
      if (expected.caseEntry.execution_role === 'main') {
        if (new Set(group
          .filter(attempt => attempt.request_kind === 'main_inference')
          .map(attempt => attempt.call_id)).size !== 1) {
          cell.reasons.add('unexpected_attempt_count');
        }
        if (group.some(attempt => (
          attempt.request_kind !== 'main_inference'
          && attempt.request_kind !== 'checkpoint_compaction'
        ))) cell.reasons.add('metadata_mismatch');
      } else {
        if (
          new Set(group
            .filter(attempt => attempt.request_kind === 'memory_branch_inference')
            .map(attempt => attempt.call_id)).size < 1
          || group.some(attempt => (
            attempt.request_kind !== 'memory_branch_inference'
            && attempt.request_kind !== 'checkpoint_compaction'
          ))
        ) cell.reasons.add('metadata_mismatch');
      }
    }
    if ([...attemptsByLogicalCall.keys()].some(logicalCall => (
      logicalCall < 1 || logicalCall > expectedLogicalCalls
    ))) {
      cell.reasons.add('unexpected_attempt_count');
    }
  }

  const cellResults = [...cells.values()]
    .map(cell => finalizeCell(cell, manifest))
    .sort((left, right) => compareStrings(left.cell_fingerprint, right.cell_fingerprint));
  for (const cell of cellResults) {
    for (const reason of cell.reasons) roundReasons.add(reason);
  }
  const status = strongestStatus([
    statusFromReasons([...roundReasons]),
    ...cellResults.map(cell => cell.status),
  ]) ?? 'passed';
  return {
    round: round.header.round,
    artifact_fingerprint: round.header.artifact_fingerprint,
    status,
    cells: cellResults,
    reasons: uniqueSorted([...roundReasons]),
  };
}

function scoreAttempt(
  attempt: CacheBenchmarkAttempt,
  cell: CellAccumulator,
  expectedCase: CacheBenchmarkCase,
): void {
  const succeeded = attempt.outcome === 'succeeded';
  if (
    (expectedCase.provider_adapter === 'openai' && !attempt.cache_strategy.startsWith('openai-'))
    || (expectedCase.provider_adapter === 'anthropic' && !attempt.cache_strategy.startsWith('anthropic-'))
  ) cell.reasons.add('metadata_mismatch');
  if (attempt.outcome === 'incomplete') {
    cell.reasons.add('non_terminal_attempt');
  } else if (!succeeded && attempt.outcome !== 'retrying') {
    cell.reasons.add('non_succeeded_attempt');
  }
  const attestation = attempt.attestation;
  if (attestation.safety_status === 'failed') cell.reasons.add('safety_gate_failed');
  if (attestation.safety_status === 'unobservable') cell.reasons.add('safety_gate_unobservable');
  if (attempt.request_kind !== 'checkpoint_compaction') {
    if (attestation.quality_status === 'failed') cell.reasons.add('quality_gate_failed');
    if (attestation.quality_status === 'unobservable') cell.reasons.add('quality_gate_unobservable');
    if (attestation.oracle_contract_fingerprint !== expectedCase.oracle_contract_fingerprint) {
      cell.reasons.add('oracle_contract_mismatch');
    }
    if (attestation.execution_plan_fingerprint !== expectedCase.execution_plan_fingerprint) {
      cell.reasons.add('execution_plan_mismatch');
    }
    const observed = new Set(attestation.observed_capabilities);
    if (expectedCase.capabilities.some(capability => !observed.has(capability))) {
      cell.reasons.add('capability_attestation_incomplete');
    }
  }
  if (attempt.outcome === 'retrying') return;
  const usage = normalizeProviderUsage(attempt.usage.provider_usage);
  const auxiliaryMemory = attempt.request_origin === 'memory_branch';
  if (usage.input === undefined) {
    if (!auxiliaryMemory) cell.reasons.add('missing_input_usage');
    return;
  }
  if (usage.input <= 0) {
    cell.reasons.add('non_positive_input');
    return;
  }
  const read = usage.read;
  if (read === undefined) {
    if (!auxiliaryMemory) cell.reasons.add('cache_read_not_reported');
    return;
  }
  if (read < 0) {
    cell.reasons.add('invalid_cache_read');
    return;
  }
  if (read > usage.input) {
    cell.reasons.add('cache_read_exceeds_input');
    return;
  }
  cell.allInput += usage.input;
  cell.allRead += read;
  const kindTotals = cell.requestKinds.get(attempt.request_kind)
    ?? emptyRequestKindTotals();
  kindTotals.allInput += usage.input;
  kindTotals.allRead += read;
  cell.requestKinds.set(attempt.request_kind, kindTotals);
  if (attempt.cache_class === 'cold') {
    cell.coldInput += usage.input;
    cell.coldRead += read;
    kindTotals.coldInput += usage.input;
    kindTotals.coldRead += read;
    return;
  }
  cell.input += usage.input;
  cell.read += read;
  kindTotals.input += usage.input;
  kindTotals.read += read;
  const task = cell.tasks.get(attempt.metadata.task_id) ?? { input: 0, read: 0 };
  task.input += usage.input;
  task.read += read;
  cell.tasks.set(attempt.metadata.task_id, task);
}

function normalizeProviderUsage(usage: CacheBenchmarkAttempt['usage']['provider_usage']): {
  input?: number;
  read?: number;
  source?: CacheReadSource;
} {
  if (!usage) return {};
  switch (usage.contract) {
    case 'openai-responses-v1':
      return {
        input: usage.input_tokens,
        read: usage.cached_tokens,
        ...(usage.cached_tokens === undefined
          ? {}
          : { source: 'openai.input_tokens_details.cached_tokens' }),
      };
    case 'openai-chat-v1':
      return {
        input: usage.prompt_tokens,
        read: usage.cached_tokens,
        ...(usage.cached_tokens === undefined
          ? {}
          : { source: 'openai.prompt_tokens_details.cached_tokens' }),
      };
    case 'deepseek-chat-v1':
      return {
        input: usage.prompt_tokens,
        read: usage.prompt_cache_hit_tokens,
        ...(usage.prompt_cache_hit_tokens === undefined
          ? {}
          : { source: 'deepseek.prompt_cache_hit_tokens' }),
      };
    case 'anthropic-messages-v1':
      return {
        input: usage.input_tokens === undefined
          || usage.cache_read_input_tokens === undefined
          || usage.cache_creation_input_tokens === undefined
          ? undefined
          : usage.input_tokens
            + usage.cache_read_input_tokens
            + usage.cache_creation_input_tokens,
        read: usage.cache_read_input_tokens,
        ...(usage.cache_read_input_tokens === undefined
          ? {}
          : { source: 'anthropic.cache_read_input_tokens' }),
      };
  }
}

function finalizeCell(cell: CellAccumulator, manifest: CacheBenchmarkManifest): CacheBenchmarkCellResult {
  const reasons = new Set(cell.reasons);
  const positiveTasks = [...cell.tasks.values()].filter(task => task.input > 0);
  let rawRatio: number | null = null;
  let cappedRatio: number | null = null;
  const coldRatio = cell.coldInput > 0 ? cell.coldRead / cell.coldInput : null;
  const allInput = cell.allInput;
  const allRead = cell.allRead;
  const allRatio = allInput > 0 ? allRead / allInput : null;
  if (cell.input > 0) {
    rawRatio = cell.read / cell.input;
    if (
      cell.trafficClass === manifest.criteria.qualification_traffic_class
      && !meetsThreshold(rawRatio, manifest.criteria.minimum_read_ratio)
    ) {
      reasons.add('minimum_read_ratio_not_met');
    }
  }
  if (positiveTasks.length >= Math.ceil(1 / manifest.criteria.maximum_task_weight)) {
    cappedRatio = calculateCappedTaskRatio(positiveTasks, manifest.criteria.maximum_task_weight);
    if (
      cell.trafficClass === manifest.criteria.qualification_traffic_class
      && !meetsThreshold(cappedRatio, manifest.criteria.minimum_read_ratio)
    ) {
      reasons.add('minimum_capped_task_ratio_not_met');
    }
  } else if (cell.trafficClass === manifest.criteria.qualification_traffic_class) {
    reasons.add('insufficient_positive_tasks');
  }
  return {
    cell_fingerprint: cell.fingerprint,
    traffic_class: cell.trafficClass,
    status: statusFromReasons([...reasons]),
    qualification_cache_class: 'warm',
    input_tokens: cell.input,
    cache_read_tokens: cell.read,
    raw_read_ratio: rawRatio,
    capped_task_ratio: cappedRatio,
    positive_task_count: positiveTasks.length,
    cold_input_tokens: cell.coldInput,
    cold_cache_read_tokens: cell.coldRead,
    cold_read_ratio: coldRatio,
    all_input_tokens: allInput,
    all_cache_read_tokens: allRead,
    all_read_ratio: allRatio,
    request_kind_usage: [...cell.requestKinds.entries()]
      .map(([requestKind, usage]) => ({
        request_kind: requestKind,
        input_tokens: usage.input,
        cache_read_tokens: usage.read,
        cold_input_tokens: usage.coldInput,
        cold_cache_read_tokens: usage.coldRead,
        all_input_tokens: usage.allInput,
        all_cache_read_tokens: usage.allRead,
      }))
      .sort((left, right) => compareStrings(left.request_kind, right.request_kind)),
    reasons: uniqueSorted([...reasons]),
  };
}

function emptyRequestKindTotals(): RequestKindTotals {
  return {
    input: 0,
    read: 0,
    coldInput: 0,
    coldRead: 0,
    allInput: 0,
    allRead: 0,
  };
}

export function calculateCappedTaskRatio(tasks: TaskTotals[], maximumWeight: number): number {
  const positive = tasks.filter(task => task.input > 0);
  if (positive.length === 0 || positive.length * maximumWeight < 1 - 1e-12) return Number.NaN;
  let low = 0;
  let high = 1;
  while (sumProjectedWeights(positive, high, maximumWeight) < 1) high *= 2;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const middle = (low + high) / 2;
    if (sumProjectedWeights(positive, middle, maximumWeight) < 1) low = middle;
    else high = middle;
  }
  const weights = positive.map(task => Math.min(maximumWeight, high * task.input));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  return positive.reduce((sum, task, index) => {
    return sum + (weights[index] / totalWeight) * (task.read / task.input);
  }, 0);
}

function sumProjectedWeights(tasks: TaskTotals[], scale: number, cap: number): number {
  return tasks.reduce((sum, task) => sum + Math.min(cap, scale * task.input), 0);
}

function buildExpectedRuns(manifest: CacheBenchmarkManifest): Map<string, ExpectedRun> {
  const result = new Map<string, ExpectedRun>();
  for (const caseEntry of manifest.cases) {
    for (const run of caseEntry.runs) {
      result.set(runKey(caseEntry.case_id, run.run_id), {
        caseEntry,
        requiredColdCalls: run.required_cold_calls,
        requiredWarmCalls: run.required_warm_calls,
      });
    }
  }
  return result;
}

function metadataMatches(attempt: CacheBenchmarkAttempt, expected: CacheBenchmarkCase): boolean {
  const actual = attempt.metadata;
  return actual.provider_instance_id === expected.provider_instance_id
    && actual.provider_adapter === expected.provider_adapter
    && actual.model === expected.model
    && actual.api_type === expected.api_type
    && actual.surface === expected.surface
    && actual.task_id === expected.task_id
    && actual.task_fixture_fingerprint === expected.task_fixture_fingerprint
    && actual.scenario_family === expected.scenario_family
    && actual.session_type === expected.session_type;
}

function fingerprintCell(caseEntry: CacheBenchmarkCase): string {
  return fingerprintCanonical({
    provider_instance_id: caseEntry.provider_instance_id,
    provider_adapter: caseEntry.provider_adapter,
    model: caseEntry.model,
    api_type: caseEntry.api_type,
    surface: caseEntry.surface,
    traffic_class: trafficClassForRole(caseEntry.execution_role),
  });
}

function buildCapabilityCoverage(
  manifest: CacheBenchmarkManifest,
  attempts: readonly CacheBenchmarkAttempt[],
): CacheBenchmarkCoverageResult[] {
  const scopes = new Map<string, {
    trafficClass: CacheBenchmarkTrafficClass;
    required: Set<CacheBenchmarkCapability>;
    observed: Set<CacheBenchmarkCapability>;
  }>();
  for (const entry of manifest.cases) {
    const trafficClass = trafficClassForRole(entry.execution_role);
    const scopeFingerprint = fingerprintCanonical({
      provider_instance_id: entry.provider_instance_id,
      provider_adapter: entry.provider_adapter,
      model: entry.model,
      api_type: entry.api_type,
      traffic_class: trafficClass,
    });
    let scope = scopes.get(scopeFingerprint);
    if (!scope) {
      scope = {
        trafficClass,
        required: new Set(trafficClass === 'primary'
          ? REQUIRED_CACHE_BENCHMARK_CAPABILITIES
          : []),
        observed: new Set(),
      };
      scopes.set(scopeFingerprint, scope);
    }
    if (trafficClass === 'auxiliary_memory') {
      for (const capability of entry.capabilities) scope.required.add(capability);
    }
  }
  const cases = new Map(manifest.cases.map(entry => [entry.case_id, entry]));
  for (const attempt of attempts) {
    const entry = cases.get(attempt.case_id);
    if (!entry) continue;
    const trafficClass = trafficClassForRole(entry.execution_role);
    const scopeFingerprint = fingerprintCanonical({
      provider_instance_id: entry.provider_instance_id,
      provider_adapter: entry.provider_adapter,
      model: entry.model,
      api_type: entry.api_type,
      traffic_class: trafficClass,
    });
    const scope = scopes.get(scopeFingerprint)!;
    if (
      attempt.request_kind !== 'main_inference'
      && attempt.request_kind !== 'memory_branch_inference'
    ) continue;
    for (const capability of attempt.attestation.observed_capabilities) {
      scope.observed.add(capability);
    }
  }
  return [...scopes.entries()]
    .map(([scopeFingerprint, scope]) => {
      const missing = REQUIRED_CACHE_BENCHMARK_CAPABILITIES.filter(capability => (
        scope.required.has(capability) && !scope.observed.has(capability)
      ));
      return {
        scope_fingerprint: scopeFingerprint,
        traffic_class: scope.trafficClass,
        status: missing.length === 0 ? 'passed' as const : 'incomplete' as const,
        missing_capabilities: [...missing],
      };
    })
    .sort((left, right) => compareStrings(left.scope_fingerprint, right.scope_fingerprint));
}

function requestKindMatchesRole(
  attempt: CacheBenchmarkAttempt,
  role: CacheBenchmarkCase['execution_role'],
): boolean {
  return role === 'main'
    ? attempt.request_origin === 'main'
      && (attempt.request_kind === 'main_inference'
        || attempt.request_kind === 'checkpoint_compaction')
    : attempt.request_origin === 'memory_branch'
      && (attempt.request_kind === 'memory_branch_inference'
        || attempt.request_kind === 'checkpoint_compaction');
}

function validateJournalLinkage(
  attempts: readonly CacheBenchmarkAttempt[],
): Set<string> {
  const invalidAttemptIds = new Set<string>();
  const groups = new Map<string, CacheBenchmarkAttempt[]>();
  for (const attempt of attempts) {
    const key = [
      attempt.metadata.task_id,
      attempt.run_id,
      attempt.logical_call,
    ].join('\0');
    groups.set(key, [...(groups.get(key) ?? []), attempt]);
  }
  for (const group of groups.values()) {
    let valid = true;
    let previousStartedSequence = 0;
    const sessionsByOrigin = new Map<string, string>();
    const lifecycleFingerprints = new Set<string>();
    const records: Array<{ sequence: number; previous: string; fingerprint: string }> = [];
    for (const attempt of group) {
      if (attempt.journal_started_sequence <= previousStartedSequence) valid = false;
      previousStartedSequence = attempt.journal_started_sequence;
      const priorSession = sessionsByOrigin.get(attempt.request_origin);
      if (priorSession !== undefined && priorSession !== attempt.session_fingerprint) valid = false;
      sessionsByOrigin.set(attempt.request_origin, attempt.session_fingerprint);
      if (lifecycleFingerprints.has(attempt.journal_lifecycle_fingerprint)) valid = false;
      lifecycleFingerprints.add(attempt.journal_lifecycle_fingerprint);
      records.push({
        sequence: attempt.journal_started_sequence,
        previous: attempt.journal_started_previous_record_fingerprint,
        fingerprint: attempt.journal_started_record_fingerprint,
      });
      if (attempt.journal_terminal_sequence !== undefined) {
        if (
          attempt.journal_terminal_previous_record_fingerprint === undefined
          || attempt.journal_terminal_record_fingerprint === undefined
        ) {
          valid = false;
        } else {
          records.push({
            sequence: attempt.journal_terminal_sequence,
            previous: attempt.journal_terminal_previous_record_fingerprint,
            fingerprint: attempt.journal_terminal_record_fingerprint,
          });
        }
      }
    }
    records.sort((left, right) => left.sequence - right.sequence);
    const recordFingerprints = new Set<string>();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const expectedPrevious = index === 0
        ? `sha256:${'0'.repeat(64)}`
        : records[index - 1].fingerprint;
      if (
        record.sequence !== index + 1
        || record.previous !== expectedPrevious
        || recordFingerprints.has(record.fingerprint)
      ) valid = false;
      recordFingerprints.add(record.fingerprint);
    }
    if (!valid) {
      for (const attempt of group) invalidAttemptIds.add(attempt.attempt_id);
    }
  }
  return invalidAttemptIds;
}

function validateTransparentRetryChains(
  attempts: readonly CacheBenchmarkAttempt[],
): Set<string> {
  const invalidAttemptIds = new Set<string>();
  const chains = new Map<string, CacheBenchmarkAttempt[]>();
  for (const attempt of attempts) {
    chains.set(attempt.call_id, [...(chains.get(attempt.call_id) ?? []), attempt]);
  }
  for (const chain of chains.values()) {
    let valid = chain.length >= 1 && chain.length <= 2;
    const immutable = retryRequestFingerprint(chain[0]);
    for (let index = 0; index < chain.length; index += 1) {
      const attempt = chain[index];
      const final = index === chain.length - 1;
      if (
        attempt.provider_attempt_number !== index + 1
        || retryRequestFingerprint(attempt) !== immutable
      ) valid = false;
      if (final) {
        if (
          attempt.outcome !== 'succeeded'
          || attempt.retry_number !== undefined
          || attempt.retry_stop_reason !== undefined
          || attempt.retry_recovery_action !== undefined
        ) valid = false;
      } else if (
        attempt.outcome !== 'retrying'
        || attempt.retry_number !== attempt.provider_attempt_number
        || attempt.retry_stop_reason !== undefined
        || attempt.retry_recovery_action !== undefined
        || attempt.usage.provider_usage !== undefined
      ) valid = false;
    }
    if (!valid) {
      for (const attempt of chain) invalidAttemptIds.add(attempt.attempt_id);
    }
  }
  return invalidAttemptIds;
}

function retryRequestFingerprint(attempt: CacheBenchmarkAttempt): string {
  return fingerprintCanonical({
    suite_id: attempt.suite_id,
    round: attempt.round,
    attempt_role: attempt.attempt_role,
    request_kind: attempt.request_kind,
    request_origin: attempt.request_origin,
    cache_strategy: attempt.cache_strategy,
    tools_count: attempt.tools_count,
    tools_fingerprint: attempt.tools_fingerprint,
    session_fingerprint: attempt.session_fingerprint,
    logical_call: attempt.logical_call,
    case_id: attempt.case_id,
    run_id: attempt.run_id,
    metadata: attempt.metadata,
    cache_class: attempt.cache_class,
    attestation: attempt.attestation,
  });
}

function trafficClassForRole(role: CacheBenchmarkCase['execution_role']): CacheBenchmarkTrafficClass {
  return role === 'main' ? 'primary' : 'auxiliary_memory';
}

function runKey(caseId: string, runId: string): string {
  return `${caseId}\0${runId}`;
}

function latestPassingSuffix(rounds: CacheBenchmarkRoundResult[]): CacheBenchmarkRoundResult[] {
  if (rounds.length === 0) return [];
  const result: CacheBenchmarkRoundResult[] = [];
  const latest = rounds[rounds.length - 1];
  let expectedRound = latest.round;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const candidate = rounds[index];
    if (candidate.round !== expectedRound) break;
    if (candidate.artifact_fingerprint !== latest.artifact_fingerprint) break;
    if (candidate.status !== 'passed') break;
    result.unshift(candidate);
    expectedRound -= 1;
  }
  return result;
}

function statusFromReasons(reasons: BenchmarkReason[]): BenchmarkStatus {
  if (reasons.some(isInvalidReason)) return 'invalid';
  if (reasons.some(reason => reason === 'missing_input_usage'
    || reason === 'cache_read_not_reported'
    || reason === 'quality_gate_unobservable'
    || reason === 'safety_gate_unobservable')) return 'unobservable';
  if (reasons.some(reason => reason === 'insufficient_positive_tasks'
    || reason === 'calibration_only'
    || reason === 'capability_coverage_incomplete'
    || reason === 'capability_attestation_incomplete')) {
    return 'incomplete';
  }
  if (reasons.some(reason => reason === 'minimum_read_ratio_not_met'
    || reason === 'minimum_capped_task_ratio_not_met'
    || reason === 'quality_gate_failed'
    || reason === 'safety_gate_failed')) {
    return 'failed';
  }
  return 'passed';
}

function isInvalidReason(reason: BenchmarkReason): boolean {
  return [
    'schema_invalid',
    'duplicate_round',
    'duplicate_attempt',
    'attempt_order_mismatch',
    'unexpected_attempt_count',
    'retry_chain_invalid',
    'retry_not_provably_pre_dispatch',
    'unknown_case_or_run',
    'metadata_mismatch',
    'missing_required_run',
    'missing_cold_attempt',
    'missing_warm_attempt',
    'non_terminal_attempt',
    'non_succeeded_attempt',
    'non_positive_input',
    'invalid_cache_read',
    'cache_read_exceeds_input',
    'oracle_contract_mismatch',
    'execution_plan_mismatch',
    'stable_prefix_drift',
    'fingerprint_mismatch',
  ].includes(reason);
}

function strongestStatus(statuses: BenchmarkStatus[]): BenchmarkStatus | undefined {
  return statuses.reduce<BenchmarkStatus | undefined>((strongest, status) => {
    if (!strongest || STATUS_PRECEDENCE[status] > STATUS_PRECEDENCE[strongest]) return status;
    return strongest;
  }, undefined);
}

function meetsThreshold(value: number, threshold: number): boolean {
  // The capped task ratio is produced by an iterative water-filling calculation.
  // Keep the acceptance tolerance aligned with that calculation's 1e-12
  // feasibility tolerance so an exact mathematical boundary is not rejected by
  // accumulated IEEE-754 rounding across many tasks.
  return value >= threshold || Math.abs(value - threshold) <= 1e-12;
}

function uniqueSorted<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function buildResult(input: {
  manifestFingerprint: string;
  configFingerprint: string;
  ledgerFingerprint: string;
  rounds: CacheBenchmarkRoundResult[];
  capabilityCoverage: CacheBenchmarkCoverageResult[];
  status: BenchmarkStatus;
  reasons: BenchmarkReason[];
  ledgerReasons: CacheBenchmarkLedgerReason[];
  qualifyingRounds: number[];
}): CacheBenchmarkResult {
  const exitCode: 0 | 1 | 2 = input.status === 'passed'
    ? 0
    : input.status === 'invalid' || input.status === 'unobservable'
      ? 2
      : 1;
  return {
    schema: CACHE_BENCHMARK_RESULT_SCHEMA,
    status: input.status,
    exit_code: exitCode,
    manifest_fingerprint: input.manifestFingerprint,
    config_fingerprint: input.configFingerprint,
    ledger_fingerprint: input.ledgerFingerprint,
    latest_round: input.rounds.length > 0 ? input.rounds[input.rounds.length - 1].round : null,
    qualifying_rounds: input.qualifyingRounds,
    rounds: input.rounds,
    reasons: uniqueSorted(input.reasons),
    ledger_reasons: uniqueSorted(input.ledgerReasons),
    capability_coverage: input.capabilityCoverage,
  };
}
