import type { DeviceGrantOperation } from '../types/session-identity';
import type { ToolErrorCode, ToolExecutionContext, ToolExecutionResult, UploadedFileResult } from '../types/tool';
import type { ToolGatewayDecision } from './tool-gateway';

const REMOTE_TOOL_DEFAULT_TIMEOUT_MS = 60_000;
const REMOTE_TOOL_MIN_TIMEOUT_MS = 5_000;
const REMOTE_TOOL_MAX_TIMEOUT_MS = 300_000;
export const MAX_DEVICE_RPC_TOOL_CONTENT_CHARS = 48_000;

type RemoteDeviceRpcToolName = 'read_file' | 'resolve_common_directory' | 'glob' | 'grep' | 'write_file' | 'edit_file' | 'send_file' | 'execute_shell';

interface DeviceRpcNormalizeOptions {
  toolName?: string;
}

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
    || (toolName === 'send_file' && operation === 'send_file')
    || (toolName === 'execute_shell' && operation === 'execute_shell');
}

export async function executeRemoteDeviceRpcTool(
  context: ToolExecutionContext,
  gateway: ToolGatewayDecision,
  toolName: RemoteDeviceRpcToolName,
  operation: DeviceGrantOperation,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult | undefined> {
  if (!gateway.ok || gateway.mode !== 'remote') return undefined;

  if (!isRemoteDeviceRpcTool(toolName, operation)) {
    return {
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: `远程设备 RPC 当前只允许 read_file / resolve_common_directory / glob / grep / write_file / edit_file / send_file / execute_shell，已阻止 ${toolName}。普通文件任务请优先用 resolve_common_directory / glob / write_file，只有服务端授权后才使用 execute_shell。`,
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
      timeoutMs: resolveRemoteToolTimeoutMs(gateway.grant?.expiresAt, requestedToolTimeoutMs(toolName, args)),
    });
  } catch (error: any) {
    return {
      ok: false,
      errorCode: mapRpcErrorCode(error),
      message: formatRpcErrorMessage(error, toolName),
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

export function normalizeDeviceRpcToolResultPayload(
  payload: unknown,
  options: DeviceRpcNormalizeOptions = {},
): ToolExecutionResult {
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
      content: normalizeDeviceRpcContent(record.content, options),
      uploadedFile: normalizeUploadedFileResult(record.uploadedFile),
    };
  }
  if (record.ok === false) {
    return {
      ok: false,
      errorCode: normalizeErrorCode(record.errorCode),
      message: truncateText(String(record.message || '远程设备工具执行失败。'), options),
      retryable: Boolean(record.retryable),
    };
  }
  return {
    ok: false,
    errorCode: 'TOOL_EXECUTION_ERROR',
    message: '远程设备返回的工具结果缺少 ok 字段。',
  };
}

export function normalizeDeviceRpcToolResultForTransport(
  result: ToolExecutionResult,
  options: DeviceRpcNormalizeOptions = {},
): ToolExecutionResult {
  if (!result.ok) {
    return {
      ok: false,
      errorCode: normalizeErrorCode(result.errorCode),
      message: truncateText(result.message, options),
      retryable: Boolean(result.retryable),
    };
  }
  return {
    ok: true,
    content: normalizeDeviceRpcContent(result.content, options),
    uploadedFile: normalizeUploadedFileResult(result.uploadedFile),
  };
}

export function resolveRemoteToolTimeoutMs(
  expiresAt?: number,
  requestedTimeoutMs?: number,
  now = Date.now(),
): number {
  const grantRemaining = typeof expiresAt === 'number' ? expiresAt - now : REMOTE_TOOL_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(grantRemaining) || grantRemaining <= 0) return REMOTE_TOOL_MIN_TIMEOUT_MS;
  const requested = Number.isFinite(requestedTimeoutMs)
    ? Math.floor(requestedTimeoutMs as number)
    : REMOTE_TOOL_DEFAULT_TIMEOUT_MS;
  const desired = Math.min(
    REMOTE_TOOL_MAX_TIMEOUT_MS,
    Math.max(REMOTE_TOOL_MIN_TIMEOUT_MS, requested),
  );
  return Math.max(0, Math.min(desired, Math.floor(grantRemaining)));
}

function requestedToolTimeoutMs(toolName: string, args: Record<string, unknown>): number | undefined {
  if (toolName === 'send_file') return REMOTE_TOOL_MAX_TIMEOUT_MS;
  if (toolName !== 'execute_shell') return undefined;
  const timeout = Number(args?.timeout);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
}

function normalizeUploadedFileResult(value: unknown): UploadedFileResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const url = String(record.url || '').trim();
  const name = String(record.name || '').trim();
  const size = Number(record.size);
  const type = record.type === 'image' ? 'image' : record.type === 'file' ? 'file' : undefined;
  if (!url || !name || !Number.isFinite(size) || size < 0 || !type) return undefined;
  return { url, name, size, type };
}

function normalizeDeviceRpcContent(content: unknown, options: DeviceRpcNormalizeOptions): string {
  if (typeof content === 'string') return truncateText(content, options);
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
    return truncateText(lines.join('\n'), options);
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (record._imageForNewMessage) {
      return '[远程设备读取到图片文件；当前 Device RPC 不转发图片二进制，请让用户以附件方式上传该图片。]';
    }
  }
  return truncateText(String(content ?? ''), options);
}

function truncateText(value: string, options: DeviceRpcNormalizeOptions = {}): string {
  const maxChars = MAX_DEVICE_RPC_TOOL_CONTENT_CHARS;
  if (value.length <= maxChars) return value;
  return [
    value.slice(0, maxChars),
    '',
    `[远程设备结果超过 ${maxChars} 字符，已截断。请用更精确的 path/pattern/limit/offset 继续读取。]`,
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

function formatRpcErrorMessage(error: any, toolName: string): string {
  const message = `远程设备工具执行失败: ${error?.message || error || 'unknown error'}`;
  if (toolName !== 'execute_shell' || mapRpcErrorCode(error) !== 'EXECUTION_TIMEOUT') return message;
  return `${message}\n请缩小命令范围，或改用 glob / grep / read_file 等专用工具继续；避免无变化地重复执行同一条长命令。`;
}
