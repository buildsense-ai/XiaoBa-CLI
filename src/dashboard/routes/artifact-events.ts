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

const MAX_EVENTS_PER_REQUEST = 100;

/**
 * Artifact A2UI / annotation event intake routes.
 *
 * Mount under `/api` (e.g. `app.use('/api', auth, createArtifactEventsRouter(sink))`)
 * so requests land on:
 *   POST /api/artifacts/events
 *   POST /api/artifacts/:artifactId/bind
 *
 * The sink is injected so Track 1's ExternalEventRouter can be wired in with a
 * one-line adapter once it lands.
 */
export function createArtifactEventsRouter(sink: ArtifactEventSink): Router {
  const router = Router();

  router.post('/artifacts/events', async (req, res) => {
    try {
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
      if (!sessionKey && !topic) {
        return res.status(422).json({
          ok: false,
          code: 'missing_binding_target',
          error: 'bind requires sessionKey or topic',
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
  const status = Number((error as any)?.status) || 500;
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    ok: false,
    code: (error as any)?.code || 'artifact_event_error',
    error: (error as Error)?.message || String(error),
  });
}
