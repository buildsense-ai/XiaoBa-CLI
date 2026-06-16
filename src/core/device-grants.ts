import { randomUUID } from 'crypto';
import type {
  DeviceGrantOperation,
  DeviceGrantStatus,
  ExecutionScope,
  MessageSource,
  ScopedDeviceGrant,
  UserDevice,
  UserDeviceStatus,
} from '../types/session-identity';
import type { ToolExecutionContext } from '../types/tool';
import { normalizeCatsCoUserId, sameCatsCoUserId } from '../catscompany/user-id';

export const DEFAULT_DEVICE_GRANT_TTL_MS = 10 * 60 * 1000;

export interface CreateUserDeviceInput {
  source: MessageSource;
  ownerUserId: string;
  deviceId: string;
  displayName?: string;
  bodyId?: string;
  installationId?: string;
  identityTrust?: UserDevice['identityTrust'];
  identitySource?: string;
  status?: UserDeviceStatus;
  registeredAt?: number;
  lastSeenAt?: number;
}

export interface CreateDeviceGrantOptions {
  operations: DeviceGrantOperation[];
  ttlMs?: number;
  now?: number;
  grantId?: string;
  status?: DeviceGrantStatus;
  identitySource?: string;
}

export type DeviceGrantDecision =
  | { ok: true; grant: ScopedDeviceGrant }
  | { ok: false; errorCode: 'PERMISSION_DENIED' | 'TOOL_EXECUTION_ERROR'; message: string };

export interface ResolveDeviceGrantOptions {
  operation: DeviceGrantOperation;
  deviceId?: string;
  now?: number;
}

const DELEGATED_DEVICE_GRANT_IDENTITY_SOURCES = new Set([
  'channel_identity_link',
]);

export function isDelegatedDeviceGrant(grant: Pick<ScopedDeviceGrant, 'identityTrust' | 'identitySource' | 'ownerUserId' | 'actorUserId'>): boolean {
  return grant.identityTrust === 'server_canonical'
    && !sameCatsCoUserId(grant.ownerUserId, grant.actorUserId)
    && DELEGATED_DEVICE_GRANT_IDENTITY_SOURCES.has(String(grant.identitySource || ''));
}

export function createUserDevice(input: CreateUserDeviceInput): UserDevice | undefined {
  const source = normalizeSource(input.source);
  const ownerUserId = normalizeCatsCoUserId(input.ownerUserId);
  const deviceId = normalizeId(input.deviceId);
  if (!ownerUserId || !deviceId) return undefined;
  const registeredAt = normalizeTime(input.registeredAt) ?? Date.now();

  return pruneUndefined({
    kind: 'user_device',
    source,
    ownerUserId,
    deviceId,
    displayName: normalizeId(input.displayName),
    bodyId: normalizeId(input.bodyId),
    installationId: normalizeId(input.installationId),
    identityTrust: normalizeIdentityTrust(input.identityTrust),
    identitySource: normalizeId(input.identitySource),
    status: normalizeStatus(input.status),
    registeredAt,
    lastSeenAt: normalizeTime(input.lastSeenAt),
  }) as UserDevice;
}

export function createDeviceGrant(
  scope: ExecutionScope | undefined,
  device: UserDevice | undefined,
  options: CreateDeviceGrantOptions,
): ScopedDeviceGrant | undefined {
  if (!scope || !device) return undefined;
  const operations = normalizeOperations(options.operations);
  if (operations.length === 0) return undefined;
  if (device.source !== scope.source) return undefined;
  if (!sameCatsCoUserId(device.ownerUserId, scope.actorUserId)) return undefined;
  const now = normalizeTime(options.now) ?? Date.now();
  const ttlMs = normalizeTtl(options.ttlMs);

  return pruneUndefined({
    kind: 'user_device_grant',
    source: device.source,
    grantId: normalizeId(options.grantId) || `device_grant_${randomUUID()}`,
    status: options.status || 'active',
    identityTrust: scope.identityTrust,
    identitySource: normalizeId(options.identitySource) || scope.permissionsSource,
    deviceId: device.deviceId,
    deviceDisplayName: device.displayName,
    deviceBodyId: device.bodyId,
    deviceInstallationId: device.installationId,
    ownerUserId: device.ownerUserId,
    sessionKey: scope.sessionKey,
    topicId: scope.topicId,
    topicType: scope.topicType,
    actorUserId: scope.actorUserId,
    agentId: scope.agentId,
    agentBodyId: scope.agentBodyId,
    operations,
    createdAt: now,
    expiresAt: now + ttlMs,
  }) as ScopedDeviceGrant;
}

