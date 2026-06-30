import type { DeviceGrantOperation } from '../types/session-identity';
import type { ToolErrorCode, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import type { ToolGatewayDecision } from './tool-gateway';

const REMOTE_TOOL_TIMEOUT_MS = 60_000;
export const MAX_DEVICE_RPC_TOOL_CONTENT_CHARS = 48_000;

export function isRemoteReadonlyTool(toolName: string, operation: DeviceGrantOperation): boolean {
  return (toolName === 'read_file' && operation === 'read_file')
    || (toolName === 'resolve_common_directory' && operation === 'resolve_common_directory')
    || (toolName === 'glob' && operation === 'glob')
    || (toolName === 'grep' && operation === 'grep');
}

export function isRemoteDeviceRpcTool(toolName: string, operation: DeviceGrantOperation): boolean {
  return isRemoteReadonlyTool(toolName, operation)
    || (toolName === 'write_file' && operation === 'write_file')
    || (toolName === 'edit_file' && operation === 'edit_file')
    || (toolName === 'execute_shell' && operation === 'execute_shell');
}

export async function executeRemoteDeviceRpcTool(
  context: ToolExecutionContext,
  gateway: ToolGatewayDecision,
  toolName: 'read_file' | 'resolve_common_directory' | 'glob' | 'grep' | 'write_file' | 'edit_file' | 'execute_shell',
  operation: DeviceGrantOperation,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult | undefined> {
  if (!gateway.ok || gateway.mode !== 'remote') return undefined;

  if (!isRemoteDeviceRpcTool(toolName, operation)) {
    return {
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: `远程设备 RPC 当前只允许 read_file / resolve_common_directory / glob / grep / write_file / edit_file / execute_shell，已阻止 ${toolName}。普通文件任务请优先用 resolve_common_directory / glob / write_file，只有服务端授权后才使用 execute_shell。`,
    };
  }

  if (!context.deviceRpc) {
    return {
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: '后端选定的设备不是当前运行体，但当前上下文没有远程设备 RPC 通道。',
    };
  }

  try {
    return await context.deviceRpc.executeTool({
      toolName,
      operation,
      args: stripTransportOnlyArgs(args),
      grant: gateway.grant,
      targetDeviceId: gateway.targetDeviceId,
      targetDeviceDisplayName: gateway.targetDeviceDisplayName,
      targetDeviceBodyId: gateway.targetDeviceBodyId,
      targetDeviceInstallationId: gateway.targetDeviceInstallationId,
      timeoutMs: gateway.grant ? timeoutForGrant(gateway.grant.expiresAt) : REMOTE_TOOL_TIMEOUT_MS,
    });
  } catch (error: any) {
    return {
      ok: false,
      errorCode: mapRpcErrorCode(error),
      message: `远程设备工具执行失败: ${error?.message || error || 'unknown error'}`,
      retryable: isRetryableRpcError(error),
    };
  }
}

function stripTransportOnlyArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { target: _target, ...rest } = args;
  return rest;
}

export async function executeRemoteReadonlyTool(
  context: ToolExecutionContext,
  gateway: ToolGatewayDecision,
  toolName: 'read_file' | 'glob' | 'grep',
  operation: DeviceGrantOperation,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult | undefined> {
  return executeRemoteDeviceRpcTool(context, gateway, toolName, operation, args);
}

export function normalizeDeviceRpcToolResultPayload(payload: unknown): ToolExecutionResult {
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      errorCode: 'TOOL_EXECUTION_ERROR',
      message: '远程设备返回了无效工具结果。',
    };
  }
  const record = payload as Record<string, unknown>;
  if (record.ok === true) {
    return {
      ok: true,
      content: normalizeDeviceRpcContent(record.content),
    };
  }
  if (record.ok === false) {
    return {
      ok: false,
      errorCode: normalizeErrorCode(record.errorCode),
      message: truncateText(String(record.message || '远程设备工具执行失败。')),
      retryable: Boolean(record.retryable),
    };
  }
  return {
    ok: false,
    errorCode: 'TOOL_EXECUTION_ERROR',
    message: '远程设备返回的工具结果缺少 ok 字段。',
  };
}

export function normalizeDeviceRpcToolResultForTransport(result: ToolExecutionResult): ToolExecutionResult {
  if (!result.ok) {
    return {
      ok: false,
      errorCode: normalizeErrorCode(result.errorCode),
      message: truncateText(result.message),
      retryable: Boolean(result.retryable),
    };
  }
  return {
    ok: true,
    content: normalizeDeviceRpcContent(result.content),
  };
}

function timeoutForGrant(expiresAt: number): number {
  const remaining = expiresAt - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return 10_000;
  return Math.max(5_000, Math.min(REMOTE_TOOL_TIMEOUT_MS, remaining));
}

function normalizeDeviceRpcContent(content: unknown): string {
  if (typeof content === 'string') return truncateText(content);
  if (Array.isArray(content)) {
    const lines: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const record = block as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string') {
        lines.push(record.text);
      } else if (record.type === 'image') {
        lines.push('[远程设备返回了图片内容块；当前 Device RPC 不转发图片二进制，请让用户以附件方式上传该图片。]');
      }
    }
    return truncateText(lines.join('\n'));
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (record._imageForNewMessage) {
      return '[远程设备读取到图片文件；当前 Device RPC 不转发图片二进制，请让用户以附件方式上传该图片。]';
    }
  }
  return truncateText(String(content ?? ''));
}

function truncateText(value: string): string {
  if (value.length <= MAX_DEVICE_RPC_TOOL_CONTENT_CHARS) return value;
  return [
    value.slice(0, MAX_DEVICE_RPC_TOOL_CONTENT_CHARS),
    '',
    `[远程设备结果超过 ${MAX_DEVICE_RPC_TOOL_CONTENT_CHARS} 字符，已截断。请用更精确的 path/pattern/limit/offset 继续读取。]`,
  ].join('\n');
}

function normalizeErrorCode(value: unknown): ToolErrorCode {
  const text = String(value || '').trim();
  if (
    text === 'TOOL_NOT_FOUND'
    || text === 'INVALID_TOOL_ARGUMENTS'
    || text === 'TOOL_EXECUTION_ERROR'
    || text === 'RATE_LIMIT'
    || text === 'PERMISSION_DENIED'
    || text === 'FILE_NOT_FOUND'
    || text === 'EXECUTION_TIMEOUT'
  ) {
    return text;
  }
  return 'TOOL_EXECUTION_ERROR';
}

function mapRpcErrorCode(error: any): ToolErrorCode {
  const text = String(error?.code || error?.kind || error?.message || '').toLowerCase();
  if (text.includes('timeout')) return 'EXECUTION_TIMEOUT';
  if (text.includes('permission') || text.includes('forbidden') || text.includes('denied')) return 'PERMISSION_DENIED';
  return 'TOOL_EXECUTION_ERROR';
}

function isRetryableRpcError(error: any): boolean {
  const text = String(error?.code || error?.kind || error?.message || '').toLowerCase();
  return text.includes('timeout') || text.includes('offline') || text.includes('unavailable') || text.includes('transport');
}
