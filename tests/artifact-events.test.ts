import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'http';
import {
  ARTIFACT_EVENT_SCHEMA,
  ArtifactEventValidationError,
  artifactEventFamily,
  normalizeArtifactEvent,
  resolveArtifactEventPriority,
  type ArtifactBindResult,
  type ArtifactEventEmitResult,
  type ArtifactEventEnvelope,
  type ArtifactEventSink,
  type ArtifactSessionBinding,
} from '../src/artifacts/artifact-event-contract';
import {
  formatAnnotationBatchPrompt,
  formatArtifactEventPrompt,
} from '../src/artifacts/artifact-event-formatter';
import { createArtifactEventsRouter } from '../src/dashboard/routes/artifact-events';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

function listen(app: express.Express): Promise<Server> {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    servers.push(server);
  });
}

function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function baseUrl(server: Server): string {
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  return `http://127.0.0.1:${addr.port}`;
}

class RecordingSink implements ArtifactEventSink {
  events: ArtifactEventEnvelope[] = [];
  bindings: ArtifactSessionBinding[] = [];
  emitResult: Partial<ArtifactEventEmitResult> = {};
  bindResult: Partial<ArtifactBindResult> = { ok: true };

  emitEvent(envelope: ArtifactEventEnvelope) {
    this.events.push(envelope);
    return { eventId: envelope.eventId, accepted: true, ...this.emitResult };
  }

  bindArtifactSession(binding: ArtifactSessionBinding) {
    this.bindings.push(binding);
    return { ok: true, binding, ...this.bindResult };
  }
}

async function startEventServer(sink: ArtifactEventSink): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createArtifactEventsRouter(sink));
  return baseUrl(await listen(app));
}

function a2uiActionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'a2ui_action',
    artifactId: 'art-123',
    componentId: 'btn-approve',
    actionName: 'approve',
    sessionKey: 'sess-1',
    actorUserId: 'user-9',
    ...overrides,
  };
}

function annotationCreateEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'annotation_create',
    artifactId: 'art-123',
    annotationId: 'ann-1',
    anchor: { type: 'text', exact: 'quarterly revenue', start: 12, end: 29 },
    quote: 'quarterly revenue',
    comment: 'This number looks stale.',
    ...overrides,
  };
}

