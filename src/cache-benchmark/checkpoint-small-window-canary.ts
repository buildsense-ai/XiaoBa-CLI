import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CheckpointCompactionCoordinator,
  collectCanonicalCompletedToolBoundaryEntries,
} from '../core/checkpoint-compaction';
import { ConversationRunner } from '../core/conversation-runner';
import { estimateMessagesTokens, estimateToolsTokens } from '../core/token-estimator';
import type { ModelAttemptEvent, ModelAttemptSink } from '../providers/provider';
import type { Message } from '../types';
import type {
  ToolCall,
  ToolDefinition,
  ToolExecutor,
  ToolResult,
} from '../types/tool';
import { AIService } from '../utils/ai-service';
import {
  loadOnlineProviderCredentials,
  type OnlineProviderAlias,
  type OnlineProviderCredential,
} from './online-credentials';

const SCHEMA = 'xiaoba.checkpoint-small-window-canary.v4';
const DEFAULT_PROMPT_BUDGET = 8_000;
const MAX_OUTPUT_TOKENS = 2_048;
const REQUIRED_CHECKPOINTS = 2;
const TOOL_NAME = 'collect_checkpoint_evidence';
const REQUIRED_TOOL_STEPS = [1, 2] as const;
const HEAD_SECRET = 'SECRET_ALPHA_5A77';
const MIDDLE_SECRET = 'SECRET_BRAVO_7E42';
const TAIL_SECRET = 'SECRET_CHARLIE_9C31';

interface AttemptEvidence {
  attempt_id: string;
  role: 'primary' | 'checkpoint_summary';
  request_kind: ModelAttemptEvent['requestKind'];
  request_origin: ModelAttemptEvent['requestOrigin'];
  outcome: ModelAttemptEvent['outcome'];
  episode_id: string | null;
  episode_number: number | null;
  message_count: number;
  tool_count: number;
  completed_tool_boundary_witness_count: number;
  completed_tool_boundary_success_witness_count: number;
  completed_tool_boundary_fingerprints: string[];
  estimated_request_tokens: number;
  stable_prefix_sha256: string;
  toolset_sha256: string;
  contains_truncation_marker: boolean;
  usage?: {
    input_reported: boolean;
    cache_read_reported: boolean;
    input_tokens?: number;
    cache_read_tokens?: number;
    cache_read_source?: string;
    cache_write_tokens?: number;
    output_tokens?: number;
  };
}

interface CanaryEvidence {
  schema: typeof SCHEMA;
  recorded_at: string;
  provider_alias: OnlineProviderAlias;
  model: string;
  api_type: OnlineProviderCredential['apiType'];
  api_origin: string | null;
  api_base_sha256: string;
  configured_prompt_budget: number;
  configured_context_window_tokens: number;
  configured_max_output_tokens: number;
  tool_schema_tokens: number;
  cache_isolation: {
    nonce_sha256: string;
    stable_prefix_sha256: string;
    stable_prefix_estimated_tokens: number;
    toolset_sha256: string;
    resumed_main_cache_read_minimum_tokens: number;
  };
  checkpoint: {
    required_count: number;
    generated_count: number;
    persisted_count: number;
    restored_count: number;
    persisted_before_each_resume: boolean;
    persisted_message_tokens: number[];
    persisted_state_sha256: string[];
    same_episode: boolean;
  };
  react: {
    tool_execution_count: number;
    tool_execution_steps: number[];
    pending_step_two_delivered: boolean;
    primary_provider_attempts: number;
    checkpoint_provider_attempts: number;
    all_primary_attempts_kept_full_toolset: boolean;
    no_request_truncation_markers: boolean;
    final_quality_passed: boolean;
    all_provider_attempts_succeeded: boolean;
    all_provider_attempts_main_owned: boolean;
    provider_attempt_lifecycle_complete: boolean;
    all_provider_attempts_reported_cache_usage: boolean;
    all_requests_within_estimated_prompt_budget: boolean;
    all_provider_reported_totals_within_context_window: boolean;
    stable_prefix_and_tools_match: boolean;
    all_resumed_main_requests_have_completed_tool_witness: boolean;
    resumed_main_cache_reads_reported: boolean;
    resumed_main_cache_reads_meet_minimum: boolean;
    primary_input_tokens: number;
    primary_cache_read_tokens: number;
    primary_token_weighted_cache_read_ratio: number;
    resumed_primary_cache_read_tokens: number[];
  };
  provider_attempts: AttemptEvidence[];
  verdict: 'passed' | 'failed';
}

class AttemptCollector implements ModelAttemptSink {
  readonly events: AttemptEvidence[] = [];
  readonly chronology: string[];

  constructor(chronology: string[]) {
    this.chronology = chronology;
  }

