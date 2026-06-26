import type { DeviceGrantOperation } from '../types/session-identity';
import type { ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import {
  isCatsCoAgentLocalBodyContext,
  isCatsCoLocalOwnerSelfContext,
  isCatsCoToolGatewayContext,
  normalizeToolTargetPreference,
  resolveToolGatewayAccess,
  type ToolTargetPreference,
  type ToolGatewayDecision,
} from './tool-gateway';

export const TOOL_TARGET_CONTEXT_PREFIX = '[tool_target]';
export const TOOL_TARGET_CONTEXT_SUFFIX = '[/tool_target]';

const DEVICE_TOOL_OPERATIONS: Partial<Record<string, DeviceGrantOperation>> = {
  read_file: 'read_file',
  resolve_common_directory: 'resolve_common_directory',
  glob: 'glob',
  grep: 'grep',
  write_file: 'write_file',
  edit_file: 'edit_file',
  execute_shell: 'execute_shell',
};

export interface ToolTargetContextOptions {
  toolName: string;
  operation?: DeviceGrantOperation;
  gateway?: ToolGatewayDecision;
  targetPreference?: ToolTargetPreference;
  cwd?: string;
  shell?: string;
}

export function operationForToolTargetContext(toolName: string): DeviceGrantOperation | undefined {
  return DEVICE_TOOL_OPERATIONS[toolName];
}

export function buildToolTargetContext(
  context: ToolExecutionContext,
  options: ToolTargetContextOptions,
): string | undefined {
  if (!isCatsCoToolGatewayContext(context)) return undefined;
  const operation = options.operation || operationForToolTargetContext(options.toolName);
  if (!operation) return undefined;

  const target = resolveToolTarget(context, options.gateway, options.targetPreference);
  const cwd = preserveCwdForTarget(options.cwd || context.workingDirectory);
  const lines = [
    TOOL_TARGET_CONTEXT_PREFIX,
    `tool: ${options.toolName}`,
    `operation: ${operation}`,
    `target: ${target.kind}`,
    target.owner ? `target_owner: ${target.owner}` : '',
    target.meaning ? `target_meaning: ${target.meaning}` : '',
    target.displayName ? `target_display_name: ${target.displayName}` : '',
    target.displayName ? `target_display_name_role: user_device_display_name_only` : '',
    cwd ? `cwd: ${cwd}` : '',
    options.shell ? `shell: ${options.shell}` : '',
    'cwd_scope: cwd is an execution directory on the target; it does not identify device ownership.',
    'path_scope: Paths in this result belong only to the target above. Re-resolve common directories after switching targets.',
    TOOL_TARGET_CONTEXT_SUFFIX,
  ].filter(Boolean);

  return lines.join('\n');
}

export function annotateToolExecutionResultWithTargetContext(
  result: ToolExecutionResult,
  context: ToolExecutionContext,
  options: ToolTargetContextOptions,
): ToolExecutionResult {
  const targetContext = buildToolTargetContext(context, options);
  if (!targetContext) return result;

  if (result.ok) {
    if (typeof result.content !== 'string' || hasToolTargetContext(result.content)) return result;
    return {
      ...result,
      content: `${targetContext}\n\n${result.content}`,
    };
  }

  if (hasToolTargetContext(result.message)) return result;
  return {
    ...result,
    message: `${targetContext}\n\n${result.message}`,
  };
}

export function hasToolTargetContext(content: unknown): boolean {
  return typeof content === 'string' && content.trimStart().startsWith(TOOL_TARGET_CONTEXT_PREFIX);
}

export function prependToolTargetContext(
  content: string | import('../types').ContentBlock[],
  targetContext: string | undefined,
): string | import('../types').ContentBlock[] {
  if (!targetContext || typeof content !== 'string' || hasToolTargetContext(content)) return content;
  return `${targetContext}\n\n${content}`;
}

export function stripToolTargetContextForDisplay(content: string): string {
  return String(content || '')
    .replace(/^\s*\[tool_target\]\r?\n[\s\S]*?\r?\n\[\/tool_target\]\r?\n*/u, '')
    .replace(/^\n+/, '');
}

export function resolveToolTargetContextGateway(
  context: ToolExecutionContext,
  toolName: string,
  args: unknown,
): ToolGatewayDecision | undefined {
  const operation = operationForToolTargetContext(toolName);
  if (!operation || !isCatsCoToolGatewayContext(context)) return undefined;
  return resolveToolGatewayAccess(context, {
    toolName,
    operation,
    targetPreference: normalizeToolTargetPreference(args),
  });
}

function resolveToolTarget(
  context: ToolExecutionContext,
  gateway?: ToolGatewayDecision,
  targetPreference: ToolTargetPreference = 'auto',
): { kind: string; owner?: string; meaning?: string; displayName?: string } {
  if (targetPreference === 'agent_runtime_device' && isCatsCoAgentLocalBodyContext(context)) {
    return agentRuntimeDeviceTarget();
  }

  if (targetPreference === 'selected_user_device' && gateway?.ok) {
    return selectedUserDeviceTarget(gateway.targetDeviceDisplayName || context.deviceSelection?.selectedDeviceDisplayName);
  }

  if (gateway?.ok && gateway.mode === 'remote') {
    return selectedUserDeviceTarget(gateway.targetDeviceDisplayName);
  }

  if (context.executionScope?.permissionsSource === 'device_rpc_forward') {
    return selectedUserDeviceTarget(context.deviceSelection?.selectedDeviceDisplayName);
  }

  if (isCatsCoAgentLocalBodyContext(context)) {
    return agentRuntimeDeviceTarget();
  }

  if (isCatsCoLocalOwnerSelfContext(context)) {
    return {
      kind: 'local_owner_device',
      owner: 'local_authenticated_user',
      meaning: 'This is the local device of the authenticated user running the current runtime.',
      displayName: context.deviceSelection?.selectedDeviceDisplayName,
    };
  }

  if (context.deviceSelection?.status === 'selected') {
    return selectedUserDeviceTarget(context.deviceSelection.selectedDeviceDisplayName, 'backend_selected_device');
  }

  return {
    kind: 'current_local_runtime',
    owner: 'current_runtime',
    meaning: 'This is the local runtime process that executed the tool.',
  };
}

function preserveCwdForTarget(cwd: string | undefined): string | undefined {
  const text = String(cwd || '').trim();
  return text || undefined;
}

function agentRuntimeDeviceTarget(): { kind: string; owner: string; meaning: string } {
  return {
    kind: 'agent_runtime_device',
    owner: 'agent_self',
    meaning: "This is the current agent body's own runtime device. It may be hosted in the cloud or on a creator-owned local computer.",
  };
}

function selectedUserDeviceTarget(
  displayName?: string,
  kind = 'selected_user_device',
): { kind: string; owner: string; meaning: string; displayName?: string } {
  return {
    kind,
    owner: 'current_speaker_user',
    meaning: "This is the current speaker user's selected device, not the agent body's own runtime device.",
    displayName,
  };
}
