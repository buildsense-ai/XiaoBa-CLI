import type {
  DeviceGrantOperation,
  ExecutionScope,
  ScopedDeviceGrant,
  ScopedDeviceSelection,
} from '../types/session-identity';
import type { TargetRoute, TargetRouteOS, TargetRoutes } from '../types/tool';
import {
  bindCatsCoRuntimeContextToDeviceGrants,
  buildCatsCoTargetAlias,
  isCurrentScopedCatsCoDeviceGrant,
} from '../catscompany/runtime-context';
import { sameCatsCoUserId, sanitizeCatsCoSpeakerId } from '../catscompany/speaker-label';

const OPERATION_ORDER: readonly DeviceGrantOperation[] = [
  'read_file',
  'resolve_common_directory',
  'glob',
  'grep',
  'write_file',
  'edit_file',
  'send_file',
  'execute_shell',
  'browser_control',
  'desktop_control',
];

export interface AuthorizedDeviceProjectionTarget {
  target: string;
  ownerUserId: string;
  ownerDisplayName: string;
  ownerModelId: string;
  deviceId: string;
  deviceDisplayName: string;
  os: TargetRouteOS;
  operations: DeviceGrantOperation[];
  grants: ScopedDeviceGrant[];
}

export interface AuthorizedDeviceProjection {
  schema: 'xiaoba.authorized_device_projection.v1';
  targets: AuthorizedDeviceProjectionTarget[];
}

export interface AuthorizedDeviceProjectionInput {
  executionScope?: ExecutionScope;
  deviceGrants?: readonly ScopedDeviceGrant[];
  deviceSelection?: ScopedDeviceSelection;
  targetRoutes?: TargetRoutes;
  remoteTransportAvailable?: boolean;
  now?: number;
}

export function buildAuthorizedDeviceProjection(
  input: AuthorizedDeviceProjectionInput,
): AuthorizedDeviceProjection {
  const scope = input.executionScope;
  const now = input.now ?? Date.now();
  if (
    input.remoteTransportAvailable === false
    ||
    !scope
    || scope.source !== 'catscompany'
    || scope.identityTrust !== 'server_canonical'
    || !scope.isTrusted
  ) return emptyProjection();

  const grants = (input.deviceGrants || [])
    .filter(grant => isCurrentScopedCatsCoDeviceGrant(grant, scope, now));
  const boundRoutes = bindCatsCoRuntimeContextToDeviceGrants(
    input.targetRoutes,
    scope,
    grants,
    now,
  );
  const targets: AuthorizedDeviceProjectionTarget[] = [];
  for (const route of boundRoutes?.routes || []) {
    const routeGrants = grants.filter(candidate => (
      candidate.deviceId === route.deviceId
      && sameCatsCoUserId(candidate.ownerUserId, route.ownerUserId)
    )).sort((left, right) => left.grantId.localeCompare(right.grantId));
    if (routeGrants.length === 0) continue;
    const operations = effectiveOperations(routeGrants, input.deviceSelection, scope);
    if (operations.length === 0) continue;
    targets.push(projectRoute(route, routeGrants, operations, scope));
  }

  const speakerHasTarget = targets.some(target => (
    sameCatsCoUserId(target.ownerUserId, scope.actorUserId)
  ));
  if (!speakerHasTarget) {
    const speakerGrants = grants.filter(grant => sameCatsCoUserId(grant.ownerUserId, scope.actorUserId));
    const selectedId = validSelectedDeviceId(input.deviceSelection, scope);
    const speakerDeviceIds = [...new Set(speakerGrants.map(grant => grant.deviceId))];
    const deviceId = selectedId
      ? speakerDeviceIds.find(candidate => candidate === selectedId)
      : speakerDeviceIds.length === 1
        ? speakerDeviceIds[0]
        : undefined;
    const deviceGrants = deviceId
      ? speakerGrants
        .filter(grant => grant.deviceId === deviceId)
        .sort((left, right) => left.grantId.localeCompare(right.grantId))
      : [];
    if (deviceGrants.length > 0) {
      const operations = effectiveOperations(deviceGrants, input.deviceSelection, scope);
      if (operations.length > 0) {
        targets.push(projectSpeakerDefault(deviceGrants, operations));
      }
    }
  }

  targets.sort((left, right) => (
    left.ownerUserId.localeCompare(right.ownerUserId)
    || left.deviceId.localeCompare(right.deviceId)
  ));
  return { schema: 'xiaoba.authorized_device_projection.v1', targets };
}

export function authorizedDeviceProjectionCanonicalValue(
  projection: AuthorizedDeviceProjection,
): string {
  return JSON.stringify(projection.targets.map(target => [
    target.target,
    target.ownerModelId,
    target.ownerDisplayName,
    target.deviceDisplayName,
    target.os,
    target.operations,
  ]));
}

