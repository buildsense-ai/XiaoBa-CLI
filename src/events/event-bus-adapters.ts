/**
 * 外部事件总线适配层：把通用 MCP Client Manager（Track 2）与
 * Artifacts A2UI / 批注路由（Track 3）统一接到 ExternalEventRouter（Track 1）。
 */
import {
  externalEventRouter,
  type ExternalEventEnvelope,
  type ExternalEventRouter,
} from './external-event-router';
import type { McpForwardedEvent } from '../mcp/mcp-notification-adapter';
import type {
  ArtifactBindResult,
  ArtifactEventEmitResult,
  ArtifactEventEnvelope,
  ArtifactEventSink,
  ArtifactSessionBinding,
} from '../artifacts/artifact-event-contract';
import {
  formatAnnotationBatchPrompt,
  formatArtifactEventPrompt,
} from '../artifacts/artifact-event-formatter';

/** 默认不唤醒模型回合的高频/诊断类 MCP 通知方法。 */
const NON_WAKING_MCP_METHODS = new Set([
  'notifications/message',
  'notifications/progress',
  'notifications/tools/list_changed',
  'notifications/prompts/list_changed',
  'notifications/resources/list_changed',
]);

export interface ForwardMcpEventOptions {
  /**
   * Per-Artifact MCP Bridge 作用域锁定：设置后该 server 发出的通知只能路由到
   * 此 artifactId（忽略服务端伪造的 sessionKey / topic / 其它 artifactId）。
   */
  boundArtifactId?: string;
  /**
   * 是否允许该 MCP server 直接指定 sessionKey/topic 唤醒任意会话（默认 false：
   * 只允许通过已绑定的 artifactId 路由，防止外部 MCP server 越权唤醒他人或群会话）。
   */
  allowSessionTargeting?: boolean;
}

/**
 * 将 McpClientManager 产生的规范化通知转发到 ExternalEventRouter。
 */
export function forwardMcpEventToExternalRouter(
  event: McpForwardedEvent,
  router: ExternalEventRouter = externalEventRouter,
  options: ForwardMcpEventOptions = {},
): boolean {
  if (NON_WAKING_MCP_METHODS.has(event.method)) {
    return false;
  }

  let target: ExternalEventEnvelope['target'];
  if (options.boundArtifactId) {
    // Per-Artifact Bridge 强制隔离到自身 artifactId，忽略服务端传入的任意会话路由。
    target = { artifactId: options.boundArtifactId };
  } else {
    const allowDirectSession = options.allowSessionTargeting === true;
    target = {
      ...(allowDirectSession && event.sessionKey ? { sessionKey: event.sessionKey } : {}),
      ...(allowDirectSession && event.topic ? { topic: event.topic } : {}),
      ...(event.artifactId ? { artifactId: event.artifactId } : {}),
    };
  }
  if (!target.sessionKey && !target.topic && !target.artifactId) {
    return false;
  }

  const parsedCreatedAt = Date.parse(event.createdAt);
  // 仅当服务端显式携带 event_id/eventId 时才进入 24h 去重表；
  // 否则（例如多次 notifications/resources/updated 针对同一 URI）不去重，避免订阅变一次性。
  const dedupeEventId = event.hasExplicitEventId ? event.eventId : undefined;

  const envelope: ExternalEventEnvelope = {
    ...(dedupeEventId ? { eventId: dedupeEventId } : {}),
    source: `mcp:${event.serverId}`,
    type: event.type,
    target,
    priority: event.priority === 'critical' || event.priority === 'high' ? 'immediate' : 'normal',
    payload: {
      serverId: event.serverId,
      method: event.method,
      ...event.payload,
    },
    ...(Number.isFinite(parsedCreatedAt) ? { createdAt: parsedCreatedAt } : {}),
  };
  return router.emit(envelope);
}

/**
 * 渲染单条或经防抖合并后的 Artifact 事件提示文本：
 * - 单条：使用 formatArtifactEventPrompt；
 * - 多条合并批注（payload.items）：使用 formatAnnotationBatchPrompt 保留全部批注。
 */