  observe(event: ModelAttemptEvent): void {
    const role = event.requestKind === 'checkpoint_compaction'
      ? 'checkpoint_summary'
      : 'primary';
    if (event.outcome === 'started') {
      this.chronology.push(`${role}:started`);
    }
    const usage = event.response?.usage;
    const completedToolBoundaryEntries = collectCanonicalCompletedToolBoundaryEntries(
      event.request.messages,
      event.context?.episodeId,
    );
    this.events.push({
      attempt_id: event.attemptId,
      role,
      request_kind: event.requestKind,
      request_origin: event.requestOrigin,
      outcome: event.outcome,
      episode_id: event.context?.episodeId || null,
      episode_number: event.context?.episodeNumber ?? null,
      message_count: event.request.messages.length,
      tool_count: event.request.tools.length,
      completed_tool_boundary_witness_count: completedToolBoundaryEntries.length,
      completed_tool_boundary_success_witness_count: completedToolBoundaryEntries.filter(
        entry => entry.resultStatus === 'success' && entry.retryable === false,
      ).length,
      completed_tool_boundary_fingerprints: completedToolBoundaryEntries.map(entry => (
        sha256(JSON.stringify(entry))
      )),
      estimated_request_tokens: estimateMessagesTokens([...event.request.messages])
        + estimateToolsTokens([...event.request.tools]),
      stable_prefix_sha256: fingerprintStablePrefix(event.request.messages),
      toolset_sha256: sha256(JSON.stringify(event.request.tools)),
      contains_truncation_marker: requestContainsTruncationMarker(event.request.messages),
      ...(usage ? {
        usage: {
          input_reported: usage.inputTokensReported === true,
          cache_read_reported: Object.prototype.hasOwnProperty.call(usage, 'cachedReadTokens'),
          ...(reportedNumber(usage.promptTokens) === undefined
            ? {} : { input_tokens: reportedNumber(usage.promptTokens) }),
          ...(reportedNumber(usage.cachedReadTokens) === undefined
            ? {} : { cache_read_tokens: reportedNumber(usage.cachedReadTokens) }),
          ...(usage.cacheReadSource ? { cache_read_source: usage.cacheReadSource } : {}),
          ...(reportedNumber(usage.cachedWriteTokens) === undefined
            ? {} : { cache_write_tokens: reportedNumber(usage.cachedWriteTokens) }),
          ...(reportedNumber(usage.completionTokens) === undefined
            ? {} : { output_tokens: reportedNumber(usage.completionTokens) }),
        },
      } : {}),
    });
  }
}

