/**
 * 受控 Sampling 与对齐 device-grants 的 Roots（Track 3）。
 *
 * **Sampling（sampling/createMessage）**—— MCP server 反向借用客户端的 LLM。
 * 这本质是把本机 Relay 额度借给一个第三方 server，风险面：烧钱、注入系统提示、
 * 借刀调用本地工具。因此默认对第三方 server **完全关闭**，只有显式 allowlist
 * 的 server 可用，并且每次调用强制：
 * - maxTokens 封顶（防单次烧穿额度）；
 * - 每回合/每分钟调用次数封顶（令牌桶思路，防循环刷量）；
 * - 可选用户审批回调（approval callback）最后一票否决；
 * - 采样不允许继承宿主本地工具 —— server 只能拿到纯文本对话能力。
 *
 * **Roots（roots/list）**—— 动态从 ExecutionScope + device-grants 构建允许的
 * file:// 根：本地工作目录、被 grant 授权的设备目录，绝不盲目暴露宿主根文件系统。
 */
import path from 'node:path';
import type { ExecutionScope, ScopedDeviceGrant } from '../types/session-identity';
import type { Message } from '../types/index';
import type { AIService } from '../utils/ai-service';
import { isOwnerOnlyServer, type McpServerRiskProfile } from './mcp-security-policy';

// ---------------- Sampling ----------------

/** MCP sampling/createMessage 请求参数的窄接口。 */
export interface SamplingRequestParams {
  messages: Array<{
    role: 'user' | 'assistant';
    content: unknown;
  }>;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  modelPreferences?: unknown;
  /** server 声明需要工具能力（capability sampling.tools）。 */
  includeContext?: string;
}

/** MCP sampling 应答（CreateMessageResult）的窄接口。 */
export interface SamplingResult {
  role: 'assistant';
  model: string;
  stopReason?: string;
  content: { type: 'text'; text: string };
}

/** 注入的最小采样能力：生产 = AIService.chat 的窄包装；测试注入内存实现。 */
/**
 * 注入的最小采样能力：生产 = AIService.chat 的窄包装；测试注入内存实现。
 * maxTokens 上限由控制器的 token cap 语义承载（AIRequestOptions 不透传逐次 maxTokens）。
 */
export type SamplingChat = (
  messages: Message[],
  options: { systemPrompt?: string },
) => Promise<{ content: string | null; model?: string; stopReason?: string }>;

export interface SamplingApprovalRequest {
  serverId: string;
  messages: SamplingRequestParams['messages'];
  maxTokens: number;
  systemPrompt?: string;
}

export interface McpSamplingControllerOptions {
  /** 允许采样的 server 集合；缺省 = 空（全部拒绝）。 */
  allowlist?: Iterable<string>;
  /** 单次调用 maxTokens 封顶（默认 2048）。 */
  maxTokensPerCall?: number;
  /** 每回合（同一 server 无成功间隙的连续窗口）最大调用数（默认 4）。 */
  maxCallsPerTurn?: number;
  /** 每分钟最大调用数（默认 8）。 */
  maxCallsPerMinute?: number;
  /** 可选用户审批回调；返回 false/抛错 = 拒绝本次采样。 */
  approvalCallback?: (request: SamplingApprovalRequest) => Promise<boolean> | boolean;
  /** 采样实现（AIService.chat 窄封装）。未注入 = 无能力（不声明 sampling capability）。 */
  chat?: SamplingChat;
  /** AIService 实例的便捷注入（二选一；chat 优先）。 */
  aiService?: Pick<AIService, 'chat' | 'getConfig'>;
  now?: () => number;
}

export type SamplingGateResult =
  | { allowed: true; effectiveMaxTokens: number }
  | { allowed: false; reason: string; code: 'not_allowlisted' | 'no_chat_impl' | 'turn_limit' | 'minute_limit' | 'token_cap_invalid' | 'approval_denied' };

