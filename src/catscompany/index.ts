import { CatsClient, MessageContext, type CatsDeviceRpcMessage } from './client';
import { CatsCompanyConfig, ParsedCatsMessage, CatsFileInfo } from './types';
import { MessageSender } from './message-sender';
import { extractContentBlocks } from './content-blocks';
import { createCatsCoMessageEnvelope, createExecutionScope } from './message-envelope';
import { createCatsCoAttachmentGrant, createCatsCoLocalDeviceGrant } from './local-file-grants';
import { extractCatsCoDeviceGrants } from './device-grants';
import { extractCatsCoDeviceSelection } from './device-selection';
import { MessageSessionManager } from '../core/message-session-manager';
import { AgentServices, BUSY_MESSAGE, RuntimeFeedbackInput, SessionCallbacks } from '../core/agent-session';
import { Logger } from '../utils/logger';
import { SubAgentManager } from '../core/sub-agent-manager';
import type { SubAgentInfo } from '../core/sub-agent-session';
import { ChannelCallbacks, DeviceRpcTransport, ToolErrorCode, ToolExecutionConfirmationRequest, ToolExecutionConfirmationResult, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { ContentBlock } from '../types';
import type { PendingUserInput } from '../core/conversation-runner';
import type { DeviceGrantOperation, ExecutionScope, ScopedDeviceGrant, ScopedDeviceSelection, ScopedLocalDeviceGrant, ScopedLocalFileGrant } from '../types/session-identity';
import { AdapterRuntimeBundle, createAdapterRuntime } from '../runtime/adapter-runtime';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
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
import { formatPathForLog } from '../utils/log-redaction';

interface PendingAttachment {
  fileName: string;
  localPath: string;
  type: 'file' | 'image';
  receivedAt: number;
  localFileGrant?: ScopedLocalFileGrant;
}

interface PendingAnswer {
  id: string;
  sessionKey: string;
  topic: string;
  expectedSenderId: string;
  resolve: (text: string) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface QueuedMessage {
  userMessage: string | ContentBlock[];
  topic: string;
  senderId: string;
  seq: number;
  executionScope: ParsedCatsMessage['executionScope'];
  deviceGrants?: ScopedDeviceGrant[];
  deviceSelection?: ScopedDeviceSelection;
  localFileGrants?: ScopedLocalFileGrant[];
  receivedAt: number;
  source?: 'user' | 'subagent_feedback';
  runtimeFeedback?: RuntimeFeedbackInput[];
}

const PENDING_ANSWER_TIMEOUT_MS = 120_000;
const TYPING_HEARTBEAT_INTERVAL_MS = 5_000;
const DEVICE_REGISTRATION_REFRESH_MS = 120_000;
const DEVICE_RPC_DEFAULT_TTL_MS = 60_000;
const HIDDEN_CATS_TOOL_PROGRESS = new Set([
  'send_text',
  'send_file',
  'spawn_subagent',
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

function shouldHideCatsToolProgress(toolName: string): boolean {
  return HIDDEN_CATS_TOOL_PROGRESS.has(toolName);
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
  /** key = pendingAnswerId */
  private pendingAnswers = new Map<string, PendingAnswer>();
  /** key = sessionKey, value = pendingAnswerId */
  private pendingAnswerBySession = new Map<string, string>();
  /** 等待用户后续指令的附件队列，key 为 sessionKey */
  private pendingAttachments = new Map<string, PendingAttachment[]>();
  /** 主会话忙时的消息队列，key = sessionKey */
  private messageQueue = new Map<string, QueuedMessage[]>();
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
    status: 'online';
    capabilities: string[];
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

    this.bot.on('error', (err: Error) => {
      Logger.error(`CatsCo 连接错误: ${err.message}`);
    });

    this.bot.connect();
    Logger.success('CatsCo agent 已启动，等待消息...');
  }

  private async registerCurrentDevice(): Promise<void> {
    if (!this.deviceRegistration?.device_id) return;
    await this.bot.registerDevice(this.deviceRegistration);
    Logger.info(`[CatsCompany] 已注册本机设备能力: device=${this.deviceRegistration.device_id}, capabilities=${this.deviceRegistration.capabilities.join(',')}`);
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
      executeTool: async ({ toolName, operation, args, grant, timeoutMs }) => {
        const response = await this.bot.sendDeviceRpcRequest({
          request_id: `device_rpc_${randomUUID()}`,
          grant_id: grant.grantId,
          session_key: grant.sessionKey,
          topic_id: grant.topicId,
          topic_type: grant.topicType,
          actor_user_id: grant.actorUserId,
          owner_user_id: grant.ownerUserId,
          identity_source: grant.identitySource,
          agent_id: grant.agentId,
          agent_body_id: grant.agentBodyId,
          device_id: grant.deviceId,
          device_body_id: grant.deviceBodyId,
          device_installation_id: grant.deviceInstallationId,
          operation,
          tool_name: toolName,
          payload: { args },
          expires_at: grant.expiresAt,
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
    switch (operation) {
      case 'read_file':
        return new ReadTool().execute(args, context);
      case 'resolve_common_directory':
        return resolveCommonDirectoryToolArgs(args);
      case 'glob':
        return new GlobTool().execute(args, context);
      case 'grep':
        return new GrepTool().execute(args, context);
      case 'write_file':
        return new WriteTool().execute(args, context);
      case 'edit_file':
        return new EditTool().execute(args, context);
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
    if (!operation || !isRemoteDeviceRpcTool(toolName, operation)) {
      return { code: 'unsupported_operation', message: 'Device RPC only allows read_file, resolve_common_directory, glob, grep, write_file, edit_file, and execute_shell.' };
    }

    const requiredFields: Array<[keyof CatsDeviceRpcMessage, string]> = [
      ['grant_id', 'grant_id'],
      ['session_key', 'session_key'],
      ['topic_id', 'topic_id'],
      ['topic_type', 'topic_type'],
      ['actor_user_id', 'actor_user_id'],
      ['owner_user_id', 'owner_user_id'],
      ['device_id', 'device_id'],
    ];
    for (const [field, label] of requiredFields) {
      if (!String(request[field] || '').trim()) {
        return { code: 'invalid_request', message: `Device RPC request missing ${label}.` };
      }
    }
    const actorUserID = String(request.actor_user_id || '').trim();
    const ownerUserID = String(request.owner_user_id || '').trim();
    if (ownerUserID !== actorUserID && String(request.identity_source || '').trim() !== 'channel_identity_link') {
      return { code: 'invalid_request', message: 'Delegated Device RPC request missing channel_identity_link identity source.' };
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
      return { ...(record.args as Record<string, unknown>) };
    }
    return { ...record };
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
    },
  ): ChannelCallbacks & { hasOutbound: boolean } {
    let _hasOutbound = false;
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

  private buildSessionCallbacks(topic: string, opts?: { sessionKey?: string; senderId?: string }): SessionCallbacks {
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
        try {
          await this.sender.sendThinking(topic, thinking);
        } catch (err: any) {
          Logger.warning(`前端通知发送失败 (thinking): ${err.message}`);
        }
      },
      onToolStart: async (toolName: string, toolUseId: string, input: any) => {
        // 跳过输出型工具的 WORKING 消息
        if (shouldHideCatsToolProgress(toolName)) {
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
        if (shouldHideCatsToolProgress(toolName)) {
          return;
        }
        try {
          let content = result;

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
      confirmToolExecution: opts?.sessionKey && opts?.senderId
        ? (request) => this.confirmCatsCoToolExecution(topic, opts.sessionKey!, opts.senderId!, request)
        : undefined,
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

    // ── 拦截：如果当前 session 正在等待回答，按 sender 精确匹配 ──
    const pendingId = this.pendingAnswerBySession.get(key);
    if (pendingId) {
      const pending = this.pendingAnswers.get(pendingId);
      if (!pending) {
        this.pendingAnswerBySession.delete(key);
      } else if (msg.senderId === pending.expectedSenderId) {
        this.clearPendingAnswerById(pending.id);
        Logger.info(`[${key}] 收到用户对提问的回复: ${msg.text.slice(0, 50)}...`);
        pending.resolve(msg.text);
        return;
      } else {
        Logger.info(`[${key}] 忽略非提问发起人的回复: ${msg.senderId}`);
        return;
      }
    }

    await this.processParsedMessage(msg, key);
  }

  private async processParsedMessage(msg: ParsedCatsMessage, key: string): Promise<void> {
    const sessionRoute = msg.envelope ? createCatsCoSessionRoute(msg.envelope) : undefined;
    const session = this.sessionManager.getOrCreate(sessionRoute && sessionRoute.sessionKey === key ? sessionRoute : key);

    // 注册持久化回调到 SubAgentManager
    const subAgentManager = SubAgentManager.getInstance();
    subAgentManager.registerPlatformCallbacks(key, {
      injectMessage: async (text: string) => {
        await this.handleSubAgentFeedback(key, msg.topic, msg.senderId, text, msg.executionScope);
      },
      onSubAgentEvent: async (event: any, info?: SubAgentInfo) => {
        await this.handleSubAgentRuntimeEvent(msg.topic, event, info);
      },
    } as any);

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
        localFileGrants,
        receivedAt: Date.now(),
        source: 'user',
        runtimeFeedback,
      });
      this.messageQueue.set(key, queue);
      Logger.info(`[${key}] 主会话忙，消息已入队 (队列长度: ${queue.length})`);
      return;
    }

    // 构建通道回调，通过 context 传递给工具（替代 bind/unbind）
    const channel = this.buildChannel(msg.topic, {
      sessionKey: key,
      senderId: msg.senderId,
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
        deviceRpc: this.buildDeviceRpcTransport(),
        localFileGrants,
        runtimeFeedback,
        pendingUserInputProvider: () => this.consumeQueuedUserInput(key, msg.executionScope),
        callbacks: this.buildSessionCallbacks(msg.topic, { sessionKey: key, senderId: msg.senderId }),
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
      this.clearPendingAnswerBySession(key);
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

    const channel = this.buildChannel(topic, {
      sessionKey,
      senderId,
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
        callbacks: this.buildSessionCallbacks(topic),
        source: 'subagent_result',
        executionScope,
        localDeviceGrant: this.localDeviceGrant,
        deviceRpc: this.buildDeviceRpcTransport(),
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
      this.clearPendingAnswerBySession(sessionKey);
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
  ): Promise<void> {
    const subAgentId = String(event?.subAgentId || info?.id || '');
    if (!subAgentId) return;

    const displayName = String(event?.subAgentName || (info as any)?.displayName || subAgentId.slice(0, 12));
    const toolUseId = `subagent:${subAgentId}`;
    const status = info?.status || 'running';

    try {
      if (event?.type === 'agent_spawned') {
        await this.sender.sendToolUse(topic, toolUseId, displayName, {
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
          topic,
          toolUseId,
          summary,
          event.type === 'agent_failed',
          this.subAgentEventMetadata(event, info, status),
        );
        return;
      }

      if (event?.type === 'agent_waiting') {
        return;
      }

      if (event?.summary) {
        await this.sender.sendThinking(
          topic,
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
    const channel = this.buildChannel(msg.topic, {
      sessionKey,
      senderId: msg.senderId,
    });

    const stopTypingHeartbeat = this.startTypingHeartbeat(msg.topic);

    try {
      const result = msg.source === 'subagent_feedback'
        ? await session.handleRuntimeObservation(msg.userMessage as string, {
          channel,
          callbacks: this.buildSessionCallbacks(msg.topic, { sessionKey, senderId: msg.senderId }),
          source: 'subagent_result',
          executionScope: msg.executionScope,
          localDeviceGrant: this.localDeviceGrant,
          deviceSelection: msg.deviceSelection,
          deviceRpc: this.buildDeviceRpcTransport(),
        })
        : await session.handleMessage(msg.userMessage, {
          channel,
          executionScope: msg.executionScope,
          localDeviceGrant: this.localDeviceGrant,
          deviceGrants: msg.deviceGrants,
          deviceSelection: msg.deviceSelection,
          deviceRpc: this.buildDeviceRpcTransport(),
          runtimeFeedback: msg.runtimeFeedback,
          localFileGrants: msg.localFileGrants,
          pendingUserInputProvider: () => this.consumeQueuedUserInput(sessionKey, msg.executionScope),
          callbacks: this.buildSessionCallbacks(msg.topic, { sessionKey, senderId: msg.senderId }),
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
      this.clearPendingAnswerBySession(sessionKey);
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
    if (localFileGrants.length === 0 && deviceGrants.length === 0 && !deviceSelection) return content;
    return {
      content,
      localFileGrants: localFileGrants.length > 0 ? localFileGrants : undefined,
      deviceGrants: deviceGrants.length > 0 ? deviceGrants : undefined,
      deviceSelection,
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
    for (const pendingId of Array.from(this.pendingAnswers.keys())) {
      this.clearPendingAnswerById(pendingId);
    }
    this.pendingAnswerBySession.clear();
    this.pendingAttachments.clear();
    this.messageQueue.clear();
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

  private async confirmCatsCoToolExecution(
    topic: string,
    sessionKey: string,
    senderId: string,
    request: ToolExecutionConfirmationRequest,
  ): Promise<ToolExecutionConfirmationResult> {
    const prompt = this.formatToolConfirmationPrompt(request);
    try {
      await this.sender.reply(topic, prompt);
    } catch (err: any) {
      Logger.warning(`工具确认请求发送失败: ${err?.message || err}`);
      return { approved: false, reason: '无法发送工具确认请求，已取消本次操作。' };
    }

    const answer = await new Promise<string>((resolve) => {
      this.registerPendingAnswer(sessionKey, topic, senderId, resolve);
    });
    const decision = this.parseToolConfirmationAnswer(answer);
    if (decision === 'approve') return true;
    if (decision === 'deny') {
      return { approved: false, reason: '用户未确认该工具操作，已取消。' };
    }
    return { approved: false, reason: '未收到明确确认，已取消该工具操作。' };
  }

  private formatToolConfirmationPrompt(request: ToolExecutionConfirmationRequest): string {
    const riskLabel = request.risk === 'high' ? '高' : request.risk === 'medium' ? '中' : '低';
    const target = this.formatToolConfirmationTarget(request.args);
    return [
      `需要你确认后才能继续执行 ${request.toolName}。`,
      `风险等级：${riskLabel}`,
      target ? `操作对象：${target}` : '',
      request.reason,
      '请只回复“同意”或“确认执行”继续；回复“取消”或“不确认”则不会执行。',
    ].filter(Boolean).join('\n');
  }

  private formatToolConfirmationTarget(args: unknown): string {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
    const record = args as Record<string, unknown>;
    const preferredKeys = ['file_path', 'path', 'target', 'command', 'pattern', 'description'];
    for (const key of preferredKeys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return `${key}=${this.truncateConfirmationValue(value.trim())}`;
      }
    }
    try {
      return this.truncateConfirmationValue(JSON.stringify(record));
    } catch {
      return '';
    }
  }

  private truncateConfirmationValue(value: string): string {
    return value.length <= 160 ? value : `${value.slice(0, 157)}...`;
  }

  private parseToolConfirmationAnswer(answer: string): 'approve' | 'deny' | 'unknown' {
    const text = String(answer || '').trim().toLowerCase().replace(/[。.!！\s]+$/g, '');
    if (!text || text.includes('未在120秒内回复')) return 'unknown';
    if (/^(取消|不同意|拒绝|不要|不行|否|no|n|cancel|deny|denied)$/i.test(text)
      || /不\s*确认/.test(text)
      || /不是\s*确认/.test(text)
      || /别\s*执行/.test(text)
      || /不要\s*执行/.test(text)
      || text.includes('取消')
      || text.includes('不同意')
      || text.includes('拒绝')) {
      return 'deny';
    }
    if (/^(同意|确认|确认执行|可以|可以继续|继续|继续执行|执行|yes|y|ok|approve|approved)$/i.test(text)) {
      return 'approve';
    }
    return 'unknown';
  }

  private registerPendingAnswer(
    sessionKey: string,
    topic: string,
    expectedSenderId: string,
    resolve: (text: string) => void,
  ): void {
    const existingId = this.pendingAnswerBySession.get(sessionKey);
    if (existingId) {
      const existing = this.pendingAnswers.get(existingId);
      this.clearPendingAnswerById(existingId);
      existing?.resolve('（提问已更新，请回答最新问题）');
    }

    const id = randomUUID();
    const timeoutHandle = setTimeout(() => {
      const pending = this.pendingAnswers.get(id);
      if (!pending) return;
      this.clearPendingAnswerById(id);
      pending.resolve('（用户未在120秒内回复）');
    }, PENDING_ANSWER_TIMEOUT_MS);

    this.pendingAnswers.set(id, {
      id,
      sessionKey,
      topic,
      expectedSenderId,
      resolve,
      timeoutHandle,
    });
    this.pendingAnswerBySession.set(sessionKey, id);
  }

  private clearPendingAnswerBySession(sessionKey: string): void {
    const pendingId = this.pendingAnswerBySession.get(sessionKey);
    if (!pendingId) return;
    this.clearPendingAnswerById(pendingId);
  }

  private clearPendingAnswerById(pendingId: string): void {
    const pending = this.pendingAnswers.get(pendingId);
    if (!pending) return;

    clearTimeout(pending.timeoutHandle);
    this.pendingAnswers.delete(pendingId);

    const mappedId = this.pendingAnswerBySession.get(pending.sessionKey);
    if (mappedId === pendingId) {
      this.pendingAnswerBySession.delete(pending.sessionKey);
    }
  }
}
