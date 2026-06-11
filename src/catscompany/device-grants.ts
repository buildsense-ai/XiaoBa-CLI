import type {
  DeviceGrantOperation,
  DeviceGrantStatus,
  ExecutionScope,
  IdentityTrustLevel,
  MessageSource,
  MessageTopicType,
  ScopedDeviceGrant,
} from '../types/session-identity';
import { isDelegatedDeviceGrant } from '../core/device-grants';

type UnknownRecord = Record<string, unknown>;

export function extractCatsCoDeviceGrants(
  metadata: Record<string, unknown> | undefined,
  scope: ExecutionScope,
): ScopedDeviceGrant[] | undefined {
  if (scope.identityTrust !== 'server_canonical') return undefined;
  const identity = asRecord(metadata?.catsco_identity);
  const permissions = asRecord(identity?.permissions);
  if (stringField(permissions, 'source') !== 'server_canonical_message') return undefined;

  const rawGrants = arrayField(identity, 'device_grants')
    ?? arrayField(permissions, 'device_grants');
  if (!rawGrants || rawGrants.length === 0) return undefined;

  const grants = rawGrants
    .map(normalizeDeviceGrant)
    .filter((grant): grant is ScopedDeviceGrant => Boolean(grant))
    .filter(grant => grantMatchesScope(grant, scope));

  return grants.length > 0 ? grants : undefined;
}

function normalizeDeviceGrant(value: unknown): ScopedDeviceGrant | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (stringField(record, 'kind') !== 'user_device_grant') return undefined;
  const source = normalizeSource(stringField(record, 'source'));
  if (source !== 'catscompany') return undefined;

  const grantId = stringField(record, 'grantId') || stringField(record, 'grant_id');
  const deviceId = stringField(record, 'deviceId') || stringField(record, 'device_id');
  const ownerUserId = stringField(record, 'ownerUserId') || stringField(record, 'owner_user_id');
  const sessionKey = stringField(record, 'sessionKey') || stringField(record, 'session_key');
  const topicId = stringField(record, 'topicId') || stringField(record, 'topic_id');
  const actorUserId = stringField(record, 'actorUserId') || stringField(record, 'actor_user_id');
  const operations = normalizeOperations(record.operations);
  const createdAt = numberField(record, 'createdAt') ?? numberField(record, 'created_at');
  const expiresAt = numberField(record, 'expiresAt') ?? numberField(record, 'expires_at');
  const status = normalizeStatus(stringField(record, 'status'));
  if (!grantId || !deviceId || !ownerUserId || !sessionKey || !topicId || !actorUserId) return undefined;
  if (operations.length === 0 || createdAt === undefined || expiresAt === undefined) return undefined;
  if (status !== 'active') return undefined;

  return pruneUndefined({
    kind: 'user_device_grant',
    source,
    grantId,
    status,
    identityTrust: normalizeTrust(stringField(record, 'identityTrust') || stringField(record, 'identity_trust')),
    identitySource: stringField(record, 'identitySource') || stringField(record, 'identity_source'),
    deviceId,
    deviceDisplayName: stringField(record, 'deviceDisplayName') || stringField(record, 'device_display_name'),
    deviceBodyId: stringField(record, 'deviceBodyId') || stringField(record, 'device_body_id'),
    deviceInstallationId: stringField(record, 'deviceInstallationId') || stringField(record, 'device_installation_id'),
    deviceActive: booleanField(record, 'deviceActive') ?? booleanField(record, 'device_active'),
    deviceRouteConnected: booleanField(record, 'deviceRouteConnected') ?? booleanField(record, 'device_route_connected'),
    deviceRoutable: booleanField(record, 'deviceRoutable') ?? booleanField(record, 'device_routable'),
    ownerUserId,
    sessionKey,
    topicId,
    topicType: normalizeTopicType(stringField(record, 'topicType') || stringField(record, 'topic_type')),
    actorUserId,
    agentId: stringField(record, 'agentId') || stringField(record, 'agent_id'),
    agentBodyId: stringField(record, 'agentBodyId') || stringField(record, 'agent_body_id'),
    operations,
    createdAt,
    expiresAt,
  }) as ScopedDeviceGrant;
}

function grantMatchesScope(grant: ScopedDeviceGrant, scope: ExecutionScope): boolean {
  if (grant.ownerUserId !== grant.actorUserId && !isDelegatedDeviceGrant(grant)) {
    return false;
  }
  return grant.status === 'active'
    && grant.identityTrust === 'server_canonical'
    && grant.source === scope.source
    && grant.sessionKey === scope.sessionKey
    && grant.topicId === scope.topicId
    && grant.topicType === scope.topicType
    && grant.actorUserId === scope.actorUserId
    && grant.agentId === scope.agentId
    && grant.agentBodyId === scope.agentBodyId;
}

function normalizeOperations(value: unknown): DeviceGrantOperation[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<DeviceGrantOperation>();
  for (const item of value) {
    if (isDeviceGrantOperation(item)) unique.add(item);
  }
  return [...unique];
}

function isDeviceGrantOperation(value: unknown): value is DeviceGrantOperation {
  return value === 'read_file'
    || value === 'write_file'
    || value === 'edit_file'
    || value === 'send_file'
    || value === 'execute_shell'
    || value === 'glob'
    || value === 'grep'
    || value === 'browser_control'
    || value === 'desktop_control';
}

function normalizeSource(value: string | undefined): MessageSource {
  return value === 'catscompany' ? 'catscompany' : 'unknown';
}

function normalizeStatus(value: string | undefined): DeviceGrantStatus | undefined {
  if (value === 'active' || value === 'revoked') return value;
  return undefined;
}

function normalizeTrust(value: string | undefined): IdentityTrustLevel {
  return value === 'server_canonical' ? 'server_canonical' : 'untrusted';
}

function normalizeTopicType(value: string | undefined): MessageTopicType {
  if (value === 'p2p' || value === 'group') return value;
  return 'unknown';
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

function arrayField(record: UnknownRecord | undefined, key: string): unknown[] | undefined {
  const value = record?.[key];
  return Array.isArray(value) ? value : undefined;
}

function stringField(record: UnknownRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

function numberField(record: UnknownRecord, key: string): number | undefined {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function booleanField(record: UnknownRecord | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  if (typeof value === 'boolean') return value;
  return undefined;
}

function pruneUndefined<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return value;
}