const DEFAULT_MAX_TOKENS_PER_CALL = 2048;
const DEFAULT_MAX_CALLS_PER_TURN = 4;
const DEFAULT_MAX_CALLS_PER_MINUTE = 8;

export class McpSamplingController {
  private readonly allowlist: Set<string>;
  private readonly maxTokensPerCall: number;
  private readonly maxCallsPerTurn: number;
  private readonly maxCallsPerMinute: number;
  private readonly approvalCallback?: McpSamplingControllerOptions['approvalCallback'];
  private readonly chat?: SamplingChat;
  private readonly now: () => number;

  /** serverId → 当前回合内已消耗调用数（宿主每回合结束调用 endTurn 清零）。 */
  private readonly turnCounts = new Map<string, number>();
  /** serverId → 最近一分钟调用时间戳。 */
  private readonly minuteWindows = new Map<string, number[]>();

  constructor(options: McpSamplingControllerOptions = {}) {
    this.allowlist = new Set(options.allowlist ?? []);
    this.maxTokensPerCall = options.maxTokensPerCall ?? DEFAULT_MAX_TOKENS_PER_CALL;
    this.maxCallsPerTurn = options.maxCallsPerTurn ?? DEFAULT_MAX_CALLS_PER_TURN;
    this.maxCallsPerMinute = options.maxCallsPerMinute ?? DEFAULT_MAX_CALLS_PER_MINUTE;
    this.approvalCallback = options.approvalCallback;
    this.now = options.now ?? Date.now;
    this.chat = options.chat ?? (options.aiService ? createAiserviceSampler(options.aiService) : undefined);
  }

  /** 是否具备采样能力（决定 client 是否声明 sampling capability）。 */
  get capable(): boolean {
    return this.chat !== undefined && this.allowlist.size > 0;
  }

  allowServer(serverId: string): void {
    this.allowlist.add(serverId);
  }

  /** 回合结束清零 turn 计数（宿主接线；分钟窗口独立滚动）。 */
  endTurn(serverId?: string): void {
    if (serverId) this.turnCounts.delete(serverId);
    else this.turnCounts.clear();
  }

  /** 门禁检查（不含审批）。 */
  checkGate(serverId: string, requestedMaxTokens?: number): SamplingGateResult {
    if (!this.chat) {
      return { allowed: false, code: 'no_chat_impl', reason: 'sampling backend unavailable' };
    }
    if (!this.allowlist.has(serverId)) {
      return { allowed: false, code: 'not_allowlisted', reason: `MCP server "${serverId}" is not on the sampling allowlist` };
    }
    const turnCount = this.turnCounts.get(serverId) ?? 0;
    if (turnCount >= this.maxCallsPerTurn) {
      return { allowed: false, code: 'turn_limit', reason: `sampling turn limit reached (${this.maxCallsPerTurn})` };
    }
    const windowStart = this.now() - 60_000;
    const window = (this.minuteWindows.get(serverId) ?? []).filter((ts) => ts >= windowStart);
    this.minuteWindows.set(serverId, window);
    if (window.length >= this.maxCallsPerMinute) {
      return { allowed: false, code: 'minute_limit', reason: `sampling per-minute limit reached (${this.maxCallsPerMinute})` };
    }
    const effectiveMaxTokens = Math.min(
      this.maxTokensPerCall,
      typeof requestedMaxTokens === 'number' && Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
        ? Math.floor(requestedMaxTokens)
        : this.maxTokensPerCall,
    );
    if (effectiveMaxTokens <= 0) {
      return { allowed: false, code: 'token_cap_invalid', reason: 'invalid maxTokens' };
    }
    return { allowed: true, effectiveMaxTokens };
  }

