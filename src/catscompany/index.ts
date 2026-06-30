import { CatsClient, MessageContext, type CatsDeviceRpcMessage, type CatsThinToolRpcMessage } from './client';
import { CatsCompanyConfig, ParsedCatsMessage, CatsFileInfo } from './types';
import { MessageSender } from './message-sender';
import { extractContentBlocks } from './content-blocks';
import { createCatsCoMessageEnvelope, createExecutionScope } from './message-envelope';
import { logCatsCoExecutionContextDiagnostics } from './execution-context-diagnostics';
import { createCatsCoAttachmentGrant, createCatsCoLocalDeviceGrant } from './local-file-grants';
import { extractCatsCoDeviceGrants } from './device-grants';
import { extractCatsCoDeviceSelection } from './device-selection';
import { extractCatsCoRuntimeContext } from './runtime-context';
import { MessageSessionManager } from '../core/message-session-manager';
import { AgentServices, BUSY_MESSAGE, RuntimeFeedbackInput, SessionCallbacks } from '../core/agent-session';
import { Logger } from '../utils/logger';
import { SubAgentManager } from '../core/sub-agent-manager';
import type { SubAgentInfo } from '../core/sub-agent-session';
import { ChannelCallbacks, DeviceRpcTransport, TargetRoutes, ThinToolRpcTransport, ToolErrorCode, ToolExecutionConfirmationRequest, ToolExecutionConfirmationResult, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { ContentBlock } from '../types';
import type { PendingUserInput } from '../core/conversation-runner';
import type { DeviceGrantOperation, ExecutionScope, ScopedDeviceGrant, ScopedDeviceSelection, ScopedLocalDeviceGrant, ScopedLocalFileGrant } from '../types/session-identity';
import { AdapterRuntimeBundle, createAdapterRuntime } from '../runtime/adapter-runtime';
import { randomUUID } from 'crypto';
import { hostname, platform } from 'os';
import { ConfigManager } from '../utils/config';
import { isPrimaryModelVisionCapable } from '../utils/model-capabilities';
import { createCatsCoSessionRoute } from '../core/session-router';
import { ReadTool } from '../tools/read-tool';
import { GlobTool } from '../tools/glob-tool';
import { GrepTool } from '../tools/grep-tool';
import { WriteTool } from '../tools/write-tool';
import { EditTool } from '../tools/edit-tool';
import { ShellTool } from '../tools/bash-tool';
import { resolveCommonDirectoryToolArgs } from '../tools/common-directory-tool';
import {
  isRemoteDeviceRpcTool,
  normalizeDeviceRpcToolResultForTransport,
  normalizeDeviceRpcToolResultPayload,
} from '../tools/device-rpc-tool';
import {
  annotateToolExecutionResultWithTargetContext,
  stripToolTargetContextForDisplay,
} from '../tools/tool-target-context';
import { formatPathForLog } from '../utils/log-redaction';
import { resolveCatsDeviceModelStatus } from './model-status';

interface PendingAttachment {
  fileName: string;
  localPath: string;
  type: 'file' | 'image';
  receivedAt: number;
  localFileGrant?: ScopedLocalFileGrant;
}

interface QueuedMessage {
  userMessage: string | ContentBlock[];
  topic: string;
  senderId: string;
  seq: number;
  executionScope: ParsedCatsMessage['executionScope'];
  deviceGrants?: ScopedDeviceGrant[];
  deviceSelection?: ScopedDeviceSelection;
  targetRoutes?: TargetRoutes;
  localFileGrants?: ScopedLocalFileGrant[];
  receivedAt: number;
  source?: 'user' | 'subagent_feedback';
  runtimeFeedback?: RuntimeFeedbackInput[];
}

interface SubAgentEventRoute {
  topic: string;
  channelSource?: string;
}

const TYPING_HEARTBEAT_INTERVAL_MS = 5_000;
const DEVICE_REGISTRATION_REFRESH_MS = 120_000;
const DEVICE_RPC_DEFAULT_TTL_MS = 60_000;
const HIDDEN_CATS_TOOL_PROGRESS = new Set([
  'send_text',
  'send_file',
  'spawn_subagent',
]);
const STRUCTURED_TOOL_PROGRESS_UNSUPPORTED_CHANNELS = new Set([
  'clawbot',
  'mobile',
  'wechat_clawbot',
  'wechat',
  'weixin_clawbot',
  'weixin',
  'wx',
]);
const SUBAGENT_TERMINAL_EVENTS = new Set(['agent_completed', 'agent_failed', 'agent_stopped']);
export const CATSCOMPANY_FULL_RUNTIME_DEVICE_CAPABILITIES: DeviceGrantOperation[] = [
  'read_file',
  'resolve_common_directory',
  'glob',
  'grep',
  'write_file',
  'edit_file',
  'send_file',
  'execute_shell',
];

function currentRuntimeOS(): 'windows' | 'macos' | 'linux' | 'unknown' {
  switch (platform()) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return 'unknown';
  }
}

function summarizeThinToolRpcArgs(args: any): string {
  const input = args && typeof args === 'object' ? args : {};
  const summary: Record<string, unknown> = {};
  for (const key of ['target', 'directory', 'path', 'file_path', 'cwd', 'command', 'pattern', 'limit']) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      const value = input[key];
      summary[key] = typeof value === 'string' && value.length > 180
        ? `${value.slice(0, 177)}...`
        : value;
    }
  }
  try {
    return JSON.stringify(summary);
  } catch {
    return String(summary);
  }
}

function speakerNameFromMetadata(msg: Pick<ParsedCatsMessage, 'metadata' | 'senderId'>): string {
  const metadata = asRecord(msg.metadata);
  const identity = asRecord(metadata?.catsco_identity);
  const actor = asRecord(identity?.actor);
  return stringField(actor, 'display_name')
    || stringField(actor, 'username')
    || stringField(actor, 'user_id')
    || msg.senderId
    || 'User';
}

