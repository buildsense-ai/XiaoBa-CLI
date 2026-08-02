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
import { getCatsCoAttachmentCacheSessionRoot } from '../catscompany/attachment-cache';
import {
  buildAuthorizedDeviceProjection,
  authorizedDeviceProjectionTargetLine,
  type AuthorizedDeviceProjection,
} from './authorized-device-projection';
import { witnessAuthorizedDeviceContext } from './authorized-device-witness';
import { sameCatsCoUserId } from '../catscompany/speaker-label';

export const TRANSIENT_RUNTIME_CONTEXT_PREFIX = '[transient_runtime_context]';
export const TRANSIENT_RUNTIME_TARGET_RULES_PREFIX = '[transient_runtime_target_rules]';

export interface BuildRuntimeContextParams {
  sessionKey: string;
  sessionType?: string;
  sessionRoute?: SessionRoute;
  executionScope?: ExecutionScope;
  localDeviceGrant?: ScopedLocalDeviceGrant;
  deviceGrants?: ScopedDeviceGrant[];
  deviceSelection?: ScopedDeviceSelection;
  targetRoutes?: TargetRoutes;
  /** True only when this run has a negotiated remote RPC transport. */
  remoteTransportAvailable?: boolean;
  localFileGrants?: ScopedLocalFileGrant[];
  /** Captured once by callers/tests when expiry-sensitive projection must be deterministic. */
  now?: number;
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
  const projection = buildAuthorizedDeviceProjection(params);
  if (projection.targets.length === 0) return null;
  const message: Message = {
    role: 'system',
    content: buildRuntimeContextText(projection),
  };
  witnessAuthorizedDeviceContext(message, projection, params.remoteTransportAvailable === true);
  return message;
}

export function buildRuntimeTargetRulesMessage(params: BuildRuntimeContextParams): Message | null {
  if (!shouldInjectRuntimeContext(params)) return null;
  const attachmentDirectory = getCatsCoAttachmentCacheSessionRoot(params.sessionKey);
  const lines = [TRANSIENT_RUNTIME_TARGET_RULES_PREFIX];
  if (attachmentDirectory) {
    lines.push(`当前会话附件缓存目录（XiaoBa 本地运行体）：${attachmentDirectory}`);
    lines.push('需要查找本会话历史附件时，用不带 target 的 glob 查看该目录；找到具体文件后再传给 read_file、grep 或本机脚本。');
    lines.push('');
  }
  lines.push('设备工具目标规则：');
  lines.push('- 默认不要传 target，工具会在 XiaoBa 自己的电脑执行。');
  lines.push('- 只有用户明确要求操作已授权用户的电脑、桌面、文件或路径时，才使用当前授权设备表列出的精确 target。');
  lines.push('- 只有带 target 参数且授权操作匹配的工具可以在用户电脑执行；没有 target 参数的工具只能在 XiaoBa 自己电脑执行。');
  lines.push('- 发言人说“我的电脑/我的桌面/我的文件/我这边”时，使用授权设备表中属于该发言人的 target。');
  lines.push('- 用户说“你的电脑/XiaoBa 的电脑/bot 的电脑”时，不要传 target。');
  lines.push('- 常用目录先在同一 target 上调用 resolve_common_directory；工具返回的路径只属于实际执行设备，换设备后要重新解析。');
  lines.push('[/transient_runtime_target_rules]');
  return { role: 'system', content: lines.join('\n') };
}

function shouldInjectRuntimeContext(params: BuildRuntimeContextParams): boolean {
  const source = params.executionScope?.source
    ?? params.sessionRoute?.source
    ?? parseSessionKeyV2(params.sessionKey)?.source
    ?? sourceFromSessionType(params.sessionType);
  return source === 'catscompany';
}

function buildRuntimeContextText(projection: AuthorizedDeviceProjection): string {
  const lines = [TRANSIENT_RUNTIME_CONTEXT_PREFIX];
  lines.push('可操作的用户电脑：');
  for (const target of projection.targets) {
    lines.push(authorizedDeviceProjectionTargetLine(target));
  }
  lines.push('每行只列出当前 scope 中 active、未过期且与 route/selection 一致的服务端授权；只可使用该行的精确 target，以及本轮实际提供的对应远程工具。');
  lines.push('[/transient_runtime_context]');
  return lines.join('\n');
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
  const projection = buildAuthorizedDeviceProjection(params);
  const speakerTarget = projection.targets.find(target => sameCatsCoUserId(target.ownerUserId, actorUserId));
  const speakerName = speakerTarget?.ownerDisplayName || displayNameForUser(actorUserId);
  const agentName = process.env.CURRENT_AGENT_DISPLAY_NAME || 'XiaoBa';
  const conversationType = toConversationType(source, topicType);
  const speakerDeviceReady = Boolean(speakerTarget);
  const speakerDeviceLabel = speakerTarget?.deviceDisplayName || `${speakerName} computer`;
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
    toolRules: buildToolRules(conversationType, speakerTarget?.target),
  };
}

function buildToolRules(
  type: ExecutionContextSnapshot['conversation']['type'],
  speakerTarget?: string,
): string[] {
  if (type === 'local') {
    return [
      'This is a normal local conversation. Use tools without target unless the user explicitly asks otherwise.',
    ];
  }
  return [
    'Default tool target is agent_self.',
    speakerTarget
      ? `When the current speaker asks for their computer or files, call target="${speakerTarget}".`
      : 'The current speaker has no ready authorized device target.',
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
