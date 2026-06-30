import type { TargetRoute, TargetRouteOS, TargetRoutes } from '../types/tool';

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

export function buildTargetRoutes(routes: TargetRoute[]): TargetRoutes | undefined {
  const readyRoutes = routes.filter(route => route.status === 'ready' && route.userId && route.deviceId);
  if (readyRoutes.length === 0) return undefined;
  const byName = new Map<string, TargetRoute[]>();
  const byUserId = new Map<string, TargetRoute[]>();
  for (const route of readyRoutes) {
    addRoute(byUserId, route.userId, route);
    addRoute(byName, route.userId, route);
    addRoute(byName, route.userName, route);
    addRoute(byName, route.label, route);
  }
  return { routes: readyRoutes, byName, byUserId };
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
