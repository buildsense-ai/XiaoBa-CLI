import type {
  DeviceGrantOperation,
  DeviceSelectionCandidate,
  DeviceSelectionStatus,
  ExecutionScope,
  MessageSource,
  MessageTopicType,
  ScopedDeviceSelection,
} from '../types/session-identity';
import { normalizeCatsCoUserId, sameCatsCoUserId } from './user-id';

type UnknownRecord = Record<string, unknown>;

export function extractCatsCoDeviceSelection(
  metadata: Record<string, unknown> | undefined,
  scope: ExecutionScope,
): ScopedDeviceSelection | undefined {
  if (scope.identityTrust !== 'server_canonical') return undefined;
  const identity = asRecord(metadata?.catsco_identity);
  const permissions = asRecord(identity?.permissions);
  if (stringField(permissions, 'source') !== 'server_canonical_message') return undefined;

  const rawSelection = asRecord(identity?.device_selection) ?? asRecord(permissions?.device_selection);
  if (!rawSelection) return undefined;

  const selection = normalizeDeviceSelection(rawSelection, scope);
  if (!selectionMatchesScope(selection, scope)) return undefined;
  return selection;
}

function normalizeDeviceSelection(record: UnknownRecord, scope: ExecutionScope): ScopedDeviceSelection | undefined {
  if (stringField(record, 'kind') !== 'user_device_selection') return undefined;
  const source = normalizeSource(stringField(record, 'source'));
  if (source !== 'catscompany') return undefined;

  const selectedDevice = asRecord(record.selectedDevice) ?? asRecord(record.selected_device);
  const selectedDeviceId = stringField(record, 'selectedDeviceId')
    || stringField(record, 'selected_device_id')
    || stringField(selectedDevice, 'deviceId')
    || stringField(selectedDevice, 'device_id');
  const status = normalizeStatus(stringField(record, 'status'), selectedDeviceId);
  if (status === 'selected' && !selectedDeviceId) return undefined;

  const sessionKey = stringField(record, 'sessionKey') || stringField(record, 'session_key');
  const topicId = stringField(record, 'topicId') || stringField(record, 'topic_id');
  const actorUserId = normalizeCatsCoUserId(stringField(record, 'actorUserId') || stringField(record, 'actor_user_id'));
  if (!sessionKey || !topicId || !actorUserId) return undefined;

  return pruneUndefined({
    kind: 'user_device_selection',
    source,
    status,
    selectionSource: stringField(record, 'selectionSource') || stringField(record, 'selection_source'),
    sessionKey,
    topicId,
    topicType: normalizeTopicType(stringField(record, 'topicType') || stringField(record, 'topic_type')),
    actorUserId,
    agentId: normalizeCatsCoUserId(stringField(record, 'agentId') || stringField(record, 'agent_id')),
    identityTrust: scope.identityTrust,
    identitySource: 'metadata.catsco_identity',
    selectedDeviceId,
    selectedDeviceDisplayName: stringField(record, 'selectedDeviceDisplayName')
      || stringField(record, 'selected_device_display_name')
      || stringField(selectedDevice, 'displayName')
      || stringField(selectedDevice, 'display_name'),
    selectedDeviceBodyId: stringField(record, 'selectedDeviceBodyId')
      || stringField(record, 'selected_device_body_id')
      || stringField(selectedDevice, 'bodyId')
      || stringField(selectedDevice, 'body_id'),
    selectedDeviceInstallationId: stringField(record, 'selectedDeviceInstallationId')
      || stringField(record, 'selected_device_installation_id')
      || stringField(selectedDevice, 'installationId')
      || stringField(selectedDevice, 'installation_id'),
    selectedDeviceOperations: normalizeOperations(selectedDevice?.operations ?? record.selectedDeviceOperations ?? record.selected_device_operations),
    candidates: normalizeCandidates(record.candidates),
    candidateCount: numberField(record, 'candidateCount') ?? numberField(record, 'candidate_count'),
    createdAt: numberField(record, 'createdAt') ?? numberField(record, 'created_at'),
  }) as ScopedDeviceSelection;
}

function selectionMatchesScope(selection: ScopedDeviceSelection | undefined, scope: ExecutionScope): selection is ScopedDeviceSelection {
  return Boolean(selection)
    && selection!.source === scope.source
    && selection!.sessionKey === scope.sessionKey
    && selection!.topicId === scope.topicId
    && selection!.topicType === scope.topicType
    && sameCatsCoUserId(selection!.actorUserId, scope.actorUserId)
    && optionalSameCatsCoUserId(selection!.agentId, scope.agentId);
}

function optionalSameCatsCoUserId(left: unknown, right: unknown): boolean {
  if (!left && !right) return true;
  return sameCatsCoUserId(left, right);
}

function normalizeCandidates(value: unknown): DeviceSelectionCandidate[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const candidates = value
    .map(item => {
      const record = asRecord(item);
      if (!record) return undefined;
      const deviceId = stringField(record, 'deviceId') || stringField(record, 'device_id');
      if (!deviceId) return undefined;
      return pruneUndefined({
        deviceId,
        displayName: stringField(record, 'displayName') || stringField(record, 'display_name'),
        operations: normalizeOperations(record.operations),
        lastSeenAt: numberField(record, 'lastSeenAt') ?? numberField(record, 'last_seen_at'),
      }) as DeviceSelectionCandidate;
    })
    .filter((item): item is DeviceSelectionCandidate => Boolean(item));
  return candidates.length > 0 ? candidates : undefined;
}

function normalizeOperations(value: unknown): DeviceGrantOperation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const unique = new Set<DeviceGrantOperation>();
  for (const item of value) {
    if (isDeviceGrantOperation(item)) unique.add(item);
  }
  return unique.size > 0 ? [...unique] : undefined;
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

function normalizeStatus(value: string | undefined, selectedDeviceId?: string): DeviceSelectionStatus {
  if (value === 'needs_selection' || value === 'unavailable') return value;
  if (value === 'selected' || selectedDeviceId) return 'selected';
  return 'needs_selection';
}

function normalizeSource(value: string | undefined): MessageSource {
  return value === 'catscompany' ? 'catscompany' : 'unknown';
}

function normalizeTopicType(value: string | undefined): MessageTopicType {
  if (value === 'p2p' || value === 'group') return value;
  return 'unknown';
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

function numberField(record: UnknownRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
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
