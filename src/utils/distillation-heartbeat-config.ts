import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

/**
 * Distillation Heartbeat runtime configuration.
 *
 * The Distillation Heartbeat is a runtime-scoped scheduler that periodically
 * wakes to distill newly appended session log content into Distillation Units
 * via the Log Cursor based extraction path (see `distillation-unit.ts`).
 *
 * Configuration mirrors the CatsCo log upload scheduler config shape so the
 * heartbeat reuses the same runtime configuration/scheduling conventions.
 *
 * See CONTEXT.md → "Distillation Heartbeat", "Log Cursor".
 * See ADR 0001 → "Runtime Heartbeat Log Distillation".
 */

const DEFAULT_INTERVAL_HOURS = 6;
const MIN_INTERVAL_MINUTES = 30;

export type ExternalHistoryMode = 'future-only' | 'catch-up';

export interface DistillationHeartbeatConfig {
  /** Master switch for the heartbeat scheduler. */
  enabled: boolean;
  /** Heartbeat cadence in hours. First default is six hours. */
  intervalHours: number;
  /** Runtime logs root that contains the append-only session log tree. */
  logsRoot: string;
  /** Path to the durable Log Cursor state file. */
  stateFilePath: string;
  /** Path to the heartbeat run record (observability + catch-up audit). */
  heartbeatRecordPath: string;
  /** Path to the durable review-outcomes log (promote/needs_review/reject). */
  reviewOutcomesPath: string;
  /** Path to the durable needs-review queue state file. */
  needsReviewQueuePath: string;
  /** Path to the durable Capability Registry state file. */
  capabilityRegistryPath: string;
  /** Root directory for branch-style distillation work logs. */
  workLogRoot: string;
  /** Runtime-owned root directory for all branch transcripts. */
  branchLogRoot: string;
  /** Default retention period for uncommitted and observational transcripts. */
  branchTranscriptRetentionDays: number;
  /** V3 verified Current Skill workflow master switch. */
  skillEvolutionEnabled: boolean;
  /** Active-only V3 Current Skill Registry state file. */
  skillEvolutionRegistryPath: string;
  /** Append-only V3 Transition Audit file. */
  skillEvolutionAuditPath: string;
  /** Short-lived V3 Transition Journal file. */
  skillEvolutionJournalPath: string;
  /** Durable independent Learning Episode state for V3 settlement. */
  learningEpisodeStorePath: string;
  /** V3 Settlement Window policy in hours. */
  skillEvolutionSettlementWindowHours: number;
  /** V3 curator wake policy in hours (reserved for the existing runtime seam). */
  skillEvolutionCuratorIntervalHours: number;
  /** Append-only factual generated-skill load and outcome ledger. */
  skillUsageLedgerPath: string;
  /** Durable low-frequency Curator scheduling and coalescing state. */
  skillEvolutionCuratorStatePath: string;
  /** Durable generated-skill semantic reassessment manifest. */
  skillEvolutionReassessmentManifestPath: string;
  /** Bounded Branch Promotion Reviewer worker count. */
  skillEvolutionReviewerConcurrency: number;
  /** Durable review queue state for V3 semantic defers and operational retries. */
  skillEvolutionReviewQueuePath: string;
  /** Operational review retry backoff in minutes. */
  skillEvolutionOperationalRetryMinutes: number;
  /** Operational review retry cap in hours. */
  skillEvolutionOperationalRetryMaxHours: number;
  /** Shared bounded review attempt deadline in minutes. */
  skillEvolutionReviewAttemptDeadlineMinutes: number;
  /** Maximum review candidates admitted by one wake (eligible + due queue). */
  skillEvolutionReviewMaxCandidates: number;
  /** Conservative serialized-prompt token budget for one review wake. */
  skillEvolutionReviewMaxPromptTokens: number;
  /** Optional Author model override. */
  skillEvolutionAuthorModel?: string;
  /** Optional independent Verifier model override. */
  skillEvolutionVerifierModel?: string;
  /**
   * External Session Log Sources master switch. Disabled by default — a
   * default wake performs no external provider reads. See CONTEXT.md →
   * "External Session Log Source".
   */
  /** Path to the durable Evidence Capsule store (issue #78). */
  evidenceCapsulePath: string;
  externalSessionLogSourcesEnabled: boolean;
  /**
   * Enabled External Provider Set: a normalized, deduplicated, order-independent
   * set of opaque provider IDs eligible for continuous external admission.
   * See CONTEXT.md → "Enabled External Provider Set". Issue #91.
   */
  externalSessionLogEnabledProviders: string[];
  /**
   * Bounded read concurrency for external providers (1-8, default 3).
   * See ADR-0042. Issue #91 configures the limit; bounded scheduling
   * is delivered separately in #92.
   */
  externalSessionLogMaxConcurrency: number;
  /** Environment default for per-provider external history policy. */
  externalSessionLogHistoryMode: ExternalHistoryMode;
  /** Bounded fallback diagnostic; never includes the raw environment value. */
  externalSessionLogHistoryModeDiagnostic?: string;
  /**
   * Legacy selected provider for the continuous external xurl lane.
   * Accepted as a one-item enabled-provider fallback only when
   * {@link externalSessionLogEnabledProviders} is absent. Deprecated.
   */
  externalSessionLogSelectedProvider?: string;
  /** Optional source id for the continuous external xurl lane. */
  externalSessionLogSelectedSourceId?: string;
  /** Optional xurl command path for the continuous external xurl lane. */
  externalSessionLogXurlCommand?: string;
}