function prefixCatsUserMessage(name: string, content: string | ContentBlock[]): string | ContentBlock[] {
  const prefix = `${name}：\n`;
  if (typeof content === 'string') return `${prefix}${content}`;
  const blocks = [...content];
  const firstTextIndex = blocks.findIndex(block => block.type === 'text');
  if (firstTextIndex >= 0) {
    const textBlock = blocks[firstTextIndex];
    if (textBlock.type !== 'text') return blocks;
    blocks[firstTextIndex] = {
      ...textBlock,
      text: `${prefix}${textBlock.text}`,
    };
    return blocks;
  }
  return [{ type: 'text', text: prefix.trimEnd() }, ...blocks];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

function shouldHideCatsToolProgress(toolName: string): boolean {
  return HIDDEN_CATS_TOOL_PROGRESS.has(toolName);
}

function shouldSuppressStructuredToolProgress(channelSource?: string): boolean {
  const normalized = String(channelSource || '').trim().toLowerCase();
  if (!normalized) return false;
  return STRUCTURED_TOOL_PROGRESS_UNSUPPORTED_CHANNELS.has(normalized);
}

export function isCatsCompanyPassiveAcknowledgement(text: string): boolean {
  const compact = String(text || '')
    .toLowerCase()
    .replace(/[\s。.!！,，、~～]+/g, '');
  if (!compact || compact.length > 18) return false;
  if (/[?？]/.test(text)) return false;

  const ack = '(?:嗯|嗯嗯|收到|明白|懂了)';
  const thanks = '(?:谢谢|谢了|谢谢啦|辛苦了|感谢|thx|thanks)';
  return new RegExp(`^(?:${ack}|${thanks}|${ack}${thanks}|${thanks}${ack})$`, 'i').test(compact);
}

function compactCatsSubAgentSummary(text: string, maxLength = 4000): string {
  const normalized = text.replace(/\s+\n/g, '\n').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}\n\n[内容较长，已截断；完整内容请查看本地日志]`;
}

export function createCatsCompanyRuntime(sessionTTL?: number): AdapterRuntimeBundle {
  return createAdapterRuntime({
    surface: 'catscompany',
    sessionTTL,
    promptSnapshotMode: 'mutable-identity',
  });
}

/**
 * CatsCompanyBot 主类
 * 初始化官方 SDK，注册事件，编排消息处理流程
 * 连接、握手、重连与连接层错误处理都归 SDK 负责，runtime 不在这里兜底。
 * 结构与 FeishuBot 对齐
 */
export class CatsCompanyBot {
  private bot: CatsClient;
  private sender: MessageSender;
  private sessionManager: MessageSessionManager;
  private agentServices: AgentServices;
  /** 等待用户后续指令的附件队列，key 为 sessionKey */
  private pendingAttachments = new Map<string, PendingAttachment[]>();
  /** 主会话忙时的消息队列，key = sessionKey */
  private messageQueue = new Map<string, QueuedMessage[]>();
  /** 子 Agent 事件应沿用 spawn 时的通道能力，不能被同 session 后续消息覆盖 */
  private subAgentEventRoutes = new Map<string, SubAgentEventRoute>();
  /** Bot 自身的 uid，用于过滤自己发出的消息 */
  private botUid: string | null = null;
  private runtime: AdapterRuntimeBundle;
  private runtimeProfile: AdapterRuntimeBundle['profile'];
  private localDeviceGrant?: ScopedLocalDeviceGrant;
  private deviceRegistrationTimer?: ReturnType<typeof setInterval>;
  private readonly deviceRegistration?: {
    device_id: string;
    display_name?: string;
    body_id?: string;
    installation_id?: string;
    os?: 'windows' | 'macos' | 'linux' | 'unknown';
    status: 'online';
    capabilities: string[];
    model_status?: ReturnType<typeof resolveCatsDeviceModelStatus>;
  };

  constructor(config: CatsCompanyConfig) {
    this.botUid = String(config.botUid || '').trim() || null;
    const localDeviceId = config.installationId || config.bodyId;
    const deviceRegistration = localDeviceId
      ? {
          device_id: localDeviceId,
          display_name: config.deviceName || process.env.COMPUTERNAME || process.env.HOSTNAME || hostname() || localDeviceId,
          body_id: config.bodyId,
          installation_id: config.installationId || config.bodyId,
          owner_user_id: config.ownerUserId,
          os: currentRuntimeOS(),
          status: 'online' as const,
          capabilities: [...CATSCOMPANY_FULL_RUNTIME_DEVICE_CAPABILITIES],
        }
      : undefined;

    this.bot = new CatsClient({
      serverUrl: config.serverUrl,
      apiKey: config.apiKey,
      bodyId: config.bodyId,
      installationId: config.installationId,
      deviceRegistration,
      httpBaseUrl: config.httpBaseUrl,
    });

    this.sender = new MessageSender(this.bot, config.httpBaseUrl, config.apiKey);
    this.localDeviceGrant = createCatsCoLocalDeviceGrant({
      bodyId: config.bodyId,
      installationId: config.installationId,
      deviceId: config.installationId || config.bodyId,
      ownerUserId: config.ownerUserId,
      capabilities: [...CATSCOMPANY_FULL_RUNTIME_DEVICE_CAPABILITIES],
    });
    this.deviceRegistration = deviceRegistration;

    const runtime = createCatsCompanyRuntime(config.sessionTTL);
    this.runtime = runtime;
    this.runtimeProfile = runtime.profile;
    this.agentServices = runtime.services;
    const { toolManager } = this.agentServices;

    Logger.info(`已注册 ${toolManager.getToolCount()} 个基础工具 (message mode)`);
    Logger.info(`运行时可用工具数量将根据 skill toolPolicy 动态过滤`);

    this.sessionManager = new MessageSessionManager(
      this.agentServices,
      'catscompany',
      runtime.sessionManagerOptions,
    );
  }

  /**
   * 启动 WebSocket 连接，开始监听消息
   */
  async start(): Promise<void> {
    Logger.openLogFile('catscompany');
    Logger.info('正在启动 CatsCompany connector...');

    // 加载 skills
    await this.runtime.loadSkills();

    // 注册事件
    this.bot.on('ready', (info: { uid: string; name: string }) => {
      this.botUid = String(info.uid || '').trim() || this.botUid;
      const botName = info.name.trim() || '(未设置)';
      this.runtimeProfile.displayName = botName;
      this.runtimeProfile.prompt.displayName = botName;
      process.env.CURRENT_AGENT_DISPLAY_NAME = botName;
      Logger.success(`CatsCo agent 已连接，uid=${info.uid}, name=${botName}`);
      this.registerCurrentDevice().catch((err: any) => {
        Logger.warning(`CatsCo 设备注册失败，继续保持聊天连接: ${err?.message || err}`);
      });
      this.startDeviceRegistrationRefresh();
    });

    this.bot.on('message', async (ctx: MessageContext) => {
      await this.onMessage(ctx);
    });

    this.bot.on('device_rpc_request', async (request: CatsDeviceRpcMessage) => {
      await this.handleDeviceRpcRequest(request);
    });

    this.bot.on('thin_tool_rpc_request', async (request: CatsThinToolRpcMessage) => {
      await this.handleThinToolRpcRequest(request);
    });

    this.bot.on('error', (err: Error) => {
      Logger.error(`CatsCo 连接错误: ${err.message}`);
    });

    this.bot.connect();
    Logger.success('CatsCo agent 已启动，等待消息...');
  }

  private async registerCurrentDevice(): Promise<void> {
    if (!this.deviceRegistration?.device_id) return;
    const registration = {
      ...this.deviceRegistration,
      model_status: this.resolveCurrentDeviceModelStatus(),
    };
    await this.bot.registerDevice(registration);
    const modelStatus = registration.model_status
      ? `, model=${registration.model_status.source}/${registration.model_status.model}`
      : '';
    Logger.info(`[CatsCompany] 已注册本机设备能力: device=${registration.device_id}, capabilities=${registration.capabilities.join(',')}${modelStatus}`);
  }

  private resolveCurrentDeviceModelStatus(): ReturnType<typeof resolveCatsDeviceModelStatus> {
    const getConfig = (this.agentServices.aiService as any).getConfig;
    const config = typeof getConfig === 'function'
      ? getConfig.call(this.agentServices.aiService)
      : undefined;
    return resolveCatsDeviceModelStatus({ config });
  }

  private startDeviceRegistrationRefresh(): void {
    if (!this.deviceRegistration?.device_id) return;
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

  private buildDeviceRpcTransport(): DeviceRpcTransport {
    return {
      executeTool: async ({
        toolName,
        operation,
        args,
        grant,
        targetDeviceId,
        targetDeviceDisplayName: _targetDeviceDisplayName,
        targetDeviceBodyId,
        targetDeviceInstallationId,
        timeoutMs,
      }) => {
        const deviceId = grant?.deviceId || targetDeviceId;
        if (!deviceId) {
          return {
            ok: false,
            errorCode: 'PERMISSION_DENIED',
            message: 'Device RPC target is missing.',
          };
        }
        const sessionKey = grant?.sessionKey || '';
        const topicId = grant?.topicId || '';
        const topicType = grant?.topicType || 'unknown';
        const actorUserId = grant?.actorUserId || '';
        const ownerUserId = grant?.ownerUserId || actorUserId;
        const response = await this.bot.sendDeviceRpcRequest({
          request_id: `device_rpc_${randomUUID()}`,
          grant_id: grant?.grantId || `lightweight_${randomUUID()}`,
          session_key: sessionKey,
          topic_id: topicId,
          topic_type: topicType,
          actor_user_id: actorUserId,
          owner_user_id: ownerUserId,
          identity_source: grant?.identitySource || 'lightweight_execution_router',
          agent_id: grant?.agentId,
          agent_body_id: grant?.agentBodyId,
          device_id: deviceId,
          device_display_name: grant?.deviceDisplayName || _targetDeviceDisplayName,
          device_body_id: grant?.deviceBodyId || targetDeviceBodyId,
          device_installation_id: grant?.deviceInstallationId || targetDeviceInstallationId || deviceId,
          operation,
          tool_name: toolName,
          payload: { args },
          expires_at: grant?.expiresAt || Date.now() + DEVICE_RPC_DEFAULT_TTL_MS,
        }, timeoutMs);

        if (response.error) {
          return {
            ok: false,
            errorCode: this.mapDeviceRpcToolErrorCode(response.error.code),
            message: response.error.message || response.error.code || '远程设备工具执行失败。',
            retryable: this.isRetryableDeviceRpcError(response.error.code),
          };
        }
        return normalizeDeviceRpcToolResultPayload(response.result);
      },
    };
  }

  private buildThinToolRpcTransport(): ThinToolRpcTransport {
    return {
      executeTool: async ({
        targetOwnerUserId,
        targetDeviceId,
        toolName,
        args,
        timeoutMs = DEVICE_RPC_DEFAULT_TTL_MS,
      }) => {
        if (!targetOwnerUserId || !targetDeviceId || !toolName) {
          return {
            ok: false,
            errorCode: 'TOOL_EXECUTION_ERROR',
            message: 'Thin tool RPC target is missing targetOwnerUserId, targetDeviceId, or toolName.',
            retryable: false,
          };
        }
        const requestID = `thin_tool_rpc_${randomUUID()}`;
        Logger.info(`[CatsCompany][thin_tool_rpc] executeTool request: request=${requestID}, tool=${toolName}, targetOwner=${targetOwnerUserId}, targetDevice=${targetDeviceId}, args=${summarizeThinToolRpcArgs(args)}`);
        const response = await this.bot.sendThinToolRpcRequest({
          request_id: requestID,
          target_owner_user_id: targetOwnerUserId,
          target_device_id: targetDeviceId,
          tool_name: toolName,
          payload: { args },
          expires_at: Date.now() + timeoutMs,
        }, timeoutMs);
        Logger.info(`[CatsCompany][thin_tool_rpc] executeTool response: request=${requestID}, tool=${toolName}, hasError=${Boolean(response.error)}, hasResult=${Boolean(response.result)}`);

        if (response.error) {
          return {
            ok: false,
            errorCode: this.mapDeviceRpcToolErrorCode(response.error.code),
            message: response.error.message || response.error.code || 'Thin tool RPC failed.',
            retryable: this.isRetryableDeviceRpcError(response.error.code),
          };
        }
        return normalizeDeviceRpcToolResultPayload(response.result);
      },
    };
  }

  private maybeBuildThinToolRpcTransport(): ThinToolRpcTransport | undefined {
    return this.bot?.supportsThinToolRpc ? this.buildThinToolRpcTransport() : undefined;
  }

  private async handleThinToolRpcRequest(request: CatsThinToolRpcMessage): Promise<void> {
    const requestID = request.request_id;
    if (!requestID) return;
    Logger.info(`[CatsCompany][thin_tool_rpc] target received request: request=${requestID}, tool=${request.tool_name || ''}, targetOwner=${request.target_owner_user_id || ''}, targetDevice=${request.target_device_id || ''}, device=${request.device_id || ''}`);

    let result: ToolExecutionResult;
    try {
      result = await this.executeLocalThinToolRpcTool(request);
      Logger.info(`[CatsCompany][thin_tool_rpc] target executed request: request=${requestID}, tool=${request.tool_name || ''}, ok=${result.ok}, errorCode=${result.ok ? '' : (result.errorCode || '')}`);
    } catch (error: any) {
      result = {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `Thin tool RPC execution error: ${error?.message || error || 'unknown error'}`,
        retryable: false,
      };
      Logger.warning(`[CatsCompany][thin_tool_rpc] target execution threw: request=${requestID}, tool=${request.tool_name || ''}, error=${error?.message || error}`);
    }

    const error = result.ok
      ? undefined
      : {
          code: result.errorCode || 'TOOL_EXECUTION_ERROR',
          message: result.message,
        };

    try {
      await this.bot.sendThinToolRpcResult({
        request_id: requestID,
        target_owner_user_id: request.target_owner_user_id,
        target_device_id: request.target_device_id,
        device_id: this.localDeviceGrant?.deviceId || request.device_id || request.target_device_id,
        tool_name: request.tool_name,
        result: error ? undefined : normalizeDeviceRpcToolResultForTransport(result),
        error,
      });
      Logger.info(`[CatsCompany][thin_tool_rpc] target sent result: request=${requestID}, tool=${request.tool_name || ''}, ok=${result.ok}`);
    } catch (err: any) {
      Logger.warning(`[CatsCompany] Thin Tool RPC result send failed: request=${requestID}, error=${err?.message || err}`);
    }
  }

  private async executeLocalThinToolRpcTool(request: CatsThinToolRpcMessage): Promise<ToolExecutionResult> {
    const toolName = String(request.tool_name || '').trim();
    if (!toolName) {
      return { ok: false, errorCode: 'TOOL_NOT_FOUND', message: 'Thin tool RPC request missing tool_name.' };
    }
    const context = this.buildThinToolRpcToolContext(request);
    const args = this.extractDeviceRpcToolArgs(request.payload);
    let result: ToolExecutionResult;
    switch (toolName) {
      case 'read_file':
        result = await new ReadTool().execute(args, context);
        break;
      case 'resolve_common_directory':
        result = resolveCommonDirectoryToolArgs(args);
        break;
      case 'glob':
        result = await new GlobTool().execute(args, context);
        break;
      case 'grep':
        result = await new GrepTool().execute(args, context);
        break;
      case 'write_file':
        result = await new WriteTool().execute(args, context);
        break;
      case 'edit_file':
        result = await new EditTool().execute(args, context);
        break;
      case 'execute_shell':
        result = await new ShellTool().execute(args, context);
        break;
      default:
        result = {
          ok: false,
          errorCode: 'TOOL_NOT_FOUND',
          message: `Thin tool RPC target runtime does not have tool: ${toolName}`,
        };
    }
    return annotateToolExecutionResultWithTargetContext(result, context, {
      toolName,
      operation: this.normalizeDeviceRpcOperation(toolName) || 'read_file',
      cwd: this.resolveDeviceRpcTargetContextCwd(this.normalizeDeviceRpcOperation(toolName) || 'read_file', args, context.workingDirectory),
    });
  }

  private buildThinToolRpcToolContext(request: CatsThinToolRpcMessage): ToolExecutionContext {
    const workingDirectory = this.runtimeProfile?.workingDirectory || this.runtime?.profile?.workingDirectory || process.cwd();
    return {
      workingDirectory,
      workspaceRoot: workingDirectory,
      conversationHistory: [],
      surface: 'catscompany',
      permissionProfile: 'relaxed',
      localDeviceGrant: this.localDeviceGrant,
      deviceRpcReceiver: true,
      executionContext: {
        schema: 'xiaoba.execution_context.v1',
        conversation: {
          type: 'p2p',
          currentSpeaker: { id: String(request.target_owner_user_id || 'remote_user'), role: 'user' },
          participants: [],
        },
        executionTargets: [{
          id: 'agent_self',
          label: this.localDeviceGrant?.deviceId || this.localDeviceGrant?.bodyId || 'current thin tool RPC receiver',
          kind: 'agent_self',
          status: 'ready',
          cwd: workingDirectory,
        }],
        defaultTarget: 'agent_self',
      },
    };
  }

  private async handleDeviceRpcRequest(request: CatsDeviceRpcMessage): Promise<void> {
    const requestID = request.request_id;
    if (!requestID) return;

    const validationError = this.validateDeviceRpcToolRequest(request);
    let result: ToolExecutionResult | undefined;
    if (!validationError) {
      try {
        result = await this.executeLocalDeviceRpcTool(request);
      } catch (error: any) {
        result = {
          ok: false,
          errorCode: 'TOOL_EXECUTION_ERROR',
          message: `Device RPC tool execution error: ${error?.message || error || 'unknown error'}`,
          retryable: false,
        };
      }
    }
    const error = validationError || (!result || result.ok
      ? undefined
      : {
          code: result.errorCode || 'tool_execution_error',
          message: result.message,
        });

    try {
      await this.bot.sendDeviceRpcResult({
        request_id: requestID,
        grant_id: request.grant_id,
        session_key: request.session_key,
        topic_id: request.topic_id,
        topic_type: request.topic_type,
        actor_user_id: request.actor_user_id,
        owner_user_id: request.owner_user_id,
        identity_source: request.identity_source,
        agent_id: request.agent_id,
        agent_body_id: request.agent_body_id,
        device_id: this.localDeviceGrant?.deviceId || request.device_id,
        device_body_id: this.localDeviceGrant?.bodyId || request.device_body_id,
        device_installation_id: this.localDeviceGrant?.installationId || request.device_installation_id,
        operation: request.operation,
        tool_name: request.tool_name,
        result: error || !result ? undefined : normalizeDeviceRpcToolResultForTransport(result),
        error,
      });
    } catch (err: any) {
      Logger.warning(`[CatsCompany] Device RPC result 发送失败: request=${requestID}, error=${err?.message || err}`);
    }
  }

  private async executeLocalDeviceRpcTool(request: CatsDeviceRpcMessage): Promise<ToolExecutionResult> {
    const operation = this.normalizeDeviceRpcOperation(request.operation);
    const toolName = String(request.tool_name || operation || '').trim();
    if (!operation || !isRemoteDeviceRpcTool(toolName, operation)) {
      return {
        ok: false,
        errorCode: 'PERMISSION_DENIED',
        message: `Device RPC 不允许执行 ${toolName || request.operation || 'unknown'}。`,
      };
    }

    const context = this.buildDeviceRpcToolContext(request, operation);
    const args = this.extractDeviceRpcToolArgs(request.payload);
    let result: ToolExecutionResult;
    switch (operation) {
      case 'read_file':
        result = await new ReadTool().execute(args, context);
        break;
      case 'resolve_common_directory':
        result = resolveCommonDirectoryToolArgs(args);
        break;
      case 'glob':
        result = await new GlobTool().execute(args, context);
        break;
      case 'grep':
        result = await new GrepTool().execute(args, context);
        break;
      case 'write_file':
        result = await new WriteTool().execute(args, context);
        break;
      case 'edit_file':
        result = await new EditTool().execute(args, context);
        break;
      case 'execute_shell':
        result = await new ShellTool().execute(args, context);
        break;
      default:
        result = {
          ok: false,
          errorCode: 'PERMISSION_DENIED',
          message: `Device RPC 不允许执行 ${operation}。`,
        };
    }

    return annotateToolExecutionResultWithTargetContext(result, context, {
      toolName,
      operation,
      cwd: this.resolveDeviceRpcTargetContextCwd(operation, args, context.workingDirectory),
    });
  }

  private resolveDeviceRpcTargetContextCwd(
    operation: DeviceGrantOperation,
    args: Record<string, unknown>,
    fallback: string,
  ): string {
    if (operation !== 'execute_shell') return fallback;
    const cwd = args.cwd;
    return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : fallback;
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
      identitySource: String(request.identity_source || 'device_rpc_forward'),
      deviceId: String(request.device_id || this.localDeviceGrant?.deviceId || ''),
      deviceBodyId: request.device_body_id || this.localDeviceGrant?.bodyId,
      deviceInstallationId: request.device_installation_id || this.localDeviceGrant?.installationId,
      ownerUserId: String(request.owner_user_id || executionScope.actorUserId || ''),
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
      selectedDeviceDisplayName: request.device_display_name,
      selectedDeviceBodyId: grant.deviceBodyId,
      selectedDeviceInstallationId: grant.deviceInstallationId,
      selectedDeviceOperations: [operation],
      createdAt: now,
    };
    const workingDirectory = this.runtimeProfile?.workingDirectory || this.runtime?.profile?.workingDirectory || process.cwd();
    return {
      workingDirectory,
      workspaceRoot: workingDirectory,
      conversationHistory: [],
      sessionId: executionScope.sessionKey,
      surface: 'catscompany',
      permissionProfile: 'relaxed',
      executionScope,
      localDeviceGrant: this.localDeviceGrant,
      deviceGrants: [grant],
      deviceSelection,
      deviceRpcReceiver: true,
    };
  }

  private validateDeviceRpcToolRequest(request: CatsDeviceRpcMessage): { code: string; message: string } | undefined {
    const targetError = this.validateDeviceRpcTarget(request);
    if (targetError) return targetError;

    const operation = this.normalizeDeviceRpcOperation(request.operation);
    const toolName = String(request.tool_name || operation || '').trim();
    if (!operation || !isRemoteDeviceRpcTool(toolName, operation)) {
      return { code: 'unsupported_operation', message: 'Device RPC only allows read_file, resolve_common_directory, glob, grep, write_file, edit_file, and execute_shell.' };
    }

    const requiredFields: Array<[keyof CatsDeviceRpcMessage, string]> = [
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
    if (
      operation === 'read_file'
      || operation === 'resolve_common_directory'
      || operation === 'glob'
      || operation === 'grep'
      || operation === 'write_file'
      || operation === 'edit_file'
      || operation === 'execute_shell'
    ) {
      return operation;
    }
    return undefined;
  }

  private extractDeviceRpcToolArgs(payload: unknown): Record<string, unknown> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
    const record = payload as Record<string, unknown>;
    if (record.args && typeof record.args === 'object' && !Array.isArray(record.args)) {
      const { target: _target, ...args } = record.args as Record<string, unknown>;
      return args;
    }
    const { target: _target, ...args } = record;
    return args;
  }

  private mapDeviceRpcToolErrorCode(code: unknown): ToolErrorCode {
    const text = String(code || '').toLowerCase();
    if (text.includes('permission') || text.includes('forbidden') || text.includes('mismatch') || text.includes('unsupported')) {
      return 'PERMISSION_DENIED';
    }
    if (text.includes('timeout') || text.includes('expired')) {
      return 'EXECUTION_TIMEOUT';
    }
    if (text.includes('not_found') || text.includes('offline') || text.includes('unavailable')) {
      return 'TOOL_EXECUTION_ERROR';
    }
    return 'TOOL_EXECUTION_ERROR';
  }

  private isRetryableDeviceRpcError(code: unknown): boolean {
    const text = String(code || '').toLowerCase();
    return text.includes('timeout') || text.includes('offline') || text.includes('unavailable');
  }

  private validateDeviceRpcTarget(request: CatsDeviceRpcMessage): { code: string; message: string } | undefined {
    if (!this.localDeviceGrant) {
      return { code: 'device_not_bound', message: 'Current runtime is not bound to a CatsCo local device.' };
    }
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
        return { code: 'target_device_mismatch', message: `Device RPC target ${label} does not match this local runtime.` };
      }
      matchedAny = true;
    }
    return matchedAny
      ? undefined
      : { code: 'target_device_mismatch', message: 'Device RPC target does not match this local runtime.' };
  }

  // ─── 构建 ChannelCallbacks ──────────────────────

  /**
   * 为指定 topic 构建通道回调对象。
   * CatsCo webapp 复用 ChannelCallbacks 接口，chatId 对应 topic。
   */
  private buildChannel(
    topic: string,
    opts?: {
      sessionKey?: string;
      senderId?: string;
      channelSource?: string;
    },
  ): ChannelCallbacks & { hasOutbound: boolean } {
    let _hasOutbound = false;
    const suppressStructuredProgress = shouldSuppressStructuredToolProgress(opts?.channelSource);
    const channel: ChannelCallbacks & { hasOutbound: boolean } = {
      chatId: topic,
      get hasOutbound() { return _hasOutbound; },
      reply: async (_targetTopic: string, text: string) => {
        _hasOutbound = true;
        try {
          await this.sender.reply(topic, text);
        } catch (err: any) {
          Logger.warning(`消息发送失败 (reply): ${err.message}`);
          throw err;
        }
      },
      sendFile: async (_targetTopic: string, filePath: string, fileName: string) => {
        try {
          await this.sender.sendFile(topic, filePath, fileName);
          _hasOutbound = true;
        } catch (err: any) {
          Logger.warning(`文件发送失败 (sendFile): ${err.message}`);
          throw err;
        }
      },
      sendRuntimePlan: async (_targetTopic, snapshot) => {
        if (suppressStructuredProgress) {
          return;
        }
        try {
          await this.sender.sendRuntimePlan(topic, snapshot);
        } catch (err: any) {
          Logger.warning(`计划卡片发送失败 (sendRuntimePlan): ${err.message}`);
          throw err;
        }
      },
    };

    return channel;
  }

  private buildSessionCallbacks(
    topic: string,
    opts?: { sessionKey?: string; senderId?: string; channelSource?: string },
  ): SessionCallbacks {
    const suppressToolProgress = shouldSuppressStructuredToolProgress(opts?.channelSource);
    return {
      onRetry: async (attempt, maxRetries) => {
        try {
          await this.sender.reply(topic, `⚠️ 大模型请求失败，正在重试 (${attempt}/${maxRetries})...`);
        } catch (err: any) {
          Logger.warning(`重试提示发送失败: ${err.message}`);
        }
      },
      onAssistantText: async (text: string) => {
        try {
          await this.sender.reply(topic, text);
        } catch (err: any) {
          Logger.warning(`前端通知发送失败 (assistant_text): ${err.message}`);
        }
      },
      onThinking: async (thinking: string) => {
        if (suppressToolProgress) {
          return;
        }
        try {
          await this.sender.sendThinking(topic, thinking);
        } catch (err: any) {
          Logger.warning(`前端通知发送失败 (thinking): ${err.message}`);
        }
      },
      onToolStart: async (toolName: string, toolUseId: string, input: any) => {
        // 跳过输出型工具的 WORKING 消息
        if (suppressToolProgress || shouldHideCatsToolProgress(toolName)) {
          return;
        }
        try {
          await this.sender.sendToolUse(topic, toolUseId, toolName, input);
        } catch (err: any) {
          Logger.warning(`前端通知发送失败 (tool_use): ${err.message}`);
        }
      },
      onToolEnd: async (toolName: string, toolUseId: string, result: string) => {
        // 跳过输出型工具的 WORKING 消息
        if (suppressToolProgress || shouldHideCatsToolProgress(toolName)) {
          return;
        }
        try {
          let content = stripToolTargetContextForDisplay(result);

          // 清理 execute_shell 的格式化前缀
          if (content.startsWith('命令执行成功:') || content.startsWith('命令执行失败:')) {
            const lines = content.split('\n');
            content = lines.slice(5).join('\n').trim();
          }

          // 清理 read_file 的格式化前缀
          if (content.startsWith('文件:')) {
            const lines = content.split('\n');
            const contentStart = lines.findIndex(line => line.match(/^\s+\d+→/));
            if (contentStart > 0) {
              content = lines.slice(contentStart).join('\n');
            }
          }

          // 清理 glob 的格式化前缀
          if (content.startsWith('找到') && content.includes('个匹配文件:')) {
            const lines = content.split('\n');
            const listStart = lines.findIndex((line, idx) => idx > 0 && line.match(/^\s+\d+\./));
            if (listStart > 0) {
              content = lines.slice(listStart).join('\n').trim();
            }
          }

          await this.sender.sendToolResult(topic, toolUseId, content);
        } catch (err: any) {
          Logger.warning(`前端通知发送失败 (tool_result): ${err.message}`);
        }
      },
    };
  }

  // ─── 消息处理 ─────────────────────────────────────────

  /**
   * 处理收到的消息
   */
  private async onMessage(ctx: MessageContext): Promise<void> {
    if (this.isCancelMessage(ctx)) {
      this.handleCancelMessage(ctx);
      return;
    }

    const msg = this.parseMessage(ctx);
    if (!msg) return;

    // 过滤 bot 自己发出的消息，防止循环
    if (this.botUid && msg.senderId === this.botUid) return;

    const key = msg.envelope.sessionKey;

    await this.processParsedMessage(msg, key);
  }

  private registerSubAgentPlatformCallbacks(
    sessionKey: string,
    topic: string,
    senderId: string,
    executionScope?: ParsedCatsMessage['executionScope'],
  ): void {
    SubAgentManager.getInstance().registerPlatformCallbacks(sessionKey, {
      injectMessage: async (text: string) => {
        await this.handleSubAgentFeedback(sessionKey, topic, senderId, text, executionScope);
      },
      onSubAgentEvent: async (event: any, info?: SubAgentInfo) => {
        await this.handleSubAgentRuntimeEvent(topic, event, info, executionScope?.channelSource);
      },
    } as any);
  }

  private async processParsedMessage(msg: ParsedCatsMessage, key: string): Promise<void> {
    const sessionRoute = msg.envelope ? createCatsCoSessionRoute(msg.envelope) : undefined;
    const session = this.sessionManager.getOrCreate(sessionRoute && sessionRoute.sessionKey === key ? sessionRoute : key);

    // 处理斜杠命令
    if (typeof msg.text === 'string' && msg.text.startsWith('/')) {
      const parts = msg.text.slice(1).split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);

      const result = await session.handleCommand(command, args);
      if (result.handled && result.reply) {
        try {
          await this.sender.reply(msg.topic, result.reply);
        } catch (err: any) {
          Logger.warning(`命令回复发送失败: ${err.message}`);
        }
      }
      if (result.handled && command.toLowerCase() === 'clear') {
        this.pendingAttachments.delete(key);
      }
      if (result.handled) return;
    }

    const messageFiles = msg.files && msg.files.length > 0 ? msg.files : (msg.file ? [msg.file] : []);
    const hasPendingAttachments = (this.pendingAttachments.get(key)?.length || 0) > 0;
    if (isCatsCompanyPassiveAcknowledgement(msg.text) && messageFiles.length === 0 && !hasPendingAttachments) {
      Logger.info(`[${key}] 收到纯确认/感谢消息，已静默跳过推理`);
      return;
    }

    Logger.info(`[${key}] 收到消息: ${msg.text.slice(0, 50)}...`);
    logCatsCoExecutionContextDiagnostics({
      sessionKey: key,
      topic: msg.topic,
      senderId: msg.senderId,
      text: msg.text,
      executionScope: msg.executionScope,
      deviceSelection: msg.deviceSelection,
      deviceGrants: msg.deviceGrants,
    });

    let userMessage: string | import('../types').ContentBlock[] = msg.text;
    const runtimeFeedback: RuntimeFeedbackInput[] = [];
    let localFileGrants: ScopedLocalFileGrant[] = [];

    if (messageFiles.length > 0) {
      const attachments: PendingAttachment[] = [];
      for (const file of messageFiles) {
        const localPath = await this.sender.downloadFile(file.url, file.fileName);
        if (!localPath) {
          runtimeFeedback.push({
            source: 'catscompany.file_download',
            message: `文件下载失败: ${file.fileName}`,
            actionHint: '请告知用户该附件没有成功读取，并让用户重试上传或改用文字说明。',
          });
          continue;
        }
        attachments.push({
          fileName: file.fileName,
          localPath,
          type: file.type,
          receivedAt: Date.now(),
          localFileGrant: createCatsCoAttachmentGrant(msg.executionScope, this.localDeviceGrant, {
            localPath,
            fileName: file.fileName,
            type: file.type,
            workspaceRoot: process.cwd(),
          }),
        });
      }

      if (attachments.length > 0) {
        localFileGrants = this.collectLocalFileGrants(attachments);
        userMessage = await this.buildMultimodalMessage(msg.text, attachments);
        Logger.info(`[${key}] 原子附件消息（attachments=${attachments.length})`);
      } else {
        userMessage = `[用户上传了 ${messageFiles.length} 个附件，但平台未能下载这些附件]`;
      }
    } else {
      const queuedAttachments = this.consumePendingAttachments(key);
      if (queuedAttachments.length > 0) {
        localFileGrants = this.collectLocalFileGrants(queuedAttachments);
        userMessage = await this.buildMultimodalMessage(msg.text, queuedAttachments);
        Logger.info(`[${key}] 追加 ${queuedAttachments.length} 个附件`);
      }
    }

    // 并发保护：忙时消息静默入队，空闲后自动处理
    userMessage = prefixCatsUserMessage(speakerNameFromMetadata(msg), userMessage);

    if (session.isBusy()) {
      const queue = this.messageQueue.get(key) ?? [];
      queue.push({
        userMessage,
        topic: msg.topic,
        senderId: msg.senderId,
        seq: msg.seq,
        executionScope: msg.executionScope,
        deviceGrants: msg.deviceGrants,
        deviceSelection: msg.deviceSelection,
        targetRoutes: msg.targetRoutes,
        localFileGrants,
        receivedAt: Date.now(),
        source: 'user',
        runtimeFeedback,
      });
      this.messageQueue.set(key, queue);
      Logger.info(`[${key}] 主会话忙，消息已入队 (队列长度: ${queue.length})`);
      return;
    }

    this.registerSubAgentPlatformCallbacks(key, msg.topic, msg.senderId, msg.executionScope);

    // 构建通道回调，通过 context 传递给工具（替代 bind/unbind）
    const channel = this.buildChannel(msg.topic, {
      sessionKey: key,
      senderId: msg.senderId,
      channelSource: msg.executionScope?.channelSource,
    });

    const stopTypingHeartbeat = this.startTypingHeartbeat(msg.topic);

    try {
      const result = await session.handleMessage(userMessage, {
        channel,
        sessionRoute,
        executionScope: msg.executionScope,
        localDeviceGrant: this.localDeviceGrant,
        deviceGrants: msg.deviceGrants,
        deviceSelection: msg.deviceSelection,
        targetRoutes: msg.targetRoutes,
        deviceRpc: this.buildDeviceRpcTransport(),
        thinToolRpc: this.maybeBuildThinToolRpcTransport(),
        localFileGrants,
        runtimeFeedback,
        pendingUserInputProvider: () => this.consumeQueuedUserInput(key, msg.executionScope),
        callbacks: this.buildSessionCallbacks(msg.topic, {
          sessionKey: key,
          senderId: msg.senderId,
          channelSource: msg.executionScope?.channelSource,
        }),
      });

      // 最终文本回复
      if (result.visibleToUser && result.text) {
        try {
          await this.sender.reply(msg.topic, result.text);
        } catch (err: any) {
          Logger.warning(`前端通知发送失败 (text): ${err.message}`);
        }
      }
    } finally {
      stopTypingHeartbeat();
    }

    // 处理忙时排队的消息
    await this.drainMessageQueue(key);
  }

  /**
   * 从 MessageContext 解析为 ParsedCatsMessage
   */
  private parseMessage(ctx: MessageContext): ParsedCatsMessage | null {
    const text = typeof ctx.text === 'string' ? ctx.text : '';
    const chatType = ctx.isGroup ? 'group' : 'p2p';

    // 检测 rich content 中的文件/图片
    let file: CatsFileInfo | undefined;
    const files: CatsFileInfo[] = [];
    const blockTextParts: string[] = [];
    let content = ctx.content;
    const seenFileUrls = new Set<string>();
    const appendFile = (candidate: CatsFileInfo) => {
      if (typeof candidate.url !== 'string') return;
      const url = candidate.url.trim();
      if (!url || seenFileUrls.has(url)) return;
      seenFileUrls.add(url);
      const normalized = { ...candidate, url };
      files.push(normalized);
      if (!file) file = normalized;
    };

    if (Array.isArray(ctx.content_blocks)) {
      for (const block of ctx.content_blocks) {
        if (!block || typeof block !== 'object') continue;
        const typedBlock = block as any;
        if (typedBlock.type === 'text' && typeof typedBlock.text === 'string' && typedBlock.text.trim()) {
          blockTextParts.push(typedBlock.text);
          continue;
        }
        if ((typedBlock.type === 'file' || typedBlock.type === 'image') && typedBlock.payload) {
          const payload = typedBlock.payload;
          const url = typeof payload.url === 'string' ? payload.url : '';
          if (!url) continue;
          appendFile({
            url,
            fileName: payload.name || payload.file_name || (typedBlock.type === 'image' ? 'image.png' : 'unknown'),
            type: typedBlock.type === 'image' ? 'image' : 'file',
          });
        }
      }
    }

    // 如果 content 是 JSON 字符串，先解析
    if (typeof content === 'string') {
      try {
        content = JSON.parse(content);
      } catch {
        // 解析失败，保持原样
      }
    }

    if (typeof content === 'object' && content !== null) {
      const rich = content as any;
      if (rich.type === 'file' && rich.payload) {
        appendFile({
          url: rich.payload.url,
          fileName: rich.payload.name || 'unknown',
          type: 'file',
        });
      } else if (rich.type === 'image' && rich.payload) {
        appendFile({
          url: rich.payload.url,
          fileName: rich.payload.name || 'image.png',
          type: 'image',
        });
      }
    }

    // content_blocks 里的 text block 是新协议的 canonical 用户文本；
    // 顶层 content 可能只是附件摘要，因此只作为没有 text block 时的 fallback。
    const blockText = blockTextParts.join('\n\n');
    const mergedText = blockText || text;
    if (!mergedText && files.length === 0) return null;
    const messageText = mergedText
      || (files.length > 0
        ? files.map(item => `[${item.type === 'image' ? '图片' : '文件'}] ${item.fileName}`).join('\n')
        : '');
    const envelope = createCatsCoMessageEnvelope({
      topic: ctx.topic,
      isGroup: ctx.isGroup,
      senderId: ctx.senderId,
      seq: ctx.seq,
      text: messageText,
      metadata: ctx.metadata,
      botUid: this.botUid,
    });
    const executionScope = createExecutionScope(envelope);
    const targetRoutes = extractCatsCoRuntimeContext(ctx.metadata);
    if (targetRoutes?.routes?.length) {
      Logger.info(`[CatsCompany][xiaoba_runtime] parsed target routes: topic=${ctx.topic}, sender=${ctx.senderId}, routes=${targetRoutes.routes.map(route => `${route.userName || route.userId || '?'}:${route.ownerUserId}/${route.deviceId}/${route.os}`).join(', ')}`);
    } else {
      Logger.info(`[CatsCompany][xiaoba_runtime] no target routes parsed: topic=${ctx.topic}, sender=${ctx.senderId}`);
    }

    return {
      topic: ctx.topic,
      chatType,
      senderId: ctx.senderId,
      seq: ctx.seq ?? 0,
      text: messageText,
      rawContent: ctx.content,
      metadata: ctx.metadata,
      envelope,
      executionScope,
      deviceGrants: extractCatsCoDeviceGrants(ctx.metadata, executionScope),
      deviceSelection: extractCatsCoDeviceSelection(ctx.metadata, executionScope),
      targetRoutes,
      file: files[0],
      files,
    };
  }

  /**
   * 处理子智能体反馈注入
   */
  private async handleSubAgentFeedback(
    sessionKey: string,
    topic: string,
    senderId: string,
    text: string,
    executionScope?: ParsedCatsMessage['executionScope'],
  ): Promise<void> {
    const session = this.sessionManager.getOrCreate(sessionKey);

    if (session.isBusy()) {
      this.enqueueSubAgentFeedback(sessionKey, topic, senderId, text, executionScope);
      Logger.info(`[${sessionKey}] 主会话忙，子智能体反馈已入队`);
      return;
    }

    this.registerSubAgentPlatformCallbacks(sessionKey, topic, senderId, executionScope);

    const channel = this.buildChannel(topic, {
      sessionKey,
      senderId,
      channelSource: executionScope?.channelSource,
    });

    const stopTypingHeartbeat = this.startTypingHeartbeat(topic);
    let typingHeartbeatStopped = false;
    const stopTypingHeartbeatOnce = () => {
      if (typingHeartbeatStopped) return;
      typingHeartbeatStopped = true;
      stopTypingHeartbeat();
    };

    try {
      const result = await session.handleRuntimeObservation(text, {
        channel,
        callbacks: this.buildSessionCallbacks(topic, {
          sessionKey,
          senderId,
          channelSource: executionScope?.channelSource,
        }),
        source: 'subagent_result',
        executionScope,
        localDeviceGrant: this.localDeviceGrant,
        deviceRpc: this.buildDeviceRpcTransport(),
        thinToolRpc: this.maybeBuildThinToolRpcTransport(),
      });
      if (result.text === BUSY_MESSAGE) {
        this.enqueueSubAgentFeedback(sessionKey, topic, senderId, text, executionScope);
        Logger.info(`[${sessionKey}] 主会话竞态忙碌，子智能体反馈已入队`);
        return;
      }
      if (result.text.startsWith('处理消息时出错:')) {
        try {
          await this.sender.reply(topic, result.text);
        } catch (err: any) {
          Logger.warning(`错误消息发送失败: ${err.message}`);
        }
      } else if (result.visibleToUser && result.text) {
        try {
          await this.sender.reply(topic, result.text);
        } catch (err: any) {
          Logger.warning(`子智能体结果回复发送失败: ${err.message}`);
        }
      }
      stopTypingHeartbeatOnce();
      await this.drainMessageQueue(sessionKey);
    } finally {
      stopTypingHeartbeatOnce();
    }
  }

  private enqueueSubAgentFeedback(
    sessionKey: string,
    topic: string,
    senderId: string,
    text: string,
    executionScope?: ParsedCatsMessage['executionScope'],
  ): void {
    const queue = this.messageQueue.get(sessionKey) ?? [];
    queue.push({
      userMessage: text,
      topic,
      senderId,
      seq: 0,
      executionScope: executionScope ?? createExecutionScope(createCatsCoMessageEnvelope({
        topic,
        senderId,
        text,
      })),
      receivedAt: Date.now(),
      source: 'subagent_feedback',
    });
    this.messageQueue.set(sessionKey, queue);
  }

  private async handleSubAgentRuntimeEvent(
    topic: string,
    event: any,
    info?: SubAgentInfo,
    channelSource?: string,
  ): Promise<void> {
    const subAgentId = String(event?.subAgentId || info?.id || '');
    if (!subAgentId) return;

    const eventType = String(event?.type || '');
    if (eventType === 'agent_spawned') {
      this.subAgentEventRoutes.set(subAgentId, { topic, channelSource });
    }
    const route = this.subAgentEventRoutes.get(subAgentId);
    const eventTopic = route?.topic || topic;
    const eventChannelSource = route ? route.channelSource : channelSource;
    const isTerminalEvent = SUBAGENT_TERMINAL_EVENTS.has(eventType);

    if (shouldSuppressStructuredToolProgress(eventChannelSource)) {
      if (isTerminalEvent) {
        this.subAgentEventRoutes.delete(subAgentId);
      }
      return;
    }

    const displayName = String(event?.subAgentName || (info as any)?.displayName || subAgentId.slice(0, 12));
    const toolUseId = `subagent:${subAgentId}`;
    const status = info?.status || 'running';

    try {
      if (event?.type === 'agent_spawned') {
        await this.sender.sendToolUse(eventTopic, toolUseId, displayName, {
          kind: 'subagent',
          subagent_id: subAgentId,
          display_name: displayName,
          agent_type: (info as any)?.agentType || info?.skillName || '',
          status,
          task: info?.taskDescription || event?.summary || '',
        }, this.subAgentEventMetadata(event, info, status));
        return;
      }

      if (SUBAGENT_TERMINAL_EVENTS.has(String(event?.type))) {
        const statusLabel = event.type === 'agent_completed'
          ? '已完成'
          : event.type === 'agent_stopped'
            ? '已停止'
            : '失败';
        const summary = [
          `${displayName} ${statusLabel}`,
          `任务: ${info?.taskDescription || event?.summary || '（未知）'}`,
          `结果摘要: ${compactCatsSubAgentSummary(info?.resultSummary || event?.summary || '（无结果）')}`,
          info?.outputFiles?.length ? `产出文件:\n${info.outputFiles.map(file => `- ${file}`).join('\n')}` : '',
        ].filter(Boolean).join('\n');
        await this.sender.sendToolResult(
          eventTopic,
          toolUseId,
          summary,
          event.type === 'agent_failed',
          this.subAgentEventMetadata(event, info, status),
        );
        this.subAgentEventRoutes.delete(subAgentId);
        return;
      }

      if (event?.type === 'agent_waiting') {
        return;
      }

      if (event?.summary) {
        await this.sender.sendThinking(
          eventTopic,
          `[${displayName}] ${event.summary}`,
          this.subAgentEventMetadata(event, info, status),
        );
      }
    } catch (err: any) {
      Logger.warning(`子智能体状态通知发送失败: ${err.message}`);
    }
  }

  private subAgentEventMetadata(event: any, info?: SubAgentInfo, status?: SubAgentInfo['status']): Record<string, unknown> {
    return {
      kind: 'subagent_event',
      subagent_id: event?.subAgentId || info?.id,
      subagent_name: event?.subAgentName || (info as any)?.displayName,
      display_name: event?.subAgentName || (info as any)?.displayName,
      subagent_event_type: event?.type,
      agent_type: (info as any)?.agentType || info?.skillName,
      status,
      task: info?.taskDescription,
      summary: event?.summary,
      step_count: info?.progressLog?.length,
    };
  }

  /** CatsCompany 网页停止按钮发来的轻量取消事件，不落历史消息 */
  private isCancelMessage(ctx: MessageContext): boolean {
    const type = String(ctx.type || ctx.msg_type || '').trim();
    const streamEvent = String(ctx.metadata?.stream_event || '').trim();
    const control = String(ctx.metadata?.control || '').trim();
    return type === 'stream_cancel' || streamEvent === 'cancel' || control === 'interrupt';
  }

  private handleCancelMessage(ctx: MessageContext): void {
    const envelope = createCatsCoMessageEnvelope({
      topic: ctx.topic,
      isGroup: ctx.isGroup,
      senderId: ctx.senderId,
      seq: ctx.seq,
      text: '',
      metadata: ctx.metadata,
      botUid: this.botUid,
    });
    const key = envelope.sessionKey;
    const session = (this.sessionManager as any).get?.(key) ?? null;
    if (!session) {
      Logger.info(`[${key}] 收到取消事件，但会话不存在`);
      return;
    }

    session.requestInterrupt();
    Logger.info(`[${key}] 收到 CatsCompany 取消事件，已请求中断当前回合`);
  }

  private startTypingHeartbeat(topic: string, intervalMs = TYPING_HEARTBEAT_INTERVAL_MS): () => void {
    let stopped = false;
    const send = () => {
      if (!stopped) {
        this.sender.sendTyping(topic);
      }
    };

    send();
    const interval = setInterval(send, intervalMs);
    (interval as any).unref?.();

    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }

  /**
   * 排空消息队列：将忙时积压的消息合并为一条，一次性处理
   */
  private async drainMessageQueue(sessionKey: string): Promise<void> {
    const queue = this.messageQueue.get(sessionKey);
    if (!queue || queue.length === 0) return;

    const msg = queue.shift()!;
    if (queue.length === 0) {
      this.messageQueue.delete(sessionKey);
    }

    const session = this.sessionManager.getOrCreate(sessionKey);
    this.registerSubAgentPlatformCallbacks(sessionKey, msg.topic, msg.senderId, msg.executionScope);
    const channel = this.buildChannel(msg.topic, {
      sessionKey,
      senderId: msg.senderId,
      channelSource: msg.executionScope?.channelSource,
    });

    const stopTypingHeartbeat = this.startTypingHeartbeat(msg.topic);

    try {
      const result = msg.source === 'subagent_feedback'
        ? await session.handleRuntimeObservation(msg.userMessage as string, {
          channel,
          callbacks: this.buildSessionCallbacks(msg.topic, {
            sessionKey,
            senderId: msg.senderId,
            channelSource: msg.executionScope?.channelSource,
          }),
          source: 'subagent_result',
          executionScope: msg.executionScope,
          localDeviceGrant: this.localDeviceGrant,
          deviceSelection: msg.deviceSelection,
          targetRoutes: msg.targetRoutes,
          deviceRpc: this.buildDeviceRpcTransport(),
          thinToolRpc: this.maybeBuildThinToolRpcTransport(),
        })
        : await session.handleMessage(msg.userMessage, {
          channel,
          executionScope: msg.executionScope,
          localDeviceGrant: this.localDeviceGrant,
          deviceGrants: msg.deviceGrants,
          deviceSelection: msg.deviceSelection,
          targetRoutes: msg.targetRoutes,
          deviceRpc: this.buildDeviceRpcTransport(),
          thinToolRpc: this.maybeBuildThinToolRpcTransport(),
          runtimeFeedback: msg.runtimeFeedback,
          localFileGrants: msg.localFileGrants,
          pendingUserInputProvider: () => this.consumeQueuedUserInput(sessionKey, msg.executionScope),
          callbacks: this.buildSessionCallbacks(msg.topic, {
            sessionKey,
            senderId: msg.senderId,
            channelSource: msg.executionScope?.channelSource,
          }),
        });
      if (result.text.startsWith('处理消息时出错:')) {
        try {
          await this.sender.reply(msg.topic, result.text);
        } catch (err: any) {
          Logger.warning(`错误消息发送失败: ${err.message}`);
        }
      } else if (result.text !== BUSY_MESSAGE && result.visibleToUser && result.text) {
        try {
          await this.sender.reply(msg.topic, result.text);
        } catch (err: any) {
          Logger.warning(`队列消息回复发送失败: ${err.message}`);
        }
      }
    } finally {
      stopTypingHeartbeat();
    }

    await this.drainMessageQueue(sessionKey);
  }

  private consumeQueuedUserInput(
    sessionKey: string,
    currentScope?: ParsedCatsMessage['executionScope'],
  ): string | ContentBlock[] | PendingUserInput | null {
    const queue = this.messageQueue.get(sessionKey);
    if (!queue || queue.length === 0) return null;

    const userMessages: QueuedMessage[] = [];
    let firstRemainingIndex = 0;
    for (; firstRemainingIndex < queue.length; firstRemainingIndex++) {
      const item = queue[firstRemainingIndex];
      if (item.source === 'subagent_feedback') break;
      if (!this.canMergeQueuedMessage(currentScope, item.executionScope)) break;
      userMessages.push(item);
    }
    const remainingMessages = queue.slice(firstRemainingIndex);
    if (remainingMessages.length > 0) {
      this.messageQueue.set(sessionKey, remainingMessages);
    } else {
      this.messageQueue.delete(sessionKey);
    }
    if (userMessages.length === 0) return null;

    const messages = [...userMessages].sort((a, b) => {
      if (a.seq > 0 && b.seq > 0 && a.seq !== b.seq) return a.seq - b.seq;
      return a.receivedAt - b.receivedAt;
    });

    Logger.info(`[${sessionKey}] 合并 ${messages.length} 条处理期间新到的用户消息`);
    const content = this.mergeQueuedMessages(messages);
    const localFileGrants = messages.flatMap(item => item.localFileGrants || []);
    const deviceGrants = messages.flatMap(item => item.deviceGrants || []);
    const deviceSelection = [...messages].reverse().find(item => item.deviceSelection)?.deviceSelection;
    const targetRoutes = [...messages].reverse().find(item => item.targetRoutes)?.targetRoutes;
    if (localFileGrants.length === 0 && deviceGrants.length === 0 && !deviceSelection && !targetRoutes) return content;
    return {
      content,
      localFileGrants: localFileGrants.length > 0 ? localFileGrants : undefined,
      deviceGrants: deviceGrants.length > 0 ? deviceGrants : undefined,
      deviceSelection,
      targetRoutes,
    };
  }

  private canMergeQueuedMessage(
    currentScope: ParsedCatsMessage['executionScope'] | undefined,
    queuedScope: ParsedCatsMessage['executionScope'] | undefined,
  ): boolean {
    if (!currentScope || !queuedScope) return true;
    return currentScope.sessionKey === queuedScope.sessionKey
      && currentScope.topicId === queuedScope.topicId
      && currentScope.topicType === queuedScope.topicType
      && currentScope.actorUserId === queuedScope.actorUserId
      && currentScope.agentId === queuedScope.agentId
      && currentScope.agentBodyId === queuedScope.agentBodyId
      && currentScope.identityTrust === queuedScope.identityTrust;
  }

  private mergeQueuedMessages(messages: QueuedMessage[]): string | ContentBlock[] {
    if (messages.length === 1) {
      return messages[0].userMessage;
    }

    const header = [
      `用户在你处理上一轮时又补充了 ${messages.length} 条消息。`,
      '请把这些补充消息作为当前最新需求一起处理；如果前后要求冲突，以最后一条为准。',
    ].join('\n');

    const hasRichContent = messages.some(item => Array.isArray(item.userMessage));
    if (!hasRichContent) {
      const body = messages
        .map((item, index) => `${index + 1}. ${item.senderId}: ${item.userMessage as string}`)
        .join('\n');
      return `${header}\n\n${body}`;
    }

    const blocks: ContentBlock[] = [{ type: 'text', text: `${header}\n` }];
    for (const [index, item] of messages.entries()) {
      blocks.push({
        type: 'text',
        text: `\n[补充消息 ${index + 1} / ${messages.length}，来自 ${item.senderId}]\n`,
      });
      if (Array.isArray(item.userMessage)) {
        blocks.push(...item.userMessage);
      } else {
        blocks.push({ type: 'text', text: item.userMessage });
      }
    }

    return blocks;
  }

  /**
   * 停止机器人
   */
  async destroy(): Promise<void> {
    this.stopDeviceRegistrationRefresh();
    this.bot.disconnect();
    await this.sessionManager.destroy();
    this.pendingAttachments.clear();
    this.messageQueue.clear();
    this.subAgentEventRoutes.clear();
    Logger.info('CatsCo agent 已停止');
  }

  private enqueuePendingAttachment(sessionKey: string, attachment: PendingAttachment): number {
    const queue = this.pendingAttachments.get(sessionKey) ?? [];
    queue.push(attachment);
    const trimmed = queue.slice(-5);
    this.pendingAttachments.set(sessionKey, trimmed);
    return trimmed.length;
  }

  private consumePendingAttachments(sessionKey: string): PendingAttachment[] {
    const queue = this.pendingAttachments.get(sessionKey) ?? [];
    this.pendingAttachments.delete(sessionKey);
    return queue;
  }

  private collectLocalFileGrants(attachments: PendingAttachment[]): ScopedLocalFileGrant[] {
    return attachments
      .map(attachment => attachment.localFileGrant)
      .filter((grant): grant is ScopedLocalFileGrant => Boolean(grant));
  }

  private async buildMultimodalMessage(text: string, attachments: PendingAttachment[]): Promise<import('../types').ContentBlock[]> {
    const { createImageBlock } = require('../utils/image-utils');
    const blocks: import('../types').ContentBlock[] = [];
    const config = ConfigManager.getConfigReadonly();
    const primaryModelCanSeeImages = isPrimaryModelVisionCapable(config);
    const modelName = config.model || 'unknown';
    const currentImageRefs: string[] = [];

    if (text) {
      blocks.push({ type: 'text', text });
    }

    for (const att of attachments) {
      const attachmentReference = this.formatAttachmentReferenceForModel(att);
      if (att.type === 'image') {
        if (!primaryModelCanSeeImages) {
          currentImageRefs.push(attachmentReference);
          continue;
        }

        blocks.push({ type: 'text', text: attachmentReference });
        const imgBlock = await createImageBlock(att.localPath);
        const logFile = formatPathForLog(att.localPath || att.fileName);
        if (imgBlock) {
          blocks.push({
            ...imgBlock,
            filePath: att.localFileGrant?.attachmentRef || `[CatsCo attachment: ${att.fileName}]`,
          } as any);
          Logger.info(`[CatsCo] vision_direct model=${modelName} file=${logFile} bytes_base64=${((imgBlock as any).source as any)?.data?.length || 0}`);
        } else {
          currentImageRefs.push(attachmentReference);
          Logger.warning(`[CatsCo] vision_fallback_read_file model=${modelName} file=${logFile} reason=image_block_create_failed`);
        }
      } else {
        blocks.push({ type: 'text', text: attachmentReference });
      }
    }

    Logger.info(`[多模态] 构建完成，共 ${blocks.length} 个块: ${blocks.map(b => b.type).join(', ')}`);
    if (currentImageRefs.length > 0) {
      blocks.push({
          type: 'text',
          text: [
            '[Current user turn contains image attachments]',
            'The primary model cannot directly inspect image pixels in this runtime.',
            'If the user request depends on image content, call read_file with file_path set to the current authorized attachment reference below.',
            'Use only the current authorized attachment reference(s) listed here. Do not use old tmp/downloads paths, old image URLs, old filenames, or prior image descriptions.',
            currentImageRefs.join('\n\n'),
          ].join('\n'),
        });
      Logger.info(`[CatsCo] vision_fallback_read_file model=${modelName} images=${currentImageRefs.length} reason=${primaryModelCanSeeImages ? 'image_block_create_failed' : 'model_not_vision_capable'}`);
    }

    return blocks;
  }

  private formatAttachmentReferenceForModel(attachment: PendingAttachment): string {
    const label = attachment.type === 'image' ? '图片' : '文件';
    const attachmentRef = attachment.localFileGrant?.attachmentRef;
    if (!attachmentRef) {
      return [
        `[${label}] ${attachment.fileName}`,
        '[附件授权状态] 当前消息没有生成可读取的本地附件引用。',
      ].join('\n');
    }

    return [
      `[${label}] ${attachment.fileName}`,
      `[授权附件引用] ${attachmentRef}`,
      '[使用方式] 如需读取或转发该附件，将 read_file/send_file 的 file_path 设置为这个引用。',
    ].join('\n');
  }

  private formatAttachmentContext(attachments: PendingAttachment[]): string {
    const lines = attachments.map((attachment, index) => {
      return `[附件${index + 1}]\n${this.formatAttachmentReferenceForModel(attachment)}`;
    });
    return `[用户已上传附件]\n${lines.join('\n')}`;
  }

  private buildAttachmentOnlyPrompt(attachments: PendingAttachment[]): string {
    return [
      '[用户仅上传了附件，暂未给出明确任务]',
      '[当前会话是 CatsCo 聊天：给用户可见的文本会自动发送；如需发送文件，使用当前可用的发送文件工具]',
      '请你先判断最合理的下一步，不要默认进入任何特定 skill（例如 paper-analysis）。',
      '如果任务不明确，先提出一个最小澄清问题；如果任务足够明确，再自行执行。',
      this.formatAttachmentContext(attachments),
    ].join('\n');
  }

}
