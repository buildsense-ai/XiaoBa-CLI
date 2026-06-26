import type { DeviceGrantOperation, ScopedDeviceGrant, ScopedDeviceSelection, ScopedLocalDeviceGrant } from '../types/session-identity';
import type { ToolErrorCode, ToolExecutionContext } from '../types/tool';
import { isDelegatedDeviceGrant, resolveDeviceGrant } from '../core/device-grants';

export type ToolGatewayDecision =
  | {
      ok: true;
      mode: 'local';
      grant?: ScopedDeviceGrant;
      targetDeviceId?: string;
      targetDeviceDisplayName?: string;
    }
  | {
      ok: true;
      mode: 'remote';
      grant?: ScopedDeviceGrant;
      targetDeviceId: string;
      targetDeviceDisplayName?: string;
      targetDeviceBodyId?: string;
      targetDeviceInstallationId?: string;
    }
  | { ok: false; errorCode: ToolErrorCode; message: string };

export interface ResolveToolGatewayAccessOptions {
  toolName: string;
  operation: DeviceGrantOperation;
  targetLabel?: string;
  allowCatsCoShell?: boolean;
}

export interface CatsCoVisiblePathOptions {
  fallback?: string;
  preserveRelative?: boolean;
}

const REMOTE_DEVICE_RPC_OPERATIONS = new Set<DeviceGrantOperation>([
  'read_file',
  'resolve_common_directory',
  'glob',
  'grep',
  'write_file',
  'edit_file',
  'execute_shell',
]);

export function isCatsCoToolGatewayContext(context: ToolExecutionContext): boolean {
  return context.surface === 'catscompany' || context.executionScope?.source === 'catscompany';
}

export function isCatsCoLocalOwnerSelfContext(context: ToolExecutionContext): boolean {
  if (!isCatsCoToolGatewayContext(context)) return false;
  const scope = context.executionScope;
  const localDevice = context.localDeviceGrant;
  if (!scope || scope.source !== 'catscompany' || scope.identityTrust !== 'server_canonical' || !scope.isTrusted) {
    return false;
  }
  const ownerUserId = localDevice?.ownerUserId;
  if (scope.deviceOwnerUserId && !sameCatsCoUserId(scope.deviceOwnerUserId, ownerUserId)) {
    return false;
  }
  if (sameCatsCoUserId(ownerUserId, scope.actorUserId)) {
    return true;
  }
  return false;
}

export function isCatsCoAgentLocalBodyContext(context: ToolExecutionContext): boolean {
  if (!isCatsCoToolGatewayContext(context)) return false;
  const scope = context.executionScope;
  const localDevice = context.localDeviceGrant;
  if (!scope || scope.source !== 'catscompany' || scope.identityTrust !== 'server_canonical' || !scope.isTrusted) {
    return false;
  }
  if (!localDevice || localDevice.source !== 'catscompany' || !localDevice.bodyId) {
    return false;
  }
  return Boolean(scope.agentBodyId && scope.agentBodyId === localDevice.bodyId);
}

export function formatCatsCoVisiblePath(
  context: ToolExecutionContext,
  value: string | undefined,
  options: CatsCoVisiblePathOptions = {},
): string {
  const fallback = options.fallback ?? '[current CatsCo device]';
  const text = String(value || '').trim();
  if (!isCatsCoToolGatewayContext(context)) {
    return text || fallback;
  }
  if (!text) return fallback;
  if (/^catsco_attachment:[A-Za-z0-9._:-]+$/.test(text)) return text;
  if (/^\[CatsCo [^\]]+\]$/.test(text)) return text;
  if (options.preserveRelative && !looksLikeAbsoluteLocalPath(text)) return text;
  return fallback;
}

export function redactCatsCoVisiblePath(
  context: ToolExecutionContext,
  message: unknown,
  rawPath: string,
  visiblePath?: string,
): string {
  const text = String(message || '');
  if (!isCatsCoToolGatewayContext(context) || !rawPath) return text;
  const replacement = visiblePath ?? formatCatsCoVisiblePath(context, rawPath);
  return text.split(rawPath).join(replacement);
}

