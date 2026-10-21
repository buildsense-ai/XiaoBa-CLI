import type { TargetRoute, TargetRouteOS, TargetRoutes } from '../types/tool';
import type { ExecutionScope } from '../types/session-identity';
import { extractCatsCoDeviceGrants } from './device-grants';
import { extractCatsCoDeviceSelection } from './device-selection';

type UnknownRecord = Record<string, unknown>;

export function extractCatsCoRuntimeContext(metadata: Record<string, unknown> | undefined, scope?: ExecutionScope): TargetRoutes | undefined {
  const runtime = asRecord(metadata?.xiaoba_runtime);
  // New canonical selection metadata carries the full account directory even
  // when the server still sends a v1 directory for older cloud Bots.
  if (scope?.isTrusted && scope.identityTrust === 'server_canonical' && scope.source === 'catscompany') {
    const selection = extractCatsCoDeviceSelection(metadata, scope);
    const grants = extractCatsCoDeviceGrants(metadata, scope) || [];
    const explicit = grants.filter(grant => grant.targetScope === 'explicit_device'
      && grant.ownerUserId === scope.actorUserId && typeof selection?.revision === 'string'
      && (grant.selectionRevision || '') === selection.revision);
    if (explicit.length > 0 && selection?.candidates?.length) {
      const ownerRecord = (Array.isArray(runtime?.devices) ? runtime.devices : []).map(asRecord)
        .find(device => stringField(device, 'userId') === scope.actorUserId);
      return buildTargetRoutes(selection.candidates.map(device => ({
        userId: scope.actorUserId, ownerUserId: scope.actorUserId, deviceId: device.deviceId,
        userName: stringField(ownerRecord, 'userName'),
        label: device.displayName || device.deviceId, os: normalizeOS(device.os),
        status: device.status === 'ready' && explicit.some(grant => grant.deviceId === device.deviceId)
          ? 'ready' : 'unavailable',
      })));
    }
  }
  const schema = stringField(runtime, 'schema');
  if (!runtime || (schema !== 'xiaoba.runtime.v1' && schema !== 'xiaoba.runtime.v2')) return undefined;
  const ownerUserId = scope?.deviceOwnerUserId || scope?.actorUserId;
  if (schema === 'xiaoba.runtime.v2' && (!scope?.isTrusted || scope.identityTrust !== 'server_canonical'
    || scope.source !== 'catscompany' || !ownerUserId || stringField(runtime, 'ownerUserId') !== ownerUserId)) return undefined;
  const devices = Array.isArray(runtime.devices) ? runtime.devices : [];
  const routes: TargetRoute[] = [];
  for (const item of devices) {
    const record = asRecord(item);
    if (!record) continue;
    const userId = stringField(record, 'userId') || stringField(record, 'user_id');
    const deviceId = stringField(record, 'deviceId') || stringField(record, 'device_id');
    if (!userId || !deviceId) continue;
    if (scope && userId !== ownerUserId) continue;
    const userName = stringField(record, 'userName') || stringField(record, 'user_name');
    const label = stringField(record, 'label') || (userName ? `${userName} 的电脑` : `${userId} 的电脑`);
    routes.push({
      userId,
      userName,
      ownerUserId: userId,
      deviceId,
      label,
      os: normalizeOS(stringField(record, 'os')),
      status: schema === 'xiaoba.runtime.v1' || record.status === 'ready' ? 'ready' : 'unavailable',
    });
  }
  if (routes.length === 0) return undefined;
  return buildTargetRoutes(routes);
}

export function buildTargetRoutes(routes: TargetRoute[]): TargetRoutes | undefined {
  const directoryRoutes = routes.filter(route => route.userId && route.deviceId);
  if (directoryRoutes.length === 0) return undefined;
  const byName = new Map<string, TargetRoute[]>();
  const byUserId = new Map<string, TargetRoute[]>();
  for (const route of directoryRoutes) {
    addRoute(byUserId, route.userId, route);
    addRoute(byName, route.userId, route);
    addRoute(byName, route.userName, route);
    addRoute(byName, route.label, route);
    addRoute(byName, route.deviceId, route);
  }
  return { routes: directoryRoutes, byName, byUserId };
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
