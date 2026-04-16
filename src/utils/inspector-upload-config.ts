const DEFAULT_AUTO_UPLOAD_TIME = '20:00';
const DEFAULT_STABLE_MINUTES = 5;
const DEFAULT_MAX_FILES = 12;

export function getInspectorServerUrl(): string {
  return String(process.env.INSPECTOR_SERVER_URL || '').trim();
}

export function isInspectorAutoUploadEnabled(): boolean {
  const raw = process.env.INSPECTOR_AUTO_UPLOAD_ENABLED;
  if (raw == null || raw === '') {
    return true;
  }
  return String(raw).trim().toLowerCase() === 'true';
}

export function getInspectorAutoUploadTime(): string {
  return String(process.env.INSPECTOR_AUTO_UPLOAD_TIME || DEFAULT_AUTO_UPLOAD_TIME).trim() || DEFAULT_AUTO_UPLOAD_TIME;
}

export function getInspectorStableMinutes(): number {
  const parsed = Number(process.env.INSPECTOR_AUTO_UPLOAD_STABLE_MINUTES || DEFAULT_STABLE_MINUTES);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_STABLE_MINUTES;
  }
  return parsed;
}

export function getInspectorAutoUploadMaxFiles(): number {
  const parsed = Number(process.env.INSPECTOR_AUTO_UPLOAD_MAX_FILES || DEFAULT_MAX_FILES);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_FILES;
  }
  return Math.min(Math.floor(parsed), DEFAULT_MAX_FILES);
}