export function resolveDeviceGrant(
  context: Pick<ToolExecutionContext, 'executionScope' | 'deviceGrants'>,
  options: ResolveDeviceGrantOptions,
): DeviceGrantDecision {
  const grants = context.deviceGrants || [];
  if (grants.length === 0) {
    return denied('当前会话没有可用的用户设备授权，无法操作本地设备。');
  }

  const normalizedDeviceId = normalizeId(options.deviceId);
  const matchingGrants = grants.filter(candidate => {
    if (normalizedDeviceId && candidate.deviceId !== normalizedDeviceId) return false;
    return candidate.operations.includes(options.operation);
  });

  if (matchingGrants.length === 0) {
    return denied(
      normalizedDeviceId
        ? `当前会话没有允许 ${options.operation} 的设备授权：${normalizedDeviceId}。`
        : `当前会话没有允许 ${options.operation} 的设备授权。`,
    );
  }

  const validDecisions = matchingGrants
    .map(candidate => validateDeviceGrant(context, candidate, options))
    .filter((decision): decision is Extract<DeviceGrantDecision, { ok: true }> => decision.ok);

  if (validDecisions.length === 0) {
    return validateDeviceGrant(context, matchingGrants[0], options);
  }

  if (!normalizedDeviceId) {
    const targetDeviceIds = new Set(validDecisions.map(decision => decision.grant.deviceId));
    if (targetDeviceIds.size > 1) {
      return denied(`当前会话有多个允许 ${options.operation} 的用户设备授权，请由后端指定目标 deviceId 后再执行。`);
    }
  }

  return validDecisions[0];
}

export function validateDeviceGrant(
  context: Pick<ToolExecutionContext, 'executionScope'>,
  grant: ScopedDeviceGrant,
  options: ResolveDeviceGrantOptions,
): DeviceGrantDecision {
  const scope = context.executionScope;
  if (!scope) {
    return denied('当前工具调用缺少执行身份，无法校验用户设备授权。');
  }

  const normalizedDeviceId = normalizeId(options.deviceId);
  if (normalizedDeviceId && grant.deviceId !== normalizedDeviceId) {
    return denied(`设备授权与目标设备不一致，已阻止操作：grant=${grant.deviceId} target=${normalizedDeviceId}`);
  }

  if (grant.status !== 'active') {
    return denied(`设备授权不是 active 状态，已阻止操作：${grant.status}`);
  }

  if (grant.identityTrust === 'untrusted') {
    return denied('设备授权来自未可信身份，已阻止操作。');
  }

  if (!grant.operations.includes(options.operation)) {
    return denied(`设备授权不允许执行 ${options.operation}。`);
  }

  const now = normalizeTime(options.now) ?? Date.now();
  if (grant.expiresAt <= now) {
    return denied('设备授权已过期，请让用户重新授权当前设备。');
  }

  const mismatches = [
    ['source', grant.source, scope.source],
    ['sessionKey', grant.sessionKey, scope.sessionKey],
    ['topicId', grant.topicId, scope.topicId],
    ['topicType', grant.topicType, scope.topicType],
    ['agentBodyId', grant.agentBodyId, scope.agentBodyId],
  ].filter(([, grantValue, scopeValue]) => grantValue !== scopeValue);

  if (!sameCatsCoUserId(grant.actorUserId, scope.actorUserId)) {
    mismatches.push(['actorUserId', grant.actorUserId, scope.actorUserId]);
  }

  if (!optionalSameCatsCoUserId(grant.agentId, scope.agentId)) {
    mismatches.push(['agentId', grant.agentId, scope.agentId]);
  }

  if (!sameCatsCoUserId(grant.ownerUserId, scope.actorUserId) && !isDelegatedDeviceGrant(grant)) {
    mismatches.push(['ownerUserId', grant.ownerUserId, scope.actorUserId]);
  }

  if (mismatches.length > 0) {
    return {
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: [
        '设备授权与当前执行身份不一致，已阻止操作以避免串用户或串设备。',
        ...mismatches.map(([field, grantValue, scopeValue]) => `${field}: grant=${grantValue || '(empty)'} scope=${scopeValue || '(empty)'}`),
      ].join('\n'),
    };
  }

  return { ok: true, grant };
}

function denied(message: string): DeviceGrantDecision {
  return { ok: false, errorCode: 'PERMISSION_DENIED', message };
}

function normalizeOperations(operations: DeviceGrantOperation[]): DeviceGrantOperation[] {
  const unique = new Set<DeviceGrantOperation>();
  for (const operation of operations) {
    if (isDeviceGrantOperation(operation)) unique.add(operation);
  }
  return [...unique];
}

function isDeviceGrantOperation(value: string): value is DeviceGrantOperation {
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

function normalizeSource(value: MessageSource | string | undefined): MessageSource {
  if (value === 'catscompany' || value === 'feishu' || value === 'weixin' || value === 'cli') {
    return value;
  }
  return 'unknown';
}

function normalizeStatus(value?: UserDeviceStatus): UserDeviceStatus {
  if (value === 'online' || value === 'offline') return value;
  return 'unknown';
}

function normalizeIdentityTrust(value?: UserDevice['identityTrust']): UserDevice['identityTrust'] {
  if (value === 'server_canonical' || value === 'legacy_context' || value === 'untrusted') return value;
  return 'untrusted';
}

function normalizeId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

function optionalSameCatsCoUserId(left: unknown, right: unknown): boolean {
  if (!left && !right) return true;
  return sameCatsCoUserId(left, right);
}

function normalizeTime(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function normalizeTtl(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return DEFAULT_DEVICE_GRANT_TTL_MS;
}

function pruneUndefined<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) {
      delete record[key];
    }
  }
  return value;
}