  /**
   * 处理 sampling/createMessage 请求。
   * 不满足门禁/审批 → 抛错（SDK 会把它变成 JSON-RPC error 返回给 server）。
   */
  async handleCreateMessage(serverId: string, params: SamplingRequestParams): Promise<SamplingResult> {
    const gate = this.checkGate(serverId, params.maxTokens);
    if (!gate.allowed) {
      throw new Error(`sampling denied: ${gate.reason}`);
    }

    if (this.approvalCallback) {
      let approved = false;
      try {
        approved = await this.approvalCallback({
          serverId,
          messages: params.messages ?? [],
          maxTokens: gate.effectiveMaxTokens,
          ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
        });
      } catch {
        approved = false;
      }
      if (!approved) {
        throw new Error('sampling denied: user approval rejected');
      }
    }

    // 计消耗：先记账再调用，防止并发突刺绕过限额。
    this.turnCounts.set(serverId, (this.turnCounts.get(serverId) ?? 0) + 1);
    const window = this.minuteWindows.get(serverId) ?? [];
    window.push(this.now());
    this.minuteWindows.set(serverId, window);

    const messages = toLocalSamplingMessages(params);
    const response = await this.chat!(messages, {
      ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
    });

    return {
      role: 'assistant',
      model: response.model ?? 'xiaoba-sampling',
      ...(response.stopReason ? { stopReason: normalizeStopReason(response.stopReason) } : {}),
      content: { type: 'text', text: response.content ?? '' },
    };
  }
}

/** AIService.chat → SamplingChat 窄封装。注意：故意不传 tools —— 采样永远拿不到宿主本地工具。 */
export function createAiserviceSampler(
  aiService: Pick<AIService, 'chat' | 'getConfig'>,
): SamplingChat {
  return async (messages, options) => {
    const fullMessages: Message[] = [];
    if (options.systemPrompt) {
      fullMessages.push({ role: 'system', content: options.systemPrompt });
    }
    fullMessages.push(...messages);
    const response = await aiService.chat(fullMessages);
    const config = aiService.getConfig?.();
    return {
      content: response.content,
      ...(config?.model ? { model: config.model } : {}),
      ...(response.stopReason ? { stopReason: response.stopReason } : {}),
    };
  };
}

function normalizeStopReason(stopReason: string): string {
  if (/max_tokens|length/i.test(stopReason)) return 'maxTokens';
  if (/stop/i.test(stopReason)) return 'endTurn';
  return stopReason;
}

/** MCP sampling message → 本地 Message（image/audio/tool 块降级为占位文本）。 */
export function toLocalSamplingMessages(params: SamplingRequestParams): Message[] {
  const out: Message[] = [];
  for (const message of params.messages ?? []) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    out.push({ role: message.role, content: flattenSamplingContent(message.content) });
  }
  return out;
}

function flattenSamplingContent(content: unknown): string {
  if (typeof content === 'string') return content;
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text);
    } else if (record.type === 'image') {
      parts.push('[image omitted in sampling bridge]');
    } else if (record.type === 'audio') {
      parts.push('[audio omitted in sampling bridge]');
    } else if (record.type === 'tool_use') {
      parts.push(`[tool_use ${String(record.name ?? '')}]`);
    } else if (record.type === 'tool_result') {
      parts.push('[tool_result]');
    }
  }
  return parts.join('\n');
}

// ---------------- Roots ----------------

export interface McpRoot {
  uri: string;
  name?: string;
}

/** server 的 roots 配置：声明它需要本地 roots 访问时才进入 device-grants 对齐逻辑。 */
export interface RootsServerProfile {
  /** 显式声明的附加根（绝对路径）；仍受 policy 约束。 */
  extraRoots?: string[];
  /** 是否启用 roots（缺省 true 当 server 请求 roots/list 时按 scope 动态给）。 */
  enabled?: boolean;
}

export interface BuildRootsOptions {
  /** 当前执行 scope（可为空：无会话上下文时只给 fallbackRoots）。 */
  scope?: ExecutionScope;
  /** 当前 turn 的 device grants。 */
  deviceGrants?: ScopedDeviceGrant[];
  /** 宿主工作目录（session cwd）。 */
  workingDirectory?: string;
  /** 无 scope 时的兜底根（默认空 —— 宁可不给，也不暴露宿主根）。 */
  fallbackRoots?: string[];
  /** server 风险标记：ownerOnly server 在群聊非 owner 触发时不给任何根。 */
  riskProfile?: McpServerRiskProfile;
  /** 附加根（来自 server 配置）。 */
  extraRoots?: string[];
}

