import { getAutoDevServerUrl } from './autodev-config';

const DEFAULT_AUTO_INGEST_TIME = '23:59';
const DEFAULT_STABLE_MINUTES = 5;
const DEFAULT_MAX_FILES = 12;

export function getLogIngestServerUrl(): string {
  return getAutoDevServerUrl();
}

export function isLogIngestAutoEnabled(): boolean {
  const raw = process.env.LOG_INGEST_AUTO_ENABLED;
  if (raw == null || raw === '') {
    return true;
  }
  return String(raw).trim().toLowerCase() === 'true';
}

export function getLogIngestAutoTime(): string {
  return String(process.env.LOG_INGEST_AUTO_TIME || DEFAULT_AUTO_INGEST_TIME).trim() || DEFAULT_AUTO_INGEST_TIME;
}

export function getLogIngestStableMinutes(): number {
  const parsed = Number(process.env.LOG_INGEST_STABLE_MINUTES || DEFAULT_STABLE_MINUTES);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_STABLE_MINUTES;
  }
  return parsed;
}

export function getLogIngestAutoMaxFiles(): number {
  const parsed = Number(process.env.LOG_INGEST_AUTO_MAX_FILES || DEFAULT_MAX_FILES);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_FILES;
  }
  return Math.min(Math.floor(parsed), DEFAULT_MAX_FILES);
}
