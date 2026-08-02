import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatResponse, Message } from '../types';
import type {
  ExecutionScope,
  ScopedDeviceGrant,
  ScopedDeviceSelection,
  SessionRoute,
} from '../types/session-identity';
import type { ToolCall, ToolDefinition, ToolResult, TargetRoute, TargetRoutes } from '../types/tool';
import type {
  AIRequestOptions,
  StreamCallbacks,
} from '../providers/provider';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { createAdapterRuntime } from '../runtime/adapter-runtime';
import { MessageSessionManager } from '../core/message-session-manager';
import { SubAgentManager } from '../core/sub-agent-manager';
import { withModelAttemptSink } from '../observability/model-attempt-scope';
import type { ObservationBranchCompletion } from '../core/observation-branch-session';
import {
  fingerprintMemoryReadResult,
  MemoryLogStore,
  type MemoryReadResult,
} from '../core/memory-log-store';
import {
  BENCHMARK_IDENTITY_MARKER,
  BENCHMARK_RECOVERY_MARKER,
  AttemptCapabilityAttestor,
} from './capability-attestor';
import {
  fingerprintCanonical,
  fingerprintConfig,
  fingerprintManifest,
} from './canonical';
import { CacheBenchmarkEvidenceStore } from './evidence-store';
import {
  loadOnlineProviderCredentials,
  type OnlineProviderAlias,
  type OnlineProviderCredential,
} from './online-credentials';
import { fingerprintOnlineBenchmarkArtifact } from './online-artifact';
import { OnlineBenchmarkRunLease } from './online-run-lease';
import {
  createSealedMemoryFixture,
  type SealedMemoryFixture,
} from './sealed-memory-fixture';
import {
  StrictAttemptJournal,
  type AttemptJournalRecord,
} from './strict-attempt-journal';
import {
  CACHE_BENCHMARK_ATTEMPT_SCHEMA,
  CACHE_BENCHMARK_MANIFEST_SCHEMA,
  CACHE_BENCHMARK_ROUND_SCHEMA,
  type AttemptOutcome,
  type CacheBenchmarkAttempt,
  type CacheBenchmarkAttemptRole,
  type CacheBenchmarkCapability,
  type CacheBenchmarkCase,
  type CacheBenchmarkManifest,
  type CacheBenchmarkRoundEvidence,
  type CacheClass,
  type CacheReadSource,
} from './types';

const RUN_ID = 'run-1';
const ORACLE_PROTOCOL = 'Return exactly the expected single ASCII token and do not call tools.';
const DEEPSEEK_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_MAX_OUTPUT_TOKENS = 64;
const BENCHMARK_PARTITION_MARKER = '[cache_benchmark_partition:v1]';
const MEMORY_ONLY_WORKLOAD_ID = 'unsafe-action-gate';
const MEMORY_FIXTURE_REF = 'cache-benchmark/2026-01-01/memory-fixtures.jsonl#1';
const MEMORY_ACTION_ID = 'CACHE-BENCH-ACTION-7F0';
const MEMORY_BRANCH_ALLOWED_TOOLS = [
  'memory_search',
  'memory_read_turn',
  'memory_neighbors',
  'finish_memory_search',
] as const;

export interface OnlineCacheBenchmarkOptions {
  credentialPath: string;
  outputDirectory: string;
  runtimeDataDirectory: string;
  skillsDirectory: string;
  artifactRootDirectory: string;
  expectedArtifactFingerprint: string;
  provider: OnlineProviderAlias;
  round: number;
  warmCalls: number;
  onProgress?: (progress: OnlineCacheBenchmarkProgress) => void;
}

export interface OnlineCacheBenchmarkProgress {
  provider: OnlineProviderAlias;
  caseId: string;
  cacheClass: CacheClass;
  logicalCall: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheReadSource?: string;
  qualityPassed: boolean;
  safetyPassed: boolean;
}

export interface OnlineCacheBenchmarkRunResult {
  manifest: CacheBenchmarkManifest;
  evidence: CacheBenchmarkRoundEvidence;
  manifestPath: string;
  ledgerPath: string;
  evidencePath: string;
}

interface BenchmarkWorkload {
  id: string;
  scenarioFamily: string;
  fixture: string;
  prompt: string;
  oracle: string;
  capabilities: CacheBenchmarkCapability[];
}

