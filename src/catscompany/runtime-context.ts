import { createHmac, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExecutionScope, ScopedDeviceGrant } from '../types/session-identity';
import type { TargetRoute, TargetRouteOS, TargetRoutes } from '../types/tool';
import { isDelegatedDeviceGrant } from '../core/device-grants';
import {
  sameCatsCoUserId,
  sanitizeCatsCoSpeakerLabel,
} from './speaker-label';
import { PathResolver } from '../utils/path-resolver';
import { Logger } from '../utils/logger';

type UnknownRecord = Record<string, unknown>;

export function extractCatsCoRuntimeContext(metadata: Record<string, unknown> | undefined): TargetRoutes | undefined {
  const runtime = asRecord(metadata?.xiaoba_runtime);
  if (!runtime || stringField(runtime, 'schema') !== 'xiaoba.runtime.v1') return undefined;
  const devices = Array.isArray(runtime.devices) ? runtime.devices : [];
  const routes: TargetRoute[] = [];
  for (const item of devices) {
    const record = asRecord(item);
    if (!record) continue;
    const userId = stringField(record, 'userId') || stringField(record, 'user_id');
    const deviceId = stringField(record, 'deviceId') || stringField(record, 'device_id');
    if (!userId || !deviceId) continue;
    const userName = stringField(record, 'userName') || stringField(record, 'user_name');
    const label = stringField(record, 'label') || (userName ? `${userName} 的电脑` : `${userId} 的电脑`);
    routes.push({
      userId,
      userName,
      ownerUserId: userId,
      deviceId,
      label,
      os: normalizeOS(stringField(record, 'os')),
      status: 'ready',
    });
  }
  if (routes.length === 0) return undefined;
  return buildTargetRoutes(routes);
}

export function buildTargetRoutes(
  routes: TargetRoute[],
  scope?: ExecutionScope,
): TargetRoutes | undefined {
  const readyRoutes = routes
    .filter(route => route.status === 'ready' && route.userId && route.deviceId)
    .map(route => ({
      ...route,
      targetAlias: scope
        ? buildCatsCoTargetAlias(scope, route.ownerUserId || route.userId, route.deviceId)
        : undefined,
    }))
    .filter((route, index, all) => all.findIndex(candidate => (
      candidate.ownerUserId === route.ownerUserId && candidate.deviceId === route.deviceId
    )) === index)
    .sort((left, right) => (
      left.ownerUserId.localeCompare(right.ownerUserId)
      || left.deviceId.localeCompare(right.deviceId)
    ));
  if (readyRoutes.length === 0) return undefined;
  const byName = new Map<string, TargetRoute[]>();
  const byUserId = new Map<string, TargetRoute[]>();
  for (const route of readyRoutes) {
    addRoute(byUserId, route.userId, route);
    addRoute(byName, route.userId, route);
    addRoute(byName, route.userName, route);
    addRoute(byName, route.label, route);
    addRoute(byName, route.targetAlias, route);
  }
  return { routes: readyRoutes, byName, byUserId };
}

/**
 * Discovery metadata can name a route, but only a current canonical grant can
 * make it model-visible or routable. Labels are presentation only; owner and
 * device IDs are matched before they are retained.
 */
export function bindCatsCoRuntimeContextToDeviceGrants(
  targetRoutes: TargetRoutes | undefined,
  scope: ExecutionScope | undefined,
  grants: readonly ScopedDeviceGrant[] | undefined,
  now = Date.now(),
): TargetRoutes | undefined {
  if (
    !targetRoutes
    || !scope
    || scope.source !== 'catscompany'
    || scope.identityTrust !== 'server_canonical'
    || !scope.isTrusted
  ) return undefined;

  const authorizedGrants = (grants || []).filter(grant => (
    isCurrentScopedCatsCoDeviceGrant(grant, scope, now)
  ));
  const routes = targetRoutes.routes.flatMap(route => {
    const grant = authorizedGrants.find(candidate => (
      candidate.deviceId === route.deviceId
      && sameCatsCoUserId(candidate.ownerUserId, route.ownerUserId || route.userId)
    ));
    if (!grant) return [];
    const ownerUserId = grant.ownerUserId;
    const ownerLabel = sanitizeCatsCoSpeakerLabel(route.userName || ownerUserId, ownerUserId);
    const deviceLabel = sanitizeCatsCoRuntimeLabel(
      grant.deviceDisplayName || route.label,
      `${ownerLabel} 的电脑`,
    );
    return [{
      ...route,
      userId: ownerUserId,
      ownerUserId,
      userName: ownerLabel,
      label: deviceLabel,
      targetAlias: buildCatsCoTargetAlias(scope, ownerUserId, grant.deviceId),
    }];
  });
  return buildTargetRoutes(routes, scope);
}

