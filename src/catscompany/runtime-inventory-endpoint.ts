/**
 * Derive the HTTP origin used by the optional runtime-Skill inventory report.
 *
 * This request carries a Bot API key, so endpoint resolution deliberately
 * fails closed. URL credentials are rejected as well, because a failed
 * request must never surface those credentials through error handling or logs.
 */
export function inferCatsCompanyHttpBaseUrl(serverUrl: string): string | undefined {
  try {
    const url = new URL(serverUrl);
    if (url.username || url.password) return undefined;
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    else if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

/**
 * Select the HTTP origin for an inventory report. An omitted HTTP endpoint is
 * safely derived from the connected WebSocket; an explicit endpoint must be
 * same-origin with that WebSocket before the Bot API key may be sent.
 */
export function resolveRuntimeSkillInventoryHttpBaseUrl(
  serverUrl: string,
  configuredHttpBaseUrl?: string,
): string | undefined {
  const inferred = inferCatsCompanyHttpBaseUrl(serverUrl);
  if (!inferred) return undefined;
  const configured = String(configuredHttpBaseUrl || '').trim();
  if (!configured) return inferred;
  try {
    const url = new URL(configured);
    if (url.username || url.password) return undefined;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.pathname = '';
    url.search = '';
    url.hash = '';
    const normalized = url.toString().replace(/\/$/, '');
    return normalized === inferred ? normalized : undefined;
  } catch {
    return undefined;
  }
}
