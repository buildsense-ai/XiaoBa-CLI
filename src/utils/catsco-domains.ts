/**
 * Domain compatibility helpers. The .cc endpoints remain the defaults for
 * existing installations, while the .cn endpoints are accepted during the
 * migration window.
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
