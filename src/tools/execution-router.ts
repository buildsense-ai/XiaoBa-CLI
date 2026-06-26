import type { DeviceGrantOperation, ScopedDeviceGrant } from '../types/session-identity';
import type { ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { executeRemoteDeviceRpcTool } from './device-rpc-tool';

export type ExecutionTargetId = 'agent_self' | 'speaker_default';

export type ExecutionRoute =
  | { ok: true; mode: 'local'; target: ExecutionTargetId; label: string }
  | {
      ok: true;
      mode: 'remote';
      target: ExecutionTargetId;
      label: string;
      grant?: ScopedDeviceGrant;
      targetDeviceId: string;
      targetDeviceDisplayName?: string;
      targetDeviceBodyId?: string;
      targetDeviceInstallationId?: string;
    }
  | { ok: false; errorCode: string; message: string };

const TARGET_VALUES = new Set(['agent_self', 'speaker_default']);

export function normalizeExecutionTarget(value: unknown): ExecutionTargetId | undefined {
  const text = String(value || '').trim();
  return TARGET_VALUES.has(text) ? text as ExecutionTargetId : undefined;
}

export function stripExecutionTargetArg<T extends Record<string, unknown>>(args: T): T {
  if (!Object.prototype.hasOwnProperty.call(args, 'target')) return args;
  const { target: _target, ...rest } = args;
  return rest as T;
}

export function targetParameterDescription(): { type: 'string'; enum: string[]; description: string } {
  return {
    type: 'string',
    enum: ['agent_self', 'speaker_default'],
    description: [
      'Optional execution target.',
      'Use agent_self for XiaoBa/bot/your own computer.',
      'Use speaker_default for the current speaker/user/my computer in CatsCo remote or group chats.',
      'If omitted, the runtime default is agent_self.',
    ].join(' '),
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
  const target = explicitTarget
    || context.executionContext?.defaultTarget
    || 'agent_self';

  if (target === 'agent_self' || context.surface !== 'catscompany') {
    return {
      ok: true,
      mode: 'local',
      target: 'agent_self',
      label: findTargetLabel(context, 'agent_self') || 'XiaoBa local computer',
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
  return executeRemoteDeviceRpcTool(context, {
    ok: true,
    mode: 'remote',
    grant: route.grant,
    targetDeviceId: route.targetDeviceId,
    targetDeviceDisplayName: route.targetDeviceDisplayName,
    targetDeviceBodyId: route.targetDeviceBodyId,
    targetDeviceInstallationId: route.targetDeviceInstallationId,
  }, toolName, operation, stripExecutionTargetArg(args));
}

function findTargetLabel(context: ToolExecutionContext, target: ExecutionTargetId): string | undefined {
  const targets = context.executionContext?.executionTargets || [];
  if (target === 'agent_self') {
    return targets.find(item => item.id === 'agent_self')?.label;
  }
  return targets.find(item => item.id === 'speaker_default')?.label
    || targets.find(item => item.kind === 'participant' && item.userId === context.executionContext?.conversation.currentSpeaker.id)?.label;
}

function findSpeakerRemoteTarget(context: ToolExecutionContext): {
  grant?: ScopedDeviceGrant;
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
  if (selected) return { ...selected, grant: selectedGrant };

  const grant = context.deviceGrants?.find(item => item.status === 'active') || context.deviceGrants?.[0];
  if (grant?.deviceId) {
    return {
      grant,
      deviceId: grant.deviceId,
      displayName: grant.deviceDisplayName,
      bodyId: grant.deviceBodyId,
      installationId: grant.deviceInstallationId,
    };
  }
  return undefined;
}