const WORKLOADS: readonly BenchmarkWorkload[] = [
  {
    id: 'package-manager-detection',
    scenarioFamily: 'repository-orientation',
    fixture: '{"scripts":{"test":"node --test"},"packageManager":"npm@10.8.2"}',
    prompt: 'Inspect the restored package fixture. Return exactly CACHE_BENCH_NPM if its package manager is npm. Do not call tools.',
    oracle: 'CACHE_BENCH_NPM',
    capabilities: ['identity', 'group-chat-participants', 'device-authorization'],
  },
  {
    id: 'test-failure-count',
    scenarioFamily: 'test-triage',
    fixture: 'test summary: passed=18 failed=2 skipped=1',
    prompt: 'Inspect the restored test summary. Return exactly CACHE_BENCH_TWO if failed equals 2. Do not call tools.',
    oracle: 'CACHE_BENCH_TWO',
    capabilities: ['tools', 'skills', 'plan'],
  },
  {
    id: 'unsafe-action-gate',
    scenarioFamily: 'safety-review',
    fixture: `restored action record id=${MEMORY_ACTION_ID}; classification and prior decision remain only in the archived memory record`,
    prompt: `Use the joined memory observation for action record ${MEMORY_ACTION_ID}. Return only its stored prior decision token. Do not infer a token and do not call tools.`,
    oracle: 'ARCHIVED_ACTION_DENY',
    capabilities: ['goal', 'subagent', 'memory'],
  },
  {
    id: 'plan-next-step',
    scenarioFamily: 'implementation-planning',
    fixture: 'status: implementation complete; focused tests not yet run; commit not created',
    prompt: 'Inspect the restored status. Return exactly CACHE_BENCH_TEST because focused tests are the next step. Do not call tools.',
    oracle: 'CACHE_BENCH_TEST',
    capabilities: ['runtime-feedback', 'session-recovery'],
  },
] as const;

export async function runOnlineCacheBenchmark(
  options: OnlineCacheBenchmarkOptions,
): Promise<OnlineCacheBenchmarkRunResult> {
  validateOptions(options);
  assertBootstrappedRuntimePaths(options);
  prepareBenchmarkSkill(options.skillsDirectory);
  const credential = loadOnlineProviderCredentials(options.credentialPath)
    .find(candidate => candidate.alias === options.provider);
  if (!credential) throw new Error('provider_contract_missing');
  const artifactFingerprint = fingerprintOnlineBenchmarkArtifact(options.artifactRootDirectory);
  if (artifactFingerprint !== options.expectedArtifactFingerprint) {
    throw new Error('artifact_drift_before_run');
  }
  const cachePartitionNonce = randomBytes(16).toString('hex');
  const workingDirectory = prepareSyntheticWorkspace(options.runtimeDataDirectory);
  const memoryFixture = prepareMemoryFixtures(workingDirectory, cachePartitionNonce);

  const manifest = buildOnlineCacheBenchmarkManifest(
    credential,
    options.warmCalls,
    memoryFixture.fixtureFingerprint,
  );
  const manifestFingerprint = fingerprintManifest(manifest);
  const configFingerprint = fingerprintConfig(manifest);
  const casesById = new Map(manifest.cases.map(entry => [entry.case_id, entry]));
  const attempts: CacheBenchmarkAttempt[] = [];
  let attemptNumber = 0;
  const lease = new OnlineBenchmarkRunLease({
    directory: options.outputDirectory,
    suiteId: manifest.suite_id,
    round: options.round,
    artifactFingerprint,
    manifestFingerprint,
    configFingerprint,
    cachePartitionNonce,
  });

  try {
    const store = new CacheBenchmarkEvidenceStore(options.outputDirectory);
    store.writeManifest(manifest);
    await withBenchmarkEnvironment(async () => {
      const runtime = createAdapterRuntime({
        surface: 'catscompany',
        workingDirectory,
        promptSnapshotMode: 'fixed',
        skillLoadMode: 'fail-fast',
      });
      const aiService = createOnlineAIService(credential);
      runtime.services.aiService = aiService;
      runtime.services.toolManager = new BenchmarkDenyToolManager(workingDirectory);
      runtime.services.memoryBranch = {
        enabled: false,
        modelSource: 'inherit',
        aiService,
        memoryLogStore: new MemoryLogStore(workingDirectory, {
          sealedSource: memoryFixture,
        }),
      };
      await runtime.loadSkills();

      for (const workload of WORKLOADS) {
        const mainCase = casesById.get(caseIdFor(credential.alias, workload.id, 'main'));
        const memoryCase = casesById.get(caseIdFor(credential.alias, workload.id, 'memory_branch'));
        if (!mainCase || !memoryCase) {
          throw new Error('manifest_case_missing');
        }
        runtime.services.memoryBranch = {
          enabled: true,
          modelSource: 'inherit',
          aiService,
          completionPolicy: 'join-before-primary',
          cachePartitionKey: [memoryCase.case_id, options.round, cachePartitionNonce].join(':'),
          trustedSystemPrefix: buildBenchmarkPartitionMarker(
            memoryCase.case_id,
            options.round,
            cachePartitionNonce,
          ) + '\n'
            + 'This sealed benchmark authorizes only canonical refs under '
            + 'cache-benchmark/2026-01-01/memory-fixtures.jsonl. Ignore every other memory ref. '
            + 'If no authorized record is relevant, finish with inject:false and empty refs.',
          memoryLogStore: new MemoryLogStore(workingDirectory, {
            sealedSource: memoryFixture,
          }),
        };
        const logicalCalls = 1 + options.warmCalls;
        for (let logicalCall = 0; logicalCall < logicalCalls; logicalCall += 1) {
          const cacheClass: CacheClass = logicalCall === 0 ? 'cold' : 'warm';
          memoryFixture.assertUntampered();
          let result: Awaited<ReturnType<typeof runLogicalCall>>;
          try {
            result = await runLogicalCall({
              runtime,
              credential,
              workload,
              mainCase,
              memoryExpected: true,
              memoryPublicationRequired: workload.capabilities.includes('memory'),
              expectedMemoryReadFingerprint: expectedMemoryFixtureReadFingerprint(),
              cacheClass,
              logicalCall,
              round: options.round,
              cachePartitionNonce,
              outputDirectory: options.outputDirectory,
              workingDirectory,
            });
          } finally {
            memoryFixture.assertUntampered();
          }
          for (const physical of result.attempts) {
            const attemptRole = result.attestor.getRole(physical.attempt_id);
            attempts.push(toBenchmarkAttempt({
              manifest,
              benchmarkCase: attemptRole === 'main' ? mainCase : memoryCase,
              physical,
              attestor: result.attestor,
              round: options.round,
              attemptNumber: ++attemptNumber,
              attemptRole,
              logicalCall: logicalCall + 1,
              cacheClass,
              qualityPassed: attemptRole === 'main'
                ? result.mainQualityPassed
                : result.memoryQualityPassed,
              safetyPassed: result.safetyPassed,
            }));
          }
          const terminal = result.mainAttempts[result.mainAttempts.length - 1];
          options.onProgress?.({
            provider: credential.alias,
            caseId: mainCase.case_id,
            cacheClass,
            logicalCall: logicalCall + 1,
            inputTokens: terminal?.input_tokens,
            cacheReadTokens: terminal?.cache_read_tokens,
            cacheReadSource: terminal?.cache_read_source,
            qualityPassed: result.mainQualityPassed && result.memoryQualityPassed,
            safetyPassed: result.safetyPassed,
          });
        }
      }
    });

    if (fingerprintOnlineBenchmarkArtifact(options.artifactRootDirectory) !== artifactFingerprint) {
      throw new Error('artifact_drift_during_round');
    }
    memoryFixture.assertUntampered();
    const evidence: CacheBenchmarkRoundEvidence = {
      header: {
        schema: CACHE_BENCHMARK_ROUND_SCHEMA,
        suite_id: manifest.suite_id,
        round: options.round,
        cache_partition_nonce: cachePartitionNonce,
        artifact_fingerprint: artifactFingerprint,
        manifest_fingerprint: manifestFingerprint,
        config_fingerprint: configFingerprint,
      },
      attempts,
    };
    const sealed = store.sealRound(manifest, evidence);
    memoryFixture.assertUntampered();
    lease.complete(sealed.evidenceFingerprint);
    return {
      manifest,
      evidence,
      manifestPath: sealed.manifestPath,
      ledgerPath: sealed.ledgerPath,
      evidencePath: sealed.evidencePath,
    };
  } finally {
    lease.close();
    memoryFixture.close();
  }
}

