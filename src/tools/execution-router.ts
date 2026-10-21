import type { DeviceGrantOperation, ScopedDeviceGrant } from '../types/session-identity';
import type { TargetRoute, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { normalizeTargetText } from '../catscompany/runtime-context';
import { executeRemoteDeviceRpcTool, resolveRemoteToolTimeoutMs } from './device-rpc-tool';
import { resolveGrepRpcTimeoutMs } from './grep-search-policy';
import { TOOL_TARGET_CONTEXT_PREFIX, TOOL_TARGET_CONTEXT_SUFFIX } from './tool-target-context';
import {
  isArtifactPublishSkillCommand,
  isRevokedBotSkillSnapshotCommand,
  resolveTrustedBotSkillScriptInvocation,
  type TrustedBotSkillScriptInvocation,
} from '../bot-skills/trusted-script-execution';
import { Logger } from '../utils/logger';
import { resolveDeviceGrant } from '../core/device-grants';

export type ExecutionTargetId = 'agent_self' | string;

export type ExecutionRoute =
  | {
      ok: true;
      mode: 'local';
      target: ExecutionTargetId;
      label: string;
      trustedSkillScript?: TrustedBotSkillScriptInvocation;
    }
  | {
      ok: true;
      mode: 'remote';
      target: ExecutionTargetId;
      label: string;
      grant?: ScopedDeviceGrant;
      targetOwnerUserId?: string;
      targetDeviceId: string;
      targetDeviceDisplayName?: string;
      targetDeviceBodyId?: string;
      targetDeviceInstallationId?: string;
    }
  | { ok: false; errorCode: string; message: string };

export function normalizeExecutionTarget(value: unknown): string | undefined {
  const text = String(value || '').trim();
  return text || undefined;
}

export function stripExecutionTargetArg<T extends Record<string, unknown>>(args: T): T {
  if (!Object.prototype.hasOwnProperty.call(args, 'target')) return args;
  const { target: _target, ...rest } = args;
  return rest as T;
}

export function targetParameterDescription(): { type: 'string'; description: string } {
  return {
    type: 'string',
    description: 'Optional. Omit target only for work intended for the host running this agent (including normal Skill/attachment work). For a user computer, use its exact device name/id from the current device directory, or the participant name/id for their currently selected computer. If the requested device is missing, ambiguous, offline or different from the selected device, stop and ask the user to identify/select it. Never omit/change target or translate paths to search another computer as a fallback.',
  };
}

const failedTargetRuns = new WeakSet<object>();
const TARGET_FAILURE_CODES = new Set(['TARGET_NOT_FOUND', 'TARGET_AMBIGUOUS', 'TARGET_UNAVAILABLE']);

export function getDeviceTargetResolutionFailure(context: ToolExecutionContext): Extract<ExecutionRoute, { ok: false }> | undefined {
  if (context.surface !== 'catscompany' || context.deviceRpcReceiver
    || !context.targetResolutionState || !failedTargetRuns.has(context.targetResolutionState)) return undefined;
  return {
    ok: false,
    errorCode: 'TARGET_RESOLUTION_BLOCKED',
    message: '本轮指定的设备目标未能确认，已停止后续设备/文件操作。不能删除 target、改用其他电脑或 Bot 宿主机，也不能猜测其他系统的路径。请说明目标不可用并等待用户确认目标后发起新请求；不要推断该设备是否存在或属于谁。',
  };
}

function rememberTargetFailure(context: ToolExecutionContext, route: ExecutionRoute): void {
  if (context.surface === 'catscompany' && !context.deviceRpcReceiver && context.targetResolutionState
    && !route.ok && TARGET_FAILURE_CODES.has(route.errorCode)) {
    failedTargetRuns.add(context.targetResolutionState);
  }
}

export function resolveExecutionRoute(
  context: ToolExecutionContext,
  options: Parameters<typeof resolveExecutionRouteUnchecked>[1],
): ExecutionRoute {
  const blocked = getDeviceTargetResolutionFailure(context);
  if (blocked) return blocked;
  const route = resolveExecutionRouteUnchecked(context, options);
  rememberTargetFailure(context, route);
  return route;
}

function resolveExecutionRouteUnchecked(
  context: ToolExecutionContext,
  options: {
    toolName: string;
    operation: DeviceGrantOperation;
    target?: unknown;
    command?: unknown;
    cwd?: unknown;
  },
): ExecutionRoute {
  let trustedSkillScript: TrustedBotSkillScriptInvocation | undefined;
  if (options.operation === 'execute_shell') {
    const decision = resolveTrustedBotSkillScriptInvocation(options.command, context, {
      cwd: options.cwd,
      target: options.target,
    });
    if (decision.ok) trustedSkillScript = decision.invocation;
    else if (isRevokedBotSkillSnapshotCommand(options.command, context, {
      cwd: options.cwd,
      target: options.target,
    })) {
      return {
        ok: false,
        errorCode: 'PERMISSION_DENIED',
        message: 'The command points to a revoked Bot Skill snapshot. Restore or install the Skill again before running its scripts.',
      };
    }
    else if (isArtifactPublishSkillCommand(options.command, context, { cwd: options.cwd })) {
      return {
        ok: false,
        errorCode: 'PERMISSION_DENIED',
        message: `The artifact-publish command was rejected: ${decision.reason} No command in the plan was executed. Do not set source fields manually.`,
      };
    }
    else if (looksLikeSkillScriptCommand(options.command) && context.executionScope?.source === 'catscompany') {
      Logger.warning(
        `[CatsCompany][shimo_connector] trusted script rejected: reason=${decision.reason} `
          + `grant_count=${context.skillConnectorGrants?.length || 0}`,
      );
    }
  }
  if (context.deviceRpcReceiver) {
    return { ok: true, mode: 'local', target: 'speaker_default', label: 'current Device RPC receiver' };
  }

  const explicitTarget = normalizeExecutionTarget(options.target);
  const target = explicitTarget || 'agent_self';

  if (!explicitTarget || target === 'agent_self' || context.surface !== 'catscompany') {
    return {
      ok: true,
      mode: 'local',
      target: 'agent_self',
      label: findTargetLabel(context, 'agent_self') || 'XiaoBa local computer',
      ...(trustedSkillScript ? { trustedSkillScript } : {}),
    };
  }

  const runtimeRoute = findRuntimeTargetRoute(context, target);
  if (runtimeRoute.ok) {
    if (!context.thinToolRpc) {
      return {
        ok: false,
        errorCode: 'TARGET_UNAVAILABLE',
        message: `Target "${target}" matched ${runtimeRoute.route.label}, but this runtime has no thin tool RPC transport.`,
      };
    }
    return authorizeRemoteRoute(context, {
      ok: true,
      mode: 'remote',
      target,
      label: runtimeRoute.route.label,
      targetOwnerUserId: runtimeRoute.route.ownerUserId,
      targetDeviceId: runtimeRoute.route.deviceId,
      targetDeviceDisplayName: runtimeRoute.route.label,
    }, options.operation);
  }
  if (runtimeRoute.reason === 'not_found' || runtimeRoute.reason === 'ambiguous' || runtimeRoute.reason === 'unavailable') {
    return {
      ok: false,
      errorCode: runtimeRoute.reason === 'ambiguous' ? 'TARGET_AMBIGUOUS' : runtimeRoute.reason === 'unavailable' ? 'TARGET_UNAVAILABLE' : 'TARGET_NOT_FOUND',
      message: runtimeRoute.message,
    };
  }

  if (target !== 'speaker_default') {
    return {
      ok: false,
      errorCode: 'TARGET_NOT_FOUND',
      message: [
        `No ready user computer matched target "${target}".`,
        availableTargetsMessage(context),
        'Stop and ask the user to identify/select the intended device. Do not omit target or probe another computer or the agent host.',
      ].filter(Boolean).join('\n'),
    };
  }

  const remote = findSpeakerRemoteTarget(context);
  if (!remote) {
    return {
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: [
        'No ready current-speaker device is available for this tool call.',
        'Ask the user to connect/select the intended computer. Do not switch to agent_self or another device as a fallback.',
      ].join('\n'),
    };
  }

  if (!context.deviceRpc) {
    if (context.thinToolRpc && remote.ownerUserId) {
      return authorizeRemoteRoute(context, {
        ok: true,
        mode: 'remote',
        target,
        label: remote.displayName || findTargetLabel(context, 'speaker_default') || 'current speaker device',
        grant: remote.grant,
        targetOwnerUserId: remote.ownerUserId,
        targetDeviceId: remote.deviceId,
        targetDeviceDisplayName: remote.displayName,
        targetDeviceBodyId: remote.bodyId,
        targetDeviceInstallationId: remote.installationId,
      }, options.operation);
    }
    return {
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: 'Current-speaker device was selected, but this runtime has no Device RPC transport.',
    };
  }

  return authorizeRemoteRoute(context, {
    ok: true,
    mode: 'remote',
    target,
    label: remote.displayName || findTargetLabel(context, 'speaker_default') || 'current speaker device',
    grant: remote.grant,
    targetOwnerUserId: remote.ownerUserId,
    targetDeviceId: remote.deviceId,
    targetDeviceDisplayName: remote.displayName,
    targetDeviceBodyId: remote.bodyId,
    targetDeviceInstallationId: remote.installationId,
  }, options.operation);
}

function authorizeRemoteRoute(
  context: ToolExecutionContext,
  route: Extract<ExecutionRoute, { ok: true; mode: 'remote' }>,
  operation: DeviceGrantOperation,
): ExecutionRoute {
  const scope = context.executionScope;
  if (!scope?.isTrusted || scope.identityTrust !== 'server_canonical' || scope.source !== 'catscompany') {
    return { ok: false, errorCode: 'PERMISSION_DENIED', message: '远程设备操作缺少可信的当前会话身份。' };
  }
  const selection = context.deviceSelection;
  if (selection && (selection.identityTrust !== 'server_canonical'
    || selection.sessionKey !== scope.sessionKey || selection.actorUserId !== scope.actorUserId
    || selection.agentId !== scope.agentId || selection.topicId !== scope.topicId
    || selection.topicType !== scope.topicType || selection.source !== scope.source
    || selection.status !== 'selected' || selection.selectedDeviceId !== route.targetDeviceId)) {
    return { ok: false, errorCode: 'TARGET_UNAVAILABLE', message: '当前选定设备不可用或与请求目标不一致；不会自动改用另一台电脑。请确认目标设备后重试。' };
  }
  const decision = resolveDeviceGrant(context, { deviceId: route.targetDeviceId, operation });
  if (!decision.ok) return decision;
  const grant = decision.grant;
  if (route.grant && (route.grant.grantId !== grant.grantId
    || !Number.isFinite(route.grant.expiresAt) || route.grant.expiresAt <= Date.now())) {
    return { ok: false, errorCode: 'PERMISSION_DENIED', message: '路由授权已失效，请重新获取当前会话的设备授权。' };
  }
  if (grant.identityTrust !== 'server_canonical' || !grant.grantId || !Number.isFinite(grant.expiresAt)
    || (route.targetOwnerUserId && route.targetOwnerUserId !== grant.ownerUserId)) {
    return { ok: false, errorCode: 'PERMISSION_DENIED', message: '设备授权与目标账号不一致或无效。' };
  }
  return { ...route, grant, targetOwnerUserId: grant.ownerUserId };
}

function looksLikeSkillScriptCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return /(?:^|[\\/\s])scripts[\\/][^\s"']+\.(?:mjs|cjs|js)(?:$|[\s"'])/i.test(command);
}

export async function executeRouteIfRemote(
  context: ToolExecutionContext,
  route: ExecutionRoute,
  toolName: 'read_file' | 'resolve_common_directory' | 'glob' | 'grep' | 'write_file' | 'edit_file' | 'send_file' | 'import_file' | 'execute_shell',
  operation: DeviceGrantOperation,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult | undefined> {
  const blocked = getDeviceTargetResolutionFailure(context);
  if (blocked) return { ...blocked, retryable: false };
  if (!route.ok || route.mode !== 'remote') return undefined;
  // Revalidate at dispatch as grants may expire or the selected device may
  // change after route resolution. Never retry through an unscoped transport.
  const authorized = authorizeRemoteRoute(context, route, operation);
  rememberTargetFailure(context, authorized);
  if (!authorized.ok) return { ...authorized, retryable: false };
  if (authorized.mode !== 'remote') return undefined;
  route = authorized;
  if (context.thinToolRpc && route.targetOwnerUserId) {
    let timeoutMs: number | undefined = toolName === 'send_file' || toolName === 'import_file' ? 300_000 : undefined;
    if (toolName === 'grep') {
      const dispatchNow = Date.now();
      if (route.grant?.expiresAt !== undefined
        && (!Number.isFinite(route.grant.expiresAt) || route.grant.expiresAt <= dispatchNow)) {
        return { ok: false, errorCode: 'PERMISSION_DENIED', message: 'grep 设备授权已过期或无效；请刷新授权后再试。', retryable: false };
      }
      try {
        timeoutMs = resolveRemoteToolTimeoutMs(route.grant?.expiresAt, resolveGrepRpcTimeoutMs(args.timeout_ms), dispatchNow);
      } catch (error: any) {
        return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: error.message, retryable: false };
      }
    }
    let result: ToolExecutionResult;
    try {
      result = await context.thinToolRpc.executeTool({
        targetOwnerUserId: route.targetOwnerUserId,
        grant: route.grant,
        targetDeviceId: route.targetDeviceId,
        toolName,
        args: stripExecutionTargetArg(args),
        timeoutMs,
      });
    } catch (error: any) {
      // Preserve the existing exception path for all other tools. Grep's
      // transport deadline is an incomplete search, never a no-match fact.
      if (toolName !== 'grep' || !/timeout|timed out|deadline/i.test(String(error?.code || error?.kind || error?.message || ''))) throw error;
      result = {
        ok: false, errorCode: 'SEARCH_TIMEOUT', retryable: false,
        message: '远程 grep 未在限定时间内返回；搜索不完整，不代表没有匹配。请缩小 path/glob，不要原样重复全目录搜索。',
      };
    }
    return attachRouteTargetContext(
      stripRemoteToolTargetContext(result),
      route,
      {
        toolName,
        operation,
        cwd: routeTargetCwd(toolName, args, context.workingDirectory),
      },
    );
  }
  const result = await executeRemoteDeviceRpcTool(context, {
    ok: true,
    mode: 'remote',
    grant: route.grant,
    targetDeviceId: route.targetDeviceId,
    targetDeviceDisplayName: route.targetDeviceDisplayName,
    targetDeviceBodyId: route.targetDeviceBodyId,
    targetDeviceInstallationId: route.targetDeviceInstallationId,
  }, toolName, operation, stripExecutionTargetArg(args));
  if (!result) return result;
  return attachRouteTargetContext(
    stripRemoteToolTargetContext(result),
    route,
    {
      toolName,
      operation,
      cwd: routeTargetCwd(toolName, args, context.workingDirectory),
    },
  );
}

export function buildExecutionRouteTargetContext(
  route: Extract<ExecutionRoute, { ok: true }>,
  options: {
    toolName: string;
    operation: DeviceGrantOperation;
    cwd?: string;
    shell?: string;
  },
): string {
  const lines = [
    TOOL_TARGET_CONTEXT_PREFIX,
    `tool: ${options.toolName}`,
    `operation: ${options.operation}`,
    `target: ${route.target}`,
    route.label ? `target_display_name: ${route.label}` : '',
    options.cwd ? `cwd: ${options.cwd}` : '',
    options.shell ? `shell: ${options.shell}` : '',
    'path_scope: Paths in this result belong only to the target above. Re-resolve common directories after switching targets.',
    TOOL_TARGET_CONTEXT_SUFFIX,
  ].filter(Boolean);
  return lines.join('\n');
}

export function attachRouteTargetContext(
  result: ToolExecutionResult,
  route: Extract<ExecutionRoute, { ok: true }>,
  options: {
    toolName: string;
    operation: DeviceGrantOperation;
    cwd?: string;
    shell?: string;
  },
): ToolExecutionResult {
  return {
    ...result,
    targetContext: buildExecutionRouteTargetContext(route, options),
  };
}

function stripRemoteToolTargetContext(result: ToolExecutionResult): ToolExecutionResult {
  if (result.ok) {
    if (typeof result.content !== 'string') return result;
    return {
      ...result,
      content: stripAllToolTargetContextBlocks(result.content),
    };
  }
  return {
    ...result,
    message: stripAllToolTargetContextBlocks(result.message),
  };
}

function stripAllToolTargetContextBlocks(content: string): string {
  return String(content || '')
    .replace(/\s*\[tool_target\]\r?\n[\s\S]*?\r?\n\[\/tool_target\]\s*/gu, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function routeTargetCwd(
  toolName: string,
  args: Record<string, unknown>,
  fallback: string,
): string | undefined {
  if (toolName === 'execute_shell') {
    const cwd = args.cwd;
    return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : fallback;
  }
  const pathArg = args.path || args.file_path;
  return typeof pathArg === 'string' && pathArg.trim() ? pathArg.trim() : fallback;
}

function findTargetLabel(context: ToolExecutionContext, target: ExecutionTargetId): string | undefined {
  const targets = context.executionContext?.executionTargets || [];
  if (target === 'agent_self') {
    return targets.find(item => item.id === 'agent_self')?.label;
  }
  return targets.find(item => item.id === 'speaker_default')?.label
    || targets.find(item => item.kind === 'participant' && item.userId === context.executionContext?.conversation.currentSpeaker.id)?.label;
}

function findRuntimeTargetRoute(context: ToolExecutionContext, target: string): (
  | { ok: true; route: TargetRoute }
  | { ok: false; reason: 'missing_routes' }
  | { ok: false; reason: 'not_found' | 'ambiguous' | 'unavailable'; message: string }
) {
  const targetRoutes = context.targetRoutes;
  if (!targetRoutes || targetRoutes.routes.length === 0) {
    return { ok: false, reason: 'missing_routes' };
  }
  const normalized = normalizeTargetText(target);
  const scope = context.executionScope;
  const owner = scope?.deviceOwnerUserId || scope?.actorUserId;
  const selection = context.deviceSelection;
  // Resolve a user alias through the server's current selection, not array
  // ordering. An explicit device label/ID must never silently mean another ID.
  const isDeviceName = targetRoutes.routes.some(route => normalizeTargetText(route.label) === normalized || normalizeTargetText(route.deviceId) === normalized);
  const isOwnerAlias = target === 'speaker_default' || (!isDeviceName && targetRoutes.routes.some(route => route.ownerUserId === owner
    && (normalizeTargetText(route.userId) === normalized || normalizeTargetText(route.userName) === normalized)));
  if (isOwnerAlias && selection) {
    if (selection.status !== 'selected' || !selection.selectedDeviceId) {
      return { ok: false, reason: selection.status === 'needs_selection' ? 'ambiguous' : 'unavailable',
        message: '当前会话尚未选定可用电脑。请确认目标设备；不会自动切换到另一台电脑。' };
    }
    const selected = targetRoutes.routes.find(route => route.ownerUserId === owner && route.deviceId === selection.selectedDeviceId);
    if (!selected || selected.status !== 'ready') {
      return { ok: false, reason: 'unavailable', message: `选定电脑 ${selection.selectedDeviceDisplayName || selection.selectedDeviceId} 暂时不可用。不会改用其他电脑执行。` };
    }
    return { ok: true, route: selected };
  }
  const matches = [
    ...(targetRoutes.byUserId.get(normalized) || []),
    ...(targetRoutes.byName.get(normalized) || []),
  ];
  const unique = uniqueRoutes(matches);
  if (unique.length === 1) return unique[0].status === 'ready'
    ? { ok: true, route: unique[0] }
    : { ok: false, reason: 'unavailable', message: `电脑 ${unique[0].label} 暂时不可用。不会改用其他电脑执行。` };
  if (unique.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      message: [
        `Target "${target}" matches multiple user computers.`,
        availableTargetsMessage(context),
        'Ask the user to confirm a specific device; identical names require a device ID.',
      ].filter(Boolean).join('\n'),
    };
  }
  return {
    ok: false,
    reason: 'not_found',
    message: [
      `No ready user computer matched target "${target}".`,
      availableTargetsMessage(context),
      'Ask the user to confirm the device. Do not run this path on another computer.',
    ].filter(Boolean).join('\n'),
  };
}

function uniqueRoutes(routes: TargetRoute[]): TargetRoute[] {
  const seen = new Set<string>();
  const out: TargetRoute[] = [];
  for (const route of routes) {
    const key = `${route.userId}\u0000${route.deviceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(route);
  }
  return out;
}

function availableTargetsMessage(context: ToolExecutionContext): string {
  const routes = context.targetRoutes?.routes || [];
  if (routes.length === 0) return 'No user computer targets are currently available.';
  return `User computers: ${routes.map(route => `${route.label} [${route.deviceId}] (${route.status})`).join(', ')}`;
}

function findSpeakerRemoteTarget(context: ToolExecutionContext): {
  grant?: ScopedDeviceGrant;
  ownerUserId?: string;
  deviceId: string;
  displayName?: string;
  bodyId?: string;
  installationId?: string;
} | undefined {
  const selected = context.deviceSelection?.selectedDeviceId
    ? {
        deviceId: context.deviceSelection.selectedDeviceId,
        displayName: context.deviceSelection.selectedDeviceDisplayName,
        bodyId: context.deviceSelection.selectedDeviceBodyId,
        installationId: context.deviceSelection.selectedDeviceInstallationId,
      }
    : undefined;
  const selectedGrant = selected
    ? context.deviceGrants?.find(grant => grant.deviceId === selected.deviceId)
    : undefined;
  if (selected) {
    return {
      ...selected,
      ownerUserId: selectedGrant?.ownerUserId || context.deviceSelection?.actorUserId,
      grant: selectedGrant,
    };
  }

  const grant = context.deviceGrants?.find(item => item.status === 'active') || context.deviceGrants?.[0];
  if (grant?.deviceId) {
    return {
      grant,
      ownerUserId: grant.ownerUserId || grant.actorUserId,
      deviceId: grant.deviceId,
      displayName: grant.deviceDisplayName,
      bodyId: grant.deviceBodyId,
      installationId: grant.deviceInstallationId,
    };
  }
  return undefined;
}
