import { Router } from 'express';
import {
  ArtifactEventValidationError,
  normalizeArtifactEvent,
  type ArtifactBindResult,
  type ArtifactEventEnvelope,
  type ArtifactEventSink,
  type ArtifactSessionBinding,
} from '../../artifacts/artifact-event-contract';
import {
  formatAnnotationBatchPrompt,
  formatArtifactEventPrompt,
} from '../../artifacts/artifact-event-formatter';
import {
  ArtifactMcpBridgeError,
  type ArtifactMcpBridgeSink,
} from '../../mcp/artifact-mcp-registry';

const MAX_EVENTS_PER_REQUEST = 100;

/**
 * Artifact A2UI / annotation event intake routes (plus optional per-artifact
 * MCP bridge attach/detach routes).
 *
 * Mount under `/api` (e.g. `app.use('/api', auth, createArtifactEventsRouter(sink, bridgeSink))`)
 * so requests land on:
 *   POST   /api/artifacts/events
 *   POST   /api/artifacts/:artifactId/bind
 *   POST   /api/artifacts/:artifactId/mcp/attach
 *   DELETE /api/artifacts/:artifactId/mcp/attach
 *   POST   /api/artifacts/:artifactId/mcp/detach
 *   GET    /api/artifacts/mcp/bridges
 */
export interface ArtifactEventsRouterOptions {
  /**
   * 是否允许通过 HTTP 动态挂载/卸载/查询 Per-Artifact MCP Bridge。
   * 未配置 DASHBOARD_API_KEY 且未显式开启时默认拒绝，防止本机任意进程无鉴权注入或篡改 MCP 工具。
   */
  allowMcpAttach?: boolean;
  /**
   * 是否允许通过 HTTP 投递 Artifact 事件与绑定会话（/artifacts/events、/artifacts/:id/bind）。
   * 未配置 DASHBOARD_API_KEY 且未显式开启时默认拒绝，防止本机任意进程无鉴权向已知 sessionKey 注入提示词。
   */
  allowArtifactEvents?: boolean;
}

