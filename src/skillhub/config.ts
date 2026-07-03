import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { PathResolver } from '../utils/path-resolver';

export const DEFAULT_SKILLHUB_BASE_URL = 'https://logs.catsco.fun:9000';

export interface SkillHubConfig {
  baseUrl: string;
  dataDir: string;
  sessionFile: string;
}

export function loadSkillHubConfig(overrides: { baseUrl?: unknown } = {}): SkillHubConfig {
  const env = readEnvFile();
  const baseUrl = normalizeBaseUrl(
    firstNonEmpty(
      overrides.baseUrl,
      env.CATSCO_SKILLHUB_BASE_URL,
      process.env.CATSCO_SKILLHUB_BASE_URL,
      env.SKILLHUB_BASE_URL,
      process.env.SKILLHUB_BASE_URL,
    ),
    DEFAULT_SKILLHUB_BASE_URL,
  );
  const dataDir = PathResolver.getDataPath('skillhub');
  return {
    baseUrl,
    dataDir,
    sessionFile: path.join(dataDir, 'session.json'),
  };
}

export function normalizeBaseUrl(value: unknown, fallback = DEFAULT_SKILLHUB_BASE_URL): string {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return fallback;
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

function readEnvFile(): Record<string, string> {
  const envPath = path.join(PathResolver.getRuntimeDataRoot(), '.env');
  if (!fs.existsSync(envPath)) return {};
  return dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return undefined;
}
