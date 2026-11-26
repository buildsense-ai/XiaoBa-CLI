/**
 * 跨进程 Connector 事件桥（解决 Dashboard 进程 ↔ CatsCompany 子进程隔离问题）。
 *
 * 部署形态下 Dashboard 通过 ServiceManager spawn 独立的 catscompany 子进程：
 * - Connector 进程启动时调用 `startConnectorEventBridge()`，在 127.0.0.1:0 监听
 *   仅供本机访问的内部 HTTP 服务（带随机 32B Bearer token），并把 `{ port, token, pid }`
 *   原子写入 `<runtimeRoot>/connector-event-bridge.json`（0o600）。
 * - Dashboard 进程通过 `createForwardingArtifactEventSink()` /
 *   `createForwardingArtifactMcpBridgeSink()` 读取该描述符并转发到活着的 Connector 进程；
 *   若 Connector 未运行则返回 503 connector_unavailable（绝不静默返回 200/202 丢事件）。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  ArtifactEventValidationError,
  type ArtifactBindResult,
  type ArtifactEventEmitResult,
  type ArtifactEventEnvelope,
  type ArtifactEventSink,
  type ArtifactSessionBinding,
} from '../artifacts/artifact-event-contract';
import {
  ArtifactMcpBridgeError,
  type ArtifactMcpAttachResult,
  type ArtifactMcpBridgeRegistration,
  type ArtifactMcpBridgeSink,
  type ArtifactMcpBridgeSummary,
  type ArtifactMcpDetachResult,
} from '../mcp/artifact-mcp-registry';
import { createArtifactEventsRouter } from '../dashboard/routes/artifact-events';

const BRIDGE_DESCRIPTOR_FILENAME = 'connector-event-bridge.json';

export interface ConnectorEventBridgeDescriptor {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

export interface ConnectorEventBridgeHandle {
  port: number;
  token: string;
  descriptorPath: string;
  stop: () => Promise<void>;
}

export function getConnectorEventBridgePath(runtimeRoot: string): string {
  return path.join(runtimeRoot, BRIDGE_DESCRIPTOR_FILENAME);
}

/** 在 Connector 进程内启动 loopback-only 内部事件桥，供 Dashboard 跨进程转发。 */
export async function startConnectorEventBridge(options: {
  runtimeRoot: string;
  sink: ArtifactEventSink;
  bridgeSink?: ArtifactMcpBridgeSink;
}): Promise<ConnectorEventBridgeHandle> {
  const token = crypto.randomBytes(32).toString('hex');
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.use('/internal', (req, res, next) => {
    const auth = String(req.headers.authorization || '');
    const expected = `Bearer ${token}`;
    if (auth.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
      return res.status(401).json({ ok: false, code: 'unauthorized', error: 'invalid internal bridge token' });
    }
    return next();
  }, createArtifactEventsRouter(options.sink, options.bridgeSink));

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const descriptorPath = getConnectorEventBridgePath(options.runtimeRoot);
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  const descriptor: ConnectorEventBridgeDescriptor = {
    port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const tmpPath = `${descriptorPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(descriptor, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, descriptorPath);

  let stopped = false;
  return {
    port,
    token,
    descriptorPath,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        const raw = fs.readFileSync(descriptorPath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<ConnectorEventBridgeDescriptor>;
        if (parsed.pid === process.pid) {
          fs.unlinkSync(descriptorPath);
        }
      } catch {
        // 已被覆盖或清理，忽略。
      }
    },
  };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

export function readLiveConnectorBridgeDescriptor(runtimeRoot: string): ConnectorEventBridgeDescriptor | null {
  const descriptorPath = getConnectorEventBridgePath(runtimeRoot);
  try {
    const raw = fs.readFileSync(descriptorPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ConnectorEventBridgeDescriptor>;
    if (
      typeof parsed.port !== 'number' ||
      !Number.isInteger(parsed.port) ||
      parsed.port <= 0 ||
      typeof parsed.token !== 'string' ||
      !parsed.token ||
      typeof parsed.pid !== 'number' ||
      !isPidAlive(parsed.pid)
    ) {
      return null;
    }
    return parsed as ConnectorEventBridgeDescriptor;
  } catch {
    return null;
  }
}

export class ConnectorBridgeError extends Error {
  constructor(
    message: string,
    public readonly status: number = 503,
    public readonly code: string = 'connector_unavailable',
  ) {
    super(message);
    this.name = 'ConnectorBridgeError';
  }
}

async function forwardJson(
  runtimeRoot: string,
  method: 'GET' | 'POST' | 'DELETE',
  subpath: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const descriptor = readLiveConnectorBridgeDescriptor(runtimeRoot);
  if (!descriptor) {
    throw new ConnectorBridgeError(
      'CatsCo connector process is not running; cannot deliver artifact event',
      503,
      'connector_unavailable',
    );
  }
  const res = await fetch(`http://127.0.0.1:${descriptor.port}/internal${subpath}`, {
    method,
    headers: {
      authorization: `Bearer ${descriptor.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data: any = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  return { status: res.status, data };
}

/** Dashboard 侧转发 Sink：把事件与绑定请求转发到活着的 Connector 子进程。 */
export function createForwardingArtifactEventSink(runtimeRoot: string): ArtifactEventSink {
  return {
    async emitEvent(envelope: ArtifactEventEnvelope): Promise<ArtifactEventEmitResult> {
      const wireBody: Record<string, unknown> = {
        kind: envelope.kind,
        artifactId: envelope.artifactId,
        ...(envelope.clientEventId ? { clientEventId: envelope.clientEventId } : {}),
        ...(envelope.sessionKey ? { sessionKey: envelope.sessionKey } : {}),
        ...(envelope.topic ? { topic: envelope.topic } : {}),
        ...(envelope.actorUserId ? { actorUserId: envelope.actorUserId } : {}),
        occurredAt: envelope.occurredAt,
        priority: envelope.priority,
        ...(envelope.payload as unknown as Record<string, unknown>),
      };
      const { status, data } = await forwardJson(runtimeRoot, 'POST', '/artifacts/events', wireBody);
      if (status >= 400) {
        throw new ConnectorBridgeError(
          data?.error || `connector rejected artifact event (HTTP ${status})`,
          status,
          data?.code || 'connector_forward_failed',
        );
      }
      const first = Array.isArray(data?.results) ? data.results[0] : undefined;
      return {
        eventId: first?.eventId || envelope.eventId,
        accepted: first ? first.accepted !== false : data?.accepted > 0,
        deduplicated: first ? first.deduplicated === true : data?.deduplicated > 0,
      };
    },

    async bindArtifactSession(binding: ArtifactSessionBinding): Promise<ArtifactBindResult> {
      const { status, data } = await forwardJson(
        runtimeRoot,
        'POST',
        `/artifacts/${encodeURIComponent(binding.artifactId)}/bind`,
        {
          sessionKey: binding.sessionKey,
          topic: binding.topic,
          boundByUserId: binding.boundByUserId,
        },
      );
      if (status >= 400) {
        return {
          ok: false,
          reason: data?.error || `connector rejected bind (HTTP ${status})`,
        };
      }
      return {
        ok: true,
        binding: data?.binding || binding,
      };
    },
  };
}

/** Dashboard 侧转发 BridgeSink：把 Per-Artifact MCP 挂载/卸载转发到 Connector 子进程。 */
export function createForwardingArtifactMcpBridgeSink(runtimeRoot: string): ArtifactMcpBridgeSink {
  return {
    async registerArtifactBridge(input: ArtifactMcpBridgeRegistration): Promise<ArtifactMcpAttachResult> {
      const { status, data } = await forwardJson(
        runtimeRoot,
        'POST',
        `/artifacts/${encodeURIComponent(input.artifactId)}/mcp/attach`,
        input,
      );
      if (status >= 400) {
        throw new ArtifactMcpBridgeError(
          data?.error || `connector rejected mcp attach (HTTP ${status})`,
          status,
          data?.code || 'connector_forward_failed',
        );
      }
      return data as ArtifactMcpAttachResult;
    },

    async unregisterArtifactBridge(
      artifactId: string,
      options?: { unbindSession?: boolean },
    ): Promise<ArtifactMcpDetachResult> {
      const query = options?.unbindSession ? '?unbind=1' : '';
      const { status, data } = await forwardJson(
        runtimeRoot,
        'DELETE',
        `/artifacts/${encodeURIComponent(artifactId)}/mcp/attach${query}`,
      );
      if (status >= 400) {
        throw new ArtifactMcpBridgeError(
          data?.error || `connector rejected mcp detach (HTTP ${status})`,
          status,
          data?.code || 'connector_forward_failed',
        );
      }
      return data as ArtifactMcpDetachResult;
    },

    async listArtifactBridges(): Promise<ArtifactMcpBridgeSummary[]> {
      return listForwardingArtifactMcpBridges(runtimeRoot);
    },
  };
}

/** 异步拉取 Connector 进程中挂载的 Artifact MCP Bridges。 */
export async function listForwardingArtifactMcpBridges(runtimeRoot: string): Promise<ArtifactMcpBridgeSummary[]> {
  const { status, data } = await forwardJson(runtimeRoot, 'GET', '/artifacts/mcp/bridges');
  if (status >= 400) {
    throw new ArtifactMcpBridgeError(
      data?.error || `connector rejected bridges list (HTTP ${status})`,
      status,
      data?.code || 'connector_forward_failed',
    );
  }
  return Array.isArray(data?.bridges) ? data.bridges : [];
}