export function buildOnlineCacheBenchmarkManifest(
  credential: OnlineProviderCredential,
  warmCalls: number,
  memoryFixtureFingerprint = fingerprintCanonical({ source: buildMemoryFixtureSource() }),
): CacheBenchmarkManifest {
  const cases: CacheBenchmarkCase[] = WORKLOADS.flatMap(workload => {
    const shared = {
      provider_instance_id: providerInstanceId(credential),
      provider_adapter: credential.providerAdapter,
      model: credential.model,
      api_type: credential.apiType,
      surface: 'catscompany',
      task_id: workload.id,
      task_fixture_fingerprint: fingerprintCanonical({
        fixture: workload.fixture,
        memory_fixture: memoryFixtureFor(workload),
        memory_fixture_file: memoryFixtureFingerprint,
      }),
      cache_read_source: credential.cacheReadSource,
      scenario_family: workload.scenarioFamily,
      session_type: 'catscompany',
      runs: [{
        run_id: RUN_ID,
        required_cold_calls: 1 as const,
        required_warm_calls: warmCalls,
      }],
    };
    const executionPlan = {
      version: 2,
      path: [
        'createAdapterRuntime',
        'MessageSessionManager.bootstrap',
        'AgentSession.appendDurableContext',
        'MessageSessionManager.destroy',
        'MessageSessionManager.restore',
        'AgentSession.updateGoal',
        'SubAgentManager.active-status',
        'MemorySearchBranchSession.join-before-primary',
        'AgentSession.handleRuntimeObservation',
      ],
      retries: 0,
      maxOutputTokens: maxOutputTokensFor(credential.alias),
      reasoningMode: 'provider-default',
      cachePartition: 'case-round-and-reserved-run-nonce-system-prefix-v3',
    };
    const mainCase: CacheBenchmarkCase = {
      ...shared,
      case_id: caseIdFor(credential.alias, workload.id, 'main'),
      oracle_contract_fingerprint: fingerprintCanonical({
        protocol: ORACLE_PROTOCOL,
        oracle: workload.oracle,
        ...(workload.capabilities.includes('memory') ? {
          memory_ref: MEMORY_FIXTURE_REF,
          memory_read_fingerprint: expectedMemoryFixtureReadFingerprint(),
        } : {}),
      }),
      execution_plan_fingerprint: fingerprintCanonical({ ...executionPlan, role: 'main' }),
      execution_role: 'main' as const,
      capabilities: [...workload.capabilities],
    };
    return [mainCase, {
      ...shared,
      case_id: caseIdFor(credential.alias, workload.id, 'memory_branch'),
      oracle_contract_fingerprint: fingerprintCanonical({
        protocol: workload.capabilities.includes('memory')
          ? 'Publish one evidence-backed memory observation with canonical refs.'
          : 'Complete the real memory branch and either publish useful evidence or explicitly suppress a redundant result.',
        allowedTools: MEMORY_BRANCH_ALLOWED_TOOLS,
      }),
      execution_plan_fingerprint: fingerprintCanonical({ ...executionPlan, role: 'memory_branch' }),
      execution_role: 'memory_branch' as const,
      capabilities: workload.capabilities.includes('memory')
        ? ['tools', 'memory'] as CacheBenchmarkCapability[]
        : ['tools'] as CacheBenchmarkCapability[],
    }];
  });
  return {
    schema: CACHE_BENCHMARK_MANIFEST_SCHEMA,
    suite_id: `xiaoba-online-${credential.alias}-v3`,
    criteria: {
      minimum_read_ratio: 0.94,
      consecutive_rounds: 3,
      maximum_task_weight: 0.25,
      include_cold_in_primary_ratio: false,
    },
    cases,
  };
}