export async function runCheckpointSmallWindowCanary(input: {
  credential: OnlineProviderCredential;
  promptBudget?: number;
}): Promise<CanaryEvidence> {
  const promptBudget = normalizePromptBudget(input.promptBudget);
  const chronology: string[] = [];
  const attemptCollector = new AttemptCollector(chronology);
  const cacheIsolationNonce = randomBytes(32).toString('hex');
  const cacheIsolationNonceSha256 = sha256(cacheIsolationNonce);
  const episodeId = `checkpoint-canary-${input.credential.alias}-${cacheIsolationNonceSha256.slice(0, 16)}`;
  const tool = buildEvidenceTool();
  const stableSystemPrompt = buildStableSystemPrompt(cacheIsolationNonce);
  const rootMessage: Message = {
    role: 'user',
    content: [
      `Call ${TOOL_NAME} exactly once with step=1 before doing anything else.`,
      'After its result and the first continuation checkpoint, wait for an additional user instruction.',
      'That instruction will request step=2; call it exactly once, then do not call the tool again.',
      'The two tool results jointly contain HEAD_SECRET, MIDDLE_SECRET, and TAIL_SECRET labels.',
      'Return only the three secret VALUES in that label order, separated by single spaces.',
      'Do not output the labels and do not add an explanation.',
    ].join(' '),
    __episodeId: episodeId,
    __episodeInputKind: 'root',
  };
  const stablePrefixMessages: Message[] = [{
    role: 'system',
    content: stableSystemPrompt,
  }, rootMessage];
  const stablePrefixSha256 = fingerprintStablePrefix(stablePrefixMessages);
  const stablePrefixEstimatedTokens = estimateMessagesTokens(stablePrefixMessages);
  const toolsetSha256 = sha256(JSON.stringify([tool]));
  const resumedMainCacheReadMinimumTokens = Math.max(
    1_024,
    Math.floor(stablePrefixEstimatedTokens * 0.75),
  );
  const toolExecutionSteps: number[] = [];
  let generatedCount = 0;
  let persistedCount = 0;
  let restoredCount = 0;
  let pendingStepTwoDelivered = false;
  const persistedMessageTokens: number[] = [];
  const persistedStateSha256: string[] = [];
  const persistedState: { messages?: Message[] } = {};
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-checkpoint-canary-'));
  const checkpointPath = path.join(sandbox, 'checkpoint.json');
  let diagnosticPhase = 'setup';

  const service = new AIService({
    provider: input.credential.providerAdapter,
    apiKey: input.credential.apiKey,
    apiUrl: input.credential.apiBase,
    model: input.credential.model,
    openaiApiMode: input.credential.apiType === 'openai-responses'
      ? 'responses'
      : 'chat_completions',
    temperature: 0,
    maxTokens: MAX_OUTPUT_TOKENS,
    contextWindowTokens: checkpointCanaryContextWindowTokens(promptBudget),
    modelCapabilities: {
      toolCalling: true,
      streaming: true,
      promptCaching: input.credential.alias === 'newcli' ? 'openai-key' : 'automatic',
    },
  });
  const coordinator = new CheckpointCompactionCoordinator(service, {
    maxContextTokens: promptBudget,
    compactionThreshold: 0.8,
    retainedUserTokenBudget: 1_000,
  });
  const executor: ToolExecutor = {
    getToolDefinitions: () => [tool],
    executeTool: async (call: ToolCall): Promise<ToolResult> => {
      const args = JSON.parse(call.function.arguments) as { step?: unknown };
      const step = Number(args.step);
      const expectedStep = REQUIRED_TOOL_STEPS[toolExecutionSteps.length];
      if (call.function.name !== TOOL_NAME || step !== expectedStep) {
        throw checkpointCanaryFailure('CHECKPOINT_CANARY_TOOL_SEQUENCE_INVALID', {
          expected_step: expectedStep ?? null,
          actual_step: Number.isSafeInteger(step) ? step : null,
          completed_step_count: toolExecutionSteps.length,
          tool_name_matched: call.function.name === TOOL_NAME,
        });
      }
      toolExecutionSteps.push(step);
      chronology.push(`tool:complete:${step}`);
      return {
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: buildLargeToolEvidence(step),
        ok: true,
      };
    },
  };
  const runner = new ConversationRunner(service, executor, {
    stream: false,
    enableCompression: false,
    maxContextTokens: promptBudget,
    episodeId,
    requestKind: 'main_inference',
    cachePartitionKey: `checkpoint-canary-${input.credential.alias}-${cacheIsolationNonceSha256}`,
    cacheTraceSink: attemptCollector,
    checkpointCompactionCoordinator: coordinator,
    pendingUserInputProvider: async () => {
      if (persistedCount !== 1 || pendingStepTwoDelivered) return null;
      pendingStepTwoDelivered = true;
      chronology.push('pending:step-two');
      return [
        'The first checkpoint has been durably restored.',
        `Now call ${TOOL_NAME} exactly once with step=2.`,
        'After its result and the next continuation checkpoint, return the final three secret values.',
      ].join(' ');
    },
    disablePromptTrace: true,
    onCompactionCheckpoint: async messages => {
      const serialized = JSON.stringify(messages);
      fs.writeFileSync(checkpointPath, serialized, { encoding: 'utf8', mode: 0o600 });
      const restored = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as Message[];
      const restoredSerialized = JSON.stringify(restored);
      if (sha256(restoredSerialized) !== sha256(serialized)) {
        throw checkpointCanaryFailure('CHECKPOINT_CANARY_RESTORE_MISMATCH');
      }
      if (!restored.some(message => message.__checkpointSummary)) {
        throw checkpointCanaryFailure('CHECKPOINT_CANARY_RESTORED_SUMMARY_MISSING');
      }
      // ConversationRunner resumes from this exact array after the callback.
      // Replacing it with the JSON round-trip proves the active ReAct loop uses
      // the durably restored representation rather than the in-memory candidate.
      messages.splice(0, messages.length, ...restored);
      persistedState.messages = restored;
      persistedCount++;
      restoredCount++;
      persistedMessageTokens.push(estimateMessagesTokens(restored));
      persistedStateSha256.push(sha256(restoredSerialized));
      chronology.push(`checkpoint:persisted:${persistedCount}`);
      chronology.push(`checkpoint:restored:${restoredCount}`);
    },
  });

  try {
    diagnosticPhase = 'react_loop';
    const messages: Message[] = [
      {
        role: 'system',
        content: stableSystemPrompt,
      },
      rootMessage,
    ];
    const result = await runCheckpointCanaryWithoutConsoleOutput(() => runner.run(messages, {
      onThinking: text => {
        if (text.includes('Continuation checkpoint candidate generated')) {
          generatedCount++;
          chronology.push(`checkpoint:generated:${generatedCount}`);
        }
      },
    }));

    diagnosticPhase = 'evaluation';
    const lifecycle = analyzeCheckpointCanaryAttemptLifecycle(attemptCollector.events);
    const terminalAttempts = lifecycle.terminalAttempts;
    const primaryAttempts = terminalAttempts.filter(attempt => attempt.role === 'primary');
    const checkpointAttempts = terminalAttempts.filter(attempt => attempt.role === 'checkpoint_summary');
    const checkpointResumeOrdinals = checkpointResumePrimaryOrdinals(
      chronology,
      generatedCount,
    );
    const persistedBeforeEachResume = checkpointResumeOrdinals !== null;
    const expectedFinal = [HEAD_SECRET, MIDDLE_SECRET, TAIL_SECRET].join(' ');
    const finalQualityPassed = result.response.trim().replace(/\s+/g, ' ') === expectedFinal;
    const sameEpisode = terminalAttempts.every(attempt => attempt.episode_id === episodeId);
    const allPrimaryAttemptsKeptFullToolset = primaryAttempts.length >= REQUIRED_CHECKPOINTS + 1
      && primaryAttempts.every(attempt => attempt.tool_count === 1);
    const noRequestTruncationMarkers = terminalAttempts.every(
      attempt => !attempt.contains_truncation_marker,
    );
    const allProviderAttemptsSucceeded = terminalAttempts.every(
      attempt => attempt.outcome === 'succeeded',
    ) && lifecycle.complete;
    const allProviderAttemptsMainOwned = terminalAttempts.every(
      attempt => attempt.request_origin === 'main',
    );
    const allProviderAttemptsReportedCacheUsage = terminalAttempts.every(attempt => (
      attempt.usage?.input_reported === true
      && attempt.usage.cache_read_reported === true
      && attempt.usage.input_tokens !== undefined
      && attempt.usage.cache_read_tokens !== undefined
      && attempt.usage.cache_read_source === input.credential.cacheReadSource
    ));
    const configuredContextWindowTokens = checkpointCanaryContextWindowTokens(promptBudget);
    const allRequestsWithinEstimatedPromptBudget = terminalAttempts.every(
      attempt => checkpointCanaryEstimatedRequestWithinBudget(
        attempt.estimated_request_tokens,
        promptBudget,
      ),
    );
    const allProviderReportedTotalsWithinContextWindow = terminalAttempts.every(attempt => (
      checkpointCanaryProviderUsageWithinContextWindow(
        attempt.usage?.input_tokens,
        attempt.usage?.output_tokens,
        configuredContextWindowTokens,
      )
    ));
    const resumedMains = checkpointResumeOrdinals?.flatMap(ordinal => (
      primaryAttempts[ordinal] ? [primaryAttempts[ordinal]] : []
    )) || [];
    const resumedPrimaryCacheReadTokens = resumedMains.map(
      attempt => attempt.usage?.cache_read_tokens ?? 0,
    );
    const resumedMainCacheReadsReported = resumedMains.length === REQUIRED_CHECKPOINTS
      && resumedPrimaryCacheReadTokens.every(tokens => tokens > 0);
    const stablePrefixAndToolsMatch = primaryAttempts.length >= REQUIRED_CHECKPOINTS + 1
      && primaryAttempts.every(attempt => (
        attempt.stable_prefix_sha256 === stablePrefixSha256
        && attempt.toolset_sha256 === toolsetSha256
      ));
    const allResumedMainRequestsHaveCompletedToolWitness =
      checkpointCanaryCompletedToolWitnessChainIsComplete(
        resumedMains,
        REQUIRED_CHECKPOINTS,
      );
    const resumedMainCacheReadsMeetMinimum = resumedMains.length === REQUIRED_CHECKPOINTS
      && resumedPrimaryCacheReadTokens.every(
        tokens => tokens >= resumedMainCacheReadMinimumTokens,
      );
    const primaryInputTokens = primaryAttempts.reduce(
      (sum, attempt) => sum + (attempt.usage?.input_tokens ?? 0),
      0,
    );
    const primaryCacheReadTokens = primaryAttempts.reduce(
      (sum, attempt) => sum + (attempt.usage?.cache_read_tokens ?? 0),
      0,
    );
    const primaryTokenWeightedCacheReadRatio = primaryInputTokens > 0
      ? primaryCacheReadTokens / primaryInputTokens
      : 0;
    const passed = toolExecutionSteps.length === REQUIRED_TOOL_STEPS.length
      && toolExecutionSteps.every((step, index) => step === REQUIRED_TOOL_STEPS[index])
      && generatedCount === REQUIRED_CHECKPOINTS
      && persistedCount === generatedCount
      && restoredCount === generatedCount
      && persistedBeforeEachResume
      && pendingStepTwoDelivered
      && Boolean(persistedState.messages?.some(message => message.__checkpointSummary))
      && primaryAttempts.length >= REQUIRED_CHECKPOINTS + 1
      && checkpointAttempts.length >= REQUIRED_CHECKPOINTS
      && allPrimaryAttemptsKeptFullToolset
      && noRequestTruncationMarkers
      && sameEpisode
      && finalQualityPassed
      && allProviderAttemptsSucceeded
      && allProviderAttemptsMainOwned
      && lifecycle.complete
      && allProviderAttemptsReportedCacheUsage
      && allRequestsWithinEstimatedPromptBudget
      && allProviderReportedTotalsWithinContextWindow
      && stablePrefixAndToolsMatch
      && allResumedMainRequestsHaveCompletedToolWitness
      && resumedMainCacheReadsReported
      && resumedMainCacheReadsMeetMinimum;

    return {
      schema: SCHEMA,
      recorded_at: new Date().toISOString(),
      provider_alias: input.credential.alias,
      model: input.credential.model,
      api_type: input.credential.apiType,
      api_origin: officialOrigin(input.credential.apiBase),
      api_base_sha256: sha256(input.credential.apiBase),
      configured_prompt_budget: promptBudget,
      configured_context_window_tokens: configuredContextWindowTokens,
      configured_max_output_tokens: MAX_OUTPUT_TOKENS,
      tool_schema_tokens: estimateToolsTokens([tool]),
      cache_isolation: {
        nonce_sha256: cacheIsolationNonceSha256,
        stable_prefix_sha256: stablePrefixSha256,
        stable_prefix_estimated_tokens: stablePrefixEstimatedTokens,
        toolset_sha256: toolsetSha256,
        resumed_main_cache_read_minimum_tokens: resumedMainCacheReadMinimumTokens,
      },
      checkpoint: {
        required_count: REQUIRED_CHECKPOINTS,
        generated_count: generatedCount,
        persisted_count: persistedCount,
        restored_count: restoredCount,
        persisted_before_each_resume: persistedBeforeEachResume,
        persisted_message_tokens: persistedMessageTokens,
        persisted_state_sha256: persistedStateSha256,
        same_episode: sameEpisode,
      },
      react: {
        tool_execution_count: toolExecutionSteps.length,
        tool_execution_steps: toolExecutionSteps,
        pending_step_two_delivered: pendingStepTwoDelivered,
        primary_provider_attempts: primaryAttempts.length,
        checkpoint_provider_attempts: checkpointAttempts.length,
        all_primary_attempts_kept_full_toolset: allPrimaryAttemptsKeptFullToolset,
        no_request_truncation_markers: noRequestTruncationMarkers,
        final_quality_passed: finalQualityPassed,
        all_provider_attempts_succeeded: allProviderAttemptsSucceeded,
        all_provider_attempts_main_owned: allProviderAttemptsMainOwned,
        provider_attempt_lifecycle_complete: lifecycle.complete,
        all_provider_attempts_reported_cache_usage: allProviderAttemptsReportedCacheUsage,
        all_requests_within_estimated_prompt_budget: allRequestsWithinEstimatedPromptBudget,
        all_provider_reported_totals_within_context_window:
          allProviderReportedTotalsWithinContextWindow,
        stable_prefix_and_tools_match: stablePrefixAndToolsMatch,
        all_resumed_main_requests_have_completed_tool_witness:
          allResumedMainRequestsHaveCompletedToolWitness,
        resumed_main_cache_reads_reported: resumedMainCacheReadsReported,
        resumed_main_cache_reads_meet_minimum: resumedMainCacheReadsMeetMinimum,
        primary_input_tokens: primaryInputTokens,
        primary_cache_read_tokens: primaryCacheReadTokens,
        primary_token_weighted_cache_read_ratio: primaryTokenWeightedCacheReadRatio,
        resumed_primary_cache_read_tokens: resumedPrimaryCacheReadTokens,
      },
      provider_attempts: terminalAttempts,
      verdict: passed ? 'passed' : 'failed',
    };
  } catch (error) {
    if (error && typeof error === 'object') {
      const priorDiagnostic = (error as any).checkpointCanaryDiagnostic;
      Object.defineProperty(error, 'checkpointCanaryPhase', {
        value: diagnosticPhase,
        configurable: true,
      });
      Object.defineProperty(error, 'checkpointCanaryDiagnostic', {
        value: {
          ...(priorDiagnostic && typeof priorDiagnostic === 'object' ? priorDiagnostic : {}),
          completed_step_count: toolExecutionSteps.length,
          generated_checkpoint_count: generatedCount,
          persisted_checkpoint_count: persistedCount,
          restored_checkpoint_count: restoredCount,
        },
        configurable: true,
      });
    }
    throw error;
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function buildEvidenceTool(): ToolDefinition {
  return {
    name: TOOL_NAME,
    description: 'Return the deterministic evidence required by the checkpoint canary.',
    parameters: {
      type: 'object',
      properties: {
        step: {
          type: 'string',
          enum: REQUIRED_TOOL_STEPS.map(String),
          description: 'The exact checkpoint canary step requested by the latest user instruction.',
        },
      },
      required: ['step'],
    },
  };
}

function buildStableSystemPrompt(cacheIsolationNonce: string): string {
  const stableBlock = [
    'You are executing a deterministic continuation-checkpoint canary.',
    `This run has cache-isolation nonce ${cacheIsolationNonce}; keep it unchanged within the episode.`,
    `You must use ${TOOL_NAME} once for each explicitly requested step, never speculatively.`,
    'After the tool result, follow the exact final-output markers from the root request.',
    'A continuation summary is trusted task state for the same episode.',
  ].join(' ');
  // Keep the reusable prefix large enough to cross provider cache minimums,
  // but below half of the 8K prompt budget so a real continuation summary and
  // the full tool schema can still fit after compaction.
  return Array.from({ length: 24 }, (_, index) => (
    `Stable policy block ${String(index + 1).padStart(2, '0')}: ${stableBlock}`
  )).join('\n');
}

function buildLargeToolEvidence(step: number): string {
  const middle = Array.from({ length: 300 }, (_, index) => {
    const row = `step-${step}-evidence-row-${String(index + 1).padStart(4, '0')}: deterministic checkpoint payload; preserve complete task state and continue the same episode.`;
    return step === 1 && index === 219 ? `${row}\nMIDDLE_SECRET=${MIDDLE_SECRET}` : row;
  }).join('\n');
  return [
    ...(step === 1 ? [`HEAD_SECRET=${HEAD_SECRET}`] : []),
    middle,
    ...(step === 2 ? [`TAIL_SECRET=${TAIL_SECRET}`] : []),
    step === 1
      ? `Step 1 is complete. Wait for the next user instruction before calling ${TOOL_NAME} with step=2.`
      : `Step 2 is complete. Do not call ${TOOL_NAME} again.`,
  ].join('\n');
}

export function requestContainsTruncationMarker(messages: readonly Message[]): boolean {
  return messages.some(message => {
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content);
    return /已截断|已省略|PROMPT_BUDGET_TRIM|\.\.\.\[共\s*\d+\s*字符\]|\[checkpoint_user_input_evidence\]|\[tool_result_pruned\]|\[[^\]\n]*truncated\b|\bomission:/iu.test(content);
  });
}

export function analyzeCheckpointCanaryAttemptLifecycle(events: AttemptEvidence[]): {
  terminalAttempts: AttemptEvidence[];
  complete: boolean;
} {
  const order: string[] = [];
  const grouped = new Map<string, AttemptEvidence[]>();
  for (const event of events) {
    if (!order.includes(event.attempt_id)) order.push(event.attempt_id);
    const records = grouped.get(event.attempt_id) || [];
    records.push(event);
    grouped.set(event.attempt_id, records);
  }
  let complete = order.length > 0;
  const terminalAttempts = order.flatMap(attemptId => {
    const records = grouped.get(attemptId) || [];
    const started = records.filter(event => event.outcome === 'started');
    const terminal = records.filter(event => event.outcome !== 'started');
    if (started.length !== 1 || terminal.length !== 1) complete = false;
    return terminal.length === 1 ? [terminal[0]] : [];
  });
  return { terminalAttempts, complete };
}

function fingerprintStablePrefix(messages: readonly Message[]): string {
  const stablePrefix: Message[] = [];
  for (const message of messages) {
    if (message.__checkpointBoundary) break;
    stablePrefix.push(message);
  }
  return sha256(JSON.stringify(stablePrefix.map(message => ({
    role: message.role,
    content: message.content,
  }))));
}

export async function runCheckpointCanaryWithoutConsoleOutput<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => undefined;
  console.info = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    return await operation();
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
}

