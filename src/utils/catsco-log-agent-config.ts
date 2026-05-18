import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

const DEFAULT_STABLE_MINUTES = 5;
const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_FILES_PER_CYCLE = 12;
const DEFAULT_API_BASE_URL = 'https://logs.catsco.fun:8000';

export interface CatscoLogAgentConfig {
  enabled: boolean;
  apiBaseUrl: string;
  stateFilePath: string;
  logsRoot: string;
  uploadIntervalMinutes: number;
  stableMinutes: number;
  maxFileBytes: number;
  maxFilesPerCycle: number;
  catscoUserToken?: string;
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

function normalizeBaseUrl(value?: string): string {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase();
    const isLocalhost = hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '::1'
      || hostname === '[::1]';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
      return '';
    }
    return parsed.origin;
  } catch {
    return '';
  }
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

export function getCatscoLogAgentConfig(
  workingDirectory: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): CatscoLogAgentConfig {
  const runtimeEnv = {
    ...loadDotenvValues(workingDirectory, env),
    ...env,
  };

  const apiBaseUrl = normalizeBaseUrl(
    readEnv(runtimeEnv, 'CATSCO_LOG_API_BASE_URL', 'CATSLOG_API_BASE_URL') || DEFAULT_API_BASE_URL,
  );
  const enabled = readBoolean(runtimeEnv, 'CATSCO_LOG_UPLOAD_ENABLED', true);
  const stateFilePath = resolveContainedPath(
    workingDirectory,
    'data',
    readEnv(runtimeEnv, 'CATSCO_LOG_STATE_FILE', 'CATSLOG_STATE_FILE'),
    'data/catsco-log-agent-state.json',
  );
  const logsRoot = resolveContainedPath(
    workingDirectory,
    'logs',
    readEnv(runtimeEnv, 'CATSCO_LOG_ROOT', 'CATSLOG_LOG_ROOT'),
    'logs',
  );

  return {
    enabled,
    apiBaseUrl,
    stateFilePath,
    logsRoot,
    uploadIntervalMinutes: readNumber(runtimeEnv, 'CATSCO_LOG_UPLOAD_INTERVAL_MINUTES', DEFAULT_INTERVAL_MINUTES, 1),
    stableMinutes: readNumber(runtimeEnv, 'CATSCO_LOG_STABLE_MINUTES', DEFAULT_STABLE_MINUTES, 0),
    maxFileBytes: readNumber(runtimeEnv, 'CATSCO_LOG_MAX_FILE_BYTES', DEFAULT_MAX_FILE_BYTES, 1),
    maxFilesPerCycle: readNumber(runtimeEnv, 'CATSCO_LOG_MAX_FILES_PER_CYCLE', DEFAULT_MAX_FILES_PER_CYCLE, 1),
    catscoUserToken: readEnv(runtimeEnv, 'CATSCO_USER_TOKEN', 'CATSCOMPANY_USER_TOKEN'),
  };
}
