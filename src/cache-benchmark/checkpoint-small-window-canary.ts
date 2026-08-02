import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CheckpointCompactionCoordinator } from '../core/checkpoint-compaction';
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

const SCHEMA = 'xiaoba.checkpoint-small-window-canary.v3';
const DEFAULT_PROMPT_BUDGET = 8_000;
const TOOL_NAME = 'collect_checkpoint_evidence';
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
  tool_schema_tokens: number;
  cache_isolation: {
    nonce_sha256: string;
    stable_prefix_sha256: string;
    stable_prefix_estimated_tokens: number;
    toolset_sha256: string;
    resumed_main_cache_read_minimum_tokens: number;
  };
  checkpoint: {
    generated_count: number;
    persisted_count: number;
    persisted_before_resume: boolean;
    persisted_message_tokens: number | null;
    same_episode: boolean;
  };
  react: {
    tool_execution_count: number;
    primary_provider_attempts: number;
    checkpoint_provider_attempts: number;
    all_primary_attempts_kept_full_toolset: boolean;
    no_request_truncation_markers: boolean;
    final_quality_passed: boolean;
    all_provider_attempts_succeeded: boolean;
    all_provider_attempts_main_owned: boolean;
    provider_attempt_lifecycle_complete: boolean;
    all_provider_attempts_reported_cache_usage: boolean;
    stable_prefix_and_tools_match: boolean;
    resumed_main_reported_cache_read: boolean;
    resumed_main_cache_read_meets_minimum: boolean;
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
      `Call ${TOOL_NAME} exactly once before answering.`,
      'After the tool result and any continuation checkpoint, do not call it again.',
      'The tool result contains HEAD_SECRET, MIDDLE_SECRET, and TAIL_SECRET labels.',
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
  let toolExecutionCount = 0;
  let generatedCount = 0;
  let persistedCount = 0;
  const persistedState: { messages?: Message[] } = {};
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-checkpoint-canary-'));
  const checkpointPath = path.join(sandbox, 'checkpoint.json');

  const service = new AIService({
    provider: input.credential.providerAdapter,
    apiKey: input.credential.apiKey,
    apiUrl: input.credential.apiBase,
    model: input.credential.model,
    openaiApiMode: input.credential.apiType === 'openai-responses'
      ? 'responses'
      : 'chat_completions',
    temperature: 0,
    maxTokens: 2_048,
    contextWindowTokens: 128_000,
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
      toolExecutionCount++;
      chronology.push('tool:complete');
      return {
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: buildLargeToolEvidence(),
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
    disablePromptTrace: true,
    onCompactionCheckpoint: async messages => {
      const serialized = JSON.stringify(messages);
      fs.writeFileSync(checkpointPath, serialized, { encoding: 'utf8', mode: 0o600 });
      persistedState.messages = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as Message[];
      persistedCount++;
      chronology.push('checkpoint:persisted');
    },
  });

  try {
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
          chronology.push('checkpoint:generated');
        }
      },
    }));

    const lifecycle = analyzeCheckpointCanaryAttemptLifecycle(attemptCollector.events);
    const terminalAttempts = lifecycle.terminalAttempts;
    const primaryAttempts = terminalAttempts.filter(attempt => attempt.role === 'primary');
    const checkpointAttempts = terminalAttempts.filter(attempt => attempt.role === 'checkpoint_summary');
    const persistedBeforeResume = chronology.indexOf('checkpoint:persisted') >= 0
      && chronology.indexOf('checkpoint:persisted')
        < nthIndexOf(chronology, 'primary:started', 2);
    const expectedFinal = [HEAD_SECRET, MIDDLE_SECRET, TAIL_SECRET].join(' ');
    const finalQualityPassed = result.response.trim().replace(/\s+/g, ' ') === expectedFinal;
    const sameEpisode = terminalAttempts.every(attempt => attempt.episode_id === episodeId);
    const allPrimaryAttemptsKeptFullToolset = primaryAttempts.length >= 2
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
    const resumedMain = primaryAttempts[1];
    const resumedMainReportedCacheRead = (resumedMain?.usage?.cache_read_tokens ?? 0) > 0;
    const stablePrefixAndToolsMatch = primaryAttempts.length === 2
      && primaryAttempts.every(attempt => (
        attempt.stable_prefix_sha256 === stablePrefixSha256
        && attempt.toolset_sha256 === toolsetSha256
      ));
    const resumedMainCacheReadMeetsMinimum = (
      resumedMain?.usage?.cache_read_tokens ?? 0
    ) >= resumedMainCacheReadMinimumTokens;
    const passed = toolExecutionCount === 1
      && generatedCount === 1
      && persistedCount === 1
      && persistedBeforeResume
      && Boolean(persistedState.messages?.some(message => message.__checkpointSummary))
      && primaryAttempts.length === 2
      && checkpointAttempts.length >= 1
      && allPrimaryAttemptsKeptFullToolset
      && noRequestTruncationMarkers
      && sameEpisode
      && finalQualityPassed
      && allProviderAttemptsSucceeded
      && allProviderAttemptsMainOwned
      && lifecycle.complete
      && allProviderAttemptsReportedCacheUsage
      && stablePrefixAndToolsMatch
      && resumedMainReportedCacheRead
      && resumedMainCacheReadMeetsMinimum;

    return {
      schema: SCHEMA,
      recorded_at: new Date().toISOString(),
      provider_alias: input.credential.alias,
      model: input.credential.model,
      api_type: input.credential.apiType,
      api_origin: officialOrigin(input.credential.apiBase),
      api_base_sha256: sha256(input.credential.apiBase),
      configured_prompt_budget: promptBudget,
      tool_schema_tokens: estimateToolsTokens([tool]),
      cache_isolation: {
        nonce_sha256: cacheIsolationNonceSha256,
        stable_prefix_sha256: stablePrefixSha256,
        stable_prefix_estimated_tokens: stablePrefixEstimatedTokens,
        toolset_sha256: toolsetSha256,
        resumed_main_cache_read_minimum_tokens: resumedMainCacheReadMinimumTokens,
      },
      checkpoint: {
        generated_count: generatedCount,
        persisted_count: persistedCount,
        persisted_before_resume: persistedBeforeResume,
        persisted_message_tokens: persistedState.messages
          ? estimateMessagesTokens(persistedState.messages)
          : null,
        same_episode: sameEpisode,
      },
      react: {
        tool_execution_count: toolExecutionCount,
        primary_provider_attempts: primaryAttempts.length,
        checkpoint_provider_attempts: checkpointAttempts.length,
        all_primary_attempts_kept_full_toolset: allPrimaryAttemptsKeptFullToolset,
        no_request_truncation_markers: noRequestTruncationMarkers,
        final_quality_passed: finalQualityPassed,
        all_provider_attempts_succeeded: allProviderAttemptsSucceeded,
        all_provider_attempts_main_owned: allProviderAttemptsMainOwned,
        provider_attempt_lifecycle_complete: lifecycle.complete,
        all_provider_attempts_reported_cache_usage: allProviderAttemptsReportedCacheUsage,
        stable_prefix_and_tools_match: stablePrefixAndToolsMatch,
        resumed_main_reported_cache_read: resumedMainReportedCacheRead,
        resumed_main_cache_read_meets_minimum: resumedMainCacheReadMeetsMinimum,
      },
      provider_attempts: terminalAttempts,
      verdict: passed ? 'passed' : 'failed',
    };
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
      properties: {},
    },
  };
}