async function runLogicalCall(input: {
  runtime: ReturnType<typeof createAdapterRuntime>;
  credential: OnlineProviderCredential;
  workload: BenchmarkWorkload;
  mainCase: CacheBenchmarkCase;
  memoryExpected: boolean;
  memoryPublicationRequired: boolean;
  expectedMemoryReadFingerprint: string;
  cacheClass: CacheClass;
  logicalCall: number;
  round: number;
  cachePartitionNonce: string;
  outputDirectory: string;
  workingDirectory: string;
}): Promise<{
  attempts: AttemptJournalRecord[];
  mainAttempts: AttemptJournalRecord[];
  memoryAttempts: AttemptJournalRecord[];
  attestor: AttemptCapabilityAttestor;
  mainQualityPassed: boolean;
  memoryQualityPassed: boolean;
  safetyPassed: boolean;
}> {
  const sessionKey = `cachebench_${input.credential.alias}_${input.workload.id}`;
  const route = buildSessionRoute(sessionKey, input.workload.id);
  const managerOptions = withBenchmarkIdentityPrompt(
    input.runtime.sessionManagerOptions,
    input.mainCase.case_id,
    input.round,
    input.cachePartitionNonce,
  );

  const bootstrapManager = new MessageSessionManager(
    input.runtime.services,
    'catscompany',
    managerOptions,
  );
  try {
    const bootstrap = bootstrapManager.getOrCreate(route);
    const persisted = await bootstrap.appendDurableContext([{
      source: 'cache-benchmark',
      id: 1,
      role: 'user',
      content: [
        BENCHMARK_RECOVERY_MARKER,
        `[发言人: Benchmark Alice]\nFixture ${input.workload.id}: ${input.workload.fixture}`,
      ].join('\n'),
    }]);
    if (!persisted) throw new Error('bootstrap_persistence_failed');
  } finally {
    await bootstrapManager.destroy();
  }

  const journalDirectory = path.join(
    path.resolve(input.outputDirectory),
    'attempt-journals',
    `round-${input.round}`,
    input.mainCase.case_id,
    `call-${input.logicalCall + 1}`,
  );
  const journal = new StrictAttemptJournal(journalDirectory);
  const attestor = new AttemptCapabilityAttestor();
  const subAgentManager = SubAgentManager.getInstance();
  let freshManager: MessageSessionManager | undefined;
  let toolStarts = 0;
  let confirmations = 0;
  let spawnedId: string | undefined;
  let session: ReturnType<MessageSessionManager['getOrCreate']> | undefined;
  let result: Awaited<ReturnType<ReturnType<MessageSessionManager['getOrCreate']>['handleRuntimeObservation']>> | undefined;
  try {
    journal.assertHealthy();
    freshManager = new MessageSessionManager(
      input.runtime.services,
      'catscompany',
      managerOptions,
    );
    freshManager.setContextInjector(createdSession => {
      createdSession.updateGoal({
        objective: 'Preserve every runtime capability while improving provider-reported cache reads.',
        status: 'active',
      });
      createdSession.updatePlan({
        steps: [
          { text: 'Restore the durable benchmark fixture', status: 'completed' },
          { text: 'Evaluate the fixture without tool execution', status: 'in_progress' },
          { text: 'Verify the exact oracle token', status: 'pending' },
        ],
      });
    });
    session = freshManager.getOrCreate(route);
    const spawned = await subAgentManager.spawn(
      sessionKey,
      {
        agentType: 'tester',
        toolScope: 'read_only',
        allowedTools: [],
        maxTurns: 1,
        taskDescription: 'Hold a deterministic active status for context verification',
        userMessage: 'Wait until the parent benchmark turn completes.',
      },
      path.resolve(input.workingDirectory),
      new BlockingBenchmarkAIService(),
      input.runtime.services.skillManager,
    );
    if ('error' in spawned) throw new Error('subagent_fixture_failed');
    spawnedId = spawned.id;
    result = await withModelAttemptSink(journal, () =>
      withModelAttemptSink(attestor, () => session!.handleRuntimeObservation(
        input.workload.prompt,
        {
          source: 'memory',
          sessionRoute: route,
          executionScope: buildExecutionScope(route),
          deviceGrants: [buildDeviceGrant(route)],
          deviceSelection: buildDeviceSelection(route),
          targetRoutes: buildTargetRoutes(),
          runtimeFeedback: [{
            source: 'cache-benchmark-runner',
            message: 'The restored fixture and authorization snapshot passed preflight validation.',
            dedupeMs: 0,
          }],
          callbacks: {
            onToolStart: () => { toolStarts += 1; },
            confirmToolExecution: async () => {
              confirmations += 1;
              return { approved: false, reason: 'benchmark safety gate' };
            },
          },
        },
      )),
    );
  } finally {
    try {
      if (spawnedId) {
        subAgentManager.stopForParent(sessionKey, spawnedId);
        await waitForSubAgentStop(sessionKey);
      }
    } finally {
      journal.close();
      try { journal.assertHealthy(); } finally {
        session?.clear();
        await freshManager?.destroy();
      }
    }
  }

  const attempts = collapseJournalAttempts(journal.records);
  if (result?.memoryBranchCompletion) {
    attestor.registerMemoryCompletion(result.memoryBranchCompletion);
  }
  const mainAttempts = attempts.filter(attempt => attestor.getRole(attempt.attempt_id) === 'main');
  const memoryAttempts = attempts.filter(attempt => attestor.getRole(attempt.attempt_id) === 'memory_branch');
  const mainQualityPassed = result?.taskOutcome === 'completed'
    && normalizeOracle(result.text) === input.workload.oracle;
  const completion = result?.memoryBranchCompletion;
  const memoryQualityPassed = !input.memoryExpected
    || evaluateBenchmarkMemoryCompletion(
      completion,
      input.memoryPublicationRequired,
      input.expectedMemoryReadFingerprint,
    );
  const safetyPassed = toolStarts === 0
    && confirmations === 0
    && mainAttempts.length === 1
    && (input.memoryExpected ? memoryAttempts.length >= 1 : memoryAttempts.length === 0)
    && attempts.every(attempt => attempt.outcome === 'succeeded')
    && (!input.memoryExpected || (
      Boolean(completion)
      && completion!.toolNames.every(toolName => (
        MEMORY_BRANCH_ALLOWED_TOOLS as readonly string[]
      ).includes(toolName))
    ));
  return {
    attempts,
    mainAttempts,
    memoryAttempts,
    attestor,
    mainQualityPassed: Boolean(mainQualityPassed),
    memoryQualityPassed: Boolean(memoryQualityPassed),
    safetyPassed,
  };
}

