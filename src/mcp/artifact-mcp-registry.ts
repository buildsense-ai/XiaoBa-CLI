/**
 * Per-Artifact MCP Bridge 动态注册表（一 Artifact 一 MCP 端点）。
 *
 * 适用场景：Canvas / A2UI Artifact 打开时自带独立的 Streamable HTTP MCP 端点，
 * 调用 `registerArtifactBridge()` 动态挂入进程内活跃的 McpClientManager（并可选
 * 自动绑定 artifactId → sessionKey/topic），关闭时 `unregisterArtifactBridge()`
 * 卸载工具与长连接。
 */
import crypto from 'node:crypto';
import type { McpClientManager } from './mcp-client-manager';
import type { McpHttpServerConfig } from './mcp-config';
import { externalEventRouter, type ExternalEventRouter } from '../events/external-event-router';

export interface ArtifactMcpBridgeRegistration {
  artifactId: string;
  /** Artifact 内置的 Streamable HTTP MCP 端点 URL（仅允许 http / https）。 */
  url: string;
  bearerToken?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 可选：挂载时顺手把 artifactId 绑定到对应会话。 */
  sessionKey?: string;
  topic?: string;
}

export interface ArtifactMcpBridgeSummary {
  artifactId: string;
  serverId: string;
  url: string;
  hasBearerToken: boolean;
  sessionKey?: string;
  topic?: string;
  attachedAt: string;
}

export interface ArtifactMcpAttachResult {
  ok: boolean;
  artifactId: string;
  serverId: string;
  url: string;
  attachedManagers: number;
  sessionBound: boolean;
}

export interface ArtifactMcpDetachResult {
  ok: boolean;
  artifactId: string;
  serverId: string;
  existed: boolean;
  sessionUnbound: boolean;
}

/** 路由层依赖注入契约，便于单测替换。 */
export interface ArtifactMcpBridgeSink {
  registerArtifactBridge(input: ArtifactMcpBridgeRegistration): Promise<ArtifactMcpAttachResult> | ArtifactMcpAttachResult;
  unregisterArtifactBridge(
    artifactId: string,
    options?: { unbindSession?: boolean },
  ): Promise<ArtifactMcpDetachResult> | ArtifactMcpDetachResult;
  listArtifactBridges(): Promise<ArtifactMcpBridgeSummary[]> | ArtifactMcpBridgeSummary[];
}

export class ArtifactMcpBridgeError extends Error {
  constructor(
    message: string,
    public readonly status: number = 422,
    public readonly code: string = 'invalid_artifact_mcp_bridge',
  ) {
    super(message);
    this.name = 'ArtifactMcpBridgeError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(normalized);
}

/**
 * 将任意 artifactId 规范化为合法且无碰撞的 MCP serverId（用于 `mcp_art_<slug>_<hash6>_<tool>` 前缀）。
 * 追加原始 artifactId 的 6 位 sha256 哈希，避免 `a.b` 与 `a-b` 映射到同一 serverId。
 */
export function artifactServerId(artifactId: string): string {
  const trimmed = artifactId.trim();
  const cleaned = trimmed
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  const hash = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 6);
  return `art_${cleaned || 'unnamed'}_${hash}`;
}

interface StoredArtifactBridge {
  artifactId: string;
  serverId: string;
  config: McpHttpServerConfig;
  sessionKey?: string;
  topic?: string;
  attachedAt: string;
}

export class ArtifactMcpRegistry implements ArtifactMcpBridgeSink {
  private readonly managers = new Set<McpClientManager>();
  private readonly bridges = new Map<string, StoredArtifactBridge>();
  private readonly eventRouter: ExternalEventRouter;

  constructor(eventRouter: ExternalEventRouter = externalEventRouter) {
    this.eventRouter = eventRouter;
  }

  /** 注册一个活跃的 McpClientManager，并立即同步已挂载的 Artifact Bridge。 */
  attachManager(manager: McpClientManager): () => void {
    this.managers.add(manager);
    for (const bridge of this.bridges.values()) {
      manager.addServer(bridge.serverId, bridge.config);
    }
    return () => {
      this.detachManager(manager);
    };
  }

  detachManager(manager: McpClientManager): void {
    this.managers.delete(manager);
  }