function readEnv(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function loadDotenvValues(workingDirectory: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const envPath = env.DOTENV_CONFIG_PATH || path.join(workingDirectory, '.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }
  try {
    return dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
  } catch {
    return {};
  }
}

function readBoolean(env: NodeJS.ProcessEnv, key: string, defaultValue: boolean): boolean {
  const raw = env[key];
  if (raw == null || raw === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function readNumber(env: NodeJS.ProcessEnv, key: string, defaultValue: number, min: number): number {
  const parsed = Number(env[key] || defaultValue);
  if (!Number.isFinite(parsed) || parsed < min) return defaultValue;
  return parsed;
}

function readNumberInRange(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const parsed = Number(env[key] || defaultValue);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return defaultValue;
  return parsed;
}

/**
 * Parse a comma-separated enabled-provider list into a normalized,
 * deduplicated, order-independent set of opaque provider IDs.
 * Returns an empty array when the env value is absent or empty.
 */
function parseEnabledProviders(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = env[key];
  if (!raw || !raw.trim()) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(',')) {
    const normalized = part.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function readExternalHistoryMode(env: NodeJS.ProcessEnv): {
  mode: ExternalHistoryMode;
  diagnostic?: string;
} {
  const raw = env.XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE?.trim().toLowerCase();
  if (raw === 'catch-up' || raw === 'future-only') return { mode: raw };
  if (!raw) {
    return {
      mode: 'future-only',
      diagnostic: 'External history mode is not configured; using future-only.',
    };
  }
  return {
    mode: 'future-only',
    diagnostic: 'External history mode is invalid; using future-only.',
  };
}

function readIntervalHours(env: NodeJS.ProcessEnv): number {
  const rawMinutes = env.DISTILLATION_HEARTBEAT_INTERVAL_MINUTES;
  if (rawMinutes != null && rawMinutes !== '') {
    const minutes = Number(rawMinutes);
    if (Number.isFinite(minutes) && minutes >= MIN_INTERVAL_MINUTES) {
      return minutes / 60;
    }
    return DEFAULT_INTERVAL_HOURS;
  }

  const hours = readNumber(
    env,
    'DISTILLATION_HEARTBEAT_INTERVAL_HOURS',
    DEFAULT_INTERVAL_HOURS,
    MIN_INTERVAL_MINUTES / 60,
  );
  return hours;
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === ''
    || (
      !!relative
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    )
  );
}

function resolveContainedPath(
  workingDirectory: string,
  containmentRoot: string,
  rawValue: string | undefined,
  defaultRelativePath: string,
): string {
  const workingRoot = path.resolve(workingDirectory);
  const fallback = path.resolve(workingRoot, defaultRelativePath);
  const candidate = rawValue
    ? path.resolve(workingRoot, rawValue)
    : fallback;
  const resolvedContainmentRoot = path.resolve(workingRoot, containmentRoot);
  return isPathInside(candidate, resolvedContainmentRoot) ? candidate : fallback;
}

export function getDistillationHeartbeatConfig(
  workingDirectory: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): DistillationHeartbeatConfig {
  const runtimeEnv = {
    ...loadDotenvValues(workingDirectory, env),
    ...env,
  };
  const configuredRuntimeDataRoot = readEnv(
    runtimeEnv,
    'XIAOBA_USER_DATA_DIR',
    'CATSCO_USER_DATA_DIR',
    'XIAOBA_ELECTRON_USER_DATA_DIR',
    'XIAOBA_RUNTIME_ROOT',
  );
  // Every durable heartbeat path must share the same Runtime root as the
  // cross-process owner lock. In packaged Electron, workingDirectory can be
  // the immutable app bundle while XIAOBA_RUNTIME_ROOT points at userData.
  const runtimeDataRoot = path.resolve(configuredRuntimeDataRoot || workingDirectory);

  const enabled = readBoolean(runtimeEnv, 'DISTILLATION_HEARTBEAT_ENABLED', true);
  const intervalHours = readIntervalHours(runtimeEnv);
  const logsRoot = resolveContainedPath(
    runtimeDataRoot,
    'logs',
    readEnv(runtimeEnv, 'DISTILLATION_HEARTBEAT_LOG_ROOT', 'CATSCO_LOG_ROOT', 'CATSLOG_LOG_ROOT'),
    'logs',
  );
  const stateFilePath = resolveContainedPath(
    runtimeDataRoot,
    'data',
    readEnv(runtimeEnv, 'DISTILLATION_HEARTBEAT_STATE_FILE'),
    'data/distillation-cursor-state.json',
  );
  const heartbeatRecordPath = resolveContainedPath(
    runtimeDataRoot,
    'data',
    readEnv(runtimeEnv, 'DISTILLATION_HEARTBEAT_RECORD_FILE'),
    'data/distillation-heartbeat-record.json',
  );
  const reviewOutcomesPath = resolveContainedPath(
    runtimeDataRoot,
    'data',
    readEnv(runtimeEnv, 'DISTILLATION_HEARTBEAT_REVIEW_OUTCOMES_FILE'),
    'data/distillation-review-outcomes.json',
  );
  const needsReviewQueuePath = resolveContainedPath(
    runtimeDataRoot,
    'data',
    readEnv(runtimeEnv, 'DISTILLATION_HEARTBEAT_NEEDS_REVIEW_QUEUE_FILE'),
    'data/needs-review-queue-state.json',
  );
  const capabilityRegistryPath = resolveContainedPath(
    runtimeDataRoot,
    'data',
    readEnv(runtimeEnv, 'DISTILLATION_HEARTBEAT_CAPABILITY_REGISTRY_FILE'),
    'data/capability-registry-state.json',
  );
  const workLogRoot = resolveContainedPath(
    runtimeDataRoot,
    'logs',
    readEnv(runtimeEnv, 'DISTILLATION_HEARTBEAT_WORK_LOG_ROOT'),
    'logs/branches/distillation',
  );
  const branchLogRoot = resolveContainedPath(
    runtimeDataRoot,
    'logs',
    readEnv(runtimeEnv, 'XIAOBA_BRANCH_LOG_ROOT', 'DISTILLATION_HEARTBEAT_BRANCH_LOG_ROOT'),
    'logs/branches',
  );
  const branchTranscriptRetentionDays = readNumber(
    runtimeEnv,
    'XIAOBA_BRANCH_TRANSCRIPT_RETENTION_DAYS',
    30,
    1,
  );
  // V3 is the production path. Operators and compatibility tests can still
  // opt back into V1 explicitly.
  const skillEvolutionEnabled = readBoolean(runtimeEnv, 'XIAOBA_SKILL_EVOLUTION_V3_ENABLED', true);
  const skillEvolutionRegistryPath = resolveContainedPath(
    runtimeDataRoot,
    'data',
    readEnv(runtimeEnv, 'XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE'),
    'data/current-skill-registry.json',
  );
  const skillEvolutionAuditPath = resolveContainedPath(
    runtimeDataRoot,
    'data',
    readEnv(runtimeEnv, 'XIAOBA_SKILL_EVOLUTION_AUDIT_FILE'),
    'data/transition-audit.jsonl',
  );
  const skillEvolutionJournalPath = resolveContainedPath(
    runtimeDataRoot,
    'data',
    readEnv(runtimeEnv, 'XIAOBA_SKILL_EVOLUTION_JOURNAL_FILE'),
    'data/transition-journal.json',
  );
  const learningEpisodeStorePath = resolveContainedPath(
    runtimeDataRoot,
    'data',
    readEnv(runtimeEnv, 'XIAOBA_LEARNING_EPISODE_STORE_FILE'),
    'data/learning-episodes.json',
  );
  const skillEvolutionSettlementWindowHours = readNumber(
    runtimeEnv,
    'XIAOBA_SKILL_EVOLUTION_SETTLEMENT_WINDOW_HOURS',
    3,
    0,
  );
  const skillEvolutionCuratorIntervalHours = readNumber(
    runtimeEnv,
    'XIAOBA_SKILL_EVOLUTION_CURATOR_INTERVAL_HOURS',
    24,
    1 / 60,
  );
  const skillUsageLedgerPath = resolveContainedPath(
    runtimeDataRoot,
    'data',
    readEnv(runtimeEnv, 'XIAOBA_SKILL_USAGE_LEDGER_FILE'),
    'data/skill-usage-ledger.jsonl',
  );
  const skillEvolutionCuratorStatePath = resolveContainedPath(
    runtimeDataRoot,
    'data',
    readEnv(runtimeEnv, 'XIAOBA_SKILL_EVOLUTION_CURATOR_STATE_FILE'),
    'data/skill-evolution-curator-state.json',
  );
  const skillEvolutionReassessmentManifestPath = resolveContainedPath(
    runtimeDataRoot,
    'data',
    readEnv(runtimeEnv, 'XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE'),
    'data/skill-evolution-reassessment-manifest.json',
  );
  const skillEvolutionReviewQueuePath = readEnv(
    runtimeEnv,
    'XIAOBA_SKILL_EVOLUTION_REVIEW_QUEUE_FILE',
  );
  const skillEvolutionReviewerConcurrency = Math.min(readNumber(
    runtimeEnv,
    'XIAOBA_SKILL_EVOLUTION_REVIEWER_CONCURRENCY',
    3,
    1,
  ), 32);
  const skillEvolutionOperationalRetryMinutes = readNumber(
    runtimeEnv,
    'XIAOBA_SKILL_EVOLUTION_OPERATIONAL_RETRY_MINUTES',
    5,
    1 / 60,
  );
  const configuredOperationalRetryMaxHours = readNumber(
    runtimeEnv,
    'XIAOBA_SKILL_EVOLUTION_OPERATIONAL_RETRY_MAX_HOURS',
    6,
    1 / 60,
  );
  const skillEvolutionOperationalRetryMaxHours = Math.max(
    configuredOperationalRetryMaxHours,
    skillEvolutionOperationalRetryMinutes / 60,
  );
  const skillEvolutionReviewAttemptDeadlineMinutes = readNumberInRange(
    runtimeEnv,
    'XIAOBA_SKILL_EVOLUTION_REVIEW_ATTEMPT_DEADLINE_MINUTES',
    10,
    1,
    60,
  );
  const skillEvolutionReviewMaxCandidates = readNumberInRange(
    runtimeEnv,
    'XIAOBA_SKILL_EVOLUTION_REVIEW_MAX_CANDIDATES',
    100,
    1,
    10_000,
  );
  const skillEvolutionReviewMaxPromptTokens = readNumberInRange(
    runtimeEnv,
    'XIAOBA_SKILL_EVOLUTION_REVIEW_MAX_PROMPT_TOKENS',
    200_000,
    1_000,
    10_000_000,
  );
  const skillEvolutionAuthorModel = readEnv(runtimeEnv, 'XIAOBA_SKILL_EVOLUTION_AUTHOR_MODEL');
  const skillEvolutionVerifierModel = readEnv(runtimeEnv, 'XIAOBA_SKILL_EVOLUTION_VERIFIER_MODEL');
  const evidenceCapsulePath = resolveContainedPath(
    runtimeDataRoot,
    'data',
    readEnv(runtimeEnv, 'XIAOBA_EVIDENCE_CAPSULE_STORE_FILE'),
    'data/evidence-capsules.json',
  );
  const externalSessionLogSourcesEnabled = readBoolean(
    runtimeEnv,
    'XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED',
    false,
  );
  // Enabled External Provider Set (issue #91): normalized, deduplicated, order-independent.
  const enabledProvidersFromEnv = parseEnabledProviders(
    runtimeEnv,
    'XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS',
  );
  const configuredExternalSessionLogMaxConcurrency = Number(
    runtimeEnv.XIAOBA_EXTERNAL_SESSION_LOG_MAX_CONCURRENCY ?? 3,
  );
  const externalSessionLogMaxConcurrency = !Number.isFinite(configuredExternalSessionLogMaxConcurrency)
    || configuredExternalSessionLogMaxConcurrency < 1
    ? 3
    : Math.min(8, Math.floor(configuredExternalSessionLogMaxConcurrency));
  const externalHistoryMode = readExternalHistoryMode(runtimeEnv);
  const externalSessionLogSelectedProvider = readEnv(
    runtimeEnv,
    'XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER',
  );
  const externalSessionLogSelectedSourceId = readEnv(
    runtimeEnv,
    'XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID',
  );
  const externalSessionLogXurlCommand = readEnv(
    runtimeEnv,
    'XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND',
  );
  // Legacy fallback: when the new enabled-provider set is absent, accept the
  // deprecated selected-provider as a one-item list so existing configs keep working.
  const externalSessionLogEnabledProviders =
    enabledProvidersFromEnv.length > 0
      ? enabledProvidersFromEnv
      : externalSessionLogSelectedProvider
        ? [externalSessionLogSelectedProvider.trim().toLowerCase()]
        : [];

  return {
    enabled,
    intervalHours,
    logsRoot,
    stateFilePath,
    heartbeatRecordPath,
    reviewOutcomesPath,
    needsReviewQueuePath,
    capabilityRegistryPath,
    workLogRoot,
    branchLogRoot,
    branchTranscriptRetentionDays,
    skillEvolutionEnabled,
    skillEvolutionRegistryPath,
    skillEvolutionAuditPath,
    skillEvolutionJournalPath,
    learningEpisodeStorePath,
    skillEvolutionSettlementWindowHours,
    skillEvolutionCuratorIntervalHours,
    skillUsageLedgerPath,
    skillEvolutionCuratorStatePath,
    skillEvolutionReassessmentManifestPath,
    skillEvolutionReviewerConcurrency,
    skillEvolutionReviewQueuePath: resolveContainedPath(
      runtimeDataRoot,
      'data',
      skillEvolutionReviewQueuePath,
      'data/skill-evolution-review-queue.json',
    ),
    skillEvolutionOperationalRetryMinutes,
    skillEvolutionOperationalRetryMaxHours,
    skillEvolutionReviewAttemptDeadlineMinutes,
    skillEvolutionReviewMaxCandidates,
    skillEvolutionReviewMaxPromptTokens,
    ...(skillEvolutionAuthorModel && { skillEvolutionAuthorModel }),
    ...(skillEvolutionVerifierModel && { skillEvolutionVerifierModel }),
    evidenceCapsulePath,
    externalSessionLogSourcesEnabled,
    externalSessionLogEnabledProviders,
    externalSessionLogMaxConcurrency,
    externalSessionLogHistoryMode: externalHistoryMode.mode,
    ...(externalHistoryMode.diagnostic
      ? { externalSessionLogHistoryModeDiagnostic: externalHistoryMode.diagnostic }
      : {}),
    ...(externalSessionLogSelectedProvider ? { externalSessionLogSelectedProvider } : {}),
    ...(externalSessionLogSelectedSourceId ? { externalSessionLogSelectedSourceId } : {}),
    ...(externalSessionLogXurlCommand ? { externalSessionLogXurlCommand } : {}),
  };
}