export function didPersistEveryCheckpointBeforeResume(
  chronology: readonly string[],
  checkpointCount: number,
): boolean {
  return checkpointResumePrimaryOrdinals(chronology, checkpointCount) !== null;
}

export function checkpointResumePrimaryOrdinals(
  chronology: readonly string[],
  checkpointCount: number,
): number[] | null {
  if (!Number.isSafeInteger(checkpointCount) || checkpointCount < 1) return null;
  const primaryStartedIndices = chronology.flatMap((entry, index) => (
    entry === 'primary:started' ? [index] : []
  ));
  if (primaryStartedIndices.length < checkpointCount + 1) return null;
  const resumeOrdinals: number[] = [];
  let priorResumeIndex = primaryStartedIndices[0];
  for (let checkpoint = 1; checkpoint <= checkpointCount; checkpoint++) {
    const generatedMarker = `checkpoint:generated:${checkpoint}`;
    const persistedMarker = `checkpoint:persisted:${checkpoint}`;
    const restoredMarker = `checkpoint:restored:${checkpoint}`;
    if (
      chronology.filter(entry => entry === generatedMarker).length !== 1
      || chronology.filter(entry => entry === persistedMarker).length !== 1
      || chronology.filter(entry => entry === restoredMarker).length !== 1
    ) return null;
    const generatedIndex = chronology.indexOf(generatedMarker);
    const persistedIndex = chronology.indexOf(persistedMarker);
    const restoredIndex = chronology.indexOf(restoredMarker);
    const resumedMainOrdinal = primaryStartedIndices.findIndex(index => index > restoredIndex);
    const resumedMainIndex = primaryStartedIndices[resumedMainOrdinal];
    const prematurePrimary = primaryStartedIndices.some(index => (
      index > generatedIndex && index < restoredIndex
    ));
    if (
      generatedIndex <= priorResumeIndex
      || persistedIndex <= generatedIndex
      || restoredIndex <= persistedIndex
      || resumedMainOrdinal < 0
      || prematurePrimary
    ) {
      return null;
    }
    resumeOrdinals.push(resumedMainOrdinal);
    priorResumeIndex = resumedMainIndex;
  }
  return resumeOrdinals;
}