export function authorizedDeviceProjectionTargetLine(
  target: AuthorizedDeviceProjectionTarget,
): string {
  const availableTools = target.operations.flatMap(operation => {
    const tool = remoteToolNameForDeviceOperation(operation);
    return tool ? [tool] : [];
  });
  const unavailableCapabilities = target.operations.filter(operation => (
    operation === 'browser_control' || operation === 'desktop_control'
  ));
  return `- target="${target.target}"：用户 ${target.ownerDisplayName} (id=${target.ownerModelId})；`
    + `设备 ${target.deviceDisplayName}，${formatOS(target.os)}；`
    + `已授权操作对应工具（仅当本轮提供该工具时可调用）：${availableTools.join(', ') || '无'}`
    + (unavailableCapabilities.length > 0
      ? `；已授权但当前无远程工具：${unavailableCapabilities.join(', ')}`
      : '');
}

export function remoteToolNameForDeviceOperation(
  operation: DeviceGrantOperation,
): string | undefined {
  if (operation === 'browser_control' || operation === 'desktop_control') return undefined;
  return operation === 'send_file' ? 'import_file' : operation;
}

function projectRoute(
  route: TargetRoute,
  grants: ScopedDeviceGrant[],
  operations: DeviceGrantOperation[],
  scope: ExecutionScope,
): AuthorizedDeviceProjectionTarget {
  const grant = grants[0];
  const ownerModelId = sanitizeCatsCoSpeakerId(grant.ownerUserId, 'User');
  return {
    target: route.targetAlias || buildCatsCoTargetAlias(scope, grant.ownerUserId, grant.deviceId),
    ownerUserId: grant.ownerUserId,
    // Capability-bearing system context must not promote upstream display text
    // into instructions. Opaque IDs and neutral labels are sufficient to route.
    ownerDisplayName: ownerModelId,
    ownerModelId,
    deviceId: grant.deviceId,
    deviceDisplayName: '已授权用户电脑',
    os: route.os,
    operations,
    grants,
  };
}

function formatOS(os: TargetRouteOS): string {
  switch (os) {
    case 'windows':
      return 'Windows';
    case 'macos':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return 'Unknown';
  }
}

function projectSpeakerDefault(
  grants: ScopedDeviceGrant[],
  operations: DeviceGrantOperation[],
): AuthorizedDeviceProjectionTarget {
  const grant = grants[0];
  const ownerModelId = sanitizeCatsCoSpeakerId(grant.ownerUserId, 'User');
  return {
    target: 'speaker_default',
    ownerUserId: grant.ownerUserId,
    ownerDisplayName: ownerModelId,
    ownerModelId,
    deviceId: grant.deviceId,
    deviceDisplayName: '当前发言人的电脑',
    os: 'unknown',
    operations,
    grants,
  };
}

function effectiveOperations(
  grants: ScopedDeviceGrant[],
  selection: ScopedDeviceSelection | undefined,
  scope: ExecutionScope,
): DeviceGrantOperation[] {
  const grant = grants[0];
  const scopedSelection = validScopedSelection(selection, scope);
  if (
    scopedSelection
    && sameCatsCoUserId(grant.ownerUserId, scope.actorUserId)
    && (
      scopedSelection.status !== 'selected'
      || scopedSelection.selectedDeviceId !== grant.deviceId
    )
  ) return [];
  const selectedId = scopedSelection?.status === 'selected'
    ? scopedSelection.selectedDeviceId
    : undefined;
  const selectionOperations = selectedId === grant.deviceId
    ? scopedSelection?.selectedDeviceOperations
    : undefined;
  return OPERATION_ORDER.filter(operation => (
    grants.some(candidate => candidate.operations.includes(operation))
    && (!selectionOperations || selectionOperations.includes(operation))
  ));
}

function validSelectedDeviceId(
  selection: ScopedDeviceSelection | undefined,
  scope: ExecutionScope,
): string | undefined {
  const scoped = validScopedSelection(selection, scope);
  return scoped?.status === 'selected' ? scoped.selectedDeviceId : undefined;
}

function validScopedSelection(
  selection: ScopedDeviceSelection | undefined,
  scope: ExecutionScope,
): ScopedDeviceSelection | undefined {
  if (
    !selection
    || selection.identityTrust !== 'server_canonical'
    || selection.source !== scope.source
    || selection.sessionKey !== scope.sessionKey
    || selection.topicId !== scope.topicId
    || selection.topicType !== scope.topicType
    || !sameCatsCoUserId(selection.actorUserId, scope.actorUserId)
    || selection.agentId !== scope.agentId
  ) return undefined;
  return selection;
}

function emptyProjection(): AuthorizedDeviceProjection {
  return { schema: 'xiaoba.authorized_device_projection.v1', targets: [] };
}