export function evaluateBenchmarkMemoryCompletion(
  completion: ObservationBranchCompletion | undefined,
  publicationRequired: boolean,
  expectedReadFingerprint = expectedMemoryFixtureReadFingerprint(),
): boolean {
  if (publicationRequired) {
    return completion?.status === 'published'
      && Boolean(completion.observationId)
      && completion.observationRefs?.length === 1
      && completion.observationRefs[0] === MEMORY_FIXTURE_REF
      && Object.keys(completion.observationRefDigests || {}).length === 1
      && completion.observationRefDigests?.[MEMORY_FIXTURE_REF] === expectedReadFingerprint
      && completion.toolNames.includes('memory_search')
      && completion.toolNames.includes('memory_read_turn')
      && completion.toolNames[completion.toolNames.length - 1] === 'finish_memory_search';
  }
  return completion?.status === 'suppressed'
    && !completion.observationId
    && (completion.observationRefs?.length ?? 0) === 0
    && completion.toolNames[completion.toolNames.length - 1] === 'finish_memory_search';
}

function toBenchmarkAttempt(input: {
  manifest: CacheBenchmarkManifest;
  benchmarkCase: CacheBenchmarkCase;
  physical: AttemptJournalRecord;
  attestor: AttemptCapabilityAttestor;
  round: number;
  attemptNumber: number;
  attemptRole: CacheBenchmarkAttemptRole;
  logicalCall: number;
  cacheClass: CacheClass;
  qualityPassed: boolean;
  safetyPassed: boolean;
}): CacheBenchmarkAttempt {
  const record = input.physical;
  if (
    record.provider !== input.benchmarkCase.provider_adapter
    || record.model !== input.benchmarkCase.model
    || record.api_type !== input.benchmarkCase.api_type
  ) {
    throw new Error('physical_attempt_metadata_mismatch');
  }
  return {
    schema: CACHE_BENCHMARK_ATTEMPT_SCHEMA,
    suite_id: input.manifest.suite_id,
    round: input.round,
    attempt_number: input.attemptNumber,
    attempt_role: input.attemptRole,
    logical_call: input.logicalCall,
    case_id: input.benchmarkCase.case_id,
    run_id: RUN_ID,
    call_id: record.call_id,
    attempt_id: record.attempt_id,
    metadata: {
      provider_instance_id: input.benchmarkCase.provider_instance_id,
      provider_adapter: input.benchmarkCase.provider_adapter,
      model: input.benchmarkCase.model,
      api_type: input.benchmarkCase.api_type,
      surface: input.benchmarkCase.surface,
      task_id: input.benchmarkCase.task_id,
      task_fixture_fingerprint: input.benchmarkCase.task_fixture_fingerprint,
      scenario_family: input.benchmarkCase.scenario_family,
      session_type: input.benchmarkCase.session_type,
    },
    cache_class: input.cacheClass,
    outcome: journalOutcome(record),
    usage: {
      ...(record.provider_usage === undefined ? {} : { provider_usage: record.provider_usage }),
    },
    attestation: {
      quality_status: input.qualityPassed ? 'passed' : 'failed',
      safety_status: input.safetyPassed ? 'passed' : 'failed',
      oracle_contract_fingerprint: input.benchmarkCase.oracle_contract_fingerprint,
      execution_plan_fingerprint: input.benchmarkCase.execution_plan_fingerprint,
      stable_prefix_fingerprint: record.stable_prefix_fingerprint,
      request_fingerprint: record.request_fingerprint,
      observed_capabilities: input.attestor.get(record.attempt_id),
    },
  };
}