export function checkpointCanaryContextWindowTokens(promptBudget: number): number {
  return promptBudget + MAX_OUTPUT_TOKENS;
}

export function checkpointCanaryEstimatedRequestWithinBudget(
  estimatedRequestTokens: number,
  promptBudget: number,
): boolean {
  return Number.isFinite(estimatedRequestTokens)
    && Number.isFinite(promptBudget)
    && estimatedRequestTokens >= 0
    && promptBudget > 0
    && estimatedRequestTokens <= promptBudget;
}

export function checkpointCanaryProviderUsageWithinContextWindow(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  contextWindowTokens: number,
): boolean {
  return Number.isFinite(inputTokens)
    && Number.isFinite(outputTokens)
    && Number.isFinite(contextWindowTokens)
    && (inputTokens as number) >= 0
    && (outputTokens as number) >= 0
    && contextWindowTokens > 0
    && (inputTokens as number) + (outputTokens as number) <= contextWindowTokens;
}

export function checkpointCanaryCompletedToolWitnessChainIsComplete(
  attempts: readonly {
    completed_tool_boundary_witness_count: number;
    completed_tool_boundary_success_witness_count: number;
    completed_tool_boundary_fingerprints: string[];
  }[],
  requiredCheckpoints: number,
): boolean {
  return attempts.length === requiredCheckpoints
    && attempts.every((attempt, index) => (
      attempt.completed_tool_boundary_witness_count === index + 1
      && attempt.completed_tool_boundary_success_witness_count === index + 1
      && new Set(attempt.completed_tool_boundary_fingerprints).size === index + 1
      && (index === 0 || attempts[index - 1].completed_tool_boundary_fingerprints.every(
        fingerprint => attempt.completed_tool_boundary_fingerprints.includes(fingerprint),
      ))
    ));
}

