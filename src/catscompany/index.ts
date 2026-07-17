import {
  CatsClient,
  MessageContext,
  type CatsAgentContextMessage,
  type CatsDeviceRpcMessage,
  type CatsThinToolRpcMessage,
} from './client';
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
import { shouldSuppressSubAgentObservationReply } from '../core/sub-agent-observation';
import type { SubAgentInfo } from '../core/sub-agent-session';
import { ChannelCallbacks, DeviceRpcTransport, TargetRoutes, ThinToolRpcTransport, ToolErrorCode, ToolExecutionConfirmationRequest, ToolExecutionConfirmationResult, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { ContentBlock } from '../types';
import type { PendingUserInput } from '../core/conversation-runner';
import type { StreamRetryInfo } from '../providers/provider';
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
import { uploadImportFileSource } from '../tools/import-file-tool';
import { resolveCommonDirectoryToolArgs } from '../tools/common-directory-tool';
import { inferCatsUploadType } from './upload';
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
import {
  configureExternalHistoryProviders,
  getExternalHistoryControlStatus,
  runExternalHistoryBackfillControl,
} from '../commands/external-source';
import {
  activateExternalHistoryRuntimeConfiguration,
  getActiveRuntimeLearning,
} from '../utils/runtime-command-support';
import { isXurlOutputLimitError } from '../utils/xurl-session-log-source';
import type { ExternalHistoryProgressUpdate } from '../utils/session-log-backfill';
import {
  buildCatsCoAttachmentCachePath,
  scheduleCatsCoAttachmentCacheCleanup,
} from './attachment-cache';
import {
  agentContextMessageSeq,
  isNativeFeishuGroupTrigger,
  isNativeFeishuClearBoundary,
  selectNativeFeishuGroupContext,
} from './agent-context-history';
import {
  CatsCompanyCloudSessionRestorer,
  type CloudSessionRestoreResult,
} from './cloud-session-restore';

interface PendingAttachment {
  fileName: string;
  localPath: string;
  type: 'file' | 'image';
  receivedAt: number;
  localFileGrant?: ScopedLocalFileGrant;
}

type NativeFeishuGroupTriggerMessage = Pick<ParsedCatsMessage, 'topic' | 'chatType' | 'seq' | 'metadata'>;

interface NativeFeishuContextHydration {
  message: NativeFeishuGroupTriggerMessage;
  cloudRestoreStatus?: CloudSessionRestoreResult['status'];
  clearGeneration: number;
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
  nativeFeishuContext?: NativeFeishuContextHydration;
  attempts?: number;
  deliveryOnly?: boolean;
  deliveryAttempts?: number;
}

interface SubAgentEventRoute {
  topic: string;
  channelSource?: string;
}

interface BackgroundSubAgentCompletionItem {
  id?: string;
  displayName: string;
  statusLabel: string;
  task: string;
  summary: string;
  outputFiles: string[];
  observation: string;
}

interface BackgroundSubAgentCompletionBatch {
  topic: string;
  senderId: string;
  channelSource?: string;
  executionScope?: ParsedCatsMessage['executionScope'];
  firstAt: number;
  clearGeneration: number;
  items: Map<string, BackgroundSubAgentCompletionItem>;
  timer?: ReturnType<typeof setTimeout>;
}

const TYPING_HEARTBEAT_INTERVAL_MS = 5_000;
const BACKGROUND_SUBAGENT_COMPLETION_DEBOUNCE_MS = 1_500;
const BACKGROUND_SUBAGENT_COMPLETION_MAX_DELAY_MS = 15_000;
const SUBAGENT_FALLBACK_MAX_DELIVERY_ATTEMPTS = 3;
const NATIVE_FEISHU_CONTEXT_PAGE_SIZE = 100;
const NATIVE_FEISHU_CONTEXT_MAX_PAGES = 10;
const BACKGROUND_SUBAGENT_COMPLETION_MAX_ITEMS = 6;
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
  'external_history',
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
  const prefix = `[发言人: ${name}]\n`;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isCatsCoAttachmentSummaryText(text: string, files: CatsFileInfo[]): boolean {
  const trimmed = String(text || '').trim();
  if (!trimmed || files.length === 0) return false;

  let remainder = trimmed.replace(/\[(?:附件|图片|文件)\]/g, '');
  for (const file of files) {
    const fileName = String(file.fileName || '').trim();
    if (!fileName) continue;
    remainder = remainder.replace(new RegExp(escapeRegExp(fileName), 'g'), '');
  }

  return remainder.replace(/[\s,，、;；\r\n]+/g, '').length === 0;
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

function formatModelRetryThinking(attempt: number, maxRetries: number, info?: StreamRetryInfo): string {
  const retryIn = info && info.delayMs >= 1000
    ? `，约 ${Math.ceil(info.delayMs / 1000)} 秒后继续`
    : '';
  const status = info?.status && info.status !== 'unknown'
    ? `（${info.status}）`
    : '';
  return `模型连接异常${status}，正在重试 ${attempt}/${maxRetries}${retryIn}...`;
}

function isActiveSubAgentStatusForUi(status?: SubAgentInfo['status']): boolean {
  return status === 'running' || status === 'waiting_for_input';
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

function isClearCommand(text: string): boolean {
  return /^\/clear(?:\s|$)/i.test(String(text || ''));
}

function compactCatsSubAgentSummary(text: string, maxLength = 4000): string {
  const normalized = text.replace(/\s+\n/g, '\n').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}\n\n[内容较长，已截断；完整内容请查看本地日志]`;
}

function normalizeCatsUid(value: unknown): string {
  const raw = String(value ?? '').trim();
  const numeric = raw.match(/^(?:usr)?(\d+)$/i);
  return numeric ? `usr${numeric[1]}` : raw;
}

function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const onAbort = (signal: AbortSignal) => {
    for (const candidate of signals) {
      const listener = listeners.get(candidate);
      if (listener) candidate.removeEventListener('abort', listener);
    }
    controller.abort(signal.reason);
  };

  for (const signal of signals) {
    if (signal.aborted) {
      for (const [candidate, listener] of listeners) {
        candidate.removeEventListener('abort', listener);
      }
      controller.abort(signal.reason);
      return controller.signal;
    }
    const listener = () => onAbort(signal);
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
  }
  return controller.signal;
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
  private cloudSessionRestorer: CatsCompanyCloudSessionRestorer;
  private cloudSessionRestorePromises = new Map<string, Promise<CloudSessionRestoreResult>>();
  /** 等待用户后续指令的附件队列，key 为 sessionKey */
  private pendingAttachments = new Map<string, PendingAttachment[]>();
  /** 主会话忙时的消息队列，key = sessionKey */
  private messageQueue = new Map<string, QueuedMessage[]>();
  /** Serializes history hydration and all model turns for one CatsCo session. */
  private sessionExecutionReservations = new Set<string>();
  /** Invalidates queued or in-flight pre-turn hydration after /clear. */
  private sessionClearGenerations = new Map<string, number>();
  /** Lets /clear cancel an initial cloud restore before it can recreate old history. */
  private cloudSessionRestoreAbortControllers = new Map<string, AbortController>();
  /** 子 Agent 事件应沿用 spawn 时的通道能力，不能被同 session 后续消息覆盖 */
  private subAgentEventRoutes = new Map<string, SubAgentEventRoute>();
  /** no-wait 子 Agent 完成后的批量回流，避免逐条唤醒主模型刷屏 */
  private subAgentCompletionBatches = new Map<string, BackgroundSubAgentCompletionBatch>();
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
    this.cloudSessionRestorer = new CatsCompanyCloudSessionRestorer(this.bot, this.agentServices.aiService);
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
    scheduleCatsCoAttachmentCacheCleanup();
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
        return normalizeDeviceRpcToolResultPayload(response.result, { toolName });
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
      case 'import_file':
        result = await this.executeRemoteImportFileUpload(args, context);
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

    const externalHistoryRequest = request.operation === 'external_history';
    const validationError = externalHistoryRequest
      ? this.validateExternalHistoryRequest(request)
      : this.validateDeviceRpcToolRequest(request);
    let result: ToolExecutionResult | undefined;
    if (!validationError) {
      try {
        result = externalHistoryRequest
          ? await this.executeExternalHistoryControl(request)
          : await this.executeLocalDeviceRpcTool(request);
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
          ...(result.ok === false && result.details ? { details: result.details } : {}),
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
        result: error || !result ? undefined : normalizeDeviceRpcToolResultForTransport(result, { toolName: request.tool_name }),
        error,
      });
    } catch (err: any) {
      Logger.warning(`[CatsCompany] Device RPC result 发送失败: request=${requestID}, error=${err?.message || err}`);
    }
  }

  private validateExternalHistoryRequest(request: CatsDeviceRpcMessage): { code: string; message: string } | undefined {
    const targetError = this.validateDeviceRpcTarget(request);
    if (targetError) return targetError;
    if (!String(request.device_id || '').trim()) {
      return { code: 'invalid_request', message: 'External history request missing device_id.' };
    }
    if (typeof request.expires_at === 'number' && Date.now() > request.expires_at) {
      return { code: 'request_expired', message: 'External history request has expired.' };
    }
    const payload = request.payload;
    const action = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? String((payload as Record<string, unknown>).action || '').trim()
      : '';
    if (!['status', 'configure', 'preview', 'execute'].includes(action)) {
      return { code: 'unsupported_operation', message: 'Unsupported external history action.' };
    }
    return undefined;
  }

  private async executeExternalHistoryControl(request: CatsDeviceRpcMessage): Promise<ToolExecutionResult> {
    const payload = request.payload as Record<string, unknown>;
    const action = String(payload.action || '').trim();
    const workingDirectory = this.runtimeProfile?.workingDirectory || this.runtime?.profile?.workingDirectory || process.cwd();
    let response: Record<string, unknown>;

    if (action === 'status') {
      response = {
        ...getExternalHistoryControlStatus(workingDirectory),
        runtimeOwnerReady: Boolean(getActiveRuntimeLearning()),
      };
    } else if (action === 'configure') {
      const providers = Array.isArray(payload.providers)
        ? payload.providers.map(provider => String(provider))
        : [];
      const configured = configureExternalHistoryProviders(providers, workingDirectory);
      const activation = activateExternalHistoryRuntimeConfiguration(workingDirectory);
      response = {
        ...configured,
        ...activation,
        restartRequired: !activation.appliedImmediately,
      };
    } else {
      const provider = String(payload.provider || '').trim().toLowerCase();
      const updatedSince = String(payload.updatedSince || '').trim();
      if (provider !== 'codex' && provider !== 'pi') {
        return { ok: false, errorCode: 'INVALID_ARGUMENT', message: 'Provider must be codex or pi.' };
      }
      if (!updatedSince) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT', message: 'History range is required.' };
      }
      const execute = action === 'execute';
      const runtimeLearning = execute ? getActiveRuntimeLearning() : undefined;
      if (execute && !runtimeLearning) {
        return {
          ok: false,
          errorCode: 'RUNTIME_NOT_READY',
          message: 'The local Runtime owner is not ready. Restart the local assistant and try again.',
          retryable: true,
        };
      }
      const recovery = execute
        ? runtimeLearning!.retryExternalProviderRecovery(provider)
        : undefined;
      const requestID = request.request_id;
      const sendProgress = async (progress: ExternalHistoryProgressUpdate): Promise<void> => {
        if (!requestID || !this.bot) return;
        try {
          await this.bot.sendDeviceRpcProgress({
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
            progress: {
              processed: progress.processed,
              total: progress.total,
              completed: progress.completed,
              failed: progress.failed,
              skipped: progress.skipped,
              remaining: progress.remaining,
              provider: progress.provider || provider,
              phase: progress.phase,
            },
          });
        } catch (err: any) {
          Logger.warning(`[CatsCompany] Device RPC progress 发送失败: request=${requestID}, error=${err?.message || err}`);
        }
      };
      try {
        response = {
          ...await runExternalHistoryBackfillControl({
            provider,
            updatedSince,
            execute,
            operationId: typeof payload.operationId === 'string' ? payload.operationId : undefined,
            preferExistingOperation: !execute,
            workingDirectory,
            runtimeLearning: runtimeLearning ?? undefined,
            onProgress: execute ? sendProgress : undefined,
          }),
          ...(recovery && (
            recovery.quarantinesRetried > 0
            || recovery.sourceFailuresRetried > 0
          ) ? { recovery } : {}),
        };
      } catch (error: any) {
        // Structured oversized-record error: propagate stable Device RPC code
        // with provider, limitBytes, and resumable — never as a 55s timeout.
        if (isXurlOutputLimitError(error)) {
          return {
            ok: false,
            errorCode: 'external_history_record_too_large',
            message: `历史记录超过安全限制 (${error.commandKind} ${error.limitBytes} bytes)，已保留当前进度，可以继续导入剩余历史。`,
            retryable: true,
            details: {
              provider,
              limitBytes: error.limitBytes,
              commandKind: error.commandKind,
              resumable: true,
            },
          };
        }
        throw error;
      }
    }

    return { ok: true, content: JSON.stringify(response) };
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
      case 'send_file':
        result = await this.executeRemoteImportFileUpload(args, context);
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

  private async executeRemoteImportFileUpload(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    return uploadImportFileSource(args, context, async (filePath, fileName) => {
      const type = inferCatsUploadType(fileName);
      const upload = await this.bot.uploadFile(filePath, type);
      return {
        url: upload.url,
        name: fileName,
        size: upload.size,
        type,
      };
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
      return { code: 'unsupported_operation', message: 'Device RPC only allows read_file, resolve_common_directory, glob, grep, write_file, edit_file, import_file, and execute_shell.' };
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
      receiveUploadedFile: async (file) => {
        if (!file.url.startsWith('/uploads/')) {
          throw new Error(`远程文件上传结果不是受信任的 CatsCo 上传地址: ${file.name}`);
        }
        const targetPath = buildCatsCoAttachmentCachePath(opts?.sessionKey, file.name);
        const localPath = await this.sender.downloadFile(file.url, file.name, { targetPath });
        if (!localPath) {
          throw new Error(`无法把上传文件保存到当前运行体: ${file.name}`);
        }
        scheduleCatsCoAttachmentCacheCleanup();
        return localPath;
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
      onRetry: async (attempt, maxRetries, info) => {
        if (suppressToolProgress) {
          return;
        }
        try {
          await this.sender.sendThinking(topic, formatModelRetryThinking(attempt, maxRetries, info), {
            model_retry: true,
            attempt,
            max_retries: maxRetries,
            delay_ms: info?.delayMs,
            status: info?.status,
          });
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
        await this.handleSubAgentRuntimeEvent(topic, event, info, executionScope?.channelSource, sessionKey);
      },
    } as any);
  }

  private async processParsedMessage(msg: ParsedCatsMessage, key: string): Promise<void> {
    const entryClearGeneration = this.getSessionClearGeneration(key);
    const nativeFeishuTrigger = isNativeFeishuGroupTrigger(msg);
    const sessionRoute = msg.envelope ? createCatsCoSessionRoute(msg.envelope) : undefined;
    let cloudRestoreResult: CloudSessionRestoreResult | undefined;
    if (sessionRoute && !isClearCommand(msg.text)) {
      cloudRestoreResult = await this.ensureCloudSessionRestored(msg, sessionRoute);
      if (entryClearGeneration !== this.getSessionClearGeneration(key)) return;
      if (cloudRestoreResult.status === 'failed' || cloudRestoreResult.status === 'skipped') {
        await this.sender.reply(
          msg.topic,
          '这台设备暂时没能恢复这段会话，我没有新建空白上下文。请稍后再发一次。',
        ).catch((error: any) => {
          Logger.warning(`云端会话恢复失败提示发送失败: ${error?.message || error}`);
        });
        return;
      }
    }
    const session = this.sessionManager.getOrCreate(sessionRoute && sessionRoute.sessionKey === key ? sessionRoute : key);

    // 处理斜杠命令
    if (typeof msg.text === 'string' && msg.text.startsWith('/')) {
      const parts = msg.text.slice(1).split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);
      const isClear = command.toLowerCase() === 'clear';

      if (isClear) {
        this.pendingAttachments.delete(key);
        this.messageQueue.delete(key);
        this.bumpSessionClearGeneration(key);
        const completionBatch = this.subAgentCompletionBatches.get(key);
        if (completionBatch?.timer) clearTimeout(completionBatch.timer);
        this.subAgentCompletionBatches.delete(key);
        this.cloudSessionRestoreAbortControllers?.get(key)?.abort();
        this.cloudSessionRestorePromises.delete(key);
        session.requestInterrupt?.();
      }

      const result = await session.handleCommand(command, args);
      if (result.handled && isClear && !args.includes('--all')) {
        this.cloudSessionRestorer.markLocalSessionCleared(sessionRoute?.sessionKey || key);
      }
      if (result.handled && result.reply) {
        try {
          await this.sender.reply(msg.topic, result.reply);
        } catch (err: any) {
          Logger.warning(`命令回复发送失败: ${err.message}`);
        }
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
        const targetPath = buildCatsCoAttachmentCachePath(key, file.fileName);
        const localPath = await this.sender.downloadFile(file.url, file.fileName, { targetPath });
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
        scheduleCatsCoAttachmentCacheCleanup();
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
    if (entryClearGeneration !== this.getSessionClearGeneration(key)) return;
    userMessage = prefixCatsUserMessage(speakerNameFromMetadata(msg), userMessage);
    const nativeFeishuContext: NativeFeishuContextHydration | undefined = nativeFeishuTrigger
      ? {
        message: {
          topic: msg.topic,
          chatType: msg.chatType,
          seq: msg.seq,
          metadata: msg.metadata,
        },
        cloudRestoreStatus: cloudRestoreResult?.status,
        clearGeneration: entryClearGeneration,
      }
      : undefined;

    if (!this.tryReserveSessionExecution(key, session)) {
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
        nativeFeishuContext,
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
      let shouldProcess = true;
      if (nativeFeishuContext) {
        shouldProcess = await this.hydrateNativeFeishuGroupContext(
          session,
          nativeFeishuContext,
          key,
        );
      }
      if (shouldProcess) {
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
      }
    } finally {
      this.releaseSessionExecution(key);
      stopTypingHeartbeat();
    }

    // 处理忙时排队的消息
    await this.drainMessageQueue(key);
  }

  private async hydrateNativeFeishuGroupContext(
    session: {
      injectContext(text: string): void;
      getRemoteContextCursor(source: string): number;
      saveRemoteContextCursor(source: string, cursor: number): void;
    },
    hydration: NativeFeishuContextHydration,
    sessionKey: string,
  ): Promise<boolean> {
    const { message: msg, cloudRestoreStatus, clearGeneration } = hydration;
    if (!isNativeFeishuGroupTrigger(msg)) return true;
    if (clearGeneration !== this.getSessionClearGeneration(sessionKey)) return false;
    const cursorKey = 'catscompany.agent_context';
    if (cloudRestoreStatus === 'restored' || cloudRestoreStatus === 'empty') {
      if (clearGeneration !== this.getSessionClearGeneration(sessionKey)) return false;
      session.saveRemoteContextCursor(
        cursorKey,
        Math.max(session.getRemoteContextCursor(cursorKey), msg.seq),
      );
      return true;
    }
    try {
      const previousCursor = session.getRemoteContextCursor(cursorKey);
      const history = await this.fetchNativeFeishuGroupContextHistory(msg.topic, msg.seq, previousCursor);
      if (clearGeneration !== this.getSessionClearGeneration(sessionKey)) return false;
      const contextMessages = selectNativeFeishuGroupContext(history, previousCursor);
      for (const message of contextMessages) {
        session.injectContext(message);
      }
      session.saveRemoteContextCursor(cursorKey, Math.max(previousCursor, msg.seq));
      if (contextMessages.length > 0) {
        Logger.info(`[${sessionKey}] 已补入 ${contextMessages.length} 条飞书群普通消息上下文`);
      }
      return true;
    } catch (err: any) {
      Logger.warning(`[${sessionKey}] 飞书群历史上下文恢复失败，继续处理当前消息: ${err?.message || err}`);
      return clearGeneration === this.getSessionClearGeneration(sessionKey);
    }
  }

  private async fetchNativeFeishuGroupContextHistory(
    topic: string,
    beforeId: number,
    afterSeq: number,
  ): Promise<CatsAgentContextMessage[]> {
    const messagesBySeq = new Map<number, CatsAgentContextMessage>();
    let pageBeforeId = beforeId;
    const signal = AbortSignal.timeout(10_000);

    for (let pageIndex = 0; pageIndex < NATIVE_FEISHU_CONTEXT_MAX_PAGES; pageIndex++) {
      const page = await this.bot.getAgentContextHistory(topic, {
        beforeId: pageBeforeId,
        limit: NATIVE_FEISHU_CONTEXT_PAGE_SIZE,
        signal,
      });
      if (page.topic_id !== topic) {
        throw new Error(`agent context topic mismatch: ${page.topic_id}`);
      }
      if (normalizeCatsUid(page.agent_uid) !== normalizeCatsUid(this.botUid)) {
        throw new Error(`agent context identity mismatch: ${page.agent_uid}`);
      }
      for (const message of page.messages || []) {
        const seq = agentContextMessageSeq(message);
        if (seq > 0 && !messagesBySeq.has(seq)) messagesBySeq.set(seq, message);
      }

      const pageMessages = page.messages || [];
      const reachedPreviousCursor = afterSeq > 0
        && pageMessages.some(message => agentContextMessageSeq(message) <= afterSeq);
      const reachedClearBoundary = pageMessages.some(isNativeFeishuClearBoundary);
      if (
        reachedPreviousCursor
        || reachedClearBoundary
        || !page.has_more
        || page.next_before_id <= 0
      ) {
        return [...messagesBySeq.values()]
          .sort((left, right) => agentContextMessageSeq(left) - agentContextMessageSeq(right));
      }
      if (page.next_before_id >= pageBeforeId) {
        throw new Error(`agent context pagination did not advance: ${page.next_before_id}`);
      }
      pageBeforeId = page.next_before_id;
    }

    Logger.warning(
      `[${topic}] 飞书群历史超过 ${NATIVE_FEISHU_CONTEXT_MAX_PAGES * NATIVE_FEISHU_CONTEXT_PAGE_SIZE} 条，`
      + '仅补入最近一段并推进游标',
    );
    return [...messagesBySeq.values()]
      .sort((left, right) => agentContextMessageSeq(left) - agentContextMessageSeq(right));
  }

  private tryReserveSessionExecution(
    sessionKey: string,
    session: { isBusy?: () => boolean },
  ): boolean {
    const reservations = this.sessionExecutionReservations ??= new Set<string>();
    if (reservations.has(sessionKey) || session.isBusy?.()) return false;
    reservations.add(sessionKey);
    return true;
  }

  private releaseSessionExecution(sessionKey: string): void {
    this.sessionExecutionReservations?.delete(sessionKey);
  }

  private getSessionClearGeneration(sessionKey: string): number {
    return this.sessionClearGenerations?.get(sessionKey) ?? 0;
  }

  private bumpSessionClearGeneration(sessionKey: string): void {
    const generations = this.sessionClearGenerations ??= new Map<string, number>();
    generations.set(sessionKey, this.getSessionClearGeneration(sessionKey) + 1);
  }

  private async ensureCloudSessionRestored(
    msg: ParsedCatsMessage,
    sessionRoute: ReturnType<typeof createCatsCoSessionRoute>,
  ): Promise<CloudSessionRestoreResult> {
    if (this.sessionManager.get(sessionRoute)) {
      return {
        status: 'local_present',
        restoredMessages: 0,
        fetchedMessages: 0,
        compressed: false,
      };
    }
    if (sessionRoute.topicType !== 'p2p' && sessionRoute.topicType !== 'group') {
      return {
        status: 'skipped',
        restoredMessages: 0,
        fetchedMessages: 0,
        compressed: false,
      };
    }

    const key = sessionRoute.sessionKey;
    const existing = this.cloudSessionRestorePromises.get(key);
    if (existing) {
      const result = await existing;
      if (result.status === 'restored' || result.status === 'empty' || result.status === 'local_present') {
        return {
          status: 'local_present',
          restoredMessages: 0,
          fetchedMessages: 0,
          compressed: false,
        };
      }
      return result;
    }

    const abortController = new AbortController();
    (this.cloudSessionRestoreAbortControllers ??= new Map()).set(key, abortController);
    const restore = this.restoreCloudSessionWithStatus(msg, sessionRoute, abortController.signal)
      .finally(() => {
        if (this.cloudSessionRestorePromises.get(key) === restore) {
          this.cloudSessionRestorePromises.delete(key);
        }
        if (this.cloudSessionRestoreAbortControllers?.get(key) === abortController) {
          this.cloudSessionRestoreAbortControllers.delete(key);
        }
      });
    this.cloudSessionRestorePromises.set(key, restore);
    return restore;
  }

  private async restoreCloudSessionWithStatus(
    msg: ParsedCatsMessage,
    sessionRoute: ReturnType<typeof createCatsCoSessionRoute>,
    clearSignal?: AbortSignal,
  ): Promise<CloudSessionRestoreResult> {
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      statusTimer = setTimeout(() => {
        void this.sender.sendThinking(msg.topic, '正在恢复并整理这段对话的云端上下文...').catch((error: any) => {
          Logger.warning(`云端会话恢复提示发送失败: ${error?.message || error}`);
        });
      }, 800);

      const timeoutSignal = AbortSignal.timeout(30_000);
      const signal = clearSignal
        ? combineAbortSignals([clearSignal, timeoutSignal])
        : timeoutSignal;
      return await this.cloudSessionRestorer.restoreIfMissing({
        sessionKey: sessionRoute.sessionKey,
        topicId: sessionRoute.topicId,
        topicType: sessionRoute.topicType === 'group' ? 'group' : 'p2p',
        agentId: sessionRoute.agentId || this.botUid || '',
        currentSeq: Number(msg.seq || sessionRoute.channelSeq || 0),
        signal,
      });
    } finally {
      if (statusTimer) clearTimeout(statusTimer);
    }
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
    const userText = isCatsCoAttachmentSummaryText(mergedText, files) ? '' : mergedText;
    if (!userText && files.length === 0) return null;
    const messageText = userText;
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
    const subAgentManager = SubAgentManager.getInstance();
    const resultObservationHandling = subAgentManager.getResultObservationHandlingForParent(sessionKey, text);
    if (resultObservationHandling === 'drop') {
      Logger.info(`[${sessionKey}] 子智能体完成 observation 已由 wait_subagents 消费，跳过回流处理`);
      return;
    }

    const session = this.sessionManager.getOrCreate(sessionKey);

    this.registerSubAgentPlatformCallbacks(sessionKey, topic, senderId, executionScope);

    const channel = this.buildChannel(topic, {
      sessionKey,
      senderId,
      channelSource: executionScope?.channelSource,
    });

    const suppressFinalResponse = resultObservationHandling !== 'notify'
      && shouldSuppressSubAgentObservationReply(text);
    if (suppressFinalResponse) {
      this.scheduleSubAgentCompletionBatch(sessionKey, topic, senderId, text, executionScope);
      await this.drainMessageQueue(sessionKey);
      return;
    }

    if (!this.tryReserveSessionExecution(sessionKey, session)) {
      this.enqueueSubAgentFeedback(sessionKey, topic, senderId, text, executionScope);
      Logger.info(`[${sessionKey}] 主会话忙，子智能体反馈已入队`);
      return;
    }

    const stopTypingHeartbeat = suppressFinalResponse ? () => undefined : this.startTypingHeartbeat(topic);
    let typingHeartbeatStopped = false;
    const stopTypingHeartbeatOnce = () => {
      if (typingHeartbeatStopped) return;
      typingHeartbeatStopped = true;
      stopTypingHeartbeat();
    };

    try {
      const result = await session.handleRuntimeObservation(text, {
        channel,
        callbacks: suppressFinalResponse ? undefined : this.buildSessionCallbacks(topic, {
          sessionKey,
          senderId,
          channelSource: executionScope?.channelSource,
        }),
        source: 'subagent_result',
        suppressFinalResponse,
        executionScope,
        localDeviceGrant: this.localDeviceGrant,
        deviceRpc: this.buildDeviceRpcTransport(),
        thinToolRpc: this.maybeBuildThinToolRpcTransport(),
      });
      if (result.text === BUSY_MESSAGE) {
        this.enqueueSubAgentFeedback(sessionKey, topic, senderId, text, executionScope);
        Logger.info(`[${sessionKey}] 主会话竞态忙碌，子智能体反馈已入队`);
      } else {
        subAgentManager.markResultObservationHandledForParent(sessionKey, text);
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
      }
    } catch (err: any) {
      this.enqueueSubAgentFeedback(sessionKey, topic, senderId, text, executionScope, 1);
      Logger.warning(`[${sessionKey}] 子智能体反馈执行异常，已入队重试: ${err?.message || err}`);
    } finally {
      this.releaseSessionExecution(sessionKey);
      stopTypingHeartbeatOnce();
    }

    await this.drainMessageQueue(sessionKey);
  }

  private enqueueSubAgentFeedback(
    sessionKey: string,
    topic: string,
    senderId: string,
    text: string,
    executionScope?: ParsedCatsMessage['executionScope'],
    attempts = 0,
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
      attempts,
    });
    this.messageQueue.set(sessionKey, queue);
  }

  private scheduleSubAgentCompletionBatch(
    sessionKey: string,
    topic: string,
    senderId: string,
    observation: string,
    executionScope?: ParsedCatsMessage['executionScope'],
  ): void {
    const item = this.parseSubAgentCompletionObservation(sessionKey, observation);
    if (!item) return;

    const now = Date.now();
    const clearGeneration = this.getSessionClearGeneration(sessionKey);
    let existing = this.subAgentCompletionBatches.get(sessionKey);
    if (existing && existing.clearGeneration !== clearGeneration) {
      if (existing.timer) clearTimeout(existing.timer);
      this.subAgentCompletionBatches.delete(sessionKey);
      existing = undefined;
    }
    const batch: BackgroundSubAgentCompletionBatch = existing ?? {
      topic,
      senderId,
      channelSource: executionScope?.channelSource,
      executionScope,
      firstAt: now,
      clearGeneration,
      items: new Map(),
    };
    batch.topic = topic;
    batch.senderId = senderId;
    batch.channelSource = executionScope?.channelSource ?? batch.channelSource;
    batch.executionScope = executionScope ?? batch.executionScope;
    batch.items.set(item.id || `${item.displayName}:${item.task}:${batch.items.size}`, item);

    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      void this.flushSubAgentCompletionBatch(sessionKey);
    }, BACKGROUND_SUBAGENT_COMPLETION_DEBOUNCE_MS);
    batch.timer.unref?.();
    this.subAgentCompletionBatches.set(sessionKey, batch);
  }

  private async flushSubAgentCompletionBatch(sessionKey: string, force = false): Promise<void> {
    const batch = this.subAgentCompletionBatches.get(sessionKey);
    if (!batch || batch.items.size === 0) return;
    if (batch.clearGeneration !== this.getSessionClearGeneration(sessionKey)) {
      if (batch.timer) clearTimeout(batch.timer);
      this.subAgentCompletionBatches.delete(sessionKey);
      return;
    }

    const session = this.sessionManager.get?.(sessionKey) || this.sessionManager.getOrCreate(sessionKey);

    const manager = SubAgentManager.getInstance();
    const activeSubAgents = manager
      .listByParent(sessionKey)
      .filter(info => isActiveSubAgentStatusForUi(info.status));
    const elapsed = Date.now() - batch.firstAt;
    if (!force && activeSubAgents.length > 0 && elapsed < BACKGROUND_SUBAGENT_COMPLETION_MAX_DELAY_MS) {
      this.rescheduleSubAgentCompletionBatch(sessionKey, batch);
      return;
    }

    if (!this.tryReserveSessionExecution(sessionKey, session)) {
      this.rescheduleSubAgentCompletionBatch(sessionKey, batch);
      return;
    }

    const items = [...batch.items.values()];
    let stopTypingHeartbeat: () => void = () => undefined;

    try {
      this.subAgentCompletionBatches.delete(sessionKey);
      if (batch.timer) clearTimeout(batch.timer);

      const observation = this.formatSubAgentCompletionBatchObservation(items, activeSubAgents.length);
      if (!observation) return;

      this.registerSubAgentPlatformCallbacks(sessionKey, batch.topic, batch.senderId, batch.executionScope);
      const channel = this.buildChannel(batch.topic, {
        sessionKey,
        senderId: batch.senderId,
        channelSource: batch.channelSource,
      });
      stopTypingHeartbeat = this.startTypingHeartbeat(batch.topic);

      const result = await session.handleRuntimeObservation(observation, {
        channel,
        callbacks: this.buildSessionCallbacks(batch.topic, {
          sessionKey,
          senderId: batch.senderId,
          channelSource: batch.channelSource,
        }),
        source: 'subagent_result_batch',
        suppressFinalResponse: false,
        executionScope: batch.executionScope,
        localDeviceGrant: this.localDeviceGrant,
        deviceRpc: this.buildDeviceRpcTransport(),
        thinToolRpc: this.maybeBuildThinToolRpcTransport(),
      });
      if (result.text === BUSY_MESSAGE) {
        this.subAgentCompletionBatches.set(sessionKey, batch);
        this.rescheduleSubAgentCompletionBatch(sessionKey, batch);
        return;
      }
      if (batch.clearGeneration !== this.getSessionClearGeneration(sessionKey)) return;

      for (const item of items) {
        manager.markResultObservationHandledForParent(sessionKey, item.observation);
      }

      if (result.text.startsWith('处理消息时出错:')) {
        await this.sender.reply(batch.topic, result.text);
      } else if (result.visibleToUser && result.text) {
        await this.sender.reply(batch.topic, result.text);
      }
    } catch (err: any) {
      Logger.warning(`后台子任务批量回流失败: ${err.message}`);
      if (batch.clearGeneration !== this.getSessionClearGeneration(sessionKey)) return;
      const fallback = this.formatSubAgentCompletionNotice(items, activeSubAgents.length);
      let fallbackDelivered = false;
      if (fallback) {
        try {
          await this.sender.reply(batch.topic, fallback);
          for (const item of items) {
            manager.markResultObservationHandledForParent(sessionKey, item.observation);
          }
          fallbackDelivered = true;
        } catch (sendErr: any) {
          Logger.warning(`后台子任务兜底通知发送失败: ${sendErr.message}`);
        }
      }
      if (!fallbackDelivered && batch.clearGeneration === this.getSessionClearGeneration(sessionKey)) {
        const pendingBatch = this.subAgentCompletionBatches.get(sessionKey);
        if (pendingBatch && pendingBatch !== batch) {
          for (const [itemKey, item] of batch.items) pendingBatch.items.set(itemKey, item);
          pendingBatch.firstAt = Math.min(pendingBatch.firstAt, batch.firstAt);
          this.rescheduleSubAgentCompletionBatch(sessionKey, pendingBatch);
        } else {
          this.subAgentCompletionBatches.set(sessionKey, batch);
          this.rescheduleSubAgentCompletionBatch(sessionKey, batch);
        }
      }
    } finally {
      this.releaseSessionExecution(sessionKey);
      stopTypingHeartbeat();
    }

    await this.drainMessageQueue(sessionKey);
  }

  private rescheduleSubAgentCompletionBatch(
    sessionKey: string,
    batch: BackgroundSubAgentCompletionBatch,
  ): void {
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      void this.flushSubAgentCompletionBatch(sessionKey);
    }, BACKGROUND_SUBAGENT_COMPLETION_DEBOUNCE_MS);
    batch.timer.unref?.();
  }

  private parseSubAgentCompletionObservation(
    sessionKey: string,
    observation: string,
  ): BackgroundSubAgentCompletionItem | null {
    const text = String(observation || '').trim();
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const headingMatch = firstLine.match(/^\[([^\]]+?)\s+(已完成|失败|已停止)\]/)
      || firstLine.match(/^\[(子智能体(?:已)?(?:完成|失败|停止))\]/);
    if (!headingMatch) return null;

    const id = text.match(/\bID[：:]\s*(sub-[0-9a-f-]+)/i)?.[1];
    const info = id ? SubAgentManager.getInstance().getInfoForParent(sessionKey, id) : undefined;
    const statusLabel = info?.status
      ? this.subAgentStatusLabel(info.status)
      : (headingMatch[2] || (firstLine.includes('失败') ? '失败' : firstLine.includes('停止') ? '已停止' : '已完成'));

    return {
      id,
      displayName: info?.displayName || (headingMatch[1] || '子任务').trim(),
      statusLabel,
      task: info?.taskDescription || this.extractSubAgentObservationField(text, '任务') || '后台子任务',
      summary: info?.resultSummary || this.extractSubAgentObservationField(text, '结果摘要') || statusLabel,
      outputFiles: info?.outputFiles?.length ? info.outputFiles : this.extractSubAgentOutputFiles(text),
      observation: text,
    };
  }

  private formatSubAgentCompletionBatchObservation(
    items: BackgroundSubAgentCompletionItem[],
    activeCount: number,
  ): string {
    if (items.length === 0) return '';
    const summary = this.formatSubAgentCompletionNotice(items, activeCount);
    const rawResults = items.map((item, index) => [
      `结果 ${index + 1}:`,
      item.observation,
    ].join('\n')).join('\n\n');

    return [
      '[后台子任务批量回流]',
      '这些是后台子 agent 的完成结果。用户没有显式等待这些结果，但可能需要你基于结果做一条简短补充。',
      '请判断是否需要回复用户：如果结果完成了用户关心的后台事项，简短说明；如果没有新增价值，可以不回复。不要逐条复述内部过程。',
      '',
      '批量摘要：',
      summary,
      '',
      '原始结果：',
      rawResults,
    ].join('\n');
  }

  private formatSubAgentCompletionNotice(
    items: BackgroundSubAgentCompletionItem[],
    activeCount: number,
  ): string {
    if (items.length === 0) return '';
    const groups = this.groupSubAgentCompletionItems(items);
    const completedCount = items.filter(item => item.statusLabel === '已完成').length;
    const failedCount = items.filter(item => item.statusLabel === '失败').length;
    const stoppedCount = items.filter(item => item.statusLabel === '已停止').length;
    const statusBits = [
      completedCount ? `${completedCount} 条已完成` : '',
      failedCount ? `${failedCount} 条失败` : '',
      stoppedCount ? `${stoppedCount} 条已停止` : '',
    ].filter(Boolean).join('，');
    const groupHint = groups.length < items.length
      ? `，涉及 ${groups.length} 个产出/任务`
      : '';
    const header = activeCount > 0
      ? `后台子任务更新：${statusBits || `${items.length} 条结果`}${groupHint}，还有 ${activeCount} 个仍在运行。`
      : `后台子任务已回传：${statusBits || `${items.length} 条结果`}${groupHint}。`;

    const shown = groups.slice(0, BACKGROUND_SUBAGENT_COMPLETION_MAX_ITEMS);
    const lines = shown.map(group => this.formatSubAgentCompletionGroupLine(group));
    if (groups.length > shown.length) {
      lines.push(`- 另外 ${groups.length - shown.length} 组结果也已回传。`);
    }

    return [
      header,
      ...lines,
      '结果已保留；需要我继续检查、合并或调整，直接说就行。',
    ].join('\n');
  }

  private groupSubAgentCompletionItems(
    items: BackgroundSubAgentCompletionItem[],
  ): BackgroundSubAgentCompletionItem[][] {
    const grouped = new Map<string, BackgroundSubAgentCompletionItem[]>();
    for (const item of items) {
      const key = this.subAgentCompletionGroupKey(item);
      const group = grouped.get(key) || [];
      group.push(item);
      grouped.set(key, group);
    }
    return [...grouped.values()];
  }

  private formatSubAgentCompletionGroupLine(items: BackgroundSubAgentCompletionItem[]): string {
    const first = items[0];
    const fileHint = first.outputFiles.length
      ? `；产出 ${first.outputFiles.slice(0, 2).map(file => this.basenameForNotice(file)).join('、')}`
      : '';
    const statusText = this.subAgentCompletionGroupStatusText(items);
    if (items.length === 1) {
      return `- ${first.displayName}：${this.compactNoticeText(first.task, 42)}（${statusText}）${fileHint}`;
    }
    return `- ${this.compactNoticeText(first.task, 42)}（${statusText}，${items.length} 条回传）${fileHint}`;
  }

  private subAgentCompletionGroupStatusText(items: BackgroundSubAgentCompletionItem[]): string {
    const counts = new Map<string, number>();
    for (const item of items) {
      counts.set(item.statusLabel, (counts.get(item.statusLabel) || 0) + 1);
    }
    if (counts.size === 1) return items[0].statusLabel;
    return [...counts.entries()]
      .map(([label, count]) => `${count} 条${label}`)
      .join('，');
  }

  private subAgentCompletionGroupKey(item: BackgroundSubAgentCompletionItem): string {
    const outputKey = item.outputFiles
      .map(file => this.basenameForNotice(file).toLowerCase())
      .filter(Boolean)
      .sort()
      .join('|');
    if (outputKey) return `files:${outputKey}`;

    const taskKey = String(item.task || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    return `task:${taskKey || item.displayName}`;
  }

  private extractSubAgentObservationField(text: string, label: string): string | undefined {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}[：:]\\s*([\\s\\S]*?)(?=\\n(?:ID|任务|结果摘要|说明|产出文件)[：:]|\\n说明：|\\n产出文件：|$)`, 'm');
    const value = text.match(pattern)?.[1]?.trim();
    return value || undefined;
  }

  private extractSubAgentOutputFiles(text: string): string[] {
    const section = text.match(/(?:^|\n)产出文件[：:]\s*\n([\s\S]*)/m)?.[1];
    if (!section) return [];
    return section
      .split(/\r?\n/)
      .map(line => line.match(/^\s*-\s*(.+?)\s*$/)?.[1]?.trim())
      .filter((file): file is string => Boolean(file))
      .slice(0, 6);
  }

  private subAgentStatusLabel(status: SubAgentInfo['status']): string {
    switch (status) {
      case 'completed':
        return '已完成';
      case 'failed':
        return '失败';
      case 'stopped':
        return '已停止';
      case 'waiting_for_input':
        return '等待回复';
      default:
        return '运行中';
    }
  }

  private compactNoticeText(text: string, maxLength: number): string {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}...`;
  }

  private basenameForNotice(filePath: string): string {
    return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || String(filePath || '');
  }

  private async handleSubAgentRuntimeEvent(
    topic: string,
    event: any,
    info?: SubAgentInfo,
    channelSource?: string,
    sessionKey?: string,
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
    const displayName = String(event?.subAgentName || (info as any)?.displayName || subAgentId.slice(0, 12));
    const toolUseId = `subagent:${subAgentId}`;
    const status = info?.status || 'running';
    const isInactiveStatus = !isActiveSubAgentStatusForUi(status);

    if (sessionKey) {
      const manager = SubAgentManager.getInstance();
      const parentSession = this.sessionManager.get?.(sessionKey) || this.sessionManager.getOrCreate(sessionKey);
      const shouldShowTerminalForWait = isTerminalEvent
        && manager.isResultWaitClaimedForParent(sessionKey, subAgentId);
      const shouldSuppressForSession = (parentSession && !parentSession.isBusy())
        || (isTerminalEvent ? !shouldShowTerminalForWait : isInactiveStatus);
      if (shouldSuppressForSession) {
        if (isTerminalEvent || isInactiveStatus) {
          this.subAgentEventRoutes.delete(subAgentId);
        }
        return;
      }
    }

    if (shouldSuppressStructuredToolProgress(eventChannelSource)) {
      if (isTerminalEvent) {
        this.subAgentEventRoutes.delete(subAgentId);
      }
      return;
    }

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

    const msg = queue[0];

    const subAgentManager = SubAgentManager.getInstance();
    const queuedResultObservationHandling = msg.source === 'subagent_feedback'
      ? subAgentManager.getResultObservationHandlingForParent(sessionKey, msg.userMessage as string)
      : 'silent';
    if (queuedResultObservationHandling === 'drop') {
      queue.shift();
      if (queue.length === 0) this.messageQueue.delete(sessionKey);
      Logger.info(`[${sessionKey}] 队列中的子智能体完成 observation 已由 wait_subagents 消费，跳过回流处理`);
      await this.drainMessageQueue(sessionKey);
      return;
    }

    const session = this.sessionManager.getOrCreate(sessionKey);
    const suppressSubAgentFinalResponse = msg.source === 'subagent_feedback'
      && queuedResultObservationHandling !== 'notify'
      && shouldSuppressSubAgentObservationReply(msg.userMessage as string);
    if (suppressSubAgentFinalResponse) {
      queue.shift();
      if (queue.length === 0) this.messageQueue.delete(sessionKey);
      this.scheduleSubAgentCompletionBatch(
        sessionKey,
        msg.topic,
        msg.senderId,
        msg.userMessage as string,
        msg.executionScope,
      );
      await this.drainMessageQueue(sessionKey);
      return;
    }

    if (msg.source === 'subagent_feedback' && msg.deliveryOnly) {
      queue.shift();
      if (queue.length === 0) this.messageQueue.delete(sessionKey);
      const fallback = `后台子任务已完成，但暂时无法写入主会话上下文：\n\n${String(msg.userMessage)}`;
      try {
        await this.sender.reply(msg.topic, fallback);
        subAgentManager.markResultObservationHandledForParent(sessionKey, msg.userMessage as string);
        await this.drainMessageQueue(sessionKey);
      } catch (err: any) {
        const deliveryAttempts = (msg.deliveryAttempts ?? 0) + 1;
        if (deliveryAttempts < SUBAGENT_FALLBACK_MAX_DELIVERY_ATTEMPTS) {
          const pending = this.messageQueue.get(sessionKey) ?? [];
          pending.unshift({ ...msg, deliveryAttempts });
          this.messageQueue.set(sessionKey, pending);
          const retryDelay = BACKGROUND_SUBAGENT_COMPLETION_DEBOUNCE_MS * (2 ** (deliveryAttempts - 1));
          Logger.warning(`[${sessionKey}] 子智能体结果兜底通知发送失败，将在 ${retryDelay}ms 后重试: ${err?.message || err}`);
          const timer = setTimeout(() => void this.drainMessageQueue(sessionKey), retryDelay);
          timer.unref?.();
        } else {
          Logger.error(`[${sessionKey}] 子智能体结果兜底通知连续失败 ${deliveryAttempts} 次，已停止重试: ${err?.message || err}`);
        }
      }
      return;
    }

    if (!this.tryReserveSessionExecution(sessionKey, session)) return;

    queue.shift();
    if (queue.length === 0) this.messageQueue.delete(sessionKey);

    this.registerSubAgentPlatformCallbacks(sessionKey, msg.topic, msg.senderId, msg.executionScope);
    const channel = this.buildChannel(msg.topic, {
      sessionKey,
      senderId: msg.senderId,
      channelSource: msg.executionScope?.channelSource,
    });
    const stopTypingHeartbeat = suppressSubAgentFinalResponse ? () => undefined : this.startTypingHeartbeat(msg.topic);

    let retryLater = false;
    try {
      let shouldProcess = true;
      if (msg.nativeFeishuContext) {
        shouldProcess = await this.hydrateNativeFeishuGroupContext(
          session,
          msg.nativeFeishuContext,
          sessionKey,
        );
      }
      if (shouldProcess) {
        const result = msg.source === 'subagent_feedback'
          ? await session.handleRuntimeObservation(msg.userMessage as string, {
            channel,
            callbacks: suppressSubAgentFinalResponse ? undefined : this.buildSessionCallbacks(msg.topic, {
              sessionKey,
              senderId: msg.senderId,
              channelSource: msg.executionScope?.channelSource,
            }),
            source: 'subagent_result',
            suppressFinalResponse: suppressSubAgentFinalResponse,
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
        if (result.text === BUSY_MESSAGE) {
          const pending = this.messageQueue.get(sessionKey) ?? [];
          pending.unshift(msg);
          this.messageQueue.set(sessionKey, pending);
          retryLater = true;
          Logger.info(`[${sessionKey}] 队列执行遇到竞态忙碌，消息保留等待重试`);
        } else {
          if (result.text.startsWith('处理消息时出错:')) {
            try {
              await this.sender.reply(msg.topic, result.text);
            } catch (err: any) {
              Logger.warning(`错误消息发送失败: ${err.message}`);
            }
          } else if (result.visibleToUser && result.text) {
            try {
              await this.sender.reply(msg.topic, result.text);
            } catch (err: any) {
              Logger.warning(`队列消息回复发送失败: ${err.message}`);
            }
          }
          if (msg.source === 'subagent_feedback') {
            subAgentManager.markResultObservationHandledForParent(sessionKey, msg.userMessage as string);
          }
        }
      }
    } catch (err: any) {
      const attempts = (msg.attempts ?? 0) + 1;
      if (attempts <= 2) {
        const pending = this.messageQueue.get(sessionKey) ?? [];
        pending.unshift({ ...msg, attempts });
        this.messageQueue.set(sessionKey, pending);
        retryLater = true;
        Logger.warning(`[${sessionKey}] 队列消息执行异常，保留等待重试: ${err?.message || err}`);
      } else {
        Logger.error(`[${sessionKey}] 队列消息连续执行失败，停止重试: ${err?.message || err}`);
        if (msg.source === 'subagent_feedback') {
          const pending = this.messageQueue.get(sessionKey) ?? [];
          pending.unshift({ ...msg, attempts, deliveryOnly: true });
          this.messageQueue.set(sessionKey, pending);
          retryLater = true;
        } else {
          await this.sender.reply(msg.topic, '处理消息时出错，请稍后重试。').catch(() => undefined);
        }
      }
    } finally {
      this.releaseSessionExecution(sessionKey);
      stopTypingHeartbeat();
    }

    if (retryLater) {
      const timer = setTimeout(() => void this.drainMessageQueue(sessionKey), 100);
      timer.unref?.();
      return;
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
      if (item.nativeFeishuContext) break;
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
    this.sessionExecutionReservations?.clear();
    this.sessionClearGenerations?.clear();
    for (const controller of this.cloudSessionRestoreAbortControllers?.values() ?? []) controller.abort();
    this.cloudSessionRestoreAbortControllers?.clear();
    this.subAgentEventRoutes.clear();
    for (const batch of this.subAgentCompletionBatches.values()) {
      if (batch.timer) clearTimeout(batch.timer);
    }
    this.subAgentCompletionBatches.clear();
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
            filePath: att.localPath || `[CatsCo attachment: ${att.fileName}]`,
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
            'If the user request depends on image content, call read_file with file_path set to the local cache path below.',
            'Use the local cache path shown here. Do not use old tmp/downloads paths, old image URLs, old filenames, or prior image descriptions.',
            currentImageRefs.join('\n\n'),
          ].join('\n'),
        });
      Logger.info(`[CatsCo] vision_fallback_read_file model=${modelName} images=${currentImageRefs.length} reason=${primaryModelCanSeeImages ? 'image_block_create_failed' : 'model_not_vision_capable'}`);
    }

    return blocks;
  }

  private formatAttachmentReferenceForModel(attachment: PendingAttachment): string {
    const label = attachment.type === 'image' ? '图片' : '文件';
    return [
      `[${label}] ${attachment.fileName}`,
      `本地缓存路径: ${attachment.localPath}`,
      '读取方式: 如需查看该附件，调用 read_file，file_path 使用上面的本地缓存路径。',
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
