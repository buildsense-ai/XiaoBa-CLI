/**
 * MCP Notification / Event → McpForwardedEvent 规范化适配层。
 *
 * 设计目标：
 * 1. 已知的标准通知（tools/list_changed、resources/updated、progress、
 *    prompts/list_changed、resources/list_changed、logging/message、
 *    tasks/status）映射为稳定 type，并给出合理优先级与路由字段提取。
 * 2. 未识别的 notifications/* 与未来的 events/* 原语走统一兜底：
 *    method 原样进 event.method，type = method 去掉 "notifications/" 前缀，
 *    payload = params。官方 SDK 之后新增 events/* 时无需改动本层结构，
 *    只在 KNOWN_PRIORITIES / type 特例表里补一行即可。
 * 3. eventId 幂等：优先取 params 里显式的 event_id/id/eventId，
 *    否则对 serverId+method+params 做稳定 sha256 指纹 —— 同一条通知重放
 *    （重连补推、广播重复）会得到同一个 eventId，下游按它去重。
 */
import crypto from 'node:crypto';

export type McpEventPriority = 'low' | 'normal' | 'high' | 'critical';

/** 发给外部事件总线的规范化事件。 */
export interface McpForwardedEvent {
  /** 幂等键：同一条通知重放产生相同 eventId。 */
  eventId: string;
  /** 事件来源标识，固定 'mcp'（便于总线侧区分本机/平台事件）。 */
  source: 'mcp';
  /** 规范化事件类型，如 'tools/list_changed'、'resources/updated'。 */
  type: string;
  /** 产生事件的 MCP server id。 */
  serverId: string;
  /** 原始 JSON-RPC method（保留完整前缀，便于排查）。 */
  method: string;
  artifactId?: string;
  sessionKey?: string;
  topic?: string;
  /** 原始通知 params（未识别的扩展字段全量保留）。 */
  payload: Record<string, unknown>;
  priority: McpEventPriority;
  createdAt: string; // ISO-8601
}

export interface McpNotificationLike {
  method: string;
  params?: unknown;
}

/** 各 method 的默认优先级；未列出的按 'normal'。 */
const KNOWN_PRIORITIES: Record<string, McpEventPriority> = {
  'notifications/tools/list_changed': 'high',
  'notifications/prompts/list_changed': 'normal',
  'notifications/resources/list_changed': 'normal',
  'notifications/resources/updated': 'normal',
  'notifications/progress': 'low',
  'notifications/message': 'low',
  'notifications/logging/message': 'low',
  'notifications/tasks/status': 'normal',
  'notifications/cancelled': 'high',
  'notifications/elicitation/complete': 'normal',
};

/** 从 method 推导规范化 type：去掉 notifications/ 前缀，其余原样。 */
export function typeForMethod(method: string): string {
  return method.startsWith('notifications/') ? method.slice('notifications/'.length) : method;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** params 里显式的事件 id（幂等键优先来源）。 */
function explicitEventId(params: Record<string, unknown>): string | undefined {
  for (const key of ['event_id', 'eventId', 'id', 'notification_id', 'notificationId']) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return `n-${value}`;
  }
  return undefined;
}

/** 提取路由字段：先看 _meta，再看 params 顶层；resources/updated 的 uri 落 artifactId。 */
function extractRouting(params: Record<string, unknown>): { artifactId?: string; sessionKey?: string; topic?: string } {
  const meta = isRecord(params._meta) ? params._meta : {};
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const metaValue = meta[name];
      if (typeof metaValue === 'string' && metaValue.trim()) return metaValue.trim();
      const direct = params[name];
      if (typeof direct === 'string' && direct.trim()) return direct.trim();
    }
    return undefined;
  };
  const routing: { artifactId?: string; sessionKey?: string; topic?: string } = {};
  const artifactId = pick('artifact_id', 'artifactId', 'artifact');
  const sessionKey = pick('session_key', 'sessionKey', 'session_id', 'sessionId');
  const topic = pick('topic', 'chat_id', 'chatId');
  if (artifactId) routing.artifactId = artifactId;
  if (sessionKey) routing.sessionKey = sessionKey;
  if (topic) routing.topic = topic;
  // resources/updated 的 uri 天然是被更新资源的标识，作为 artifactId 兜底。
  if (!routing.artifactId && typeof params.uri === 'string' && params.uri.trim()) {
    routing.artifactId = params.uri.trim();
  }
  return routing;
}

/**
 * 生成幂等 eventId：显式 id 优先，否则 sha256(serverId|method|stableJson(params)) 前 32 位。
 * 确定性 —— 同一输入永远同一输出，这是重放去重的前提。
 */
export function mcpEventId(serverId: string, method: string, params: unknown): string {
  const explicit = isRecord(params) ? explicitEventId(params) : undefined;
  if (explicit) return `mcp:${serverId}:${explicit}`;
  const fingerprint = crypto
    .createHash('sha256')
    .update(serverId)
    .update('')
    .update(method)
    .update('')
    .update(stableStringify(params))
    .digest('hex')
    .slice(0, 32);
  return `mcp:${serverId}:${fingerprint}`;
}

/** 键序稳定的 JSON 序列化，保证同一份 params 永远得到同一个指纹。 */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
}

/** 优先级兜底规则：标准映射优先，error/fail 类名字升 critical。 */
export function priorityForMethod(method: string): McpEventPriority {
  const known = KNOWN_PRIORITIES[method];
  if (known) return known;
  if (/error|fail/i.test(method)) return 'critical';
  return 'normal';
}

/**
 * 把一条 MCP 通知（已识别的或未知的扩展方法）规范化为 McpForwardedEvent。
 * 不抛异常 —— 通知通道不能因为一条怪数据把连接搞崩。
 */
export function adaptMcpNotification(serverId: string, notification: McpNotificationLike): McpForwardedEvent {
  const method = typeof notification?.method === 'string' && notification.method
    ? notification.method
    : 'notifications/unknown';
  const params = isRecord(notification?.params) ? notification.params : {};
  return {
    eventId: mcpEventId(serverId, method, params),
    source: 'mcp',
    type: typeForMethod(method),
    serverId,
    method,
    ...extractRouting(params),
    payload: params,
    priority: priorityForMethod(method),
    createdAt: new Date().toISOString(),
  };
}