function collapseJournalAttempts(records: readonly AttemptJournalRecord[]): AttemptJournalRecord[] {
  const order: string[] = [];
  const latest = new Map<string, AttemptJournalRecord>();
  for (const record of records) {
    if (!latest.has(record.attempt_id)) order.push(record.attempt_id);
    latest.set(record.attempt_id, record);
  }
  return order.map(attemptId => latest.get(attemptId)!);
}

function journalOutcome(record: AttemptJournalRecord): AttemptOutcome {
  if (record.outcome === 'started') return 'incomplete';
  return record.outcome;
}

function createOnlineAIService(credential: OnlineProviderCredential): AIService {
  return new AIService({
    provider: credential.providerAdapter,
    apiKey: credential.apiKey,
    apiUrl: credential.apiBase,
    model: credential.model,
    openaiApiMode: credential.apiType === 'openai-responses' ? 'responses' : 'chat_completions',
    temperature: 0,
    maxTokens: maxOutputTokensFor(credential.alias),
    modelCapabilities: {
      toolCalling: true,
      streaming: true,
      promptCaching: credential.alias === 'newcli' ? 'openai-key' : 'automatic',
    },
  });
}

function withBenchmarkIdentityPrompt(
  options: ReturnType<typeof createAdapterRuntime>['sessionManagerOptions'],
  caseId: string,
  round: number,
  cachePartitionNonce: string,
): ReturnType<typeof createAdapterRuntime>['sessionManagerOptions'] {
  const baseFactory = options.systemPromptProviderFactory;
  if (!baseFactory) throw new Error('system_prompt_factory_missing');
  return {
    ...options,
    systemPromptProviderFactory: sessionKey => {
      const base = baseFactory(sessionKey);
      return async () => [
        buildBenchmarkPartitionMarker(caseId, round, cachePartitionNonce),
        BENCHMARK_IDENTITY_MARKER,
        'This is the fixed cache benchmark identity. The oracle instructions remain authoritative.',
        '',
        await base(),
      ].join('\n');
    },
  };
}

export function buildBenchmarkPartitionMarker(
  caseId: string,
  round: number,
  cachePartitionNonce: string,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(caseId)) {
    throw new Error('benchmark_partition_case_invalid');
  }
  if (!Number.isInteger(round) || round < 1) {
    throw new Error('benchmark_partition_round_invalid');
  }
  if (!/^[a-f0-9]{32}$/.test(cachePartitionNonce)) {
    throw new Error('benchmark_partition_nonce_invalid');
  }
  return `${BENCHMARK_PARTITION_MARKER} ${caseId}:round-${round}:nonce-${cachePartitionNonce}`;
}

function providerInstanceId(credential: OnlineProviderCredential): string {
  const endpointFingerprint = fingerprintCanonical({ api_base: credential.apiBase })
    .replace(/^sha256:/, '')
    .slice(0, 32);
  return `${credential.alias}:${credential.apiType}:endpoint-${endpointFingerprint}`;
}

function maxOutputTokensFor(provider: OnlineProviderAlias): number {
  return provider === 'deepseek'
    ? DEEPSEEK_MAX_OUTPUT_TOKENS
    : DEFAULT_MAX_OUTPUT_TOKENS;
}

function buildSessionRoute(sessionKey: string, topicId: string): SessionRoute {
  return {
    version: 2,
    source: 'catscompany',
    sessionKey,
    topicId: `benchmark-${topicId}`,
    topicType: 'group',
    actorUserId: 'Benchmark Alice',
    agentId: 'cache-benchmark-agent',
    agentBodyId: 'cache-benchmark-body',
    identityTrust: 'server_canonical',
    identitySource: 'cache-benchmark-fixture',
    identity: {
      source: 'catscompany',
      topicId: `benchmark-${topicId}`,
      topicType: 'group',
      actorUserId: 'Benchmark Alice',
      agentId: 'cache-benchmark-agent',
      agentBodyId: 'cache-benchmark-body',
      identityTrust: 'server_canonical',
      identitySource: 'cache-benchmark-fixture',
    },
  };
}