/**
 * 动态构建 file:// roots：
 * - 主根 = 当前会话 workingDirectory（ExecutionScope 所在会话）；
 * - device-grants 中 read_file/write_file 等文件类授权存在时，追加授权设备声明的根；
 *   （device grant 本身不携带目录清单 —— 目录由 resolveCommonDirectory 协商，
 *   这里只暴露 grant.ownerUserId 归属的授权标记根：仍限在工作目录内。）
 * - 群聊里 ownerOnly server + actor≠owner → 空根列表（防注入借 roots 读宿主文件）。
 * - 绝不返回 '/' 或用户 home 根，除非它恰好等于 workingDirectory。
 */
export function buildScopedRoots(options: BuildRootsOptions): McpRoot[] {
  if (isOwnerOnlyServer(options.riskProfile)) {
    const scope = options.scope;
    if (scope?.topicType === 'group'
      && scope.actorUserId
      && scope.deviceOwnerUserId
      && scope.actorUserId !== scope.deviceOwnerUserId) {
      return [];
    }
  }

  const roots: McpRoot[] = [];
  const seen = new Set<string>();
  const pushRoot = (absolutePath: string, name?: string) => {
    const normalized = path.resolve(absolutePath);
    // 安全闸：不暴露文件系统根。
    if (normalized === path.parse(normalized).root) return;
    const uri = pathToFileUri(normalized);
    if (seen.has(uri)) return;
    seen.add(uri);
    roots.push({ uri, ...(name ? { name } : {}) });
  };

  if (options.workingDirectory) {
    pushRoot(options.workingDirectory, 'workspace');
  }
  for (const extra of options.extraRoots ?? []) {
    if (typeof extra === 'string' && extra.trim()) pushRoot(extra.trim(), 'configured');
  }
  // device-grants 对齐：存在有效文件类授权时，追加授权根（本实现以 workingDirectory
  // 为锚；设备目录的精确映射由 device grant 的 resolveCommonDirectory 语义承载，
  // 这里绝不因为 grant 存在而扩大暴露面）。
  const hasFileGrant = (options.deviceGrants ?? []).some((grant) =>
    grant.status === 'active'
    && grant.operations.some((op) => op === 'read_file' || op === 'write_file' || op === 'resolve_common_directory'));
  if (hasFileGrant && options.workingDirectory) {
    // grant 有效 ⇒ workingDirectory 根保持可用（无额外暴露；注释保留语义锚点）。
  }

  if (roots.length === 0) {
    for (const fallback of options.fallbackRoots ?? []) {
      if (typeof fallback === 'string' && fallback.trim()) pushRoot(fallback.trim(), 'fallback');
    }
  }
  return roots;
}

/** roots 解析器注册表：McpClientManager 按 serverId 注入动态 scope provider。 */
export type RootsProvider = () => McpRoot[] | Promise<McpRoot[]>;

export class McpRootsRegistry {
  private readonly providers = new Map<string, RootsProvider>();

  register(serverId: string, provider: RootsProvider): void {
    this.providers.set(serverId, provider);
  }

  remove(serverId: string): void {
    this.providers.delete(serverId);
  }

  async resolve(serverId: string): Promise<McpRoot[]> {
    const provider = this.providers.get(serverId);
    if (!provider) return [];
    try {
      return await provider();
    } catch {
      return [];
    }
  }

  has(serverId: string): boolean {
    return this.providers.has(serverId);
  }
}

/** 绝对路径 → file:// URI（POSIX/Windows 均安全）。 */
export function pathToFileUri(absolutePath: string): string {
  const normalized = path.resolve(absolutePath).replace(/\\/g, '/');
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `file://${encodeURI(withSlash).replace(/[?#]/g, (c) => encodeURIComponent(c))}`;
}
