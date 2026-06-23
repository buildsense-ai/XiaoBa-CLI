const MAX_PROVIDER_ERROR_LOG_MESSAGE_LENGTH = 240;

function valueToString(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pickErrorField(error: any, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = error?.[key] ?? error?.error?.[key] ?? error?.response?.[key];
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
  }
  return undefined;
}

export function sanitizeProviderErrorMessageForLog(error: unknown): string {
  const normalized = valueToString(error)
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/https?:\/\/[^\s'"`<>)}]+/gi, '[redacted-url]')
    .replace(/\bhost=(?:"[^"]*"|'[^']*'|[^\s,;)]+)/gi, 'host=[redacted-host]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[redacted-ip]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]')
    .replace(/\bcc_[A-Za-z0-9_-]{8,}\b/g, 'cc_[redacted]')
    .replace(/\bcats_svc_[A-Za-z0-9_-]+\b/g, 'cats_svc_[redacted]')
    .replace(/\bAuthorization\s*[:=]\s*(?:[A-Za-z][A-Za-z0-9+.-]*\s+)?[^\s,;'"`<>}]+/gi, 'Authorization: [redacted-token]')
    .replace(/\b(?:Bearer|ApiKey|Token)\s+[A-Za-z0-9._~+/=-]+/gi, match => `${match.split(/\s+/)[0]} [redacted-token]`)
    .replace(/(["']?)([A-Za-z0-9_.-]*(?:token|api[_-]?key|apikey|secret|password|credential)[A-Za-z0-9_.-]*)\1\s*[:=]\s*["']?[^&\s,'"`<>}]+["']?/gi, '$1$2$1=[redacted-token]')
    .trim();

  if (normalized.length <= MAX_PROVIDER_ERROR_LOG_MESSAGE_LENGTH) {
    return normalized || 'unknown error';
  }
  return `${normalized.slice(0, MAX_PROVIDER_ERROR_LOG_MESSAGE_LENGTH)}...(truncated)`;
}

export function classifyProviderErrorForLog(error: unknown): string {
  const text = sanitizeProviderErrorMessageForLog(error);
  if (/input_new_sensitive|image is sensitive|content\[\d+\]\s+image/i.test(text)) {
    return 'model_image_safety';
  }
  if (/request_timed_out|request timed out|timeout|ETIMEDOUT|gateway timeout|504/i.test(text)) {
    return 'provider_timeout';
  }
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|ConnectTimeout|Connection error|connection/i.test(text)) {
    return 'provider_connection';
  }
  if (/rate limit|too many requests|\b429\b/i.test(text)) {
    return 'provider_rate_limited';
  }
  if (/\b5\d\d\b|api_error|server error/i.test(text)) {
    return 'provider_server_error';
  }
  return 'provider_error';
}

export function formatProviderErrorForLog(error: unknown): string {
  const status = pickErrorField(error as any, ['status', 'statusCode']);
  const code = pickErrorField(error as any, ['code']);
  const type = pickErrorField(error as any, ['type']);
  const parts = [
    `category=${classifyProviderErrorForLog(error)}`,
    status ? `status=${status}` : '',
    code ? `code=${code}` : '',
    type ? `type=${type}` : '',
    `message=${sanitizeProviderErrorMessageForLog(error)}`,
  ].filter(Boolean);
  return parts.join(' ');
}
