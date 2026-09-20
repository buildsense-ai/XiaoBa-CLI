/**
 * Domain compatibility helpers for the dual-domain (cc/cn) migration window.
 * New installations default to .cn endpoints; .cc remains a fully supported
 * sibling so existing installations keep working until their runtime fails
 * over automatically.
 */
export const CATSCO_APP_HTTP_ORIGINS = new Set([
  'https://app.catsco.cc',
  'https://app.catsco.cn',
]);

export const CATSCO_RELAY_ORIGINS = new Set([
  'https://relay.catsco.cc',
  'https://relay.catsco.cn',
]);

const CATSCO_WS_PATH = '/v0/channels';

export function isCatsCoAppHttpOrigin(value: unknown): boolean {
  const text = String(value || '').trim();
  if (!text) return false;
  try {
    return CATSCO_APP_HTTP_ORIGINS.has(new URL(text).origin);
  } catch {
    return false;
  }
}

export function isCatsCoWebSocketEndpoint(value: unknown): boolean {
  const text = String(value || '').trim();
  if (!text) return false;
  try {
    const url = new URL(text);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const appOrigin = `https://${url.host}`;
    return url.protocol === 'wss:'
      && CATSCO_APP_HTTP_ORIGINS.has(appOrigin)
      && pathname === CATSCO_WS_PATH;
  } catch {
    return false;
  }
}

export function isCatsRelayApiBase(value: unknown): boolean {
  const text = String(value || '').trim();
  if (!text) return false;
  try {
    return CATSCO_RELAY_ORIGINS.has(new URL(text).origin);
  } catch {
    return false;
  }
}

export type CatsCoDomainFamily = 'cc' | 'cn';

const CATSCO_FAMILY_SUFFIXES: Record<CatsCoDomainFamily, string> = {
  cc: '.catsco.cc',
  cn: '.catsco.cn',
};

/**
 * Returns the domain family of a CatsCo URL (`.catsco.cc` → 'cc',
 * `.catsco.cn` → 'cn'). Unrelated hosts and malformed input return undefined so
 * callers never rewrite customer-owned domains.
 */
export function catsCoDomainFamily(value: unknown): CatsCoDomainFamily | undefined {
  const text = String(value || '').trim();
  if (!text) return undefined;
  let hostname: string;
  try {
    hostname = new URL(text).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (hostname.endsWith(CATSCO_FAMILY_SUFFIXES.cc)) return 'cc';
  if (hostname.endsWith(CATSCO_FAMILY_SUFFIXES.cn)) return 'cn';
  return undefined;
}

/**
 * Swaps the cc/cn suffix while keeping scheme, subdomain label, port, path,
 * query and hash. Returns undefined for hosts that are not CatsCo domains.
 */
export function siblingCatsCoUrl(value: unknown): string | undefined {
  const family = catsCoDomainFamily(value);
  if (!family) return undefined;
  let url: URL;
  try {
    url = new URL(String(value).trim());
  } catch {
    return undefined;
  }
  const suffix = CATSCO_FAMILY_SUFFIXES[family];
  const siblingSuffix = family === 'cc' ? CATSCO_FAMILY_SUFFIXES.cn : CATSCO_FAMILY_SUFFIXES.cc;
  const hostname = url.hostname.toLowerCase();
  url.hostname = `${hostname.slice(0, -suffix.length)}${siblingSuffix}`;
  return url.toString().replace(/\/+$/, '');
}

/**
 * Returns the same URL rewritten to `family` when the value is a CatsCo domain
 * and the rewrite changes something; otherwise undefined (callers keep the
 * original value).
 */
export function catsCoUrlForFamily(
  value: unknown,
  family: CatsCoDomainFamily | undefined,
): string | undefined {
  if (!family) return undefined;
  const current = catsCoDomainFamily(value);
  if (!current || current === family) return undefined;
  return siblingCatsCoUrl(value);
}

/**
 * Builds the ordered endpoint candidates for failover: the configured endpoint
 * stays first unless `preferredFamily` (the last successful family) points to
 * the sibling. Non-CatsCo hosts get a single candidate.
 */
export function catsCoEndpointCandidates(
  configured: unknown,
  preferredFamily?: CatsCoDomainFamily,
): string[] {
  const text = String(configured || '').trim().replace(/\/+$/, '');
  if (!text) return [];
  const sibling = siblingCatsCoUrl(text);
  if (!sibling || sibling === text) return [text];
  const family = catsCoDomainFamily(text);
  return preferredFamily && family && preferredFamily !== family
    ? [sibling, text]
    : [text, sibling];
}
