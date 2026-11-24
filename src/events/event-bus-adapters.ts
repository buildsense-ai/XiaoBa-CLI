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

/**
 * 将 McpClientManager 产生的规范化通知转发到 ExternalEventRouter。
 * 无任何路由目标（sessionKey/topic/artifactId 均缺失）的通知会被路由安全忽略并返回 false。
 */
export function forwardMcpEventToExternalRouter(
  event: McpForwardedEvent,
  router: ExternalEventRouter = externalEventRouter,
): boolean {
  const target = {
    ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
    ...(event.topic ? { topic: event.topic } : {}),
    ...(event.artifactId ? { artifactId: event.artifactId } : {}),
  };
  if (!target.sessionKey && !target.topic && !target.artifactId) {
    return false;
  }

  const parsedCreatedAt = Date.parse(event.createdAt);
  const envelope: ExternalEventEnvelope = {
    eventId: event.eventId,
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
 * 为 Dashboard 的 Artifact A2UI / 批注路由创建基于 ExternalEventRouter 的 Sink。
 */
export function createExternalEventArtifactSink(
  router: ExternalEventRouter = externalEventRouter,
): ArtifactEventSink {
  return {
    emitEvent(envelope: ArtifactEventEnvelope): ArtifactEventEmitResult {
      const parsedOccurredAt = Date.parse(envelope.occurredAt);
      const renderedPrompt = envelope.batchPrompt || envelope.prompt;
      const routedEnvelope: ExternalEventEnvelope = {
        eventId: envelope.eventId,
        source: envelope.family === 'a2ui' ? 'artifact:a2ui' : 'artifact:annotation',
        type: envelope.kind,
        target: {
          artifactId: envelope.artifactId,
          ...(envelope.sessionKey ? { sessionKey: envelope.sessionKey } : {}),
          ...(envelope.topic ? { topic: envelope.topic } : {}),
        },
        ...(envelope.actorUserId ? { actorUserId: envelope.actorUserId } : {}),
        payload: envelope.payload,
        priority: envelope.priority === 'immediate' ? 'immediate' : 'normal',
        ...(Number.isFinite(parsedOccurredAt) ? { createdAt: parsedOccurredAt } : {}),
        ...(renderedPrompt ? { buildText: () => renderedPrompt } : {}),
      };

      const accepted = router.emit(routedEnvelope);
      return {
        eventId: envelope.eventId,
        accepted,
        deduplicated: !accepted,
      };
    },

    bindArtifactSession(binding: ArtifactSessionBinding): ArtifactBindResult {
      const sessionKey = (binding.sessionKey || binding.topic || '').trim();
      if (!sessionKey) {
        return {
          ok: false,
          reason: 'missing_binding_target',
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