describe('artifact event contract', () => {
  test('normalizes an a2ui_action event into a standard envelope', () => {
    const envelope = normalizeArtifactEvent(a2uiActionEvent());
    assert.equal(envelope.schema, ARTIFACT_EVENT_SCHEMA);
    assert.equal(envelope.family, 'a2ui');
    assert.equal(envelope.kind, 'a2ui_action');
    assert.equal(envelope.artifactId, 'art-123');
    assert.equal(envelope.sessionKey, 'sess-1');
    assert.equal(envelope.actorUserId, 'user-9');
    assert.equal(envelope.priority, 'immediate');
    assert.match(envelope.eventId, /^aev_/);
    assert.match(envelope.dedupKey, /^a2ui:art-123:btn-approve:/);
    assert.equal((envelope.payload as any).actionName, 'approve');
    assert.ok(!Number.isNaN(Date.parse(envelope.occurredAt)));
  });

  test('accepts snake_case fields and all a2ui kinds', () => {
    const form = normalizeArtifactEvent({
      type: 'a2ui_form_submit',
      artifact_id: 'art-9',
      component_id: 'form-1',
      form_data: { name: 'Ada', agree: true },
      session_key: 's',
      actor_user_id: 'u1',
    });
    assert.equal(form.kind, 'a2ui_form_submit');
    assert.equal((form.payload as any).formData.name, 'Ada');
    assert.equal((form.payload as any).actionName, 'submit');

    const state = normalizeArtifactEvent({
      event: 'a2ui_state_change',
      artifactId: 'art-9',
      componentId: 'slider-1',
      state: { value: 42 },
      previous_state: { value: 10 },
    });
    assert.equal(state.kind, 'a2ui_state_change');
    assert.equal((state.payload as any).state.value, 42);
    assert.equal((state.payload as any).previousState.value, 10);
  });

  test('normalizes annotation events with text and region anchors', () => {
    const text = normalizeArtifactEvent(annotationCreateEvent());
    assert.equal(text.family, 'annotation');
    assert.equal(text.priority, 'coalesce');
    assert.equal(text.dedupKey, 'ann:art-123:ann-1:annotation_create');
    const anchor = (text.payload as any).anchor;
    assert.equal(anchor.type, 'text');
    assert.equal(anchor.start, 12);

    const region = normalizeArtifactEvent(annotationCreateEvent({
      annotationId: 'ann-2',
      anchor: { type: 'region', x: 10, y: 20, width: 100, height: 50, page: 2 },
      quote: undefined,
    }));
    assert.equal((region.payload as any).anchor.type, 'region');
    assert.equal((region.payload as any).anchor.page, 2);
  });

  test('generates annotationId when omitted and rejects invalid inputs', () => {
    const generated = normalizeArtifactEvent(annotationCreateEvent({ annotationId: undefined, id: undefined }));
    assert.match((generated.payload as any).annotationId, /^ann_/);

    assert.throws(() => normalizeArtifactEvent(null), (e: any) => e.status === 400);
    assert.throws(() => normalizeArtifactEvent({ artifactId: 'a' }), (e: any) => e.status === 400);
    assert.throws(() => normalizeArtifactEvent({ kind: 'wat', artifactId: 'a' }), (e: any) => {
      assert.equal(e.status, 422);
      assert.equal(e.code, 'unknown_kind');
      return true;
    });
    assert.throws(() => normalizeArtifactEvent({ kind: 'a2ui_action', artifactId: 'a' }), (e: any) => {
      assert.equal(e.code, 'missing_field');
      return true;
    });
    assert.throws(() => normalizeArtifactEvent({
      kind: 'annotation_create', artifactId: 'a', comment: 'hi',
    }), (e: any) => {
      assert.equal(e.code, 'missing_anchor');
      return true;
    });
    assert.throws(() => normalizeArtifactEvent({
      kind: 'annotation_create', artifactId: 'a', quote: 'q',
    }), (e: any) => {
      assert.equal(e.code, 'missing_comment');
      return true;
    });
    assert.throws(() => normalizeArtifactEvent({
      kind: 'annotation_resolve', artifactId: 'a',
    }), (e: any) => {
      assert.equal(e.code, 'missing_annotation_id');
      return true;
    });
  });

  test('enforces json depth limits on nested payloads', () => {
    let nested: any = { leaf: 1 };
    for (let i = 0; i < 12; i += 1) nested = { wrap: nested };
    assert.throws(() => normalizeArtifactEvent({
      kind: 'a2ui_state_change', artifactId: 'a', componentId: 'c', state: nested,
    }), (e: any) => e instanceof ArtifactEventValidationError && e.code === 'field_too_deep');
  });

  test('a2ui interactions default to immediate, annotations to coalesce', () => {
    assert.equal(resolveArtifactEventPriority('a2ui_action'), 'immediate');
    assert.equal(resolveArtifactEventPriority('a2ui_form_submit'), 'immediate');
    assert.equal(resolveArtifactEventPriority('a2ui_state_change'), 'immediate');
    assert.equal(resolveArtifactEventPriority('annotation_create'), 'coalesce');
    assert.equal(resolveArtifactEventPriority('annotation_update'), 'coalesce');
    // Explicit batch submit escalates annotations to immediate.
    assert.equal(resolveArtifactEventPriority('annotation_create', { batchSubmit: true }), 'immediate');
    // Explicit priority input wins over defaults.
    assert.equal(resolveArtifactEventPriority('a2ui_action', { explicit: 'coalesce' }), 'coalesce');
    assert.throws(() => resolveArtifactEventPriority('a2ui_action', { explicit: 'urgent' }), /priority/);
  });

  test('batchSubmit flag in the event escalates envelope priority', () => {
    const envelope = normalizeArtifactEvent(annotationCreateEvent({ batchSubmit: true }));
    assert.equal(envelope.priority, 'immediate');
    const snake = normalizeArtifactEvent(annotationCreateEvent({ batchSubmit: undefined, batch_submit: true }));
    assert.equal(snake.priority, 'immediate');
    assert.equal((snake.payload as any).batchSubmit, true);
  });

  test('artifactEventFamily maps every kind', () => {
    for (const kind of ['a2ui_action', 'a2ui_form_submit', 'a2ui_state_change'] as const) {
      assert.equal(artifactEventFamily(kind), 'a2ui');
    }
    for (const kind of ['annotation_create', 'annotation_update', 'annotation_resolve', 'annotation_dismiss'] as const) {
      assert.equal(artifactEventFamily(kind), 'annotation');
    }
  });

  test('dedup keys collapse annotation updates and hash a2ui payloads', () => {
    const a = normalizeArtifactEvent(annotationCreateEvent());
    const b = normalizeArtifactEvent(annotationCreateEvent({ comment: 'different comment' }));
    assert.equal(a.dedupKey, b.dedupKey);

    const x = normalizeArtifactEvent(a2uiActionEvent({ params: { v: 1 } }));
    const y = normalizeArtifactEvent(a2uiActionEvent({ params: { v: 2 } }));
    assert.notEqual(x.dedupKey, y.dedupKey);
    // Key order in params does not change the dedup hash.
    const p1 = normalizeArtifactEvent(a2uiActionEvent({ params: { a: 1, b: 2 } }));
    const p2 = normalizeArtifactEvent(a2uiActionEvent({ params: { b: 2, a: 1 } }));
    assert.equal(p1.dedupKey, p2.dedupKey);
  });
});

