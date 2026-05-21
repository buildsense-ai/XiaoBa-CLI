import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

const DEFAULT_API_BASE_URL = 'https://logs.catsco.fun:8000';
const DEFAULT_LOOKBACK_HOURS = 168;
const DEFAULT_INTERVAL_MINUTES = 1440;
const DEFAULT_MAX_FAILURES = 100;
const DEFAULT_MAX_SESSIONS = 30;
const DEFAULT_MAX_ENTRIES_PER_SESSION = 200;
const DEFAULT_MAX_TURNS_PER_SESSION = 80;
const DEFAULT_MAX_TARGET_TURNS = 500;

export interface CatscoReviewAgentConfig {
  enabled: boolean;
  apiBaseUrl: string;
  reviewToken?: string;
  outputDir: string;
  lookbackHours: number;
  intervalMinutes: number;
  maxFailures: number;
  maxSessions: number;
  maxEntriesPerSession: number;
  maxTurnsPerSession: number;
  maxTargetTurns: number;
  targetUserId?: string;
  targetDeviceId?: string;
  targetDeviceName?: string;
  targetUserKey?: string;
  targetDeviceKey?: string;
  targetSessionId?: string;
  targetSessionKey?: string;
  targetSessionType?: string;
  targetOrgKey?: string;
  targetOrgType?: string;
  targetUserRole?: string;
  targetDeviceRole?: string;
  targetChannelType?: string;
  targetWorkspaceKey?: string;
  targetRepo?: string;
  prBaseBranch: string;
  gitRemote: string;
  createBranch: boolean;
  commitChanges: boolean;
  createGithubPr: boolean;
}

