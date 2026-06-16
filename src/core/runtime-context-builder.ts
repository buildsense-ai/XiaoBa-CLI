import { Message } from '../types';
import type {
  ExecutionScope,
  MessageSource,
  MessageTopicType,
  ScopedDeviceGrant,
  ScopedDeviceSelection,
  ScopedLocalDeviceGrant,
  ScopedLocalFileGrant,
  SessionRoute,
} from '../types/session-identity';
import { readDefaultPromptLines } from '../utils/prompt-template';
import { parseSessionKeyV2 } from './session-router';

export const TRANSIENT_RUNTIME_CONTEXT_PREFIX = '[transient_runtime_context]';

export interface BuildRuntimeContextParams {
  sessionKey: string;
  sessionType?: string;
  sessionRoute?: SessionRoute;
  executionScope?: ExecutionScope;
  localDeviceGrant?: ScopedLocalDeviceGrant;
  deviceGrants?: ScopedDeviceGrant[];
  deviceSelection?: ScopedDeviceSelection;
  localFileGrants?: ScopedLocalFileGrant[];
}

interface RuntimeContextSnapshot {
  schema: 'xiaoba.runtime_context.v1';
  session: {
    key: string;
    legacyKey?: string;
    source: MessageSource;
    topic: {
      id: string;
      type: MessageTopicType;
    };
    agent?: {
      id?: string;
    };
  };
  turn: {
    actorUserId: string;
    messageId?: string;
    channelSeq?: number;
    identityTrust: string;
    identitySource?: string;
    permissionsSource?: string;
    isTrusted?: boolean;
  };
  execution: {
    mode: 'backend_controlled';
    scopeSource: 'execution_scope' | 'session_route' | 'session_key';
    toolsUseBackendScope: true;
    localDevice?: {
      source: MessageSource;
      deviceId?: string;
    };
    userDevices?: Array<{
      grantId: string;
      deviceId: string;
      displayName?: string;
      operations: string[];
      status: string;
      expiresAt: number;
    }>;
    deviceSelection?: {
      status: string;
      selectionSource?: string;
      selectedDevice?: {
        deviceId: string;
        displayName?: string;
        operations?: string[];
      };
      candidates?: Array<{
        deviceId: string;
        displayName?: string;
        operations?: string[];
      }>;
      candidateCount?: number;
    };
    localFiles?: Array<{
      ref?: string;
      fileName: string;
      fileType: string;
      operations: string[];
      expiresAt: number;
    }>;
  };
  rules: string[];
}

export function buildRuntimeContextMessage(params: BuildRuntimeContextParams): Message | null {
  const snapshot = buildRuntimeContextSnapshot(params);
  if (!snapshot) return null;

  return {
    role: 'system',
    content: `${TRANSIENT_RUNTIME_CONTEXT_PREFIX}\n${JSON.stringify(snapshot, null, 2)}`,
  };
}

export function buildRuntimeContextSnapshot(params: BuildRuntimeContextParams): RuntimeContextSnapshot | null {
  const parsedKey = parseSessionKeyV2(params.sessionKey);
  const route = params.sessionRoute;
  const scope = params.executionScope;
  const source = route?.source
    ?? scope?.source
    ?? parsedKey?.source
    ?? sourceFromSessionType(params.sessionType);
  const topicId = scope?.topicId
    ?? route?.topicId
    ?? parsedKey?.topicId;
  const topicType = scope?.topicType
    ?? route?.topicType
    ?? parsedKey?.topicType;

  if (!source || !topicId || !topicType) {
    return null;
  }

  const actorUserId = scope?.actorUserId
    ?? route?.actorUserId
    ?? 'unknown_actor';
  const agentId = scope?.agentId
    ?? route?.agentId
    ?? parsedKey?.agentId;
  const identityTrust = scope?.identityTrust
    ?? route?.identityTrust
    ?? 'legacy_context';
  const scopeSource = scope
    ? 'execution_scope'
    : route
      ? 'session_route'
      : 'session_key';

  return pruneUndefined({
    schema: 'xiaoba.runtime_context.v1',
    session: pruneUndefined({
      key: params.sessionKey,
      legacyKey: scope?.legacySessionKey ?? route?.legacySessionKey,
      source,
      topic: {
        id: topicId,
        type: topicType,
      },
      agent: agentId
        ? pruneUndefined({
          id: agentId,
        })
        : undefined,
    }),
    turn: pruneUndefined({
      actorUserId,
      messageId: route?.messageId,
      channelSeq: scope?.channelSeq ?? route?.channelSeq,
      identityTrust,
      identitySource: route?.identitySource,
      permissionsSource: scope?.permissionsSource,
      isTrusted: scope?.isTrusted,
    }),
    execution: pruneUndefined({
      mode: 'backend_controlled',
      scopeSource,
      toolsUseBackendScope: true,
      localDevice: sanitizeLocalDevice(params.localDeviceGrant),
      userDevices: sanitizeDeviceGrants(params.deviceGrants),
      deviceSelection: sanitizeDeviceSelection(params.deviceSelection),
      localFiles: sanitizeLocalFiles(params.localFileGrants),
    }),
    rules: readDefaultPromptLines('transient/runtime-context-rules.md'),
  }) as RuntimeContextSnapshot;
}

function sanitizeLocalDevice(grant?: ScopedLocalDeviceGrant): RuntimeContextSnapshot['execution']['localDevice'] | undefined {
  if (!grant) return undefined;
  return pruneUndefined({
    source: grant.source,
    deviceId: grant.deviceId,
  });
}

function sanitizeDeviceGrants(grants?: ScopedDeviceGrant[]): RuntimeContextSnapshot['execution']['userDevices'] | undefined {
  if (!grants || grants.length === 0) return undefined;
  return grants.map(grant => pruneUndefined({
    grantId: grant.grantId,
    deviceId: grant.deviceId,
    displayName: grant.deviceDisplayName,
    operations: [...grant.operations],
    status: grant.status,
    expiresAt: grant.expiresAt,
  }));
}

function sanitizeDeviceSelection(selection?: ScopedDeviceSelection): RuntimeContextSnapshot['execution']['deviceSelection'] | undefined {
  if (!selection) return undefined;
  return pruneUndefined({
    status: selection.status,
    selectionSource: selection.selectionSource,
    selectedDevice: selection.selectedDeviceId
      ? pruneUndefined({
        deviceId: selection.selectedDeviceId,
        displayName: selection.selectedDeviceDisplayName,
        operations: selection.selectedDeviceOperations ? [...selection.selectedDeviceOperations] : undefined,
      })
      : undefined,
    candidates: selection.candidates?.map(candidate => pruneUndefined({
      deviceId: candidate.deviceId,
      displayName: candidate.displayName,
      operations: candidate.operations ? [...candidate.operations] : undefined,
    })),
    candidateCount: selection.candidateCount,
  });
}

function sanitizeLocalFiles(grants?: ScopedLocalFileGrant[]): RuntimeContextSnapshot['execution']['localFiles'] | undefined {
  if (!grants || grants.length === 0) return undefined;
  return grants.map(grant => pruneUndefined({
    ref: grant.attachmentRef,
    fileName: grant.fileName,
    fileType: grant.fileType,
    operations: [...grant.operations],
    expiresAt: grant.expiresAt,
  }));
}

function sourceFromSessionType(sessionType?: string): MessageSource | undefined {
  if (sessionType === 'catscompany' || sessionType === 'feishu' || sessionType === 'weixin' || sessionType === 'cli') {
    return sessionType;
  }
  return undefined;
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
