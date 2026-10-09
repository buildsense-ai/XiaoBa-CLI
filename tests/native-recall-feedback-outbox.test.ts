import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeRecallFeedbackOutbox, feedbackEvent } from '../src/core/native-recall-feedback-outbox';
import { dailyKnowledgeRef, hashedRecallRef } from '../src/core/native-recall-attribution';
import { saveCatscoLogAgentState } from '../src/utils/catsco-log-agent-state';
import { Logger } from '../src/utils/logger';

const DOC = `akd-${'a'.repeat(24)}`;
const REV = `akr-${'b'.repeat(64)}`;
const ENTRY = `ake-${'c'.repeat(24)}`;
const KNOWLEDGE_REF = dailyKnowledgeRef(DOC, REV, ENTRY);
const KNOWLEDGE_ANCHOR = { kind: 'knowledge_entry', id: ENTRY, document_id: DOC, revision: REV };
const SESSION_ANCHOR = { kind: 'session_query', id: 'turn-0', stream_id: 'stream-1',
  session_id: 's-1', session_type: 'main', byte_offset: 0, byte_length: 0,
  revision: 'a'.repeat(64) };
const SOURCE_REF = hashedRecallRef('source', [SESSION_ANCHOR, null]);

function dir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kc-feedback-outbox-'));
}
function env(base: string, user = 'user-token'): NodeJS.ProcessEnv {
  return {
    CATSLOG_API_BASE_URL: base,
    CATSCO_LOG_API_BASE_URL: base,
    CATSCO_USER_TOKEN: user,
    CATSLOG_MEMORY_ENABLED: 'true',
    CATSCO_LOG_UPLOAD_ENABLED: 'true',
  };
}
function state(working: string, token = 'skill-token'): void {
  saveCatscoLogAgentState(path.join(working, 'data', 'catsco-log-agent-state.json'), {
    deviceId: 'device-1', userId: 'user-1',
    token: 'login-token', memoryWriteToken: 'memory-token',
    skillToken: token, skillTokenId: 'skill-id-1',
    skillTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as any);
}
function event(kind: 'native_recall' | 'branch_source' = 'native_recall'): Record<string, unknown> {
  const observed = kind === 'branch_source'
    ? [{ ref: SOURCE_REF, anchor: SESSION_ANCHOR, disclosure: 'metadata' }]
    : [{ ref: KNOWLEDGE_REF, anchor: KNOWLEDGE_ANCHOR, disclosure: 'metadata' }];
  return {
    event_id: `feedback-${Math.random().toString(36).slice(2)}`,
    trace_id: `recall-${Math.random().toString(36).slice(2)}`,
    kind, outcome: 'completed', occurred_at_ms: 1,
    observed,
    delivered: observed.map(s => ({ ref: s.ref, disclosure: 'metadata' })),
    cited: observed.map(s => s.ref), retained: observed.map(s => s.ref),
    citation_semantics: 'explicit_ref_match_not_causal_use',
    delivery_semantics: kind === 'branch_source' ? 'branch_summary_with_refs_not_source_body' : 'submitted_in_model_input',
    retained_semantics: 'final_explicit_ref_match_not_semantic_adoption',
    lifecycle: 'turn_local_no_carryover',
  };
}
function queueFile(working: string): string {
  return path.join(working, 'data', 'catsco-log-agent-state.json.knowledge-feedback.json');
}
function client(outcomes: { event_id: string; applied: boolean }[] | ((body: any) => any)) {
  return () => ({
    async reportKnowledgeSourceFeedback(input: any) {
      const data = typeof outcomes === 'function' ? outcomes(input) : outcomes;
      return { schema_version: 1, claim_semantics: 'client_claim_not_server_attestation', outcomes: data };
    },
  });
}

test('feedbackEvent requires canonical anchors and subset ordering', () => {
  // No anchor -> envelope rejected (whole event dropped, never rewritten).
  const bare = event(); (bare.observed as any[])[0] = { ref: KNOWLEDGE_REF, disclosure: 'metadata' };
  assert.equal(feedbackEvent(bare), undefined);
  // cited/ref must be delivered; delivered must be observed.
  const notDelivered = event(); notDelivered.delivered = [];
  assert.equal(feedbackEvent(notDelivered), undefined);
  const fabricated = event(); (fabricated.observed as any[])[0].ref = 'catslog:knowledge:x:y:z';
  assert.equal(feedbackEvent(fabricated), undefined);
  // Valid event round-trips with canonical ref recomputation.
  const valid = feedbackEvent(event());
  assert.ok(valid);
  assert.equal(valid!.observed[0].ref, KNOWLEDGE_REF);
  const branch = feedbackEvent(event('branch_source'));
  assert.ok(branch);
  assert.equal(branch!.observed[0].ref, SOURCE_REF);
});

test('enqueue persists only under the captured scope and whole events', async () => {
  const working = dir(); state(working);
  const outbox = new NativeRecallFeedbackOutbox(working, { env: env('https://example.test') });
  const scope = outbox.captureScope();
  assert.ok(scope);
  const ev = event();
  assert.equal(outbox.enqueue([ev], scope), 1);
  assert.equal(outbox.enqueue([ev], scope), 0, 'duplicate event_id must not double-enqueue');
  const queue = JSON.parse(fs.readFileSync(queueFile(working), 'utf8'));
  assert.equal(queue.events.length, 1);
  assert.equal(queue.events[0].ref, undefined);
  // Wrong scope: nothing enters the durable queue.
  assert.equal(outbox.enqueue([event()], 'a'.repeat(64)), 0);
  // Unbound source (no canonical anchor) drops the whole event.
  const unbound = event(); (unbound.observed as any[])[0] = { ref: KNOWLEDGE_REF, disclosure: 'metadata' };
  assert.equal(outbox.enqueue([unbound], scope), 0);
});

test('flush acks only after a real server response and marks acknowledged', async () => {
  const working = dir(); state(working);
  let sent: any;
  const outbox = new NativeRecallFeedbackOutbox(working, {
    env: env('https://example.test'),
    clientFactory: client((body: any) => { sent = body; return body.events.map((e: any) => ({ event_id: e.event_id, applied: true })); }),
  });
  const scope = outbox.captureScope()!;
  const ev = event();
  outbox.enqueue([ev], scope);
  const first = await outbox.flush();
  assert.deepEqual(first.acknowledged, [(ev as any).event_id]);
  // The factory seam receives the client method input: token + events; the
  // schema_version envelope is owned by the client's wire encoder.
  assert.equal(sent.token, 'skill-token');
  assert.equal(sent.events.length, 1);
  const queue = JSON.parse(fs.readFileSync(queueFile(working), 'utf8'));
  assert.equal(queue.events.length, 0, 'acked events leave the durable queue');
});

test('401/403 purge retires the scope; unbound events stay local', async () => {
  const working = dir(); state(working);
  const err: any = new Error('denied'); err.status = 403;
  const outbox = new NativeRecallFeedbackOutbox(working, {
    env: env('https://example.test'),
    clientFactory: () => ({ async reportKnowledgeSourceFeedback() { throw err; } }),
  });
  const scope = outbox.captureScope()!;
  outbox.enqueue([event()], scope);
  await outbox.flush();
  const queue = JSON.parse(fs.readFileSync(queueFile(working), 'utf8'));
  assert.equal(queue.revoked, true);
  assert.equal(queue.events.length, 0);
  // The tombstoned scope can never enqueue again.
  assert.equal(outbox.captureScope(), undefined);
});

test('identity change tombstones pending claims instead of migrating them', () => {
  const working = dir(); state(working, 'skill-token-a');
  const options = { env: env('https://example.test') };
  const outbox = new NativeRecallFeedbackOutbox(working, options);
  const scopeA = outbox.captureScope()!;
  outbox.enqueue([event()], scopeA);
  // Rotate the skill token: pending claims must not ride the new credential.
  state(working, 'skill-token-b');
  const scopeB = outbox.captureScope();
  assert.notEqual(scopeB, scopeA);
  const queue = JSON.parse(fs.readFileSync(queueFile(working), 'utf8'));
  assert.equal(queue.revoked, true);
  assert.equal(queue.scope, scopeA, 'tombstone preserves the origin scope');
});

test('branch_source events enqueue and flush through the same durable path', async () => {
  const working = dir(); state(working);
  const outbox = new NativeRecallFeedbackOutbox(working, {
    env: env('https://example.test'),
    clientFactory: client((body: any) => body.events.map((e: any) => ({ event_id: e.event_id, applied: true }))),
  });
  const scope = outbox.captureScope()!;
  const ev = event('branch_source');
  assert.equal(outbox.enqueue([ev], scope), 1);
  const res = await outbox.flush();
  assert.deepEqual(res.acknowledged, [(ev as any).event_id]);
});

test('branch observation emits feedback_sources only with proven scope and exact envelopes', async () => {
  const { MemorySearchBranchSession } = await import('../src/core/memory-search-branch-session');
  const { InMemorySyntheticObservationQueue } = await import('../src/core/synthetic-observation');
  const { createHash } = await import('node:crypto');
  const sourceAnchor = (n: number) => ({ kind: 'session_query' as const, id: `ref_${createHash('sha256').update(`fb-stream\0${n}`).digest('hex')}`,
    session_id: 'fb-session', stream_id: 'fb-stream', byte_offset: n * 100, revision: String(n).padStart(64, '0') });
  const source = (a: any, text = 'branch body') => ({ anchor: a, status: 'read' as const, role: 'organic' as const, speaker: 'user_assistant' as const,
    occurred_at: null, text, content_hash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
    coverage: 'complete' as const, truncated: false, redacted: false, missing: false, revoked: false });
  const dailyRef = KNOWLEDGE_REF;
  // Refs are computed exactly like the lane does: hashedRecallRef
  // canonicalizes the anchor before hashing.
  const sourceRef = hashedRecallRef('source', [sourceAnchor(1), `sha256:${createHash('sha256').update('branch body').digest('hex')}`]);
  const pages = [{ source: { ...source(sourceAnchor(1)), ref: sourceRef, disclosure: 'metadata' }, before: [], after: [] }];
  const finishPayload = { summary: 's', refs: [sourceRef, dailyRef, hashedRecallRef('history', [{ x: 1 }])], delivery: 'context', inject: true };
  const baseOptions = { sessionKey: 'fb-branch', input: 'x', recentMessages: [] as any[], aiService: {} as any, queue: new InMemorySyntheticObservationQueue(), logEnabled: false };

  // Without a capability, metadata without proven origin scope stays local-only.
  const bare = new MemorySearchBranchSession({ ...baseOptions, workingDirectory: dir() }) as any;
  bare.retrieval.refinePresentation = { presentedRefs: [], evidencePack: { daily_knowledge: { source_reads: pages } }, diagnostics: {} };
  bare.observedRefs.recordPresentedRefs([sourceRef, dailyRef]);
  bare.retrieval.refinePresentation.presentedRefs = [sourceRef, dailyRef];
  const bareObservation = bare.buildObservation(finishPayload);
  assert.equal(bareObservation.metadata.feedback_sources, undefined);
  assert.equal(bareObservation.metadata.feedback_scope, undefined);

  // With a capability the observation carries canonical envelopes + scope.
  // The production session builds its outbox from process.env, so the
  // fixture sets a bounded sandbox capability and restores afterwards.
  const working = dir(); state(working);
  const previousEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env('https://example.test'))) {
    previousEnv[key] = process.env[key]; process.env[key] = value as string;
  }
  const capable = new MemorySearchBranchSession({ ...baseOptions, workingDirectory: working }) as any;
  capable.retrieval.refinePresentation = { presentedRefs: [], evidencePack: { daily_knowledge: { source_reads: pages } }, diagnostics: {} };
  capable.observedRefs.recordPresentedRefs([sourceRef, dailyRef]);
  capable.retrieval.refinePresentation.presentedRefs = [sourceRef, dailyRef];
  const observation = capable.buildObservation(finishPayload);
  const sources = observation.metadata.feedback_sources;
  const scope = observation.metadata.feedback_scope;
  assert.ok(scope && /^[a-f0-9]{64}$/.test(scope), 'feedback_scope must be a captured identity hash');
  assert.ok(Array.isArray(sources) && sources.length === 2, `want daily+source envelopes, got ${JSON.stringify(sources)}`);
  const byRef = new Map(sources.map((s: any) => [s.ref, s]));
  assert.deepEqual(byRef.get(dailyRef)?.anchor, { kind: 'knowledge_entry', id: ENTRY, document_id: DOC, revision: REV });
  assert.equal(byRef.get(sourceRef)?.anchor.revision, sourceAnchor(1).revision);
  // Unmapped/unobserved refs never enter the envelope list.
  const historyRef = hashedRecallRef('history', [{ x: 1 }]);
  assert.ok(!byRef.has(historyRef));
  // The envelopes must survive the outbox's own whole-event gate.
  const outbox = new NativeRecallFeedbackOutbox(working, { env: env('https://example.test') });
  const event = { event_id: 'feedback-branch-obs', trace_id: 'recall-branch-obs', kind: 'branch_source',
    outcome: 'completed', occurred_at_ms: 1, observed: sources,
    delivered: sources.map((s: any) => ({ ref: s.ref, disclosure: 'metadata' })),
    cited: [], retained: [], citation_semantics: 'explicit_ref_match_not_causal_use',
    delivery_semantics: 'branch_summary_with_refs_not_source_body',
    retained_semantics: 'final_explicit_ref_match_not_semantic_adoption', lifecycle: 'turn_local_no_carryover' };
  assert.equal(outbox.enqueue([event], scope), 1);
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('silent drops are observable: oversize and overflow emit metadata-only drop logs', async () => {
  const working = dir(); state(working);
  const outbox = new NativeRecallFeedbackOutbox(working, { env: env('https://example.test') });
  const scope = outbox.captureScope()!;
  const events: any[] = [];
  const original = Logger.runtimeEvent;
  const drops: any[] = [];
  try {
    Logger.runtimeEvent = ((level: string, message: string, event: any) => {
      if (event?.type === 'native_recall_feedback_drop') drops.push({ level, message, payload: event.payload });
    }) as any;
    // Overflow: fill the 512-event durable bound, then one more is dropped.
    assert.equal(outbox.enqueue(Array.from({ length: 512 }, () => event()), scope), 512);
    assert.equal(outbox.enqueue([event()], scope), 0);
  } finally {
    Logger.runtimeEvent = original;
  }
  // Oversize on a FRESH queue: an otherwise-valid event whose wire envelope
  // exceeds 60KiB (the full queue above would hit the overflow branch first).
  const oversizeWorking = dir(); state(oversizeWorking);
  const oversizeOutbox = new NativeRecallFeedbackOutbox(oversizeWorking, { env: env('https://example.test') });
  const oversizeScope = oversizeOutbox.captureScope()!;
  const oversizeDrops: any[] = [];
  const original2 = Logger.runtimeEvent;
  try {
    Logger.runtimeEvent = ((level: string, message: string, event: any) => {
      if (event?.type === 'native_recall_feedback_drop') oversizeDrops.push({ level, message, payload: event.payload });
    }) as any;
    const hugeAnchor = { kind: 'session_query', id: 'x'.repeat(70_000), stream_id: 'stream-1',
      session_id: 's-1', byte_offset: 0, byte_length: 0, revision: 'a'.repeat(64) };
    const oversize = event('branch_source');
    oversize.observed = [{ ref: hashedRecallRef('source', [hugeAnchor, null]), anchor: hugeAnchor, disclosure: 'metadata' }];
    oversize.delivered = oversize.observed.map((s: any) => ({ ref: s.ref, disclosure: 'metadata' }));
    oversize.cited = []; oversize.retained = [];
    assert.ok(Buffer.byteLength(JSON.stringify({ schema_version: 1, events: [feedbackEvent(oversize)] })) > 60 * 1024, 'fixture must actually exceed the wire bound');
    assert.equal(oversizeOutbox.enqueue([oversize], oversizeScope), 0);
  } finally {
    Logger.runtimeEvent = original2;
  }
  drops.push(...oversizeDrops);
  const reasons = new Map(drops.map(d => [d.payload.reason, d]));
  assert.deepEqual([...reasons.keys()].sort(), ['overflow', 'oversize']);
  assert.equal(reasons.get('overflow').payload.count, 1);
  assert.equal(reasons.get('oversize').payload.count, 1);
  for (const drop of drops) {
    assert.equal(drop.level, 'WARN');
    assert.ok(!JSON.stringify(drop).includes('catslog:'), 'drop log must stay metadata-only');
    assert.ok(!JSON.stringify(drop).includes('x'.repeat(1000)));
  }
  // The durable queue itself is untouched by the drops.
  assert.equal(JSON.parse(fs.readFileSync(queueFile(working), 'utf8')).events.length, 512);
});
