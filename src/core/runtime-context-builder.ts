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
}

export interface ExecutionContextSnapshot {
  schema: 'xiaoba.execution_context.v1';
  conversation: {
    type: 'local' | 'p2p' | 'group';
    currentSpeaker: {
      id: string;
      name?: string;
      role: 'user';
    };
    participants: Array<{
      id: string;
      name?: string;
      role: 'user' | 'agent';
    }>;
  };
  executionTargets: Array<{
    id: 'agent_self' | 'speaker_default';
    label: string;
    kind: 'agent_self' | 'participant';
    status: 'ready' | 'unavailable';
    userId?: string;
    cwd?: string;
  }>;
  defaultTarget: 'agent_self';
  toolRules: string[];
}

export function buildRuntimeContextMessage(params: BuildRuntimeContextParams): Message | null {
  const snapshot = buildRuntimeContextSnapshot(params);
  if (!snapshot) return null;
  return {
    role: 'system',
    content: `${TRANSIENT_RUNTIME_CONTEXT_PREFIX}\n${JSON.stringify(snapshot, null, 2)}`,
  };
}

export function buildRuntimeContextSnapshot(params: BuildRuntimeContextParams): ExecutionContextSnapshot | null {
  const parsedKey = parseSessionKeyV2(params.sessionKey);
  const route = params.sessionRoute;
  const scope = params.executionScope;
  const source = route?.source
    ?? scope?.source
    ?? parsedKey?.source
    ?? sourceFromSessionType(params.sessionType);
  const topicType = scope?.topicType
    ?? route?.topicType
    ?? parsedKey?.topicType
    ?? 'unknown';

  if (!source || (source !== 'catscompany' && source !== 'cli')) return null;

  const actorUserId = scope?.actorUserId
    ?? route?.actorUserId
    ?? parsedKey?.topicId
    ?? 'local_user';
  const agentId = scope?.agentId
    ?? route?.agentId
    ?? parsedKey?.agentId
    ?? 'agent_self';
  const speakerName = displayNameForUser(actorUserId);
  const agentName = process.env.CURRENT_AGENT_DISPLAY_NAME || 'XiaoBa';
  const conversationType = toConversationType(source, topicType);
  const selected = params.deviceSelection?.selectedDeviceId ? params.deviceSelection : undefined;
  const speakerGrant = selected
    ? params.deviceGrants?.find(grant => grant.deviceId === selected.selectedDeviceId)
    : params.deviceGrants?.find(grant => grant.status === 'active') || params.deviceGrants?.[0];
  const speakerDeviceReady = Boolean(selected?.selectedDeviceId || speakerGrant?.deviceId);
  const speakerDeviceLabel = selected?.selectedDeviceDisplayName
    || speakerGrant?.deviceDisplayName
    || `${speakerName} computer`;
  const agentCwd = process.cwd();

  return {
    schema: 'xiaoba.execution_context.v1',
    conversation: {
      type: conversationType,
      currentSpeaker: {
        id: actorUserId,
        name: speakerName,
        role: 'user',
      },
      participants: [
        {
          id: actorUserId,
          name: speakerName,
          role: 'user',
        },
        {
          id: agentId,
          name: agentName,
          role: 'agent',
        },
      ],
    },
    executionTargets: [
      {
        id: 'agent_self',
        label: `${agentName} local computer`,
        kind: 'agent_self',
        status: 'ready',
        cwd: agentCwd,
      },
      ...(conversationType === 'local'
        ? []
        : [{
            id: 'speaker_default' as const,
            label: speakerDeviceLabel,
            kind: 'participant' as const,
            status: speakerDeviceReady ? 'ready' as const : 'unavailable' as const,
            userId: actorUserId,
          }]),
    ],
    defaultTarget: 'agent_self',
    toolRules: buildToolRules(conversationType),
  };
}

function buildToolRules(type: ExecutionContextSnapshot['conversation']['type']): string[] {
  if (type === 'local') {
    return [
      'This is a normal local conversation. Use tools without target unless the user explicitly asks otherwise.',
    ];
  }
  return [
    'Default tool target is agent_self.',
    'When the current speaker says "my computer", "my desktop", "my files", "我电脑", "我的电脑", "我的桌面", or "我这边", call target="speaker_default".',
    'When the current speaker says "your computer", "bot computer", "XiaoBa computer", "你的电脑", "你自己的电脑", "小八的电脑", or "机器人的电脑", call target="agent_self".',
    'If a user asks for a common directory such as Desktop or Downloads, call resolve_common_directory on the same target before passing the returned path to glob, read_file, write_file, edit_file, or execute_shell.',
    'Paths returned by tools belong only to the target that produced them. Re-resolve paths after switching target.',
  ];
}

function toConversationType(source: MessageSource, topicType: MessageTopicType): ExecutionContextSnapshot['conversation']['type'] {
  if (source === 'cli') return 'local';
  if (topicType === 'group') return 'group';
  return 'p2p';
}

function displayNameForUser(userId: string): string {
  const text = String(userId || '').trim();
  if (!text || text === 'local_user') return 'User';
  return text;
}

function sourceFromSessionType(sessionType?: string): MessageSource | undefined {
  if (sessionType === 'catscompany' || sessionType === 'feishu' || sessionType === 'weixin' || sessionType === 'cli') {
    return sessionType;
  }
  return undefined;
}
