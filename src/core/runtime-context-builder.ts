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
import type { TargetRoute, TargetRoutes, GroupRosterEntry } from '../types/tool';
import { parseSessionKeyV2 } from './session-router';
import { getCatsCoAttachmentCacheSessionRoot } from '../catscompany/attachment-cache';
import { renderMachineResourcesForPrompt } from '../utils/machine-resources';

export const TRANSIENT_RUNTIME_CONTEXT_PREFIX = '[transient_runtime_context]';

// Cleanup-only compatibility for transcripts created before automatic
// Artifact observations were removed. No current code emits this prefix.
const LEGACY_TRANSIENT_ARTIFACT_OBSERVATION_PREFIX = '[transient_artifact_observation]';

export function isLegacyArtifactObservationMessage(message: Message): boolean {
  return message.__injected === true
    && typeof message.content === 'string'
    && message.content.startsWith(LEGACY_TRANSIENT_ARTIFACT_OBSERVATION_PREFIX);
}

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
  /** 群成员名单；只有多 bot 群才有，用于渲染"群里有谁"。 */
  groupRoster?: GroupRosterEntry[];
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
  const content = buildRuntimeContextText(
    params.targetRoutes,
    getCatsCoAttachmentCacheSessionRoot(params.sessionKey),
    params.groupRoster,
    params.deviceSelection,
  );
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

export function buildRuntimeContextText(
  targetRoutes?: TargetRoutes,
  attachmentDirectory?: string,
  groupRoster?: GroupRosterEntry[],
  selection?: ScopedDeviceSelection,
): string {
  const routes = targetRoutes?.routes || [];
  const lines = [TRANSIENT_RUNTIME_CONTEXT_PREFIX];
  if (attachmentDirectory) {
    lines.push(`当前会话附件缓存目录（XiaoBa 本地运行体）：${attachmentDirectory}`);
    lines.push('仅在用户请求涉及本会话附件时，用不带 target 的 glob 查看该目录；找到具体文件后再传给 read_file、grep 或本机脚本。用户指定的设备不可确认时，不要把附件缓存当作替代搜索位置。');
    lines.push('');
  }
  // 群成员名单：让这个助手知道群里谁是人、谁是同伴。
  //
  // 每轮重建、不进历史：它是会变的状态，写进历史就会过期。人和助手都显式标注，
  // 因为只标助手的话，"没有标记"会有两种含义，读的人无法可靠判断。
  if (groupRoster && groupRoster.length > 0) {
    lines.push('群成员：');
    for (const member of groupRoster) {
      lines.push(`- ${formatRosterMember(member)}`);
    }
    lines.push('');
  }
  const machineResources = renderMachineResourcesForPrompt();
  if (machineResources) {
    lines.push(machineResources);
    lines.push('');
  }
  if (routes.length > 0) {
    lines.push('当前账号的电脑（在线不代表已获本轮操作授权）：');
    for (const route of routes) {
      lines.push(`- ${displayTargetUser(route)}：${JSON.stringify(route.label)}，device_id=${JSON.stringify(route.deviceId)}，${formatOS(route.os)}，${route.status === 'ready' ? '在线' : '暂时不可用'}`);
    }
    if (selection) {
      lines.push(`本轮设备选择：${selection.status}；目标=${JSON.stringify(selection.selectedDeviceDisplayName || selection.selectedDeviceId || '尚未选择')}`);
    }
    lines.push('');
    lines.push('可在用户电脑执行的工具：');
    lines.push('read_file, resolve_common_directory, glob, grep, write_file, edit_file, execute_shell');
    lines.push('');
  }
  lines.push('规则：');
  lines.push('- 对本来就在 Bot 自身环境进行的工作（如正常 Skill、附件处理），默认不要传 target，工具会在 XiaoBa 自己的电脑执行。这不是查找用户指定设备失败后的回退方式。');
  lines.push('- 右上角选中的设备是默认目标。用户说“在桌面创建文件”“我的电脑”等且未指定设备时，直接使用本轮默认选择（target="speaker_default"），不必再次询问设备名。默认未选定且有多台设备时才询问。');
  lines.push('- 用户明确要求在某台设备执行时，用列表中的准确设备名/ID作为 target；该设备可以不同于默认选择，但必须有自己的本轮授权。这只是本次任务的目标，不改变默认设备。仅在提问、引用或否定中提到设备，不构成操作请求。');
  lines.push('- 用户明确要求操作两台/多台设备时，逐台使用准确 target、独立解析路径并执行，分别报告实际成功或失败。可以依次执行，不要把一台的成功说成全部成功。已知离线设备直接说明不可用；不要拿它的任务或路径到其他电脑、Bot 宿主机或附件缓存中尝试。');
  lines.push('- 设备名不可见只说明当前上下文无法确认该目标，不得声称它属于其他账号、一定存在或已被权限系统拒绝。不得猜测/改写 Linux 与 Windows 路径以尝试其他电脑。');
  lines.push('- 只有用户明确要求操作某个用户的电脑、桌面、文件或路径时才设置 target：指定设备用列表中的准确设备名/ID；“我的电脑”等用户别名按本轮选择解析，例如 target="Alice"。不能用当前用户名代替用户明确点名的另一台设备。');
  lines.push('- 只有带 target 参数的工具可以在用户电脑执行；没有 target 参数的工具只能在 XiaoBa 自己电脑执行。');
  lines.push('- 如果 Alice 说“我的电脑/我的桌面/我这边”，target 用 "Alice"。');
  lines.push('- 如果用户说“你的电脑/XiaoBa 的电脑/bot 的电脑”，不要传 target。');
  lines.push('- 工具结果中的路径只属于实际执行设备，换设备后要重新解析路径。');
  lines.push('- 同账号可能有多台电脑；用户名不是某一台电脑的固定名称，以本轮默认选择为准。未指定目标、多台且未选定默认设备时先询问；明确指定设备或明确要求所有设备时，不必要求用户先改变默认选择。不按列表顺序猜测目标。');
  lines.push('- 已选定的电脑离线时说明它暂时不可用，不能换另一台电脑或改为服务器执行。仅提到其他设备不代表要求切换。');
  lines.push('- 删除、覆盖等操作也必须核对本次任务的目标设备和路径；未明确指定时使用默认设备。换设备后重新解析路径，不能把上一台电脑的路径当作本机路径。保留原有安全检查，不新增设备操作确认步骤。');
  lines.push('[/transient_runtime_context]');
  return lines.join('\n');
}

