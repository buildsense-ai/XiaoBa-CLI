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
  currentDirectory?: string;
}

interface RuntimeContextSnapshot {
  schema: 'xiaoba.execution_context.v1';
  conversation: {
    type: 'local' | MessageTopicType;
    currentSpeaker: {
      id: string;
      name: string;
      role: 'user';
    };
    participants: Array<{
      id: string;
      name: string;
      role: 'user' | 'agent';
    }>;
  };
  executionTargets: Array<{
    id: 'agent_self' | 'speaker_default';
    label: string;
    kind: 'agent_self' | 'participant_default';
    status: 'ready' | 'unavailable';
    ownerUserId?: string;
    cwd?: string;
  }>;
  defaultTarget: 'agent_self';
  toolTargeting: {
    defaultToolTarget: 'agent_self';
    targetParameterTools: string[];
    rule: string;
  };
}

export function buildRuntimeContextMessage(params: BuildRuntimeContextParams): Message | null {
  const snapshot = buildRuntimeContextSnapshot(params);
  if (!snapshot) return null;

  return {
    role: 'user',
    content: `${TRANSIENT_RUNTIME_CONTEXT_PREFIX}\n${JSON.stringify(snapshot, null, 2)}`,
    __injected: true,
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

  const actorUserId = scope?.actorUserId
    ?? route?.actorUserId
    ?? 'unknown_actor';
  const agentId = scope?.agentId
    ?? route?.agentId
    ?? parsedKey?.agentId;
  const conversationType = resolveConversationType(source, topicType);
  const currentSpeaker = buildCurrentSpeaker(conversationType, actorUserId);
  const agentParticipant = buildAgentParticipant(agentId);
  const participants = dedupeParticipants([currentSpeaker, agentParticipant]);
  const executionTargets = buildExecutionTargets(params, conversationType, currentSpeaker);

  return pruneUndefined({
    schema: 'xiaoba.execution_context.v1',
    conversation: pruneUndefined({
      type: conversationType,
      currentSpeaker,
      participants,
    }),
    executionTargets,
    defaultTarget: 'agent_self',
    toolTargeting: {
      defaultToolTarget: 'agent_self',
      targetParameterTools: [
        'resolve_common_directory',
        'glob',
        'grep',
        'read_file',
        'write_file',
        'edit_file',
        'execute_shell',
      ],
      rule: 'Omit target or use target="agent_self" for the bot computer. Use target="speaker_default" only when the user explicitly asks to operate the current speaker/user computer.',
    },
  }) as RuntimeContextSnapshot;
}

function resolveConversationType(
  source: MessageSource | undefined,
  topicType: MessageTopicType | undefined,
): RuntimeContextSnapshot['conversation']['type'] {
  if (!source || source === 'cli') return 'local';
  if (topicType === 'p2p' || topicType === 'group') return topicType;
  return 'local';
}

function buildCurrentSpeaker(
  conversationType: RuntimeContextSnapshot['conversation']['type'],
  actorUserId: string,
): RuntimeContextSnapshot['conversation']['currentSpeaker'] {
  const id = conversationType === 'local' ? 'local_user' : (actorUserId || 'unknown_actor');
  return {
    id,
    name: displayNameFromId(id),
    role: 'user',
  };
}

function buildAgentParticipant(agentId?: string): RuntimeContextSnapshot['conversation']['participants'][number] {
  const id = agentId || 'agent_self';
  return {
    id,
    name: id === 'agent_self' ? 'XiaoBa' : displayNameFromId(id),
    role: 'agent',
  };
}

function dedupeParticipants(
  participants: RuntimeContextSnapshot['conversation']['participants'],
): RuntimeContextSnapshot['conversation']['participants'] {
  const seen = new Set<string>();
  return participants.filter(participant => {
    if (seen.has(participant.id)) return false;
    seen.add(participant.id);
    return true;
  });
}

function buildExecutionTargets(
  params: BuildRuntimeContextParams,
  conversationType: RuntimeContextSnapshot['conversation']['type'],
  currentSpeaker: RuntimeContextSnapshot['conversation']['currentSpeaker'],
): RuntimeContextSnapshot['executionTargets'] {
  const localOwnerUserId = params.localDeviceGrant?.ownerUserId
    || (conversationType === 'local' ? currentSpeaker.id : undefined);
  const targets: RuntimeContextSnapshot['executionTargets'] = [pruneUndefined({
    id: 'agent_self',
    label: conversationType === 'local' ? '当前电脑' : 'XiaoBa 自己的电脑',
    kind: 'agent_self',
    status: 'ready',
    ownerUserId: localOwnerUserId,
    cwd: normalizeText(params.currentDirectory),
  }) as RuntimeContextSnapshot['executionTargets'][number]];

  const speakerTarget = buildSpeakerDefaultTarget(params, currentSpeaker);
  if (speakerTarget) {
    targets.push(speakerTarget);
  }

  return targets;
}

function buildSpeakerDefaultTarget(
  params: BuildRuntimeContextParams,
  currentSpeaker: RuntimeContextSnapshot['conversation']['currentSpeaker'],
): RuntimeContextSnapshot['executionTargets'][number] | undefined {
  const selection = params.deviceSelection;
  const grants = params.deviceGrants || [];
  const selectedGrant = selection?.selectedDeviceId
    ? grants.find(grant => grant.deviceId === selection.selectedDeviceId)
    : undefined;
  const fallbackGrant = grants.find(grant => grant.ownerUserId === currentSpeaker.id) || grants[0];
  const grant = selectedGrant || fallbackGrant;

  if (!selection && !grant) return undefined;

  const displayName = selection?.selectedDeviceDisplayName
    || grant?.deviceDisplayName;
  const label = displayName
    ? `${currentSpeaker.name} 的 ${displayName}`
    : `${currentSpeaker.name} 的电脑`;

  return pruneUndefined({
    id: 'speaker_default',
    label,
    kind: 'participant_default',
    status: selection?.status === 'selected' || grant?.status === 'active' ? 'ready' : 'unavailable',
    ownerUserId: grant?.ownerUserId || currentSpeaker.id,
  }) as RuntimeContextSnapshot['executionTargets'][number];
}

function sourceFromSessionType(sessionType?: string): MessageSource | undefined {
  if (sessionType === 'catscompany' || sessionType === 'feishu' || sessionType === 'weixin' || sessionType === 'cli') {
    return sessionType;
  }
  return undefined;
}

function displayNameFromId(id: string): string {
  if (id === 'local_user') return 'User';
  return id;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
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
