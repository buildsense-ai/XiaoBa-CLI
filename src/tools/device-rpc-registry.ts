import type { DeviceGrantOperation } from '../types/session-identity';
import type { ToolRiskLevel } from '../types/tool';

export type DeviceRpcToolName =
  | 'read_file'
  | 'resolve_common_directory'
  | 'glob'
  | 'grep'
  | 'write_file'
  | 'edit_file'
  | 'send_file'
  | 'execute_shell';

export type DeviceRpcToolCategory =
  | 'readonly'
  | 'file_mutation'
  | 'outbound'
  | 'shell';

export interface DeviceRpcToolRegistration {
  toolName: DeviceRpcToolName;
  operation: DeviceGrantOperation;
  category: DeviceRpcToolCategory;
  skipLocalConfirmationWhenRemoteAuthorized: boolean;
  remoteConfirmationRisk: ToolRiskLevel;
  requiresChannel?: boolean;
}

export const DEVICE_RPC_TOOL_REGISTRY: readonly DeviceRpcToolRegistration[] = [
  {
    toolName: 'read_file',
    operation: 'read_file',
    category: 'readonly',
    skipLocalConfirmationWhenRemoteAuthorized: true,
    remoteConfirmationRisk: 'low',
  },
  {
    toolName: 'resolve_common_directory',
    operation: 'resolve_common_directory',
    category: 'readonly',
    skipLocalConfirmationWhenRemoteAuthorized: true,
    remoteConfirmationRisk: 'low',
  },
  {
    toolName: 'glob',
    operation: 'glob',
    category: 'readonly',
    skipLocalConfirmationWhenRemoteAuthorized: true,
    remoteConfirmationRisk: 'low',
  },
  {
    toolName: 'grep',
    operation: 'grep',
    category: 'readonly',
    skipLocalConfirmationWhenRemoteAuthorized: true,
    remoteConfirmationRisk: 'low',
  },
  {
    toolName: 'write_file',
    operation: 'write_file',
    category: 'file_mutation',
    skipLocalConfirmationWhenRemoteAuthorized: true,
    remoteConfirmationRisk: 'low',
  },
  {
    toolName: 'edit_file',
    operation: 'edit_file',
    category: 'file_mutation',
    skipLocalConfirmationWhenRemoteAuthorized: true,
    remoteConfirmationRisk: 'low',
  },
  {
    toolName: 'send_file',
    operation: 'send_file',
    category: 'outbound',
    skipLocalConfirmationWhenRemoteAuthorized: true,
    remoteConfirmationRisk: 'low',
    requiresChannel: true,
  },
  {
    toolName: 'execute_shell',
    operation: 'execute_shell',
    category: 'shell',
    skipLocalConfirmationWhenRemoteAuthorized: true,
    remoteConfirmationRisk: 'high',
  },
] as const;

const REGISTRY_BY_PAIR = new Map<string, DeviceRpcToolRegistration>(
  DEVICE_RPC_TOOL_REGISTRY.map(registration => [
    registryKey(registration.toolName, registration.operation),
    registration,
  ]),
);

const REGISTRY_BY_TOOL = new Map<string, DeviceRpcToolRegistration>(
  DEVICE_RPC_TOOL_REGISTRY.map(registration => [registration.toolName, registration]),
);

const OPERATIONS = new Set<DeviceGrantOperation>(
  DEVICE_RPC_TOOL_REGISTRY.map(registration => registration.operation),
);

export const CATSCOMPANY_FULL_RUNTIME_DEVICE_CAPABILITIES: readonly DeviceGrantOperation[] =
  DEVICE_RPC_TOOL_REGISTRY.map(registration => registration.operation);

export function getDeviceRpcToolRegistration(
  toolName: string,
  operation: DeviceGrantOperation,
): DeviceRpcToolRegistration | undefined {
  return REGISTRY_BY_PAIR.get(registryKey(toolName, operation));
}

export function getDeviceRpcToolRegistrationByToolName(
  toolName: string,
): DeviceRpcToolRegistration | undefined {
  return REGISTRY_BY_TOOL.get(toolName);
}

export function isDeviceRpcTool(toolName: string, operation: DeviceGrantOperation): boolean {
  return Boolean(getDeviceRpcToolRegistration(toolName, operation));
}

export function isDeviceRpcReadonlyTool(toolName: string, operation: DeviceGrantOperation): boolean {
  return getDeviceRpcToolRegistration(toolName, operation)?.category === 'readonly';
}

export function isDeviceRpcOperation(operation: DeviceGrantOperation): boolean {
  return OPERATIONS.has(operation);
}

export function normalizeDeviceRpcOperation(value: unknown): DeviceGrantOperation | undefined {
  const operation = String(value || '').trim() as DeviceGrantOperation;
  return OPERATIONS.has(operation) ? operation : undefined;
}

export function formatDeviceRpcAllowedToolList(): string {
  return DEVICE_RPC_TOOL_REGISTRY.map(registration => registration.toolName).join(' / ');
}

export function formatDeviceRpcAllowedOperationList(): string {
  return DEVICE_RPC_TOOL_REGISTRY.map(registration => registration.operation).join(' / ');
}

export function getDeviceRpcRemoteConfirmationReason(registration: DeviceRpcToolRegistration): string {
  if (registration.category === 'shell') {
    return '服务端已选定远程设备并下发 execute_shell device grant，命令由 Device RPC 直接转发。';
  }
  if (registration.category === 'outbound') {
    return '服务端已选定远程设备并下发短期 device grant，文件外发由 Device RPC 在目标设备上执行。';
  }
  return '服务端已选定远程设备并下发短期 device grant，普通文件工具不需要本机二次确认。';
}

function registryKey(toolName: string, operation: DeviceGrantOperation): string {
  return `${toolName}:${operation}`;
}