function displayTargetUser(route: TargetRoute): string {
  return route.userName || route.userId;
}

/**
 * 渲染一条群成员，形如 `林（人）` / `阿码（bot）` / `小文（bot，已禁言）`。
 *
 * 身份缺失时不加后缀：旧服务端不下发它，硬猜一个比不标更糟。禁言必须标出来，
 * 因为被禁言的成员无法被指名——打算交接的同伴需要知道点名它会无人应答。
 */
function formatRosterMember(member: GroupRosterEntry): string {
  const name = String(member.name || '').trim() || member.uid;
  const tags: string[] = [];
  if (member.isBot === true) tags.push('bot');
  else if (member.isBot === false) tags.push('人');
  if (member.muted === true) tags.push('已禁言');
  return tags.length > 0 ? `${name}（${tags.join('，')}）` : name;
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
  const selected = params.deviceSelection;
  const speakerGrant = selected?.status === 'selected' && selected.selectedDeviceId
    ? params.deviceGrants?.find(grant => grant.deviceId === selected.selectedDeviceId)
    : selected ? undefined : params.deviceGrants?.find(grant => grant.status === 'active') || params.deviceGrants?.[0];
  const speakerDeviceReady = selected ? selected.status === 'selected' && Boolean(selected.selectedDeviceId) : Boolean(speakerGrant?.deviceId);
  const speakerDeviceLabel = (selected?.status === 'selected' ? selected.selectedDeviceDisplayName : undefined)
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
    'The selected computer is the default for unspecified user-device requests. An explicitly requested device may differ from the default if it has its own current authorization. For multiple devices, use separate exact targets and report each result without changing the default. Missing, ambiguous or offline targets never permit probing the agent host, attachment cache or another device.',
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