export function resolveToolGatewayAccess(
  context: ToolExecutionContext,
  options: ResolveToolGatewayAccessOptions,
): ToolGatewayDecision {
  if (!isCatsCoToolGatewayContext(context)) {
    return { ok: true, mode: 'local' };
  }

  const scope = context.executionScope;
  if (!scope || scope.source !== 'catscompany') {
    return denied(['当前工具调用缺少 CatsCo 执行身份，已阻止本地设备操作。'], options.targetLabel);
  }

  if (scope.identityTrust !== 'server_canonical' || !scope.isTrusted) {
    return denied(['当前消息身份未通过服务端一致性校验，已阻止本地设备操作。'], options.targetLabel);
  }

  const localDevice = context.localDeviceGrant;
  if (!localDevice || localDevice.source !== 'catscompany') {
    return denied(['当前运行体缺少 CatsCo 本机设备绑定，已阻止本地设备操作。'], options.targetLabel);
  }

  const localOwnerSelf = isCatsCoLocalOwnerSelfContext(context);
  const agentLocalBody = isCatsCoAgentLocalBodyContext(context);
  const rpcForwardLocal = isCatsCoDeviceRpcForwardLocalContext(context, options.operation);
  const requireSelectedDevice = requiresExplicitBackendDeviceSelection(scope, localDevice, rpcForwardLocal);

  const selectionScope = validateSelectionScope(context.deviceSelection, scope, options.targetLabel);
  if (!selectionScope.ok) return selectionScope;

  const selectedTarget = resolveBackendSelectedDevice(
    context.deviceSelection,
    localDevice,
    options.operation,
    options.targetLabel,
    {
      allowLocalSelfOperation: localOwnerSelf || agentLocalBody || rpcForwardLocal,
      allowLocalAgentBodyFallback: agentLocalBody,
      requireSelection: requireSelectedDevice && !agentLocalBody,
    },
  );
  if (!selectedTarget.ok) return selectedTarget;

  const targetDeviceId = selectedTarget.deviceId || localDevice.deviceId || localDevice.installationId || localDevice.bodyId;
  if (selectedTarget.mode === 'local' && (localOwnerSelf || agentLocalBody || rpcForwardLocal)) {
    return {
      ok: true,
      mode: 'local',
      targetDeviceId,
      targetDeviceDisplayName: selectedTarget.displayName,
    };
  }

  const decision = resolveDeviceGrant(context, {
    operation: options.operation,
    deviceId: targetDeviceId,
  });
  if (!decision.ok) {
    return denied([
      `当前会话没有允许当前设备执行 ${options.operation} 的短期授权，已阻止 ${options.toolName}。`,
      '请确认用户已在对应设备授权，或等待服务端为本轮消息下发匹配的 device_grant。',
    ], options.targetLabel);
  }

  const grant = decision.grant;
  if (selectedTarget.mode === 'remote') {
    if (!REMOTE_DEVICE_RPC_OPERATIONS.has(options.operation)) {
      return denied([
        `后端选定的用户设备不是当前运行体，但 ${options.operation} 还没有开放远程执行。`,
        '当前只开放 read_file / resolve_common_directory / glob / grep / write_file / edit_file 远程工具。',
        '如需查看目录文件请使用 glob；如需创建或覆盖文本文件请使用 write_file。',
      ], options.targetLabel);
    }
    if (!context.deviceRpc) {
      return denied([
        '后端选定的用户设备不是当前运行体，且当前运行体没有配置远程设备 RPC 通道。',
        '已阻止本地 fallback，避免误操作当前设备或串设备。',
        selectedTarget.displayName ? `Selected device: ${selectedTarget.displayName}` : '',
      ], options.targetLabel);
    }
    return {
      ok: true,
      mode: 'remote',
      grant,
      targetDeviceId: selectedTarget.deviceId,
      targetDeviceDisplayName: selectedTarget.displayName,
      targetDeviceBodyId: selectedTarget.bodyId,
      targetDeviceInstallationId: selectedTarget.installationId,
    };
  }

  if (!context.deviceSelection && !agentLocalBody && requiresBackendSelectedDeviceForLocalExecution(scope, localDevice, grant, rpcForwardLocal)) {
    return denied([
      '后端没有选定当前说话人的目标设备，已阻止本地设备操作。',
      '共享虚拟员工不能默认使用云端运行体本机，必须由服务端选择当前用户自己的在线设备。',
    ], options.targetLabel);
  }

  if (options.operation === 'execute_shell' && !localOwnerSelf && !agentLocalBody && !rpcForwardLocal && !options.allowCatsCoShell) {
    return denied([
      'CatsCo 会话暂不允许外部用户或远程委托通过 execute_shell 操作命令行。',
      '命令执行只允许本机 owner 自用场景直接执行。',
    ], options.targetLabel);
  }

  if (localDevice.ownerUserId && !sameCatsCoUserId(grant.ownerUserId, localDevice.ownerUserId)) {
    return denied([
      '设备授权归属与当前本机 owner 不一致，已阻止本地设备操作以避免他人会话误操作本机。',
      `owner: grant=${grant.ownerUserId || '(empty)'} local=${localDevice.ownerUserId}`,
    ], options.targetLabel);
  }
  if (grant.ownerUserId !== grant.actorUserId && !isDelegatedDeviceGrant(grant)) {
    return denied([
      '跨用户设备授权缺少服务端委托标记，已阻止本地设备操作。',
    ], options.targetLabel);
  }

  const mismatches: string[] = [];
  if (grant.deviceBodyId && localDevice.bodyId && grant.deviceBodyId !== localDevice.bodyId) {
    mismatches.push('device body');
  }
  if (grant.deviceInstallationId && localDevice.installationId && grant.deviceInstallationId !== localDevice.installationId) {
    mismatches.push('device installation');
  }
  if (mismatches.length > 0) {
    return denied([
      '设备授权与当前运行体不一致，已阻止本地设备操作以避免串设备。',
      `不一致字段: ${mismatches.join(', ')}`,
    ], options.targetLabel);
  }

  return {
    ok: true,
    mode: 'local',
    grant,
    targetDeviceId,
    targetDeviceDisplayName: selectedTarget.displayName,
  };
}

