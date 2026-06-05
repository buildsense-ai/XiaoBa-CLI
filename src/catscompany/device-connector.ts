import { hostname } from 'os';
import { CatsClient, type CatsDeviceRegistration, type CatsDeviceRpcMessage } from './client';
import { CatsCompanyConfig } from './types';
import { createCatsCoLocalDeviceGrant } from './local-file-grants';
import type { DeviceGrantOperation, ExecutionScope, ScopedDeviceGrant, ScopedDeviceSelection, ScopedLocalDeviceGrant } from '../types/session-identity';
import type { ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { Logger } from '../utils/logger';
import { ReadTool } from '../tools/read-tool';
import { GlobTool } from '../tools/glob-tool';
import { GrepTool } from '../tools/grep-tool';
import { WriteTool } from '../tools/write-tool';
import { ShellTool } from '../tools/bash-tool';
import {
  isRemoteDeviceTool,
  normalizeDeviceRpcToolResultForTransport,
} from '../tools/device-rpc-tool';

const DEVICE_REGISTRATION_REFRESH_MS = 120_000;
const DEVICE_RPC_DEFAULT_TTL_MS = 60_000;

export class CatsCoDeviceConnector {
  private readonly client: CatsClient;
  private readonly localDeviceGrant: ScopedLocalDeviceGrant;
  private readonly deviceRegistration: CatsDeviceRegistration;
  private deviceRegistrationTimer?: ReturnType<typeof setInterval>;
  private readonly allowWriteFile: boolean;
  private readonly allowShell: boolean;

  constructor(private readonly config: CatsCompanyConfig) {
    if (!config.connectorToken) {
      throw new Error('CatsCo device connector token is missing. Pair this device before starting connector-only mode.');
    }
    const deviceId = config.installationId || config.bodyId;
    if (!deviceId) {
      throw new Error('CatsCo device id is missing. Pair this device before starting connector-only mode.');
    }
    const capabilities = normalizeConnectorCapabilities(config);
    this.allowWriteFile = capabilities.includes('write_file') && Boolean(config.allowWriteFile);
    this.allowShell = capabilities.includes('execute_shell') && Boolean(config.allowShell);
    this.deviceRegistration = {
      device_id: deviceId,
      display_name: config.deviceName || process.env.COMPUTERNAME || process.env.HOSTNAME || hostname() || deviceId,
      body_id: config.bodyId || deviceId,
      installation_id: config.installationId || deviceId,
      status: 'online',
      capabilities,
    };
    const localDeviceGrant = createCatsCoLocalDeviceGrant({
      bodyId: this.deviceRegistration.body_id,
      installationId: this.deviceRegistration.installation_id,
      deviceId: this.deviceRegistration.device_id,
    });
    if (!localDeviceGrant) {
      throw new Error('CatsCo device connector could not create a local device grant.');
    }
    this.localDeviceGrant = localDeviceGrant;
    this.client = new CatsClient({
      serverUrl: config.serverUrl,
      connectorToken: config.connectorToken,
      authMode: 'device_connector',
      bodyId: this.deviceRegistration.body_id,
      installationId: this.deviceRegistration.installation_id,
      deviceRegistration: this.deviceRegistration,
      httpBaseUrl: config.httpBaseUrl,
    });
  }

  async start(): Promise<void> {
    Logger.openLogFile('catsco-device-connector');
    Logger.info('正在启动 CatsCo Device Connector...');

    this.client.on('ready', () => {
      Logger.success(`CatsCo Device Connector 已连接，device=${this.deviceRegistration.device_id}`);
      this.registerCurrentDevice().catch((err: any) => {
        Logger.warning(`CatsCo 设备注册失败，继续保持连接: ${err?.message || err}`);
      });
      this.startDeviceRegistrationRefresh();
    });

    this.client.on('device_rpc_request', async (request: CatsDeviceRpcMessage) => {
      await this.handleDeviceRpcRequest(request);
    });

    this.client.on('message', () => {
      Logger.warning('Device Connector 收到普通聊天消息，已忽略。');
    });

    this.client.on('error', (err: Error) => {
      Logger.error(`CatsCo Device Connector 连接错误: ${err.message}`);
    });

    this.client.connect();
    Logger.success('CatsCo Device Connector 已启动，只监听本机设备任务。');
  }

  async destroy(): Promise<void> {
    this.stopDeviceRegistrationRefresh();
    this.client.disconnect();
  }

  private async registerCurrentDevice(): Promise<void> {
    await this.client.registerDevice(this.deviceRegistration);
    Logger.info(`[CatsCo Device Connector] 已注册本机设备能力: device=${this.deviceRegistration.device_id}, capabilities=${(this.deviceRegistration.capabilities || []).join(',')}`);
  }

  private startDeviceRegistrationRefresh(): void {
    this.stopDeviceRegistrationRefresh();
    this.deviceRegistrationTimer = setInterval(() => {
      this.registerCurrentDevice().catch((err: any) => {
        Logger.warning(`CatsCo 设备状态刷新失败: ${err?.message || err}`);
      });
    }, DEVICE_REGISTRATION_REFRESH_MS);
    (this.deviceRegistrationTimer as any).unref?.();
  }

  private stopDeviceRegistrationRefresh(): void {
    if (!this.deviceRegistrationTimer) return;
    clearInterval(this.deviceRegistrationTimer);
    this.deviceRegistrationTimer = undefined;
  }

  private async handleDeviceRpcRequest(request: CatsDeviceRpcMessage): Promise<void> {
    const requestID = request.request_id;
    if (!requestID) return;

    const validationError = this.validateDeviceRpcToolRequest(request);
    const result = validationError ? undefined : await this.executeLocalDeviceRpcTool(request);
    const error = validationError || (!result || result.ok
      ? undefined
      : {
          code: result.errorCode || 'tool_execution_error',
          message: result.message,
        });

    try {
      await this.client.sendDeviceRpcResult({
        request_id: requestID,
        grant_id: request.grant_id,
        session_key: request.session_key,
        topic_id: request.topic_id,
        topic_type: request.topic_type,
        actor_user_id: request.actor_user_id,
        agent_id: request.agent_id,
        agent_body_id: request.agent_body_id,
        device_id: this.localDeviceGrant.deviceId || request.device_id,
        device_body_id: this.localDeviceGrant.bodyId || request.device_body_id,
        device_installation_id: this.localDeviceGrant.installationId || request.device_installation_id,
        operation: request.operation,
        tool_name: request.tool_name,
        result: error || !result ? undefined : normalizeDeviceRpcToolResultForTransport(result),
        error,
      });
    } catch (err: any) {
      Logger.warning(`[CatsCo Device Connector] Device RPC result 发送失败: request=${requestID}, error=${err?.message || err}`);
    }
  }

  private async executeLocalDeviceRpcTool(request: CatsDeviceRpcMessage): Promise<ToolExecutionResult> {
    const operation = this.normalizeDeviceRpcOperation(request.operation);
    const toolName = String(request.tool_name || operation || '').trim();
    if (!operation || !isRemoteDeviceTool(toolName, operation)) {
      return {
        ok: false,
        errorCode: 'PERMISSION_DENIED',
        message: `Device RPC 不允许执行 ${toolName || request.operation || 'unknown'}。`,
      };
    }
    if (operation === 'write_file' && !this.allowWriteFile) {
      return {
        ok: false,
        errorCode: 'PERMISSION_DENIED',
        message: '本机 Device Connector 未开启远程写文件能力。',
      };
    }
    if (operation === 'execute_shell' && !this.allowShell) {
      return {
        ok: false,
        errorCode: 'PERMISSION_DENIED',
        message: '本机 Device Connector 未开启远程 shell 能力。',
      };
    }

    const context = this.buildDeviceRpcToolContext(request, operation);
    const args = this.extractDeviceRpcToolArgs(request.payload);
    switch (operation) {
      case 'read_file':
        return new ReadTool().execute(args, context);
      case 'glob':
        return new GlobTool().execute(args, context);
      case 'grep':
        return new GrepTool().execute(args, context);
      case 'write_file':
        return new WriteTool().execute(args, context);
      case 'execute_shell':
        return new ShellTool().execute(args, context);
      default:
        return {
          ok: false,
          errorCode: 'PERMISSION_DENIED',
          message: `Device RPC 不允许执行 ${operation}。`,
        };
    }
  }

  private buildDeviceRpcToolContext(
    request: CatsDeviceRpcMessage,
    operation: DeviceGrantOperation,
  ): ToolExecutionContext {
    const topicType = request.topic_type === 'group' || request.topic_type === 'p2p'
      ? request.topic_type
      : 'unknown';
    const executionScope: ExecutionScope = {
      source: 'catscompany',
      sessionKey: String(request.session_key || ''),
      topicId: String(request.topic_id || ''),
      topicType,
      actorUserId: String(request.actor_user_id || ''),
      agentId: request.agent_id,
      agentBodyId: request.agent_body_id,
      permissionsSource: 'device_rpc_forward',
      identityTrust: 'server_canonical',
      isTrusted: true,
    };
    const now = Date.now();
    const grant: ScopedDeviceGrant = {
      kind: 'user_device_grant',
      source: 'catscompany',
      grantId: String(request.grant_id || ''),
      status: 'active',
      identityTrust: 'server_canonical',
      identitySource: 'device_rpc_forward',
      deviceId: String(request.device_id || this.localDeviceGrant.deviceId || ''),
      deviceBodyId: request.device_body_id || this.localDeviceGrant.bodyId,
      deviceInstallationId: request.device_installation_id || this.localDeviceGrant.installationId,
      ownerUserId: executionScope.actorUserId,
      sessionKey: executionScope.sessionKey,
      topicId: executionScope.topicId,
      topicType,
      actorUserId: executionScope.actorUserId,
      agentId: executionScope.agentId,
      agentBodyId: executionScope.agentBodyId,
      operations: [operation],
      createdAt: typeof request.created_at === 'number' ? request.created_at : now,
      expiresAt: typeof request.expires_at === 'number' ? request.expires_at : now + DEVICE_RPC_DEFAULT_TTL_MS,
    };
    const deviceSelection: ScopedDeviceSelection = {
      kind: 'user_device_selection',
      source: 'catscompany',
      status: 'selected',
      selectionSource: 'device_rpc_forward',
      sessionKey: executionScope.sessionKey,
      topicId: executionScope.topicId,
      topicType,
      actorUserId: executionScope.actorUserId,
      agentId: executionScope.agentId,
      identityTrust: 'server_canonical',
      identitySource: 'device_rpc_forward',
      selectedDeviceId: grant.deviceId,
      selectedDeviceBodyId: grant.deviceBodyId,
      selectedDeviceInstallationId: grant.deviceInstallationId,
      selectedDeviceOperations: [operation],
      createdAt: now,
    };
    const workingDirectory = process.cwd();
    return {
      workingDirectory,
      workspaceRoot: workingDirectory,
      conversationHistory: [],
      sessionId: executionScope.sessionKey,
      surface: 'catscompany',
      permissionProfile: 'strict',
      executionScope,
      localDeviceGrant: this.localDeviceGrant,
      deviceGrants: [grant],
      deviceSelection,
    };
  }

  private validateDeviceRpcToolRequest(request: CatsDeviceRpcMessage): { code: string; message: string } | undefined {
    const targetError = this.validateDeviceRpcTarget(request);
    if (targetError) return targetError;

    const operation = this.normalizeDeviceRpcOperation(request.operation);
    const toolName = String(request.tool_name || operation || '').trim();
    if (!operation || !isRemoteDeviceTool(toolName, operation)) {
      return { code: 'unsupported_operation', message: 'Device RPC only allows read_file, glob, grep, write_file, and execute_shell.' };
    }
    if (!(this.deviceRegistration.capabilities || []).includes(operation)) {
      return { code: 'capability_not_enabled', message: `This connector has not enabled ${operation}.` };
    }

    const requiredFields: Array<[keyof CatsDeviceRpcMessage, string]> = [
      ['grant_id', 'grant_id'],
      ['session_key', 'session_key'],
      ['topic_id', 'topic_id'],
      ['topic_type', 'topic_type'],
      ['actor_user_id', 'actor_user_id'],
      ['device_id', 'device_id'],
    ];
    for (const [field, label] of requiredFields) {
      if (!String(request[field] || '').trim()) {
        return { code: 'invalid_request', message: `Device RPC request missing ${label}.` };
      }
    }
    if (typeof request.expires_at === 'number' && Date.now() > request.expires_at) {
      return { code: 'request_expired', message: 'Device RPC request has expired.' };
    }
    return undefined;
  }

  private normalizeDeviceRpcOperation(value: unknown): DeviceGrantOperation | undefined {
    const operation = String(value || '').trim();
    if (operation === 'read_file'
      || operation === 'glob'
      || operation === 'grep'
      || operation === 'write_file'
      || operation === 'execute_shell') {
      return operation;
    }
    return undefined;
  }

  private extractDeviceRpcToolArgs(payload: unknown): Record<string, unknown> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
    const record = payload as Record<string, unknown>;
    if (record.args && typeof record.args === 'object' && !Array.isArray(record.args)) {
      return { ...(record.args as Record<string, unknown>) };
    }
    return { ...record };
  }

  private validateDeviceRpcTarget(request: CatsDeviceRpcMessage): { code: string; message: string } | undefined {
    const checks: Array<[unknown, unknown, string]> = [
      [request.device_id, this.localDeviceGrant.deviceId, 'device_id'],
      [request.device_installation_id, this.localDeviceGrant.installationId, 'installation_id'],
      [request.device_body_id, this.localDeviceGrant.bodyId, 'body_id'],
    ];
    let matchedAny = false;
    for (const [requested, local, label] of checks) {
      const requestedText = String(requested || '').trim();
      if (!requestedText) continue;
      const localText = String(local || '').trim();
      if (!localText || requestedText !== localText) {
        return { code: 'target_device_mismatch', message: `Device RPC target ${label} does not match this local connector.` };
      }
      matchedAny = true;
    }
    return matchedAny
      ? undefined
      : { code: 'target_device_mismatch', message: 'Device RPC target does not match this local connector.' };
  }
}

function normalizeConnectorCapabilities(config: CatsCompanyConfig): string[] {
  const values = new Set<string>();
  const configured = config.capabilities && config.capabilities.length > 0
    ? config.capabilities
    : ['read_file', 'glob', 'grep'];
  for (const item of configured) {
    const text = String(item || '').trim();
    if (text === 'read_file' || text === 'glob' || text === 'grep') values.add(text);
    if (text === 'write_file' && config.allowWriteFile) values.add(text);
    if (text === 'execute_shell' && config.allowShell) values.add(text);
  }
  if (config.allowWriteFile) values.add('write_file');
  if (config.allowShell) values.add('execute_shell');
  if (values.size === 0) values.add('read_file');
  return Array.from(values);
}
