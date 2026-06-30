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
import type { TargetRoute, TargetRoutes } from '../types/tool';
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
  targetRoutes?: TargetRoutes;
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
  if (!shouldInjectRuntimeContext(params)) return null;
  const content = buildRuntimeContextText(params.targetRoutes);
  if (!content) return null;
  return { role: 'system', content };
}

function shouldInjectRuntimeContext(params: BuildRuntimeContextParams): boolean {
  const source = params.executionScope?.source
    ?? params.sessionRoute?.source
    ?? parseSessionKeyV2(params.sessionKey)?.source
    ?? sourceFromSessionType(params.sessionType);
  return source === 'catscompany';
}

function buildRuntimeContextText(targetRoutes?: TargetRoutes): string {
  const routes = targetRoutes?.routes || [];
  const lines = [TRANSIENT_RUNTIME_CONTEXT_PREFIX];
  if (routes.length > 0) {
    lines.push('可操作的用户电脑：');
    for (const route of routes) {
      lines.push(`- ${displayTargetUser(route)}：${route.label}，${formatOS(route.os)}`);
    }
    lines.push('');
    lines.push('可在用户电脑执行的工具：');
    lines.push('read_file, resolve_common_directory, glob, grep, write_file, edit_file, execute_shell');
    lines.push('');
  }
  lines.push('规则：');
  lines.push('- 默认不要传 target，工具会在 XiaoBa 自己的电脑执行。');
  lines.push('- 只有用户明确要求操作某个用户的电脑、桌面、文件或路径时，才把 target 设为该用户名字，例如 target="Alice"。');
  lines.push('- 只有带 target 参数的工具可以在用户电脑执行；没有 target 参数的工具只能在 XiaoBa 自己电脑执行。');
  lines.push('- 如果 Alice 说“我的电脑/我的桌面/我这边”，target 用 "Alice"。');
  lines.push('- 如果用户说“你的电脑/XiaoBa 的电脑/bot 的电脑”，不要传 target。');
  lines.push('- 工具结果中的路径只属于实际执行设备，换设备后要重新解析路径。');
  lines.push('[/transient_runtime_context]');
  return lines.join('\n');
}

function displayTargetUser(route: TargetRoute): string {
  return route.userName || route.userId;
}

function formatOS(os: TargetRoute['os']): string {
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
