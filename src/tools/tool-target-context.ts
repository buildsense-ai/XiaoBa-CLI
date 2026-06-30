import type { DeviceGrantOperation } from '../types/session-identity';
import type { ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { isCatsCoToolGatewayContext, type ToolGatewayDecision } from './tool-gateway';

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

  const target = resolveToolTarget(context, options.gateway);
  const cwd = preserveCwdForTarget(options.cwd || context.workingDirectory);
  const lines = [
    TOOL_TARGET_CONTEXT_PREFIX,
    `tool: ${options.toolName}`,
    `operation: ${operation}`,
    `target: ${target.kind}`,
    target.displayName ? `target_display_name: ${target.displayName}` : '',
    cwd ? `cwd: ${cwd}` : '',
    options.shell ? `shell: ${options.shell}` : '',
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

function resolveToolTarget(
  context: ToolExecutionContext,
  gateway?: ToolGatewayDecision,
): { kind: string; displayName?: string } {
  if (gateway?.ok && gateway.mode === 'remote') {
    return {
      kind: 'speaker_default',
      displayName: gateway.targetDeviceDisplayName,
    };
  }

  if (context.deviceRpcReceiver || context.executionScope?.permissionsSource === 'device_rpc_forward') {
    return {
      kind: 'speaker_default',
      displayName: context.deviceSelection?.selectedDeviceDisplayName,
    };
  }

  if (context.executionContext) {
    const target = context.executionContext.executionTargets.find(item => item.id === 'agent_self');
    return {
      kind: 'agent_self',
      displayName: target?.label,
    };
  }

  if (context.deviceSelection?.status === 'selected') {
    return {
      kind: 'backend_selected_device',
      displayName: context.deviceSelection.selectedDeviceDisplayName,
    };
  }

  return { kind: 'current_local_runtime' };
}

function preserveCwdForTarget(cwd: string | undefined): string | undefined {
  const text = String(cwd || '').trim();
  return text || undefined;
}