type SelectedDeviceDecision =
  | {
      ok: true;
      mode: 'local';
      deviceId?: string;
      displayName?: string;
    }
  | {
      ok: true;
      mode: 'remote';
      deviceId: string;
      displayName?: string;
      bodyId?: string;
      installationId?: string;
    }
  | { ok: false; errorCode: ToolErrorCode; message: string };

function resolveBackendSelectedDevice(
  selection: ScopedDeviceSelection | undefined,
  localDevice: ScopedLocalDeviceGrant,
  operation: DeviceGrantOperation,
  targetLabel?: string,
  options: { allowLocalSelfOperation?: boolean; allowLocalAgentBodyFallback?: boolean; requireSelection?: boolean } = {},
): SelectedDeviceDecision {
  if (!selection) {
    if (options.requireSelection) {
      return selectedDenied([
        '后端没有选定当前说话人的目标设备，已阻止本地设备操作。',
        '共享虚拟员工或移动端渠道不能默认使用云端运行体本机，必须由服务端选择当前用户自己的在线设备。',
      ], targetLabel);
    }
    return {
      ok: true,
      mode: 'local',
      deviceId: localDevice.deviceId || localDevice.installationId || localDevice.bodyId,
    };
  }

  if (selection.status === 'needs_selection') {
    if (options.allowLocalAgentBodyFallback) {
      return localSelectedDevice(localDevice);
    }
    return selectedDenied([
      '后端尚未选定要操作的用户设备，已阻止本地设备操作。',
      '请让用户从可用设备中选择一个设备名后再继续。',
    ], targetLabel);
  }
  if (selection.status === 'unavailable') {
    if (options.allowLocalAgentBodyFallback) {
      return localSelectedDevice(localDevice);
    }
    return selectedDenied([
      '当前用户没有可用的在线设备授权，已阻止本地设备操作。',
      '请让用户打开并授权目标设备后再继续。',
    ], targetLabel);
  }

  const selectedDeviceId = selection.selectedDeviceId;
  if (!selectedDeviceId) {
    return selectedDenied(['后端设备选择缺少 selectedDeviceId，已阻止本地设备操作。'], targetLabel);
  }

  if (matchesLocalDevice(selection, localDevice)) {
    if (!options.allowLocalSelfOperation
      && Array.isArray(selection.selectedDeviceOperations)
      && selection.selectedDeviceOperations.length > 0
      && !selection.selectedDeviceOperations.includes(operation)) {
      return selectedDenied([
        `后端选定设备没有声明支持 ${operation}，已阻止设备工具调用。`,
        selection.selectedDeviceDisplayName ? `Selected device: ${selection.selectedDeviceDisplayName}` : '',
      ], targetLabel);
    }
    return {
      ok: true,
      mode: 'local',
      deviceId: selectedDeviceId,
      displayName: selection.selectedDeviceDisplayName,
    };
  }

  if (Array.isArray(selection.selectedDeviceOperations)
    && selection.selectedDeviceOperations.length > 0
    && !selection.selectedDeviceOperations.includes(operation)) {
    return selectedDenied([
      `后端选定设备没有声明支持 ${operation}，已阻止设备工具调用。`,
      selection.selectedDeviceDisplayName ? `Selected device: ${selection.selectedDeviceDisplayName}` : '',
    ], targetLabel);
  }

  return {
    ok: true,
    mode: 'remote',
    deviceId: selectedDeviceId,
    displayName: selection.selectedDeviceDisplayName,
    bodyId: selection.selectedDeviceBodyId,
    installationId: selection.selectedDeviceInstallationId,
  };
}

