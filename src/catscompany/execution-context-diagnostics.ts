import { Logger } from '../utils/logger';
import type { ExecutionScope, ScopedDeviceGrant, ScopedDeviceSelection } from '../types/session-identity';

export interface CatsCoExecutionContextDiagnosticsInput {
  sessionKey: string;
  topic: string;
  senderId: string;
  text: string;
  executionScope?: ExecutionScope;
  deviceSelection?: ScopedDeviceSelection;
  deviceGrants?: ScopedDeviceGrant[];
}

const DIAGNOSTIC_ENV = 'XIAOBA_CATSCOMPANY_CONTEXT_DEBUG';

export function logCatsCoExecutionContextDiagnostics(input: CatsCoExecutionContextDiagnosticsInput): void {
  if (process.env[DIAGNOSTIC_ENV] !== 'true') return;

  const selection = input.deviceSelection;
  const grants = input.deviceGrants || [];
  const candidates = selection?.candidates || [];
  const lines = [
    '[CatsCompany execution context diagnostics]',
    `sessionKey=${input.sessionKey}`,
    `topic=${input.topic}`,
    `senderId=${input.senderId}`,
    `text=${oneLine(input.text, 240)}`,
    `scope=${JSON.stringify(pruneUndefined({
      source: input.executionScope?.source,
      topicType: input.executionScope?.topicType,
      actorUserId: input.executionScope?.actorUserId,
      agentId: input.executionScope?.agentId,
      agentBodyId: input.executionScope?.agentBodyId,
      permissionsSource: input.executionScope?.permissionsSource,
      deviceOwnerUserId: input.executionScope?.deviceOwnerUserId,
      deviceOwnerSource: input.executionScope?.deviceOwnerSource,
      identityTrust: input.executionScope?.identityTrust,
      isTrusted: input.executionScope?.isTrusted,
    }))}`,
    `selection=${JSON.stringify(pruneUndefined({
      status: selection?.status,
      selectionSource: selection?.selectionSource,
      selectedDeviceId: selection?.selectedDeviceId,
      selectedDeviceDisplayName: selection?.selectedDeviceDisplayName,
      selectedDeviceBodyId: selection?.selectedDeviceBodyId,
      selectedDeviceInstallationId: selection?.selectedDeviceInstallationId,
      selectedDeviceOperations: selection?.selectedDeviceOperations,
      candidateCount: selection?.candidateCount,
    }))}`,
    `candidates=${JSON.stringify(candidates.map(item => pruneUndefined({
      deviceId: item.deviceId,
      displayName: item.displayName,
      operations: item.operations,
      lastSeenAt: item.lastSeenAt,
    })))}`,
    `grants=${JSON.stringify(grants.map(item => pruneUndefined({
      grantId: item.grantId,
      deviceId: item.deviceId,
      deviceDisplayName: item.deviceDisplayName,
      deviceBodyId: item.deviceBodyId,
      deviceInstallationId: item.deviceInstallationId,
      ownerUserId: item.ownerUserId,
      actorUserId: item.actorUserId,
      operations: item.operations,
      expiresAt: item.expiresAt,
    })))}`,
  ];
  Logger.info(lines.join('\n'));
}

function oneLine(value: string, maxLength: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function pruneUndefined<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return value;
}
