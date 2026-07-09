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
const MIN_INTERVAL_HOURS = 1;

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
  return Math.floor(parsed);
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
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
  const intervalHours = readNumber(
    runtimeEnv,
    'DISTILLATION_HEARTBEAT_INTERVAL_HOURS',
    DEFAULT_INTERVAL_HOURS,
    MIN_INTERVAL_HOURS,
  );
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

  return {
    enabled,
    intervalHours,
    logsRoot,
    stateFilePath,
    heartbeatRecordPath,
  };
}
