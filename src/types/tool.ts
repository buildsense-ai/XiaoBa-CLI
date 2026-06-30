import { ContentBlock } from './index';
import type {
  ExecutionScope,
  ScopedDeviceGrant,
  ScopedDeviceSelection,
  ScopedLocalDeviceGrant,
  ScopedLocalFileGrant,
} from './session-identity';
import type { PlanRuntime, RuntimePlanSnapshot } from '../core/plan-runtime';
import type { AIService } from '../utils/ai-service';
import type { SkillManager } from '../skills/skill-manager';

/**
 * 工具参数定义
 */
export interface ToolParameter {
  type: string;
  description?: string;
  required?: boolean;
  enum?: string[];
  items?: ToolParameter | {
    type: string;
    properties?: Record<string, ToolParameter>;
    required?: string[];
  };
  properties?: Record<string, ToolParameter>;
  default?: any;
}

/**
 * 工具定义
 */
export type ToolTranscriptMode = 'default' | 'outbound_message' | 'outbound_file' | 'suppress';
export type ToolControlMode = 'pause_turn';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
  /**
   * 控制工具结果如何进入后续 transcript。
   * default: 保留 tool_result；
   * outbound_message/outbound_file: 成功后折叠为用户已看到的外发结果。
   * suppress: 成功后不进入后续 transcript（适合控制类工具）。
   */
  transcriptMode?: ToolTranscriptMode;
  /**
   * 控制工具对当前 run 的控制语义。
   * 例如 pause_turn 会显式结束当前这一轮推理，等待新的外部事件。
   */
  controlMode?: ToolControlMode;
}

/**
 * 工具调用请求
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON字符串
  };
}

/**
 * 工具调用结果（ConversationRunner 最终收到的结构）
 */
export interface ToolResult {
  tool_call_id: string;
  role: 'tool';
  name: string;
  content: string | import('./index').ContentBlock[];
  /** Transient provider-only context that disambiguates which device/runtime produced this tool result. */
  targetContext?: string;
  ok?: boolean;
  errorCode?: string;
  retryable?: boolean;
  controlSignal?: ToolControlMode;
  newMessages?: import('./index').Message[];
}

/**
 * 工具内部执行结果的统一类型
 * 工具 execute() 必须返回此类型，由 BaseTool 统一处理失败兜底
 */
export type ToolExecutionResult = (
  | { ok: true; content: string | import('./index').ContentBlock[] }
  | { ok: false; errorCode: string; message: string; retryable?: boolean }
) & {
  /** Route-aware context for the model-visible tool result. */
  targetContext?: string;
};

export interface DeviceRpcToolRequest {
  toolName: string;
  operation: ScopedDeviceGrant['operations'][number];
  args: Record<string, unknown>;
  grant?: ScopedDeviceGrant;
  targetDeviceId?: string;
  targetDeviceDisplayName?: string;
  targetDeviceBodyId?: string;
  targetDeviceInstallationId?: string;
  timeoutMs?: number;
}

export interface DeviceRpcTransport {
  executeTool(request: DeviceRpcToolRequest): Promise<ToolExecutionResult>;
}