export function createArtifactEventsRouter(
  sink: ArtifactEventSink,
  bridgeSink?: ArtifactMcpBridgeSink,
  options: ArtifactEventsRouterOptions = {},
): Router {
  const router = Router();
  const allowMcpAttach = options.allowMcpAttach !== false;
  const allowArtifactEvents = options.allowArtifactEvents !== false;

  router.post('/artifacts/events', async (req, res) => {
    try {
      if (!allowArtifactEvents) {
        return res.status(403).json({
          ok: false,
          code: 'artifact_events_requires_auth',
          error: 'Artifact event intake requires DASHBOARD_API_KEY (or XIAOBA_ALLOW_LOCAL_ARTIFACT_EVENTS=1)',
        });
      }
      const rawEvents = extractEventInputs(req.body);
      if (rawEvents.length === 0) {
        return res.status(400).json({
          ok: false,
          code: 'empty_event_batch',
          error: 'request must contain at least one event',
        });
      }
      if (rawEvents.length > MAX_EVENTS_PER_REQUEST) {
        return res.status(422).json({
          ok: false,
          code: 'batch_too_large',
          error: `a single request accepts at most ${MAX_EVENTS_PER_REQUEST} events`,
        });
      }

      // Validate everything before emitting anything: a malformed batch must
      // not partially wake the session.
      const envelopes = rawEvents.map(normalizeArtifactEvent);
      attachPrompts(envelopes);

      const results = [];
      for (const envelope of envelopes) {
        const emitted = await sink.emitEvent(envelope);
        results.push({
          eventId: emitted.eventId || envelope.eventId,
          kind: envelope.kind,
          family: envelope.family,
          priority: envelope.priority,
          dedupKey: envelope.dedupKey,
          accepted: emitted.accepted !== false,
          deduplicated: emitted.deduplicated === true,
          ...(emitted.queueDepth !== undefined ? { queueDepth: emitted.queueDepth } : {}),
        });
      }

      const accepted = results.filter(result => result.accepted).length;
      const deduplicated = results.filter(result => result.deduplicated).length;
      return res.status(202).json({
        ok: true,
        accepted,
        deduplicated,
        results,
      });
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  router.post('/artifacts/:artifactId/bind', async (req, res) => {
    try {
      if (!allowArtifactEvents) {
        return res.status(403).json({
          ok: false,
          code: 'artifact_events_requires_auth',
          error: 'Artifact session binding requires DASHBOARD_API_KEY (or XIAOBA_ALLOW_LOCAL_ARTIFACT_EVENTS=1)',
        });
      }
      const artifactId = String(req.params.artifactId || '').trim();
      if (!artifactId) {
        return res.status(400).json({
          ok: false,
          code: 'missing_artifact_id',
          error: 'artifactId path parameter is required',
        });
      }

      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const sessionKey = firstNonEmpty(body.sessionKey, body.session_key);
      const topic = firstNonEmpty(body.topic);
      if (!sessionKey) {
        return res.status(422).json({
          ok: false,
          code: 'missing_session_key',
          error: 'bind requires a canonical sessionKey (topic alone cannot derive a CatsCo sessionKey)',
        });
      }

      const binding: ArtifactSessionBinding = {
        artifactId,
        sessionKey,
        topic,
        boundByUserId: firstNonEmpty(body.boundByUserId, body.bound_by_user_id, body.actorUserId, body.actor_user_id),
        boundAt: new Date().toISOString(),
      };

      const result: ArtifactBindResult = await sink.bindArtifactSession(binding);
      if (!result || result.ok === false) {
        return res.status(409).json({
          ok: false,
          code: 'bind_rejected',
          error: result?.reason || 'artifact session binding was rejected',
        });
      }
      return res.status(200).json({
        ok: true,
        binding: result.binding || binding,
      });
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  if (bridgeSink) {
    const requireMcpAttachAuth = (res: any): boolean => {
      if (allowMcpAttach) return true;
      res.status(403).json({
        ok: false,
        code: 'mcp_attach_requires_auth',
        error: 'MCP bridge management requires DASHBOARD_API_KEY (or XIAOBA_ALLOW_LOCAL_MCP_ATTACH=1)',
      });
      return false;
    };

    router.get('/artifacts/mcp/bridges', async (_req, res) => {
      try {
        if (!requireMcpAttachAuth(res)) return;
        const bridges = await bridgeSink.listArtifactBridges();
        return res.status(200).json({
          ok: true,
          bridges,
        });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    router.post('/artifacts/:artifactId/mcp/attach', async (req, res) => {
      try {
        if (!requireMcpAttachAuth(res)) return;
        const artifactId = String(req.params.artifactId || '').trim();
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const result = await bridgeSink.registerArtifactBridge({
          artifactId,
          url: firstNonEmpty(body.url, body.mcpUrl, body.mcp_url) || '',
          bearerToken: firstNonEmpty(body.bearerToken, body.bearer_token, body.token),
          headers: body.headers && typeof body.headers === 'object' ? body.headers : undefined,
          timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
          sessionKey: firstNonEmpty(body.sessionKey, body.session_key),
          topic: firstNonEmpty(body.topic),
        });
        return res.status(200).json(result);
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    const handleDetach = async (req: any, res: any) => {
      try {
        if (!requireMcpAttachAuth(res)) return;
        const artifactId = String(req.params.artifactId || '').trim();
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const unbindSession =
          body.unbindSession === true ||
          body.unbind_session === true ||
          req.query?.unbind === '1' ||
          req.query?.unbind === 'true';
        const result = await bridgeSink.unregisterArtifactBridge(artifactId, { unbindSession });
        return res.status(200).json(result);
      } catch (error) {
        return respondWithError(res, error);
      }
    };

    router.delete('/artifacts/:artifactId/mcp/attach', handleDetach);
    router.post('/artifacts/:artifactId/mcp/detach', handleDetach);
  }

  return router;
}

/**
 * Accept a single event object, an array of events, or a wrapper object with
 * `event` / `events` fields.
 */
function extractEventInputs(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') {
    throw new ArtifactEventValidationError(
      'request body must be a JSON object or array of events',
      400,
      'invalid_body',
    );
  }
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.events)) return record.events;
  // Wrapper form: { event: {...} }
  if (record.event && typeof record.event === 'object' && !Array.isArray(record.event)) {
    return [record.event];
  }
  // Treat the body itself as a single event if it carries a recognizable kind
  // (kind / type / event may all be used as the kind field name).
  const kind = record.kind ?? record.type ?? record.event;
  if (typeof kind === 'string') return [record];
  throw new ArtifactEventValidationError(
    'request must provide event, events, or an event object',
    400,
    'missing_events',
  );
}

/**
 * Render per-event wake prompts, plus a shared batch prompt when several
 * annotation events target the same artifact.
 */
function attachPrompts(envelopes: ArtifactEventEnvelope[]): void {
  for (const envelope of envelopes) {
    envelope.prompt = formatArtifactEventPrompt(envelope);
  }
  const byArtifact = new Map<string, ArtifactEventEnvelope[]>();
  for (const envelope of envelopes) {
    if (envelope.family !== 'annotation') continue;
    const group = byArtifact.get(envelope.artifactId) ?? [];
    group.push(envelope);
    byArtifact.set(envelope.artifactId, group);
  }
  for (const group of byArtifact.values()) {
    if (group.length < 2) continue;
    const batchPrompt = formatAnnotationBatchPrompt(group);
    for (const envelope of group) {
      envelope.batchPrompt = batchPrompt;
    }
  }
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return undefined;
}

function respondWithError(res: any, error: unknown): any {
  if (error instanceof ArtifactEventValidationError) {
    return res.status(error.status).json({
      ok: false,
      code: error.code,
      error: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
  }
  if (error instanceof ArtifactMcpBridgeError) {
    return res.status(error.status).json({
      ok: false,
      code: error.code,
      error: error.message,
    });
  }
  const status = Number((error as any)?.status) || 500;
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    ok: false,
    code: (error as any)?.code || 'artifact_event_error',
    error: (error as Error)?.message || String(error),
  });
}