export function renderCoalescedArtifactPrompt(event: ExternalEventEnvelope): string {
  const payload = event.payload as { items?: unknown[] } | ArtifactEventEnvelope | undefined;
  if (payload && typeof payload === 'object' && Array.isArray((payload as { items?: unknown[] }).items)) {
    const items = (payload as { items: unknown[] }).items.filter(isArtifactEventEnvelope);
    if (items.length > 1 && items.every((item) => item.family === 'annotation')) {
      return formatAnnotationBatchPrompt(items);
    }
    if (items.length > 0) {
      return items.map((item) => item.prompt || formatArtifactEventPrompt(item)).join('\n\n---\n\n');
    }
  }
  if (isArtifactEventEnvelope(payload)) {
    return payload.batchPrompt || payload.prompt || formatArtifactEventPrompt(payload);
  }
  return `（外部事件唤醒：来源 ${event.source}，类型 ${event.type}）`;
}

function isArtifactEventEnvelope(value: unknown): value is ArtifactEventEnvelope {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as ArtifactEventEnvelope).artifactId === 'string' &&
    typeof (value as ArtifactEventEnvelope).kind === 'string' &&
    typeof (value as ArtifactEventEnvelope).family === 'string',
  );
}

/**
 * 为 Dashboard 的 Artifact A2UI / 批注路由创建基于 ExternalEventRouter 的 Sink。
 */
export function createExternalEventArtifactSink(
  router: ExternalEventRouter = externalEventRouter,
): ArtifactEventSink {
  return {
    emitEvent(envelope: ArtifactEventEnvelope): ArtifactEventEmitResult {
      const parsedOccurredAt = Date.parse(envelope.occurredAt);
      // 调用方传入 clientEventId/eventId 时使用稳定幂等键；未传入时不强制用随机 UUID 占去重表。
      const routerEventId = envelope.clientEventId
        ? `artifact:${envelope.artifactId}:${envelope.clientEventId}`
        : undefined;

      const routedEnvelope: ExternalEventEnvelope = {
        ...(routerEventId ? { eventId: routerEventId } : {}),
        source: envelope.family === 'a2ui' ? 'artifact:a2ui' : 'artifact:annotation',
        type: envelope.kind,
        target: {
          artifactId: envelope.artifactId,
          ...(envelope.sessionKey ? { sessionKey: envelope.sessionKey } : {}),
          ...(envelope.topic ? { topic: envelope.topic } : {}),
        },
        ...(envelope.actorUserId ? { actorUserId: envelope.actorUserId } : {}),
        // 存完整 ArtifactEventEnvelope，防抖合并后 mergeEventPayloads 会收集为 { items: [...] }
        // 并由 renderCoalescedArtifactPrompt 渲染全部批注（不会丢弃第 2..N 条）。
        payload: envelope,
        priority: envelope.priority === 'immediate' ? 'immediate' : 'normal',
        ...(Number.isFinite(parsedOccurredAt) ? { createdAt: parsedOccurredAt } : {}),
        buildText: renderCoalescedArtifactPrompt,
      };

      const result = router.emitWithResult(routedEnvelope);
      return {
        eventId: envelope.eventId,
        accepted: result.accepted,
        deduplicated: result.reason === 'duplicate',
      };
    },

    bindArtifactSession(binding: ArtifactSessionBinding): ArtifactBindResult {
      // 不再回退到 raw topic：CatsCo sessionKey 是派生值，直接用 topic 会入队到错误会话。
      const sessionKey = (binding.sessionKey || '').trim();
      if (!sessionKey) {
        return {
          ok: false,
          reason: 'sessionKey is required (raw topic cannot substitute for a CatsCo sessionKey)',
        };
      }
      router.bindArtifact(binding.artifactId, {
        sessionKey,
        ...(binding.topic ? { topic: binding.topic } : {}),
      });
      return {
        ok: true,
        binding: {
          ...binding,
          sessionKey,
        },
      };
    },
  };
}