function localSelectedDevice(localDevice: ScopedLocalDeviceGrant): Extract<SelectedDeviceDecision, { ok: true; mode: 'local' }> {
  return {
    ok: true,
    mode: 'local',
    deviceId: localDevice.deviceId || localDevice.installationId || localDevice.bodyId,
  };
}

function selectedDenied(lines: string[], targetLabel?: string): SelectedDeviceDecision {
  return denied(lines, targetLabel) as Extract<SelectedDeviceDecision, { ok: false }>;
}

function validateSelectionScope(
  selection: ScopedDeviceSelection | undefined,
  scope: NonNullable<ToolExecutionContext['executionScope']>,
  targetLabel?: string,
): ToolGatewayDecision {
  if (!selection) return { ok: true, mode: 'local' };
  if (selection.identityTrust !== 'server_canonical') {
    return denied(['后端设备选择不是服务端可信身份生成的，已阻止设备工具调用。'], targetLabel);
  }
  const mismatches = [
    ['source', selection.source, scope.source],
    ['sessionKey', selection.sessionKey, scope.sessionKey],
    ['topicId', selection.topicId, scope.topicId],
    ['topicType', selection.topicType, scope.topicType],
    ['actorUserId', selection.actorUserId, scope.actorUserId],
    ['agentId', selection.agentId, scope.agentId],
  ].filter(([, selectionValue, scopeValue]) => selectionValue !== scopeValue);
  if (mismatches.length === 0) return { ok: true, mode: 'local' };
  return denied([
    '后端设备选择与当前执行身份不一致，已阻止设备工具调用以避免串用户或串会话。',
    ...mismatches.map(([field, selectionValue, scopeValue]) => `${field}: selection=${selectionValue || '(empty)'} scope=${scopeValue || '(empty)'}`),
  ], targetLabel);
}

function matchesLocalDevice(selection: ScopedDeviceSelection, localDevice: ScopedLocalDeviceGrant): boolean {
  let matched = false;
  if (selection.selectedDeviceId) {
    const localDeviceIds = [localDevice.deviceId, localDevice.installationId].filter(Boolean);
    if (!localDeviceIds.includes(selection.selectedDeviceId)) return false;
    matched = true;
  }
  if (selection.selectedDeviceInstallationId) {
    if (!localDevice.installationId || selection.selectedDeviceInstallationId !== localDevice.installationId) return false;
    matched = true;
  }
  if (selection.selectedDeviceBodyId) {
    if (!localDevice.bodyId || selection.selectedDeviceBodyId !== localDevice.bodyId) return false;
    matched = true;
  }
  return matched;
}

function denied(lines: string[], targetLabel?: string): ToolGatewayDecision {
  return {
    ok: false,
    errorCode: 'PERMISSION_DENIED',
    message: [
      ...lines,
      targetLabel ? `Target: ${sanitizeTargetLabel(targetLabel)}` : '',
    ].filter(Boolean).join('\n'),
  };
}

function sanitizeTargetLabel(value: string): string {
  const text = String(value || '').trim();
  if (!text) return '[current CatsCo device]';
  if (/^catsco_attachment:[A-Za-z0-9._:-]+$/.test(text)) return text;
  if (/^\[CatsCo [^\]]+\]$/.test(text)) return text;
  return '[current CatsCo device]';
}

function looksLikeAbsoluteLocalPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\/.test(value)
    || /^\//.test(value)
    || /^~[\\/]/.test(value);
}

function isCatsCoDeviceRpcForwardLocalContext(
  context: ToolExecutionContext,
  operation: DeviceGrantOperation,
): boolean {
  if (!isCatsCoToolGatewayContext(context)) return false;
  const scope = context.executionScope;
  const localDevice = context.localDeviceGrant;
  if (!scope || scope.permissionsSource !== 'device_rpc_forward') return false;
  if (scope.identityTrust !== 'server_canonical' || !scope.isTrusted || !localDevice?.ownerUserId) return false;
  return (context.deviceGrants || []).some(grant =>
    isCanonicalGrantForLocalOwnerDevice(grant, localDevice, localDevice.ownerUserId!, operation),
  );
}