export interface ThinToolRpcRequest {
  targetOwnerUserId: string;
  targetDeviceId: string;
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ThinToolRpcTransport {
  executeTool(request: ThinToolRpcRequest): Promise<ToolExecutionResult>;
}

export type TargetRouteOS = 'windows' | 'macos' | 'linux' | 'unknown';

export interface TargetRoute {
  userId: string;
  userName?: string;
  ownerUserId: string;
  deviceId: string;
  label: string;
  os: TargetRouteOS;
  status: 'ready';
}

export interface TargetRoutes {
  routes: TargetRoute[];
  byName: Map<string, TargetRoute[]>;
  byUserId: Map<string, TargetRoute[]>;
}

export type ToolErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'INVALID_TOOL_ARGUMENTS'
  | 'TOOL_EXECUTION_ERROR'
  | 'RATE_LIMIT'
  | 'NEEDS_CONFIRMATION'
  | 'PERMISSION_DENIED'
  | 'FILE_NOT_FOUND'
  | 'EXECUTION_TIMEOUT';

export type ToolSurface = 'cli' | 'feishu' | 'catscompany' | 'weixin' | 'agent' | 'research' | 'unknown';
export type ToolPermissionProfile = 'strict' | 'default' | 'relaxed';

/**
 * 平台通道回调（通过 ToolExecutionContext 传递给工具，替代 bind/unbind 模式）
 * 飞书、CatsCompany 等平台共用此接口，chatId 对应各平台的会话标识。
 */
export interface ChannelCallbacks {
  /** 当前会话的 chatId（飞书 chatId / CatsCompany topic） */
  chatId: string;
  /** 发送文本消息 */
  reply: (chatId: string, text: string) => Promise<void>;
  /** 发送文件 */
  sendFile: (chatId: string, filePath: string, fileName: string) => Promise<void>;
  /** 发送临时运行时计划。支持实时 UI 的 surface 可实现为卡片展示。 */
  sendRuntimePlan?: (chatId: string, snapshot: RuntimePlanSnapshot) => Promise<void>;
}

/** @deprecated Use ChannelCallbacks instead */
export type FeishuChannelCallbacks = ChannelCallbacks;

export interface RuntimeToolServices {
  aiService: AIService;
  skillManager: SkillManager;
}

export type ToolRiskLevel = 'low' | 'medium' | 'high';

export interface ToolExecutionConfirmationRequest {
  toolName: string;
  risk: ToolRiskLevel;
  reason: string;
  args: unknown;
  surface?: ToolSurface;
  workingDirectory?: string;
}

export type ToolExecutionConfirmationResult = boolean | {
  approved: boolean;
  reason?: string;
};

/**
 * 工具执行上下文
 */
export interface ToolExecutionContext {
  /** Current directory for this session. Relative paths in regular file tools resolve from here. */
  workingDirectory: string;
  /** Stable default/root directory for tools that must not follow session directory changes. */
  workspaceRoot?: string;
  conversationHistory: any[];
  sessionId?: string;
  surface?: ToolSurface;
  permissionProfile?: ToolPermissionProfile;
  runId?: string;
  abortSignal?: AbortSignal;
  planRuntime?: PlanRuntime;
  /** Runtime state for transient async prompt modes, when prompt mode routing is enabled. */
  promptModeRuntime?: {
    clear: (reason?: string) => void;
    getActiveMode?: () => unknown;
  };
  getCurrentDirectory?: () => string;
  updateCurrentDirectory?: (directory: string) => void;
  /** 子智能体需要主 agent 补充信息时使用；仅 subagent runtime 注入 */
  requestParentInput?: (question: string) => Promise<string>;
  /** 本地自用的中高风险工具确认；CatsCo/远程委托仍由服务端 grant 控制。 */
  confirmToolExecution?: (request: ToolExecutionConfirmationRequest) => Promise<ToolExecutionConfirmationResult>;
  /** 当前 runtime 已创建的共享服务，供调度类工具复用，避免重复初始化 */
  runtimeServices?: RuntimeToolServices;
  /** 平台通道回调（飞书/CatsCompany 等聊天会话时由平台层注入） */
  channel?: ChannelCallbacks;
  /** 当前 turn 的可信执行身份；后续 ToolGateway/设备授权会基于它做权限判断。 */
  executionScope?: ExecutionScope;
  /** 当前本机运行体授权，例如 CatsCo body/device 绑定。 */
  localDeviceGrant?: ScopedLocalDeviceGrant;
  /** 当前 turn 已授权的用户设备资源，供未来远程设备工具校验。 */
  deviceGrants?: ScopedDeviceGrant[];
  /** 服务端为当前 turn 选定的用户设备，或明确要求先选择设备。 */
  deviceSelection?: ScopedDeviceSelection;
  /** CatsCo 远程设备 RPC 通道。工具只能通过窄接口请求后端选定设备执行。 */
  deviceRpc?: DeviceRpcTransport;
  thinToolRpc?: ThinToolRpcTransport;
  targetRoutes?: TargetRoutes;
  executionContext?: {
    schema: 'xiaoba.execution_context.v1';
    conversation: {
      type: 'local' | 'p2p' | 'group';
      currentSpeaker: { id: string; name?: string; role?: string };
      participants: Array<{ id: string; name?: string; role?: string }>;
    };
    executionTargets: Array<{
      id: string;
      label: string;
      kind: 'agent_self' | 'participant';
      status: 'ready' | 'unavailable';
      userId?: string;
      cwd?: string;
    }>;
    defaultTarget: 'agent_self' | 'speaker_default';
  };
  deviceRpcReceiver?: boolean;
  /** 当前 turn 已授权的本地文件资源，例如用户本轮上传的 CatsCo 附件缓存。 */
  localFileGrants?: ScopedLocalFileGrant[];
}

/**
 * 工具接口
 */
export interface Tool {
  definition: ToolDefinition;
  execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

/**
 * 工具基类
 * - 统一 catch 兜底，确保所有工具执行结果都有 ok 语义
 * - 子类只需返回 ok:true 的成功结果，失败时 throw 即可
 */
export abstract class BaseTool implements Tool {
  abstract definition: ToolDefinition;

  abstract executeImpl(args: any, context: ToolExecutionContext): Promise<string | ContentBlock[]>;

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const content = await this.executeImpl(args, context);
      return { ok: true, content };
    } catch (error: any) {
      return {
        ok: false,
        errorCode: (error as any).errorCode || 'TOOL_EXECUTION_ERROR',
        message: String(error?.message || error || 'Unknown error'),
        retryable: false,
      };
    }
  }
}

/**
 * 工具执行器接口 — ConversationRunner 依赖此抽象
 * ToolManager 和 AgentToolExecutor 均实现此接口
 */
export interface ToolExecutor {
  getToolDefinitions(allowedNames?: string[]): ToolDefinition[];
  executeTool(
    toolCall: ToolCall,
    conversationHistory?: any[],
    contextOverrides?: Partial<ToolExecutionContext>
  ): Promise<ToolResult>;
}