describe('artifact event formatter', () => {
  test('renders a structured a2ui action prompt', () => {
    const envelope = normalizeArtifactEvent(a2uiActionEvent({ params: { confirm: true } }));
    const prompt = formatArtifactEventPrompt(envelope);
    assert.match(prompt, /\[Artifact A2UI Event\] a2ui_action/);
    assert.match(prompt, /Artifact: art-123/);
    assert.match(prompt, /Component: btn-approve/);
    assert.match(prompt, /Action: approve/);
    assert.match(prompt, /"confirm":true/);
    assert.match(prompt, /Actor: user-9/);
    assert.match(prompt, /Instructions:/);
  });

  test('renders form data as a readable list', () => {
    const envelope = normalizeArtifactEvent({
      kind: 'a2ui_form_submit',
      artifactId: 'art-1',
      componentId: 'survey',
      formData: { rating: 5, note: 'great' },
    });
    const prompt = formatArtifactEventPrompt(envelope);
    assert.match(prompt, /Form data:/);
    assert.match(prompt, /- rating: 5/);
    assert.match(prompt, /- note: great/);
  });

  test('renders annotation prompts with anchor, quote and comment', () => {
    const envelope = normalizeArtifactEvent(annotationCreateEvent());
    const prompt = formatArtifactEventPrompt(envelope);
    assert.match(prompt, /\[Artifact Annotation\] annotation_create/);
    assert.match(prompt, /Annotation: ann-1/);
    assert.match(prompt, /Anchor: text "quarterly revenue"/);
    assert.match(prompt, /Quote: "quarterly revenue"/);
    assert.match(prompt, /Comment: This number looks stale\./);
  });

  test('renders a merged batch prompt for multiple annotations', () => {
    const batch = [
      normalizeArtifactEvent(annotationCreateEvent()),
      normalizeArtifactEvent(annotationCreateEvent({ annotationId: 'ann-2', comment: 'Second note.' })),
      normalizeArtifactEvent({ kind: 'annotation_resolve', artifactId: 'art-123', annotationId: 'ann-3' }),
    ];
    const prompt = formatAnnotationBatchPrompt(batch);
    assert.match(prompt, /\[Artifact Annotation Batch\]/);
    assert.match(prompt, /Artifact: art-123/);
    assert.match(prompt, /Annotations: 3/);
    assert.match(prompt, /1\. Created \(annotation ann-1\)/);
    assert.match(prompt, /2\. Created \(annotation ann-2\)/);
    assert.match(prompt, /3\. Resolved \(annotation ann-3\)/);
    assert.match(prompt, /Second note\./);
  });
});