export function buildCatsCoTargetAlias(
  scope: ExecutionScope,
  ownerUserId: string,
  deviceId: string,
): string {
  const digest = createHmac('sha256', targetAliasSecret())
    .update(JSON.stringify([
      scope.source,
      scope.sessionKey,
      scope.topicId,
      scope.topicType,
      scope.actorUserId,
      scope.agentId || '',
      scope.agentBodyId || '',
      String(ownerUserId || '').trim(),
      String(deviceId || '').trim(),
    ]))
    .digest('hex')
    .slice(0, 16);
  return `device_target_${digest}`;
}

let cachedTargetAliasSecret: Buffer | undefined;

function targetAliasSecret(): Buffer {
  if (cachedTargetAliasSecret) return cachedTargetAliasSecret;
  const configured = String(process.env.XIAOBA_TARGET_ALIAS_SECRET || '').trim();
  if (/^[a-f0-9]{64}$/iu.test(configured)) {
    cachedTargetAliasSecret = Buffer.from(configured, 'hex');
    return cachedTargetAliasSecret;
  }
  try {
    const directory = path.join(PathResolver.getRuntimeDataRoot(), 'state');
    const secretPath = path.join(directory, 'device-target-alias.key');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      const fd = fs.openSync(secretPath, 'wx', 0o600);
      try {
        const secret = randomBytes(32);
        fs.writeFileSync(fd, secret);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try { fs.chmodSync(secretPath, 0o600); } catch { /* best effort */ }
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const persisted = fs.readFileSync(secretPath);
    if (persisted.length !== 32) throw new Error('device target alias secret has invalid length');
    cachedTargetAliasSecret = Buffer.from(persisted);
  } catch (error: any) {
    cachedTargetAliasSecret = randomBytes(32);
    Logger.warning(`[CatsCompany] durable target aliases unavailable; using process-private mapping: ${error?.message || error}`);
  }
  return cachedTargetAliasSecret;
}

export function isCurrentScopedCatsCoDeviceGrant(
  grant: ScopedDeviceGrant,
  scope: ExecutionScope,
  now = Date.now(),
): boolean {
  return grant.status === 'active'
    && grant.identityTrust === 'server_canonical'
    && grant.source === scope.source
    && grant.sessionKey === scope.sessionKey
    && grant.topicId === scope.topicId
    && grant.topicType === scope.topicType
    && sameCatsCoUserId(grant.actorUserId, scope.actorUserId)
    && (sameCatsCoUserId(grant.ownerUserId, scope.actorUserId) || isDelegatedDeviceGrant(grant))
    && grant.agentId === scope.agentId
    && grant.agentBodyId === scope.agentBodyId
    && grant.operations.length > 0
    && Number.isFinite(grant.expiresAt)
    && grant.expiresAt > now;
}

export function sanitizeCatsCoRuntimeLabel(value: unknown, fallback: unknown): string {
  return sanitizeCatsCoSpeakerLabel(value, fallback)
    .replace(/["'\\]/gu, character => (
      character === '"' ? '＂' : character === "'" ? '＇' : '＼'
    ));
}

export function sanitizeCatsCoDeviceLabel(
  value: unknown,
  deviceId: unknown,
  fallback: unknown = '用户电脑',
): string {
  const raw = String(value ?? '').trim();
  if (!raw || raw === String(deviceId ?? '').trim()) {
    return sanitizeCatsCoRuntimeLabel(fallback, '用户电脑');
  }
  return sanitizeCatsCoRuntimeLabel(raw, fallback);
}

export function normalizeTargetText(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function addRoute(index: Map<string, TargetRoute[]>, key: string | undefined, route: TargetRoute): void {
  const normalized = normalizeTargetText(key);
  if (!normalized) return;
  const list = index.get(normalized) || [];
  if (!list.some(item => item.userId === route.userId && item.deviceId === route.deviceId)) {
    list.push(route);
  }
  index.set(normalized, list);
}

function normalizeOS(value: string | undefined): TargetRouteOS {
  switch (String(value || '').trim().toLowerCase()) {
    case 'windows':
    case 'win32':
      return 'windows';
    case 'macos':
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return 'unknown';
  }
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

function stringField(record: UnknownRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}
