import type { DeviceGrantOperation, ScopedDeviceGrant } from '../types/session-identity';
import type { TargetRoute, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { normalizeTargetText } from '../catscompany/runtime-context';
import { executeRemoteDeviceRpcTool } from './device-rpc-tool';
import { TOOL_TARGET_CONTEXT_PREFIX, TOOL_TARGET_CONTEXT_SUFFIX } from './tool-target-context';

export type ExecutionTargetId = 'agent_self' | string;

export type ExecutionRoute =
  | { ok: true; mode: 'local'; target: ExecutionTargetId; label: string }
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
    description: 'Optional. Omit target to run on the host computer running this agent. Set target to a chat participant\'s displayed name or user id only when the user explicitly asks to operate that participant\'s computer.',
  };
}

export function resolveExecutionRoute(
  context: ToolExecutionContext,
  options: {
    toolName: string;
    operation: DeviceGrantOperation;
    target?: unknown;
  },
): ExecutionRoute {
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
    return {
      ok: true,
      mode: 'remote',
      target,
      label: runtimeRoute.route.label,
      targetOwnerUserId: runtimeRoute.route.ownerUserId,
      targetDeviceId: runtimeRoute.route.deviceId,
      targetDeviceDisplayName: runtimeRoute.route.label,
    };
  }
  if (runtimeRoute.reason === 'not_found' || runtimeRoute.reason === 'ambiguous') {
    return {
      ok: false,
      errorCode: runtimeRoute.reason === 'ambiguous' ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND',
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
        'Omit target to run on the host computer running this agent.',
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
        'Use target="agent_self" for XiaoBa local execution, or ask the user to start CatsCo on their computer.',
      ].join('\n'),
    };
  }

  if (!context.deviceRpc) {
    if (context.thinToolRpc && remote.ownerUserId) {
      return {
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
      };
    }
    return {
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: 'Current-speaker device was selected, but this runtime has no Device RPC transport.',
    };
  }

  return {
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
  };
}

export async function executeRouteIfRemote(
  context: ToolExecutionContext,
  route: ExecutionRoute,
  toolName: 'read_file' | 'resolve_common_directory' | 'glob' | 'grep' | 'write_file' | 'edit_file' | 'execute_shell',
  operation: DeviceGrantOperation,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult | undefined> {
  if (!route.ok || route.mode !== 'remote') return undefined;
  if (context.thinToolRpc && route.targetOwnerUserId) {
    const result = await context.thinToolRpc.executeTool({
      targetOwnerUserId: route.targetOwnerUserId,
      targetDeviceId: route.targetDeviceId,
      toolName,
      args: stripExecutionTargetArg(args),
    });
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
  | { ok: false; reason: 'not_found' | 'ambiguous'; message: string }
) {
  const targetRoutes = context.targetRoutes;
  if (!targetRoutes || targetRoutes.routes.length === 0) {
    return { ok: false, reason: 'missing_routes' };
  }
  const normalized = normalizeTargetText(target);
  const matches = [
    ...(targetRoutes.byUserId.get(normalized) || []),
    ...(targetRoutes.byName.get(normalized) || []),
  ];
  const unique = uniqueRoutes(matches);
  if (unique.length === 1) return { ok: true, route: unique[0] };
  if (unique.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      message: [
        `Target "${target}" matches multiple user computers.`,
        availableTargetsMessage(context),
        'Use the exact displayed name or user id.',
      ].filter(Boolean).join('\n'),
    };
  }
  return {
    ok: false,
    reason: 'not_found',
    message: [
      `No ready user computer matched target "${target}".`,
      availableTargetsMessage(context),
      'Omit target to run on the host computer running this agent.',
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
  return `Available user computer targets: ${routes.map(route => route.userName || route.userId).join(', ')}`;
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