describe('artifact events dashboard route', () => {
  test('accepts a single event and returns 202 with eventId and dedup status', async () => {
    const sink = new RecordingSink();
    const base = await startEventServer(sink);

    const res = await fetch(`${base}/api/artifacts/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(a2uiActionEvent()),
    });
    assert.equal(res.status, 202);
    const body = await res.json() as any;
    assert.equal(body.ok, true);
    assert.equal(body.accepted, 1);
    assert.equal(body.results.length, 1);
    assert.match(body.results[0].eventId, /^aev_/);
    assert.equal(body.results[0].priority, 'immediate');
    assert.equal(body.results[0].deduplicated, false);

    assert.equal(sink.events.length, 1);
    assert.equal(sink.events[0].artifactId, 'art-123');
    assert.match(sink.events[0].prompt!, /a2ui_action/);
  });

  test('accepts a batch of mixed events and annotates batch prompts', async () => {
    const sink = new RecordingSink();
    const base = await startEventServer(sink);

    const res = await fetch(`${base}/api/artifacts/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          annotationCreateEvent({ batchSubmit: true }),
          annotationCreateEvent({ annotationId: 'ann-2', comment: 'Second', batchSubmit: true }),
          a2uiActionEvent(),
        ],
      }),
    });
    assert.equal(res.status, 202);
    const body = await res.json() as any;
    assert.equal(body.accepted, 3);
    assert.equal(sink.events.length, 3);
    assert.equal(sink.events[0].priority, 'immediate');
    assert.match(sink.events[0].batchPrompt!, /Annotation Batch/);
    assert.equal(sink.events[0].batchPrompt, sink.events[1].batchPrompt);
    assert.equal(sink.events[2].batchPrompt, undefined);
  });

  test('supports {event: {...}} and top-level array wire forms', async () => {
    const sink = new RecordingSink();
    const base = await startEventServer(sink);

    let res = await fetch(`${base}/api/artifacts/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: a2uiActionEvent() }),
    });
    assert.equal(res.status, 202);

    res = await fetch(`${base}/api/artifacts/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([a2uiActionEvent(), a2uiActionEvent({ componentId: 'c2' })]),
    });
    assert.equal(res.status, 202);
    const body = await res.json() as any;
    assert.equal(body.accepted, 2);
    assert.equal(sink.events.length, 3);
  });

  test('rejects malformed bodies with 400 and invalid events with 422', async () => {
    const sink = new RecordingSink();
    const base = await startEventServer(sink);

    let res = await fetch(`${base}/api/artifacts/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [] }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json() as any).code, 'empty_event_batch');

    res = await fetch(`${base}/api/artifacts/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json() as any).code, 'missing_events');

    res = await fetch(`${base}/api/artifacts/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'a2ui_action', artifactId: 'a' }),
    });
    assert.equal(res.status, 422);
    assert.equal((await res.json() as any).code, 'missing_field');
    // Nothing was emitted for a rejected batch.
    assert.equal(sink.events.length, 0);
  });

  test('validates the whole batch before emitting anything', async () => {
    const sink = new RecordingSink();
    const base = await startEventServer(sink);

    const res = await fetch(`${base}/api/artifacts/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [a2uiActionEvent(), { kind: 'nonsense', artifactId: 'a' }],
      }),
    });
    assert.equal(res.status, 422);
    assert.equal((await res.json() as any).code, 'unknown_kind');
    assert.equal(sink.events.length, 0);
  });

  test('surfaces sink deduplication in the response', async () => {
    const sink = new RecordingSink();
    sink.emitResult = { deduplicated: true };
    const base = await startEventServer(sink);

    const res = await fetch(`${base}/api/artifacts/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(annotationCreateEvent()),
    });
    assert.equal(res.status, 202);
    const body = await res.json() as any;
    assert.equal(body.deduplicated, 1);
    assert.equal(body.results[0].deduplicated, true);
  });

  test('binds an artifact to a sessionKey or topic', async () => {
    const sink = new RecordingSink();
    const base = await startEventServer(sink);

    const res = await fetch(`${base}/api/artifacts/art-123/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: 'sess-1', topic: 'p2p_1_2', boundByUserId: 'u9' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.ok, true);
    assert.equal(body.binding.artifactId, 'art-123');
    assert.equal(body.binding.sessionKey, 'sess-1');
    assert.equal(body.binding.topic, 'p2p_1_2');

    assert.equal(sink.bindings.length, 1);
    assert.equal(sink.bindings[0].boundByUserId, 'u9');
  });

  test('rejects bind without a canonical sessionKey and maps sink rejection to 409', async () => {
    const sink = new RecordingSink();
    const base = await startEventServer(sink);

    let res = await fetch(`${base}/api/artifacts/art-123/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 422);
    assert.equal((await res.json() as any).code, 'missing_session_key');

    // topic alone must also be rejected (CatsCo sessionKey is derived, not raw topic)
    res = await fetch(`${base}/api/artifacts/art-123/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'p2p_1_2' }),
    });
    assert.equal(res.status, 422);
    assert.equal((await res.json() as any).code, 'missing_session_key');

    sink.bindResult = { ok: false, reason: 'session not found' };
    res = await fetch(`${base}/api/artifacts/art-123/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: 'sess-gone' }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json() as any).code, 'bind_rejected');
  });
});