function normalizePromptBudget(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PROMPT_BUDGET;
  if (!Number.isInteger(value) || value < 4_000 || value > 32_000) {
    throw new Error('checkpoint_canary_prompt_budget_invalid');
  }
  return value;
}

function reportedNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function officialOrigin(apiBase: string): string | null {
  const origin = new URL(apiBase).origin;
  return origin === 'https://api.deepseek.com' || origin === 'https://api.openai.com'
    ? origin
    : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function checkpointCanaryFailure(
  code: string,
  diagnostic?: Record<string, unknown>,
): Error {
  return Object.assign(new Error(code.toLowerCase()), {
    code,
    ...(diagnostic ? { checkpointCanaryDiagnostic: diagnostic } : {}),
  });
}

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function writeEvidence(evidence: CanaryEvidence, outputPath?: string): void {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (!outputPath) {
    process.stdout.write(serialized);
    return;
  }
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, serialized, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`Redacted checkpoint canary evidence written to ${resolved}\n`);
}

function writeFailureEvidence(evidence: Record<string, unknown>, outputPath?: string): void {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, serialized, { encoding: 'utf8', mode: 0o600 });
  }
  process.stderr.write(`${JSON.stringify(evidence)}\n`);
}

export function sanitizeCheckpointCanaryError(error: unknown): Record<string, unknown> {
  const candidate = error as any;
  const name = typeof candidate?.name === 'string' ? candidate.name : '';
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const status = Number(candidate?.status ?? candidate?.response?.status);
  const phase = typeof candidate?.checkpointCanaryPhase === 'string'
    ? candidate.checkpointCanaryPhase
    : '';
  const safeNames = new Set(['Error', 'AbortError', 'TimeoutError']);
  const safeCodes = new Set([
    'ABORT_ERR',
    'ECONNREFUSED',
    'ECONNRESET',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ETIMEDOUT',
    'CONTEXT_CHECKPOINT_FAILED',
    'CHECKPOINT_CANARY_RESTORE_MISMATCH',
    'CHECKPOINT_CANARY_RESTORED_SUMMARY_MISSING',
    'CHECKPOINT_CANARY_TOOL_SEQUENCE_INVALID',
  ]);
  const safePhases = new Set(['setup', 'react_loop', 'evaluation']);
  const diagnostic = sanitizeCheckpointCanaryDiagnostic(candidate?.checkpointCanaryDiagnostic);
  const reason = classifyCheckpointCanaryFailure(error);
  return {
    schema: SCHEMA,
    error: {
      name: safeNames.has(name) ? name : 'Error',
      code: safeCodes.has(code) ? code : null,
      status: Number.isSafeInteger(status) && status >= 100 && status <= 599
        ? status
        : null,
      phase: safePhases.has(phase) ? phase : null,
      reason,
      ...(diagnostic ? { diagnostic } : {}),
    },
  };
}

