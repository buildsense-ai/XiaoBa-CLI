import type { ExecutionScope, SkillConnectorGrant } from '../types/session-identity';

const MAX_GRANTS = 4;
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_FUTURE_MS = 11 * 60 * 1000;

export function extractCatsCoSkillConnectorGrants(
  metadata: unknown,
  scope: ExecutionScope,
  now = Date.now(),
): SkillConnectorGrant[] {
  if (
    scope.source !== 'catscompany'
    || !scope.isTrusted
    || scope.identityTrust !== 'server_canonical'
    || !scope.agentId
    || !isRecord(metadata)
  ) return [];

  const container = asRecord(metadata.catsco_skill_connectors);
  if (container?.schema !== 'catsco.skill_connectors.v1' || !Array.isArray(container.grants)) return [];

  const grants: SkillConnectorGrant[] = [];
  for (const raw of container.grants.slice(0, MAX_GRANTS)) {
    const grant = asRecord(raw);
    const provider = stringValue(grant?.provider).toLowerCase();
    const skillId = stringValue(grant?.skill_id);
    const connectorUrl = normalizeConnectorUrl(grant?.connector_url);
    const actorToken = stringValue(grant?.actor_token);
    const expiresAt = Date.parse(stringValue(grant?.expires_at));
    if (
      !/^[a-z0-9._-]{1,64}$/.test(provider)
      || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(skillId)
      || !connectorUrl
      || !actorToken
      || actorToken.length > MAX_TOKEN_LENGTH
      || !Number.isFinite(expiresAt)
      || expiresAt <= now
      || expiresAt > now + MAX_FUTURE_MS
    ) continue;
    grants.push({ provider, skillId, connectorUrl, actorToken, expiresAt });
  }
  return grants;
}

function normalizeConnectorUrl(value: unknown): string | undefined {
  try {
    const parsed = new URL(stringValue(value));
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    const hostname = parsed.hostname.toLowerCase();
    const localHTTP = parsed.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '::1'].includes(hostname);
    if (parsed.protocol !== 'https:' && !localHTTP) return undefined;
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