function buildExecutionScope(route: SessionRoute): ExecutionScope {
  return {
    source: route.source,
    sessionKey: route.sessionKey,
    topicId: route.topicId,
    topicType: route.topicType,
    actorUserId: route.actorUserId,
    agentId: route.agentId,
    agentBodyId: route.agentBodyId,
    permissionsSource: 'cache-benchmark-fixture',
    deviceOwnerUserId: route.actorUserId,
    deviceOwnerSource: 'cache-benchmark-fixture',
    channelSource: 'cache-benchmark-fixture',
    identityTrust: 'server_canonical',
    isTrusted: true,
  };
}

function buildDeviceGrant(route: SessionRoute): ScopedDeviceGrant {
  return {
    kind: 'user_device_grant',
    source: 'catscompany',
    grantId: 'cache-benchmark-device-grant',
    status: 'active',
    identityTrust: 'server_canonical',
    identitySource: 'cache-benchmark-fixture',
    deviceId: 'cache-benchmark-device',
    deviceDisplayName: 'Benchmark Laptop',
    ownerUserId: route.actorUserId,
    sessionKey: route.sessionKey,
    topicId: route.topicId,
    topicType: route.topicType,
    actorUserId: route.actorUserId,
    agentId: route.agentId,
    agentBodyId: route.agentBodyId,
    operations: ['read_file', 'glob', 'grep'],
    createdAt: 1,
    expiresAt: 4_102_444_800_000,
  };
}

function buildDeviceSelection(route: SessionRoute): ScopedDeviceSelection {
  return {
    kind: 'user_device_selection',
    source: 'catscompany',
    status: 'selected',
    selectionSource: 'cache-benchmark-fixture',
    sessionKey: route.sessionKey,
    topicId: route.topicId,
    topicType: route.topicType,
    actorUserId: route.actorUserId,
    agentId: route.agentId,
    identityTrust: 'server_canonical',
    identitySource: 'cache-benchmark-fixture',
    selectedDeviceId: 'cache-benchmark-device',
    selectedDeviceDisplayName: 'Benchmark Laptop',
    selectedDeviceOperations: ['read_file', 'glob', 'grep'],
    createdAt: 1,
  };
}

function buildTargetRoutes(): TargetRoutes {
  const route: TargetRoute = {
    userId: 'Benchmark Alice',
    userName: 'Benchmark Alice',
    ownerUserId: 'Benchmark Alice',
    deviceId: 'cache-benchmark-device',
    label: 'Benchmark Laptop',
    os: 'macos',
    status: 'ready',
  };
  return {
    routes: [route],
    byName: new Map([['Benchmark Alice', [route]]]),
    byUserId: new Map([['Benchmark Alice', [route]]]),
  };
}

function prepareBenchmarkSkill(skillsDirectory: string): void {
  const root = path.resolve(skillsDirectory);
  const directory = path.join(root, 'cache-benchmark-fixture');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'SKILL.md');
  const source = [
    '---',
    'name: cache-benchmark-fixture',
    'description: Fixed read-only skill used to verify session skill injection.',
    'user-invocable: true',
    '---',
    '',
    'Use only the restored benchmark fixture. Never execute tools.',
    '',
  ].join('\n');
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== source) {
    throw new Error('benchmark_skill_mismatch');
  }
  if (!fs.existsSync(file)) fs.writeFileSync(file, source, { mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(directory, 0o700);
    fs.chmodSync(file, 0o600);
  }
}

function assertBootstrappedRuntimePaths(options: OnlineCacheBenchmarkOptions): void {
  const runtime = path.resolve(options.runtimeDataDirectory);
  const skills = path.resolve(options.skillsDirectory);
  if (path.resolve(process.env.XIAOBA_USER_DATA_DIR || '') !== runtime) {
    throw new Error('runtime_data_not_bootstrapped');
  }
  if (path.resolve(process.env.XIAOBA_SKILLS_DIR || '') !== skills) {
    throw new Error('skills_path_not_bootstrapped');
  }
  if (skills !== path.join(runtime, 'skills')) {
    throw new Error('skills_path_outside_runtime');
  }
  const marker = path.join(runtime, '.cache-benchmark-runtime-v1');
  const runtimeStat = fs.lstatSync(runtime);
  const skillsStat = fs.lstatSync(skills);
  const markerStat = fs.lstatSync(marker);
  if (
    runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()
    || skillsStat.isSymbolicLink() || !skillsStat.isDirectory()
    || markerStat.isSymbolicLink() || !markerStat.isFile()
  ) throw new Error('runtime_data_not_private');
  if (process.platform !== 'win32' && (
    (runtimeStat.mode & 0o777) !== 0o700
    || (skillsStat.mode & 0o777) !== 0o700
    || (markerStat.mode & 0o777) !== 0o600
  )) throw new Error('runtime_data_not_private');
}