function classifyCheckpointCanaryFailure(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current = error;
  const messages: string[] = [];
  for (let depth = 0; current && depth < 6 && !seen.has(current); depth++) {
    seen.add(current);
    const candidate = current as any;
    const message = typeof candidate?.message === 'string' ? candidate.message : '';
    if (message) messages.push(message);
    current = candidate?.cause;
  }
  const combined = messages.join('\n');
  if (/remains over budget after compression/i.test(combined)) {
    return 'post_checkpoint_request_over_budget';
  }
  if (/tool definitions require .*cannot fit/i.test(combined)) {
    return 'tool_schema_over_budget';
  }
  if (/checkpoint persistence failed/i.test(combined)) {
    return 'checkpoint_persistence_failed';
  }
  if (/checkpoint was generated but no durable persistence callback/i.test(combined)) {
    return 'checkpoint_persistence_callback_missing';
  }
  if (/hierarchical checkpoint summary did not converge|failed to reduce/i.test(combined)) {
    return 'checkpoint_summary_did_not_converge';
  }
  if (/checkpoint compaction returned an empty/i.test(combined)) {
    return 'checkpoint_summary_empty';
  }
  if (/maximum context|context length|prompt too long/i.test(combined)) {
    return 'checkpoint_summary_provider_context_overflow';
  }
  if (/checkpoint compaction has no non-system transcript/i.test(combined)) {
    return 'checkpoint_source_missing';
  }
  if (/checkpoint generation failed/i.test(combined)) {
    return 'checkpoint_generation_failed';
  }
  return null;
}

