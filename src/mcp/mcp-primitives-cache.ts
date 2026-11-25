/**
 * MCP Resources/Prompts/Completion 本地 TTL 缓存。
 *
 * 语义遵循 MCP spec 2026-07-28 缓存原语：
 * - `ttlMs`：条目存活毫秒数，过期即失效；
 * - `cacheScope`：`'session'` 条目按 sessionId 隔离（缺省 sessionId 视为同一会话），
 *   `'global'` 条目跨会话共享；
 * - 远端结果在 `_meta.ttlMs` / `_meta.cacheScope`（或顶层同名扩展字段）里声明缓存
 *   策略；未声明时使用默认 TTL（0 = 不缓存）。
 * - 缓存是**性能优化**而非正确性依赖：list_changed / resources/updated /
 *   server 断连时按 server 维度整体失效。
 */
export type McpCacheScope = 'session' | 'global';

export interface McpCachePolicy {
  ttlMs?: number;
  cacheScope?: McpCacheScope;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  scope: McpCacheScope;
  sessionKey?: string;
}

export interface McpPrimitivesCacheOptions {
  /** 远端未声明 ttlMs 时的默认 TTL（毫秒，默认 0 = 不缓存）。 */
  defaultTtlMs?: number;
  now?: () => number;
}

/** 从远端结果里提取缓存策略声明（_meta 优先，顶层扩展字段兜底）。 */
export function extractCachePolicy(result: unknown): McpCachePolicy {
  if (typeof result !== 'object' || result === null) return {};
  const root = result as Record<string, unknown>;
  const meta = typeof root._meta === 'object' && root._meta !== null
    ? (root._meta as Record<string, unknown>)
    : {};
  const pickNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const pickScope = (value: unknown): McpCacheScope | undefined =>
    value === 'session' || value === 'global' ? value : undefined;
  const ttlMs = pickNumber(meta.ttlMs) ?? pickNumber(root.ttlMs);
  const cacheScope = pickScope(meta.cacheScope) ?? pickScope(root.cacheScope);
  return {
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(cacheScope ? { cacheScope } : {}),
  };
}

export class McpPrimitivesCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly defaultTtlMs: number;
  private readonly now: () => number;

  constructor(options: McpPrimitivesCacheOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? 0;
    this.now = options.now ?? Date.now;
  }

  private fullKey(serverId: string, kind: string, key: string, scope: McpCacheScope, sessionId?: string): string {
    const scopeKey = scope === 'session' ? `session:${sessionId ?? ''}` : 'global';
    return `${serverId}${kind}${scopeKey}${key}`;
  }

  get(serverId: string, kind: string, key: string, sessionId?: string): unknown | undefined {
    // session 作用域条目优先，其次 global —— 调用方不需要知道存的时候是哪个 scope。
    for (const scope of ['session', 'global'] as const) {
      const fullKey = this.fullKey(serverId, kind, key, scope, sessionId);
      const entry = this.entries.get(fullKey);
      if (!entry) continue;
      if (entry.expiresAt <= this.now()) {
        this.entries.delete(fullKey);
        continue;
      }
      return entry.value;
    }
    return undefined;
  }

  set(
    serverId: string,
    kind: string,
    key: string,
    value: unknown,
    policy: McpCachePolicy = {},
    sessionId?: string,
  ): void {
    const ttlMs = policy.ttlMs ?? this.defaultTtlMs;
    if (!(ttlMs > 0)) return; // ttl 0 / 负数 = 不缓存
    const scope: McpCacheScope = policy.cacheScope ?? 'session';
    const fullKey = this.fullKey(serverId, kind, key, scope, sessionId);
    this.entries.set(fullKey, {
      value,
      expiresAt: this.now() + ttlMs,
      scope,
      ...(scope === 'session' ? { sessionKey: sessionId ?? '' } : {}),
    });
  }

  /** 整个 server 的缓存全部失效（list_changed / resources/updated / 断连）。 */
  invalidateServer(serverId: string, kind?: string): number {
    let removed = 0;
    const prefix = `${serverId}`;
    for (const entryKey of [...this.entries.keys()]) {
      if (!entryKey.startsWith(prefix)) continue;
      if (kind) {
        const rest = entryKey.slice(prefix.length);
        if (!rest.startsWith(kind)) continue;
      }
      this.entries.delete(entryKey);
      removed += 1;
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