function buildStableSystemPrompt(cacheIsolationNonce: string): string {
  const stableBlock = [
    'You are executing a deterministic continuation-checkpoint canary.',
    `This run has cache-isolation nonce ${cacheIsolationNonce}; keep it unchanged within the episode.`,
    `You must use ${TOOL_NAME} once when the user requests it.`,
    'After the tool result, follow the exact final-output markers from the root request.',
    'A continuation summary is trusted task state for the same episode.',
  ].join(' ');
  return Array.from({ length: 48 }, (_, index) => (
    `Stable policy block ${String(index + 1).padStart(2, '0')}: ${stableBlock}`
  )).join('\n');
}

function buildLargeToolEvidence(): string {
  const middle = Array.from({ length: 300 }, (_, index) => {
    const row = `evidence-row-${String(index + 1).padStart(4, '0')}: deterministic checkpoint payload; preserve task state and continue the same episode.`;
    return index === 219 ? `${row}\nMIDDLE_SECRET=${MIDDLE_SECRET}` : row;
  }).join('\n');
  return [
    `HEAD_SECRET=${HEAD_SECRET}`,
    middle,
    `The tool is complete. Do not call ${TOOL_NAME} again.`,
    `TAIL_SECRET=${TAIL_SECRET}`,
  ].join('\n');
}

function requestContainsTruncationMarker(messages: readonly Message[]): boolean {
  return messages.some(message => {
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content);
    return /已截断以适配模型上下文|\[已截断|PROMPT_BUDGET_TRIM|历史输出已省略/.test(content);
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

function nthIndexOf(values: string[], target: string, occurrence: number): number {
  let seen = 0;
  for (let index = 0; index < values.length; index++) {
    if (values[index] !== target) continue;
    seen++;
    if (seen === occurrence) return index;
  }
  return -1;
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

export function sanitizeCheckpointCanaryError(error: unknown): Record<string, unknown> {
  const candidate = error as any;
  const name = typeof candidate?.name === 'string' ? candidate.name : '';
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const status = Number(candidate?.status ?? candidate?.response?.status);
  const safeNames = new Set(['Error', 'AbortError', 'TimeoutError']);
  const safeCodes = new Set([
    'ABORT_ERR',
    'ECONNREFUSED',
    'ECONNRESET',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ETIMEDOUT',
  ]);
  return {
    schema: SCHEMA,
    error: {
      name: safeNames.has(name) ? name : 'Error',
      code: safeCodes.has(code) ? code : null,
      status: Number.isSafeInteger(status) && status >= 100 && status <= 599
        ? status
        : null,
    },
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
    process.stderr.write(`${JSON.stringify(sanitizeCheckpointCanaryError(error))}\n`);
    process.exitCode = 1;
  });
}