function sanitizeCheckpointCanaryDiagnostic(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const boundedStep = (step: unknown): number | null => (
    Number.isSafeInteger(step) && Number(step) >= 1 && Number(step) <= 2
      ? Number(step)
      : null
  );
  const completedStepCount = Number(candidate.completed_step_count);
  const boundedCount = (count: unknown): number | null => {
    const parsed = Number(count);
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 32 ? parsed : null;
  };
  return {
    expected_step: boundedStep(candidate.expected_step),
    actual_step: boundedStep(candidate.actual_step),
    completed_step_count: Number.isSafeInteger(completedStepCount)
      && completedStepCount >= 0
      && completedStepCount <= 2
      ? completedStepCount
      : null,
    generated_checkpoint_count: boundedCount(candidate.generated_checkpoint_count),
    persisted_checkpoint_count: boundedCount(candidate.persisted_checkpoint_count),
    restored_checkpoint_count: boundedCount(candidate.restored_checkpoint_count),
    tool_name_matched: typeof candidate.tool_name_matched === 'boolean'
      ? candidate.tool_name_matched
      : null,
  };
}

async function main(): Promise<void> {
  if (!process.argv.includes('--run')) {
    throw new Error('checkpoint_canary_requires_explicit_run');
  }
  const credentialFile = parseArg('credential-file');
  const providerAlias = parseArg('provider') as OnlineProviderAlias | undefined;
  if (!credentialFile || (providerAlias !== 'newcli' && providerAlias !== 'deepseek')) {
    throw new Error('checkpoint_canary_arguments_invalid');
  }
  const credential = loadOnlineProviderCredentials(credentialFile)
    .find(candidate => candidate.alias === providerAlias);
  if (!credential) throw new Error('checkpoint_canary_provider_missing');
  const budgetRaw = parseArg('budget');
  const promptBudget = budgetRaw === undefined ? undefined : Number(budgetRaw);
  const evidence = await runCheckpointSmallWindowCanary({ credential, promptBudget });
  writeEvidence(evidence, parseArg('output'));
  if (evidence.verdict !== 'passed') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    writeFailureEvidence(sanitizeCheckpointCanaryError(error), parseArg('output'));
    process.exitCode = 1;
  });
}