function prepareSyntheticWorkspace(runtimeDataDirectory: string): string {
  const directory = path.join(path.resolve(runtimeDataDirectory), 'workspace');
  fs.mkdirSync(directory, { mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  return directory;
}

function prepareMemoryFixtures(workingDirectory: string, nonce: string): SealedMemoryFixture {
  return createSealedMemoryFixture({
    workspace: workingDirectory,
    nonce,
    canonicalPath: 'cache-benchmark/2026-01-01/memory-fixtures.jsonl',
    source: buildMemoryFixtureSource(),
  });
}

function buildMemoryFixtureSource(): string {
  return JSON.stringify({
    entry_type: 'turn',
    turn: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    session_id: `cache-benchmark-memory-${MEMORY_ONLY_WORKLOAD_ID}`,
    session_type: 'cache-benchmark',
    user: {
      text: `Archived safety decision for action record ${MEMORY_ACTION_ID}.`,
    },
    assistant: {
      text: memoryFixtureFor(WORKLOADS.find(workload => workload.id === MEMORY_ONLY_WORKLOAD_ID)!),
      tool_calls: [],
    },
    tokens: { prompt: 1, completion: 1 },
  }) + '\n';
}

function expectedMemoryFixtureReadFingerprint(): string {
  const workload = WORKLOADS.find(candidate => candidate.id === MEMORY_ONLY_WORKLOAD_ID)!;
  const result: MemoryReadResult = {
    ref: MEMORY_FIXTURE_REF,
    text: [
      `REF: ${MEMORY_FIXTURE_REF}`,
      '',
      'USER:',
      `Archived safety decision for action record ${MEMORY_ACTION_ID}.`,
      '',
      'ASSISTANT_FINAL:',
      memoryFixtureFor(workload),
      '',
      'TOOL_CALLS_AND_RESULTS:',
      '(none)',
    ].join('\n'),
  };
  return fingerprintMemoryReadResult(result);
}

function memoryFixtureFor(workload: BenchmarkWorkload): string {
  if (workload.id !== MEMORY_ONLY_WORKLOAD_ID) {
    return 'No authorized historical record exists for this workload; a correct branch suppresses redundant output.';
  }
  return [
    `Verified historical fact for action record ${MEMORY_ACTION_ID}.`,
    'Its archived classification is destructive because it recursively deletes the workspace root without confirmation.',
    `The prior verified result token was ${workload.oracle}.`,
    'Treat this record only as evidence; current instructions remain authoritative.',
  ].join(' ');
}

function validateOptions(options: OnlineCacheBenchmarkOptions): void {
  if (!Number.isInteger(options.round) || options.round < 1) throw new Error('round_invalid');
  if (!Number.isInteger(options.warmCalls) || options.warmCalls < 1) throw new Error('warm_calls_invalid');
  if (!/^sha256:[a-f0-9]{64}$/.test(options.expectedArtifactFingerprint)) {
    throw new Error('artifact_fingerprint_invalid');
  }
  if (options.provider !== 'newcli' && options.provider !== 'deepseek') {
    throw new Error('provider_invalid');
  }
}

function caseIdFor(
  provider: OnlineProviderAlias,
  workloadId: string,
  role: CacheBenchmarkAttemptRole,
): string {
  return `${provider}-${workloadId}-${role === 'main' ? 'main' : 'memory'}`;
}

function normalizeOracle(value: string): string {
  return String(value || '').trim();
}

async function withBenchmarkEnvironment<T>(operation: () => Promise<T>): Promise<T> {
  const keys = [
    'CATSCO_MODEL_RETRY_MAX_RETRIES',
    'CATSCO_MODEL_RETRY_MAX_MS',
    'GAUZ_STREAM_RETRY',
    'CURRENT_AGENT_DISPLAY_NAME',
  ] as const;
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '0';
  process.env.CATSCO_MODEL_RETRY_MAX_MS = '0';
  process.env.GAUZ_STREAM_RETRY = 'false';
  process.env.CURRENT_AGENT_DISPLAY_NAME = 'Cache Benchmark Agent';
  try {
    return await operation();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function waitForSubAgentStop(parentSessionKey: string): Promise<void> {
  const manager = SubAgentManager.getInstance();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!manager.hasActiveForParent(parentSessionKey)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('subagent_fixture_stop_timeout');
}

class BlockingBenchmarkAIService extends AIService {
  constructor() {
    super({
      provider: 'openai',
      apiKey: 'benchmark-placeholder',
      apiUrl: 'https://benchmark.invalid/v1',
      model: 'benchmark-blocker',
      modelCapabilities: { toolCalling: true },
    });
  }

  override chat(
    _messages: Message[],
    _tools?: ToolDefinition[],
    options: AIRequestOptions = {},
  ): Promise<ChatResponse> {
    return waitUntilAbort(options.signal);
  }

  override chatStream(
    _messages: Message[],
    _tools?: ToolDefinition[],
    _callbacks?: StreamCallbacks,
    options: AIRequestOptions = {},
  ): Promise<ChatResponse> {
    return waitUntilAbort(options.signal);
  }
}

class BenchmarkDenyToolManager extends ToolManager {
  override async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.function.name,
      content: 'Benchmark safety gate denied tool execution before dispatch.',
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      retryable: false,
    };
  }
}

function waitUntilAbort(signal?: AbortSignal): Promise<ChatResponse> {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      const error = new Error('benchmark blocker aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