function isExternalActorOnLocalBody(
  scope: NonNullable<ToolExecutionContext['executionScope']>,
  localDevice: ScopedLocalDeviceGrant,
): boolean {
  return Boolean(
    localDevice.ownerUserId
    && scope.actorUserId
    && !sameCatsCoUserId(localDevice.ownerUserId, scope.actorUserId),
  );
}

function requiresBackendSelectedDeviceForLocalExecution(
  scope: NonNullable<ToolExecutionContext['executionScope']>,
  localDevice: ScopedLocalDeviceGrant,
  grant: ScopedDeviceGrant,
  rpcForwardLocal: boolean,
): boolean {
  if (rpcForwardLocal) return false;
  if (scope.deviceOwnerUserId) return true;
  if (isMobileChannelSource(scope.channelSource)) return true;
  if (isChannelOwnerSource(scope.deviceOwnerSource)) return true;
  if (isExternalActorOnLocalBody(scope, localDevice)) return true;
  if (isDelegatedDeviceGrant(grant) || isChannelLinkedDeviceGrant(grant)) return true;
  if (!localDevice.ownerUserId && !isPlainServerMetadataDeviceGrant(grant)) return true;
  return false;
}

function requiresExplicitBackendDeviceSelection(
  scope: NonNullable<ToolExecutionContext['executionScope']>,
  localDevice: ScopedLocalDeviceGrant,
  rpcForwardLocal: boolean,
): boolean {
  if (rpcForwardLocal) return false;
  if (scope.deviceOwnerUserId) return true;
  if (isMobileChannelSource(scope.channelSource)) return true;
  if (isChannelOwnerSource(scope.deviceOwnerSource)) return true;
  if (isExternalActorOnLocalBody(scope, localDevice)) return true;
  return false;
}

function isChannelLinkedDeviceGrant(grant: Pick<ScopedDeviceGrant, 'identitySource'>): boolean {
  const source = String(grant.identitySource || '').toLowerCase();
  return source.includes('channel') || source.includes('feishu') || source.includes('weixin');
}

function isChannelOwnerSource(value: string | undefined): boolean {
  const source = String(value || '').toLowerCase();
  return source.includes('channel') || source.includes('feishu') || source.includes('weixin');
}

function isMobileChannelSource(value: string | undefined): boolean {
  const source = String(value || '').toLowerCase();
  return source === 'weixin' || source === 'wechat' || source === 'feishu' || source === 'lark';
}

function isPlainServerMetadataDeviceGrant(grant: Pick<ScopedDeviceGrant, 'identitySource' | 'ownerUserId' | 'actorUserId'>): boolean {
  const source = String(grant.identitySource || '').toLowerCase();
  return grant.ownerUserId === grant.actorUserId
    && (source === 'metadata.catsco_identity' || source === 'server_canonical_message');
}

function isCanonicalGrantForLocalOwnerDevice(
  grant: ScopedDeviceGrant,
  localDevice: ScopedLocalDeviceGrant,
  ownerUserId: string,
  operation: DeviceGrantOperation,
): boolean {
  if (grant.status !== 'active') return false;
  if (grant.identityTrust !== 'server_canonical') return false;
  if (!grant.operations.includes(operation)) return false;
  if (!sameCatsCoUserId(grant.ownerUserId, ownerUserId)) return false;
  if (!sameCatsCoUserId(grant.ownerUserId, grant.actorUserId) && !isDelegatedDeviceGrant(grant)) {
    return false;
  }
  return deviceGrantTargetsLocalDevice(grant, localDevice);
}

function deviceGrantTargetsLocalDevice(
  grant: Pick<ScopedDeviceGrant, 'deviceId' | 'deviceBodyId' | 'deviceInstallationId'>,
  localDevice: ScopedLocalDeviceGrant,
): boolean {
  let matched = false;
  const localDeviceIds = [localDevice.deviceId, localDevice.installationId].filter(Boolean);
  if (grant.deviceId) {
    if (!localDeviceIds.includes(grant.deviceId)) return false;
    matched = true;
  }
  if (grant.deviceInstallationId) {
    if (!localDevice.installationId || grant.deviceInstallationId !== localDevice.installationId) return false;
    matched = true;
  }
  if (grant.deviceBodyId) {
    if (!localDevice.bodyId || grant.deviceBodyId !== localDevice.bodyId) return false;
    matched = true;
  }
  return matched;
}

function sameCatsCoUserId(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeCatsCoUserId(left);
  const normalizedRight = normalizeCatsCoUserId(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function normalizeCatsCoUserId(value: string | undefined): string {
  const text = String(value || '').trim();
  if (!text) return '';
  return /^\d+$/.test(text) ? `usr${text}` : text;
}
