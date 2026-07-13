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
  /** Optional Author model override. */
  skillEvolutionAuthorModel?: string;
  /** Optional independent Verifier model override. */
  skillEvolutionVerifierModel?: string;
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

  const enabled = readBoolean(runtimeEnv, 'DISTILLATION_HEARTBEAT_ENABLED', true);
  const intervalHours = readIntervalHours(runtimeEnv);
  const logsRoot = resolveContainedPath(
    workingDirectory,
    'logs',
    readEnv(runtimeEnv, 'DISTILLATION_HEARTBEAT_LOG_ROOT', 'CATSCO_LOG_ROOT', 'CATSLOG_LOG_ROOT'),
    'logs',
  );
  const stateFilePath = resolveContainedPath(
    workingDirectory,
    'data',
    readEnv(runtimeEnv, 'DISTILLATION_HEARTBEAT_STATE_FILE'),
    'data/distillation-cursor-state.json',
  );
  const heartbeatRecordPath = resolveContainedPath(
    workingDirectory,
    'data',
    readEnv(runtimeEnv, 'DISTILLATION_HEARTBEAT_RECORD_FILE'),
    'data/distillation-heartbeat-record.json',
  );
  const reviewOutcomesPath = resolveContainedPath(
    workingDirectory,
    'data',
    readEnv(runtimeEnv, 'DISTILLATION_HEARTBEAT_REVIEW_OUTCOMES_FILE'),
    'data/distillation-review-outcomes.json',
  );
  const needsReviewQueuePath = resolveContainedPath(
    workingDirectory,
    'data',
    readEnv(runtimeEnv, 'DISTILLATION_HEARTBEAT_NEEDS_REVIEW_QUEUE_FILE'),
    'data/needs-review-queue-state.json',
  );
  const capabilityRegistryPath = resolveContainedPath(
    workingDirectory,
    'data',
    readEnv(runtimeEnv, 'DISTILLATION_HEARTBEAT_CAPABILITY_REGISTRY_FILE'),
    'data/capability-registry-state.json',
  );
  const workLogRoot = resolveContainedPath(
    workingDirectory,
    'logs',
    readEnv(runtimeEnv, 'DISTILLATION_HEARTBEAT_WORK_LOG_ROOT'),
    'logs/branches/distillation',
  );
  // V3 is the production path. Operators and compatibility tests can still
  // opt back into V1 explicitly.
  const skillEvolutionEnabled = readBoolean(runtimeEnv, 'XIAOBA_SKILL_EVOLUTION_V3_ENABLED', true);
  const skillEvolutionRegistryPath = resolveContainedPath(
    workingDirectory,
    'data',
    readEnv(runtimeEnv, 'XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE'),
    'data/current-skill-registry.json',
  );
  const skillEvolutionAuditPath = resolveContainedPath(
    workingDirectory,
    'data',
    readEnv(runtimeEnv, 'XIAOBA_SKILL_EVOLUTION_AUDIT_FILE'),
    'data/transition-audit.jsonl',
  );
  const skillEvolutionJournalPath = resolveContainedPath(
    workingDirectory,
    'data',
    readEnv(runtimeEnv, 'XIAOBA_SKILL_EVOLUTION_JOURNAL_FILE'),
    'data/transition-journal.json',
  );
  const learningEpisodeStorePath = resolveContainedPath(
    workingDirectory,
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
    0,
  );
  const skillUsageLedgerPath = resolveContainedPath(
    workingDirectory,
    'data',
    readEnv(runtimeEnv, 'XIAOBA_SKILL_USAGE_LEDGER_FILE'),
    'data/skill-usage-ledger.jsonl',
  );
  const skillEvolutionCuratorStatePath = resolveContainedPath(
    workingDirectory,
    'data',
    readEnv(runtimeEnv, 'XIAOBA_SKILL_EVOLUTION_CURATOR_STATE_FILE'),
    'data/skill-evolution-curator-state.json',
  );
  const skillEvolutionReassessmentManifestPath = resolveContainedPath(
    workingDirectory,
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
    0,
  );
  const skillEvolutionOperationalRetryMaxHours = readNumber(
    runtimeEnv,
    'XIAOBA_SKILL_EVOLUTION_OPERATIONAL_RETRY_MAX_HOURS',
    6,
    0,
  );
  const skillEvolutionAuthorModel = readEnv(runtimeEnv, 'XIAOBA_SKILL_EVOLUTION_AUTHOR_MODEL');
  const skillEvolutionVerifierModel = readEnv(runtimeEnv, 'XIAOBA_SKILL_EVOLUTION_VERIFIER_MODEL');

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
      workingDirectory,
      'data',
      skillEvolutionReviewQueuePath,
      'data/skill-evolution-review-queue.json',
    ),
    skillEvolutionOperationalRetryMinutes,
    skillEvolutionOperationalRetryMaxHours,
    ...(skillEvolutionAuthorModel && { skillEvolutionAuthorModel }),
    ...(skillEvolutionVerifierModel && { skillEvolutionVerifierModel }),
  };
}