function readEnv(env: NodeJS.ProcessEnv | Record<string, string>, ...keys: string[]): string | undefined {
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

function readBoolean(env: NodeJS.ProcessEnv | Record<string, string>, key: string, defaultValue: boolean): boolean {
  const raw = env[key];
  if (raw == null || raw === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function readNumber(
  env: NodeJS.ProcessEnv | Record<string, string>,
  key: string,
  defaultValue: number,
  min: number,
): number {
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

function resolveFromWorkingDirectory(workingDirectory: string, rawValue: string | undefined, fallback: string): string {
  const raw = rawValue || fallback;
  return path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(workingDirectory, raw);
}

export function getCatscoReviewAgentConfig(
  workingDirectory: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): CatscoReviewAgentConfig {
  const runtimeEnv = {
    ...loadDotenvValues(workingDirectory, env),
    ...env,
  };

  const apiBaseUrl = normalizeBaseUrl(
    readEnv(runtimeEnv, 'CATSCO_REVIEW_API_BASE_URL') || DEFAULT_API_BASE_URL,
  );
  const targetRepoRaw = readEnv(runtimeEnv, 'CATSCO_REVIEW_TARGET_REPO');

  return {
    enabled: readBoolean(runtimeEnv, 'CATSCO_REVIEW_ENABLED', true),
    apiBaseUrl,
    reviewToken: readEnv(runtimeEnv, 'CATSCO_REVIEW_TOKEN'),
    outputDir: resolveFromWorkingDirectory(
      workingDirectory,
      readEnv(runtimeEnv, 'CATSCO_REVIEW_OUTPUT_DIR'),
      'data/catsco-review-agent/runs',
    ),
    lookbackHours: readNumber(runtimeEnv, 'CATSCO_REVIEW_LOOKBACK_HOURS', DEFAULT_LOOKBACK_HOURS, 1),
    intervalMinutes: readNumber(runtimeEnv, 'CATSCO_REVIEW_INTERVAL_MINUTES', DEFAULT_INTERVAL_MINUTES, 1),
    maxFailures: readNumber(runtimeEnv, 'CATSCO_REVIEW_MAX_FAILURES', DEFAULT_MAX_FAILURES, 1),
    maxSessions: readNumber(runtimeEnv, 'CATSCO_REVIEW_MAX_SESSIONS', DEFAULT_MAX_SESSIONS, 1),
    maxEntriesPerSession: readNumber(
      runtimeEnv,
      'CATSCO_REVIEW_MAX_ENTRIES_PER_SESSION',
      DEFAULT_MAX_ENTRIES_PER_SESSION,
      1,
    ),
    maxTurnsPerSession: readNumber(
      runtimeEnv,
      'CATSCO_REVIEW_MAX_TURNS_PER_SESSION',
      DEFAULT_MAX_TURNS_PER_SESSION,
      1,
    ),
    maxTargetTurns: readNumber(runtimeEnv, 'CATSCO_REVIEW_MAX_TARGET_TURNS', DEFAULT_MAX_TARGET_TURNS, 1),
    targetUserId: readEnv(runtimeEnv, 'CATSCO_REVIEW_TARGET_USER_ID'),
    targetDeviceId: readEnv(runtimeEnv, 'CATSCO_REVIEW_TARGET_DEVICE_ID'),
    targetDeviceName: readEnv(runtimeEnv, 'CATSCO_REVIEW_TARGET_DEVICE_NAME'),
    targetUserKey: readEnv(runtimeEnv, 'CATSCO_REVIEW_TARGET_USER_KEY'),
    targetDeviceKey: readEnv(runtimeEnv, 'CATSCO_REVIEW_TARGET_DEVICE_KEY'),
    targetSessionId: readEnv(runtimeEnv, 'CATSCO_REVIEW_TARGET_SESSION_ID'),
    targetSessionKey: readEnv(runtimeEnv, 'CATSCO_REVIEW_TARGET_SESSION_KEY'),
    targetSessionType: readEnv(runtimeEnv, 'CATSCO_REVIEW_TARGET_SESSION_TYPE'),
    targetOrgKey: readEnv(runtimeEnv, 'CATSCO_REVIEW_TARGET_ORG_KEY'),
    targetOrgType: readEnv(runtimeEnv, 'CATSCO_REVIEW_TARGET_ORG_TYPE'),
    targetUserRole: readEnv(runtimeEnv, 'CATSCO_REVIEW_TARGET_USER_ROLE'),
    targetDeviceRole: readEnv(runtimeEnv, 'CATSCO_REVIEW_TARGET_DEVICE_ROLE'),
    targetChannelType: readEnv(runtimeEnv, 'CATSCO_REVIEW_TARGET_CHANNEL_TYPE'),
    targetWorkspaceKey: readEnv(runtimeEnv, 'CATSCO_REVIEW_TARGET_WORKSPACE_KEY'),
    targetRepo: targetRepoRaw ? resolveFromWorkingDirectory(workingDirectory, targetRepoRaw, workingDirectory) : undefined,
    prBaseBranch: readEnv(runtimeEnv, 'CATSCO_REVIEW_PR_BASE_BRANCH') || 'main',
    gitRemote: readEnv(runtimeEnv, 'CATSCO_REVIEW_GIT_REMOTE') || 'origin',
    createBranch: readBoolean(runtimeEnv, 'CATSCO_REVIEW_CREATE_BRANCH', false),
    commitChanges: readBoolean(runtimeEnv, 'CATSCO_REVIEW_COMMIT_CHANGES', false),
    createGithubPr: readBoolean(runtimeEnv, 'CATSCO_REVIEW_CREATE_GITHUB_PR', false),
  };
}

export function validateCatscoReviewAgentConfig(config: CatscoReviewAgentConfig): void {
  const missing: string[] = [];
  if (!config.apiBaseUrl) missing.push('CATSCO_REVIEW_API_BASE_URL');
  if (!config.reviewToken) missing.push('CATSCO_REVIEW_TOKEN');
  if (missing.length > 0) {
    throw new Error(`Missing required Review Agent settings: ${missing.join(', ')}`);
  }
}
