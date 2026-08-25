/**
 * CatsCo production endpoint policy.
 *
 * app.catsco.cc remains the canonical endpoint. app.catsco.cn is an
 * explicitly allow-listed recovery endpoint for the migration period; it is
 * never derived from arbitrary user input.
 */
export const PRIMARY_CATSCO_HTTP_BASE_URL = 'https://app.catsco.cc';
export const FALLBACK_CATSCO_HTTP_BASE_URL = 'https://app.catsco.cn';
export const PRIMARY_CATSCO_WS_URL = 'wss://app.catsco.cc/v0/channels';
export const FALLBACK_CATSCO_WS_URL = 'wss://app.catsco.cn/v0/channels';

function replaceOrigin(value: unknown, fromOrigin: string, toOrigin: string): string | undefined {
  const text = String(value || '').trim();
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.origin !== fromOrigin) return undefined;
    url.hostname = new URL(toOrigin).hostname;
    url.protocol = new URL(toOrigin).protocol;
    url.port = new URL(toOrigin).port;
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

export function fallbackCatsCoHttpBaseUrl(value: unknown): string | undefined {
  const fallback = replaceOrigin(value, PRIMARY_CATSCO_HTTP_BASE_URL, FALLBACK_CATSCO_HTTP_BASE_URL);
  return fallback ? fallback.replace(/\/$/, '') : undefined;
}

export function fallbackCatsCoServerUrl(value: unknown): string | undefined {
  return replaceOrigin(value, PRIMARY_CATSCO_WS_URL.replace('/v0/channels', ''), FALLBACK_CATSCO_WS_URL.replace('/v0/channels', ''));
}

export function catsCoHttpBaseUrlCandidates(value: unknown): string[] {
  const primary = String(value || '').trim().replace(/\/+$/, '');
  if (!primary) return [];
  const fallback = fallbackCatsCoHttpBaseUrl(primary);
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

export function catsCoServerUrlCandidates(value: unknown): string[] {
  const primary = String(value || '').trim().replace(/\/+$/, '');
  if (!primary) return [];
  const fallback = fallbackCatsCoServerUrl(primary);
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

export function isCatsCoNetworkFailure(error: any): boolean {
  const code = String(error?.cause?.code || error?.code || '').trim();
  const message = String(error?.cause?.message || error?.message || '').trim();
  return error?.name === 'AbortError'
    || !Number.isFinite(Number(error?.status))
      && (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|UND_ERR|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(code)
        || /getaddrinfo|timed?out|timeout|socket|network|fetch failed|connect/i.test(message));
}