  registerArtifactBridge(input: ArtifactMcpBridgeRegistration): ArtifactMcpAttachResult {
    const artifactId = String(input?.artifactId ?? '').trim();
    if (!artifactId) {
      throw new ArtifactMcpBridgeError('artifactId is required', 400, 'missing_artifact_id');
    }

    const rawUrl = String(input?.url ?? '').trim();
    if (!rawUrl) {
      throw new ArtifactMcpBridgeError('url is required', 422, 'missing_mcp_url');
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      throw new ArtifactMcpBridgeError(`invalid MCP endpoint url: ${rawUrl}`, 422, 'invalid_mcp_url');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new ArtifactMcpBridgeError(
        `MCP endpoint url must use http or https (got ${parsedUrl.protocol})`,
        422,
        'unsupported_mcp_protocol',
      );
    }
    const allowRemote = process.env.XIAOBA_ALLOW_REMOTE_MCP_ATTACH === '1';
    if (!allowRemote && !isLoopbackHost(parsedUrl.hostname)) {
      throw new ArtifactMcpBridgeError(
        `MCP bridge url must target a loopback host (127.0.0.1 / localhost / ::1); got ${parsedUrl.hostname}`,
        403,
        'remote_mcp_url_forbidden',
      );
    }

    const headers: Record<string, string> = {};
    if (input.headers && typeof input.headers === 'object') {
      for (const [key, value] of Object.entries(input.headers)) {
        const k = key.trim();
        if (k && typeof value === 'string') headers[k] = value;
      }
    }
    const bearerToken = typeof input.bearerToken === 'string' && input.bearerToken.trim()
      ? input.bearerToken.trim()
      : undefined;
    const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? Math.floor(input.timeoutMs)
      : undefined;

    const config: McpHttpServerConfig = {
      transport: 'streamable-http',
      url: parsedUrl.toString(),
      ...(bearerToken ? { bearerToken } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    };

    const serverId = artifactServerId(artifactId);
    const sessionKey = typeof input.sessionKey === 'string' && input.sessionKey.trim()
      ? input.sessionKey.trim()
      : undefined;
    const topic = typeof input.topic === 'string' && input.topic.trim()
      ? input.topic.trim()
      : undefined;

    if (sessionKey || topic) {
      config.scopeBinding = {
        ...(sessionKey ? { sessionKey } : {}),
        ...(topic ? { topic } : {}),
      };
    }

    const entry: StoredArtifactBridge = {
      artifactId,
      serverId,
      config,
      ...(sessionKey ? { sessionKey } : {}),
      ...(topic ? { topic } : {}),
      attachedAt: new Date().toISOString(),
    };
    this.bridges.set(artifactId, entry);

    let sessionBound = false;
    if (sessionKey) {
      this.eventRouter.bindArtifact(artifactId, {
        sessionKey,
        ...(topic ? { topic } : {}),
      });
      sessionBound = true;
    } else if (topic) {
      throw new ArtifactMcpBridgeError(
        'binding an artifact requires a canonical sessionKey (topic alone cannot derive a CatsCo sessionKey)',
        422,
        'missing_session_key',
      );
    }

    for (const manager of this.managers) {
      manager.addServer(serverId, config);
    }

    return {
      ok: true,
      artifactId,
      serverId,
      url: config.url,
      attachedManagers: this.managers.size,
      sessionBound,
    };
  }

  async unregisterArtifactBridge(
    rawArtifactId: string,
    options: { unbindSession?: boolean } = {},
  ): Promise<ArtifactMcpDetachResult> {
    const artifactId = String(rawArtifactId ?? '').trim();
    if (!artifactId) {
      throw new ArtifactMcpBridgeError('artifactId is required', 400, 'missing_artifact_id');
    }
    const existing = this.bridges.get(artifactId);
    const serverId = existing?.serverId ?? artifactServerId(artifactId);
    const existed = this.bridges.delete(artifactId);

    await Promise.allSettled(
      [...this.managers].map((manager) => manager.removeServer(serverId)),
    );

    let sessionUnbound = false;
    if (options.unbindSession) {
      this.eventRouter.unbindArtifact(artifactId);
      sessionUnbound = true;
    }

    return {
      ok: true,
      artifactId,
      serverId,
      existed,
      sessionUnbound,
    };
  }

  /** 按 MCP serverId 反查对应的 artifactId（用于限制 per-artifact bridge 仅能向自身 artifact 投递事件）。 */
  getBoundArtifactId(serverId: string): string | undefined {
    for (const bridge of this.bridges.values()) {
      if (bridge.serverId === serverId) return bridge.artifactId;
    }
    return undefined;
  }

  listArtifactBridges(): ArtifactMcpBridgeSummary[] {
    return [...this.bridges.values()].map((bridge) => ({
      artifactId: bridge.artifactId,
      serverId: bridge.serverId,
      url: bridge.config.url,
      hasBearerToken: Boolean(bridge.config.bearerToken),
      ...(bridge.sessionKey ? { sessionKey: bridge.sessionKey } : {}),
      ...(bridge.topic ? { topic: bridge.topic } : {}),
      attachedAt: bridge.attachedAt,
    }));
  }

  reset(): void {
    this.bridges.clear();
    this.managers.clear();
  }
}

/** 进程级单例：RuntimeFactory 挂载 McpClientManager，Dashboard 路由动态增删 Per-Artifact Bridge。 */
export const artifactMcpRegistry = new ArtifactMcpRegistry();
