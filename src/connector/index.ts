import { hostname, platform } from 'node:os';
import { Logger } from '../utils/logger';
import { PathResolver } from '../utils/path-resolver';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { resolveCatsCoRuntimeConfig } from '../catscompany/runtime-config';
import {
  acquireCatsCoConnectorLock,
  isProcessAlive,
  type CatsCoConnectorLock,
} from '../catscompany/connector-lock';
import {
  CatsClient,
  type CatsDeviceRegistration,
  type CatsDeviceRpcMessage,
  type CatsThinToolRpcMessage,
} from '../catscompany/client';
import type {
  DeviceGrantOperation,
  ExecutionScope,
  ScopedDeviceGrant,
  ScopedDeviceSelection,
  ScopedLocalDeviceGrant,
} from '../types/session-identity';
import type { ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { ConnectorReadTool } from '../tools/connector-read-tool';
import { GlobTool } from '../tools/glob-tool';
import { GrepTool } from '../tools/grep-tool';
import { WriteTool } from '../tools/write-tool';
import { EditTool } from '../tools/edit-tool';
import { ShellTool } from '../tools/bash-tool';
import { resolveCommonDirectoryToolArgs } from '../tools/common-directory-tool';
import { uploadImportFileSource } from '../tools/import-file-tool';
import { inferCatsUploadType } from '../catscompany/upload';
import {
  isRemoteDeviceRpcTool,
  normalizeDeviceRpcToolResultForTransport,
} from '../tools/device-rpc-tool';
import {
  annotateToolExecutionResultWithTargetContext,
} from '../tools/tool-target-context';

const DEFAULT_RPC_TTL_MS = 60_000;
const OWNER_POLL_MS = 2_000;

type ConnectorConfig = ReturnType<typeof resolveCatsCoRuntimeConfig>['connector'];

const CONNECTOR_RUNTIME_DEVICE_CAPABILITIES: DeviceGrantOperation[] = [
  'read_file',
  'resolve_common_directory',
  'glob',
  'grep',
  'write_file',
  'edit_file',
  'send_file',
  'execute_shell',
];

function currentOS(): CatsDeviceRegistration['os'] {
  switch (platform()) {
    case 'win32': return 'windows';
    case 'darwin': return 'macos';
    case 'linux': return 'linux';
    default: return 'unknown';
  }
}

function text(value: unknown): string {
  return String(value || '').trim();
}

function normalizeOperation(value: unknown): DeviceGrantOperation | undefined {
  const operation = text(value);
  if (operation === 'import_file') return 'send_file';
  if (
    operation === 'read_file'
    || operation === 'resolve_common_directory'
    || operation === 'glob'
    || operation === 'grep'
    || operation === 'write_file'
    || operation === 'edit_file'
    || operation === 'send_file'
    || operation === 'execute_shell'
  ) return operation;
  return undefined;
}

function extractArgs(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  const source = record.args && typeof record.args === 'object' && !Array.isArray(record.args)
    ? record.args as Record<string, unknown>
    : record;
  const { target: _target, ...args } = source;
  return args;
}

function localDeviceGrant(config: NonNullable<ConnectorConfig>): ScopedLocalDeviceGrant {
  return {
    kind: 'catscompany_body',
    source: 'catscompany',
    ownerUserId: text(config.ownerUserId) || undefined,
    bodyId: text(config.bodyId),
    installationId: text(config.installationId) || text(config.bodyId),
    deviceId: text(config.installationId) || text(config.bodyId),
    capabilities: [...CONNECTOR_RUNTIME_DEVICE_CAPABILITIES],
    createdAt: Date.now(),
  };
}

function toolContext(
  grant: ScopedLocalDeviceGrant,
  request: CatsDeviceRpcMessage | CatsThinToolRpcMessage,
  workingDirectory: string,
  operation?: DeviceGrantOperation,
): ToolExecutionContext {
  const isDeviceRpc = 'operation' in request;
  const topicType = 'topic_type' in request && (request.topic_type === 'group' || request.topic_type === 'p2p')
    ? request.topic_type
    : 'unknown';
  const sessionKey = text('session_key' in request ? request.session_key : undefined);
  const topicId = text('topic_id' in request ? request.topic_id : undefined);
  const actorUserId = text('actor_user_id' in request ? request.actor_user_id : undefined)
    || text('target_owner_user_id' in request ? request.target_owner_user_id : undefined)
    || 'remote_user';
  const deviceId = text(request.device_id) || grant.deviceId || grant.bodyId;
  const executionScope: ExecutionScope = {
    source: 'catscompany',
    sessionKey,
    topicId,
    topicType,
    actorUserId,
    ...(isDeviceRpc ? {
      agentId: text((request as CatsDeviceRpcMessage).agent_id) || undefined,
      agentBodyId: text((request as CatsDeviceRpcMessage).agent_body_id) || undefined,
    } : {}),
    permissionsSource: 'device_rpc_forward',
    identityTrust: 'server_canonical',
    isTrusted: true,
  };
  const effectiveOperation = operation || 'read_file';
  const scopedGrant: ScopedDeviceGrant = {
    kind: 'user_device_grant',
    source: 'catscompany',
    grantId: text((request as CatsDeviceRpcMessage).grant_id),
    status: 'active',
    identityTrust: 'server_canonical',
    identitySource: text((request as CatsDeviceRpcMessage).identity_source) || 'device_rpc_forward',
    deviceId,
    deviceBodyId: text((request as CatsDeviceRpcMessage).device_body_id) || grant.bodyId,
    deviceInstallationId: text((request as CatsDeviceRpcMessage).device_installation_id) || grant.installationId,
    ownerUserId: text('owner_user_id' in request ? request.owner_user_id : undefined) || actorUserId,
    sessionKey,
    topicId,
    topicType,
    actorUserId,
    agentId: executionScope.agentId,
    agentBodyId: executionScope.agentBodyId,
    operations: [effectiveOperation],
    createdAt: typeof ('created_at' in request ? request.created_at : undefined) === 'number'
      ? (request as CatsDeviceRpcMessage).created_at!
      : Date.now(),
    expiresAt: typeof request.expires_at === 'number' ? request.expires_at : Date.now() + DEFAULT_RPC_TTL_MS,
  };
  const selection: ScopedDeviceSelection = {
    kind: 'user_device_selection',
    source: 'catscompany',
    status: 'selected',
    selectionSource: 'device_rpc_forward',
    sessionKey,
    topicId,
    topicType,
    actorUserId,
    agentId: executionScope.agentId,
    identityTrust: 'server_canonical',
    identitySource: 'device_rpc_forward',
    selectedDeviceId: deviceId,
    selectedDeviceDisplayName: text((request as CatsDeviceRpcMessage).device_display_name) || undefined,
    selectedDeviceBodyId: scopedGrant.deviceBodyId,
    selectedDeviceInstallationId: scopedGrant.deviceInstallationId,
    selectedDeviceOperations: [effectiveOperation],
    createdAt: Date.now(),
  };
  return {
    workingDirectory,
    workspaceRoot: workingDirectory,
    conversationHistory: [],
    sessionId: sessionKey || undefined,
    surface: 'catscompany',
    permissionProfile: 'relaxed',
    executionScope,
    localDeviceGrant: grant,
    deviceGrants: [scopedGrant],
    deviceSelection: selection,
    deviceRpcReceiver: true,
    executionContext: {
      schema: 'xiaoba.execution_context.v1',
      conversation: {
        type: 'p2p',
        currentSpeaker: { id: actorUserId, role: 'user' },
        participants: [],
      },
      executionTargets: [{
        id: 'agent_self',
        label: deviceId,
        kind: 'agent_self',
        status: 'ready',
        cwd: workingDirectory,
      }],
      defaultTarget: 'agent_self',
    },
  };
}

export class ConnectorRuntime {
  private readonly client: CatsClient;
  private readonly localGrant: ScopedLocalDeviceGrant;
  private readonly workingDirectory: string;
  private readonly deviceRegistration: CatsDeviceRegistration;
  private shuttingDown = false;
  private lock?: CatsCoConnectorLock;
  private ownerTimer?: NodeJS.Timeout;

  constructor(private readonly config: NonNullable<ConnectorConfig>) {
    this.workingDirectory = process.cwd();
    this.localGrant = localDeviceGrant(config);
    this.deviceRegistration = {
      device_id: this.localGrant.deviceId || this.localGrant.bodyId,
      display_name: config.deviceName || process.env.COMPUTERNAME || process.env.HOSTNAME || hostname(),
      body_id: this.localGrant.bodyId,
      installation_id: this.localGrant.installationId,
      owner_user_id: config.ownerUserId,
      os: currentOS(),
      status: 'online',
      runtime_role: 'desktop',
      capabilities: [...CONNECTOR_RUNTIME_DEVICE_CAPABILITIES],
    };
    this.client = new CatsClient({
      serverUrl: config.serverUrl,
      apiKey: config.apiKey,
      botUid: config.botUid,
      bodyId: config.bodyId,
      installationId: config.installationId,
      runtimeCredential: config.runtimeCredential,
      runtimeCredentialExpiresAt: config.runtimeCredentialExpiresAt,
      deviceRegistration: this.deviceRegistration,
      httpBaseUrl: config.httpBaseUrl,
    });
  }

  async start(): Promise<void> {
    const lock = acquireCatsCoConnectorLock({
      runtimeRoot: PathResolver.getRuntimeDataRoot(),
      bodyId: this.config.bodyId || '',
      command: process.argv.join(' '),
      ownerPid: this.ownerPid(),
    });
    if (!lock.acquired) {
      throw new Error(`CatsCo connector already running (pid=${lock.existing.pid}).`);
    }
    this.lock = lock;

    Logger.openLogFile('catsco-connector');
    this.client.on('ready', () => {
      Logger.success(`CatsCo Connector Lite 已连接，device=${this.deviceRegistration.device_id}`);
      void this.registerDevice();
    });
    this.client.on('device_rpc_request', request => {
      void this.handleDeviceRpc(request).catch(error => {
        Logger.error(`CatsCo Connector Lite device_rpc failed: ${error?.message || error}`);
      });
    });
    this.client.on('thin_tool_rpc_request', request => {
      void this.handleThinToolRpc(request).catch(error => {
        Logger.error(`CatsCo Connector Lite thin_tool_rpc failed: ${error?.message || error}`);
      });
    });
    this.client.on('error', error => Logger.error(`CatsCo Connector Lite: ${error.message}`));
    this.client.connect();

    const ownerPid = this.ownerPid();
    if (ownerPid) {
      this.ownerTimer = setInterval(() => {
        if (isProcessAlive(ownerPid)) return;
        Logger.warning(`Dashboard owner process exited; stopping Connector Lite (pid=${ownerPid}).`);
        void this.stop();
      }, OWNER_POLL_MS);
      this.ownerTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.ownerTimer) clearInterval(this.ownerTimer);
    this.client.disconnect();
    this.lock?.release();
    this.lock = undefined;
    Logger.info('CatsCo Connector Lite 已停止');
  }

  private ownerPid(): number | undefined {
    const value = Number(process.env.CATSCO_CONNECTOR_OWNER_PID);
    return Number.isInteger(value) && value > 0 && value !== process.pid ? value : undefined;
  }

  private async registerDevice(): Promise<void> {
    try {
      await this.client.registerDevice(this.deviceRegistration);
    } catch (error: any) {
      Logger.warning(`CatsCo Connector Lite device registration failed: ${error?.message || error}`);
    }
  }

  private async handleDeviceRpc(request: CatsDeviceRpcMessage): Promise<void> {
    if (this.shuttingDown || request.type !== 'request') return;
    const validation = this.validateRequest(request, true);
    const operation = normalizeOperation(request.operation);
    let result: ToolExecutionResult | undefined;
    if (!validation && operation) {
      try {
        result = await this.execute(request, operation);
      } catch (error: any) {
        result = {
          ok: false,
          errorCode: 'TOOL_EXECUTION_ERROR',
          message: `Connector Lite device_rpc execution failed: ${error?.message || error}`,
        };
      }
    }
    await this.sendDeviceResult(request, validation, result);
  }

  private async handleThinToolRpc(request: CatsThinToolRpcMessage): Promise<void> {
    if (this.shuttingDown || request.type !== 'request') return;
    const validation = this.validateRequest(request, false);
    const operation = normalizeOperation(request.tool_name);
    let result: ToolExecutionResult | undefined;
    if (validation) {
      result = undefined;
    } else if (!operation) {
      result = { ok: false, errorCode: 'PERMISSION_DENIED', message: `Unsupported Connector Lite tool: ${text(request.tool_name)}` };
    } else {
      try {
        result = await this.execute(request, operation);
      } catch (error: any) {
        result = {
          ok: false,
          errorCode: 'TOOL_EXECUTION_ERROR',
          message: `Connector Lite thin_tool_rpc execution failed: ${error?.message || error}`,
        };
      }
    }
    const error = validation || (result && !result.ok ? { code: result.errorCode, message: result.message } : undefined);
    if (this.shuttingDown) return;
    await this.client.sendThinToolRpcResult({
      request_id: request.request_id,
      target_owner_user_id: request.target_owner_user_id,
      target_device_id: request.target_device_id,
      device_id: this.localGrant.deviceId,
      tool_name: request.tool_name,
      result: error || !result ? undefined : normalizeDeviceRpcToolResultForTransport(result),
      error,
    });
  }

  private async sendDeviceResult(
    request: CatsDeviceRpcMessage,
    validation: { code: string; message: string } | undefined,
    result: ToolExecutionResult | undefined,
  ): Promise<void> {
    const error = validation || (result && !result.ok ? { code: result.errorCode, message: result.message } : undefined);
    if (this.shuttingDown) return;
    await this.client.sendDeviceRpcResult({
      request_id: request.request_id,
      grant_id: request.grant_id,
      session_key: request.session_key,
      topic_id: request.topic_id,
      topic_type: request.topic_type,
      actor_user_id: request.actor_user_id,
      owner_user_id: request.owner_user_id,
      identity_source: request.identity_source,
      agent_id: request.agent_id,
      agent_body_id: request.agent_body_id,
      device_id: this.localGrant.deviceId,
      device_body_id: this.localGrant.bodyId,
      device_installation_id: this.localGrant.installationId,
      operation: request.operation,
      tool_name: request.tool_name,
      result: error || !result ? undefined : normalizeDeviceRpcToolResultForTransport(result),
      error,
    });
  }

  private validateRequest(
    request: CatsDeviceRpcMessage | CatsThinToolRpcMessage,
    deviceRpc: boolean,
  ): { code: string; message: string } | undefined {
    if (!text(request.request_id)) return { code: 'invalid_request', message: 'RPC request_id is required.' };
    if (typeof request.expires_at === 'number' && request.expires_at <= Date.now()) {
      return { code: 'request_expired', message: 'RPC request has expired.' };
    }
    const requestedDevice = text(request.device_id)
      || text('target_device_id' in request ? request.target_device_id : undefined)
      || text((request as CatsDeviceRpcMessage).device_body_id);
    const localDevice = this.localGrant.deviceId || this.localGrant.installationId || this.localGrant.bodyId;
    if (!requestedDevice || requestedDevice !== localDevice) {
      return { code: 'target_device_mismatch', message: 'RPC request does not target this local Connector device.' };
    }
    if (deviceRpc) {
      const operation = normalizeOperation((request as CatsDeviceRpcMessage).operation);
      const toolName = text(request.tool_name) || operation || '';
      if (!operation || !isRemoteDeviceRpcTool(toolName, operation)) {
        return { code: 'unsupported_operation', message: 'Connector Lite does not allow this device RPC operation.' };
      }
    } else if (!normalizeOperation(request.tool_name)) {
      return { code: 'unsupported_operation', message: 'Connector Lite does not allow this thin tool RPC operation.' };
    }
    return undefined;
  }

  private async execute(
    request: CatsDeviceRpcMessage | CatsThinToolRpcMessage,
    operation: DeviceGrantOperation,
  ): Promise<ToolExecutionResult> {
    const context = toolContext(this.localGrant, request, this.workingDirectory, operation);
    const args = extractArgs(request.payload);
    let result: ToolExecutionResult;
    switch (operation) {
      case 'read_file': result = await new ConnectorReadTool().execute(args, context); break;
      case 'resolve_common_directory': result = resolveCommonDirectoryToolArgs(args); break;
      case 'glob': result = await new GlobTool().execute(args, context); break;
      case 'grep': result = await new GrepTool().execute(args, context); break;
      case 'write_file': result = await new WriteTool().execute(args, context); break;
      case 'edit_file': result = await new EditTool().execute(args, context); break;
      case 'send_file':
        result = await uploadImportFileSource(args, context, async (filePath, fileName) => {
          const upload = await this.client.uploadFile(filePath, inferCatsUploadType(fileName));
          return { url: upload.url, name: fileName, size: upload.size, type: inferCatsUploadType(fileName) };
        });
        break;
      case 'execute_shell': result = await new ShellTool().execute(args, context); break;
      default: result = { ok: false, errorCode: 'PERMISSION_DENIED', message: 'Unsupported Connector Lite operation.' };
    }
    return annotateToolExecutionResultWithTargetContext(result, context, {
      toolName: text(request.tool_name) || operation,
      operation,
      cwd: operation === 'execute_shell' && typeof args.cwd === 'string' ? args.cwd : this.workingDirectory,
    });
  }
}

export async function startConnectorLite(): Promise<void> {
  const runtimeRoot = PathResolver.getRuntimeDataRoot();
  const resolution = resolveCatsCoRuntimeConfig({
    runtimeRoot,
    env: process.env,
    migrateLegacyEnvBinding: true,
  });
  const config = resolution.connector;
  if (!config) {
    throw new Error(`CatsCo Connector Lite 配置缺失：${resolution.missing.join(', ') || 'binding'}`);
  }
  const runtime = new ConnectorRuntime({
    ...config,
    runtimeRole: 'desktop',
  });
  const stop = () => { void runtime.stop(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await runtime.start();
}

if (require.main === module) {
  startConnectorLite().catch(error => {
    Logger.error(`CatsCo Connector Lite 启动失败: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
