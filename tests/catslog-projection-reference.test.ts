import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildSourceProjectionSemanticView,
  classifyExpansionError,
  discoverSourceReferenceItems,
  expandSourceReferences,
  finishRefKind,
  MAX_PROJECTION_VIEW_CHARS,
  recomputeSourceProjectionRef,
  validateSourceMemoryProjectionDocument,
} from '../src/core/catslog-projection-reference';

const REVISION = 'a'.repeat(64);
const STREAM = 'stream-abc';
const VALID_REF = recomputeSourceProjectionRef(REVISION, STREAM)!;
const OTHER_REF = `ref_${'b'.repeat(64)}`;

function validDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    provenance: 'derived',
    model_steps: 'unknown',
    causality: 'unknown',
    goal: 'Retention audit policy',
    summary: 'Audit evidence must be retained for 90 days only.',
    overall_coverage: 'complete',
    nodes: [
      { id: 'n1', kind: 'claim', text: 'Audit evidence retention is bounded to 90 days.' },
      { id: 'n2', kind: 'omission', text: 'Emergency rollback procedure is not covered.' },
    ],
    edges: [{ from: 'n2', to: 'n1', kind: 'qualifies' }],
    mappings: [{ node_id: 'n1', source_ref: 'source-memory:page:1', digest: 'd'.repeat(16) }],
    conditions: ['Applies only to production releases after 2026-07-01.'],
    omissions: ['Page 2 of the source tape was withheld (unreviewed).'],
    ...overrides,
  };
}

function validRead(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    content_trust: 'derived_memory_projection',
    projection: {
      revision: REVISION,
      stream_id: STREAM,
      document: validDocument(),
      ...(overrides.projection as Record<string, unknown> | undefined),
    },
    sources: [{ anchor: { id: 'p1' }, text: 'page text' }],
    ...overrides,
  };
}

describe('recomputeSourceProjectionRef', () => {
  test('matches the server opaque-ref derivation', () => {
    assert.match(VALID_REF, /^ref_[a-f0-9]{64}$/);
    assert.equal(
      recomputeSourceProjectionRef(REVISION, STREAM),
      recomputeSourceProjectionRef(REVISION, STREAM),
    );
    assert.notEqual(recomputeSourceProjectionRef(REVISION, 'other'), VALID_REF);
    assert.equal(recomputeSourceProjectionRef('', STREAM), undefined);
  });
});

describe('discoverSourceReferenceItems', () => {
  test('only agent_memory items with kind source_reference and valid ref are candidates', () => {
    const response = {
      branches: [
        {
          source: 'agent_memory',
          status: 'ok',
          items: [
            { ref: VALID_REF, kind: 'source_reference', text: 'meta' },
            // kind spoof: pool ref on a normal note — never a candidate
            { ref: OTHER_REF, kind: 'episode', text: 'note mentioning ' + VALID_REF },
            // ref spoof: source_reference kind on a non-pool ref
            { ref: 'note-123', kind: 'source_reference', text: 'spoofed' },
          ],
        },
        { source: 'session_graph', items: [{ ref: `ref_${'c'.repeat(64)}`, kind: 'source_reference', text: 'x' }] },
      ],
    };
    const items = discoverSourceReferenceItems(response);
    assert.equal(items.length, 1);
    assert.equal(items[0].ref, VALID_REF);
  });

  test('caps at MAX_SOURCE_REFERENCE_EXPANSIONS and dedupes', () => {
    const mk = (i: number) => `ref_${i.toString(16).padStart(64, '0')}`;
    const response = {
      branches: [{
        source: 'agent_memory',
        items: [0, 1, 2, 3, 4, 1].map(i => ({ ref: mk(i), kind: 'source_reference', text: 'm' })),
      }],
    };
    const items = discoverSourceReferenceItems(response);
    assert.equal(items.length, 4);
    assert.equal(new Set(items.map(i => i.ref)).size, 4);
  });
});

describe('validateSourceMemoryProjectionDocument', () => {
  test('accepts a well-formed read and recomputes the ref', () => {
    const validation = validateSourceMemoryProjectionDocument(validRead(), VALID_REF);
    assert.equal(validation.ok, true);
    assert.equal(validation.document?.goal, 'Retention audit policy');
    assert.equal(validation.sources?.length, 1);
  });

  test('rejects stale ref (revision mismatch)', () => {
    const read = validRead();
    read.projection.revision = 'f'.repeat(64);
    const validation = validateSourceMemoryProjectionDocument(read, VALID_REF);
    assert.equal(validation.ok, false);
    assert.equal(validation.reason, 'stale_ref');
  });

  test('rejects a foreign projection read under a different ref', () => {
    const validation = validateSourceMemoryProjectionDocument(validRead(), OTHER_REF);
    assert.equal(validation.ok, false);
    assert.equal(validation.reason, 'stale_ref');
  });

  test('rejects malformed envelope / document shape', () => {
    for (const bad of [
      {},
      { projection: 'nope' },
      { projection: { revision: REVISION, stream_id: STREAM, document: { schema_version: 2 } } },
      validRead({ projection: { document: { ...validDocument(), provenance: 'authored' } } }),
      validRead({ projection: { document: { ...validDocument(), nodes: [] } } }),
      validRead({ projection: { document: { ...validDocument(), overall_coverage: 'partial', gap_acknowledgement: ' ' } } }),
    ]) {
      const validation = validateSourceMemoryProjectionDocument(bad, VALID_REF);
      assert.equal(validation.ok, false, JSON.stringify(bad).slice(0, 200));
      assert.equal(validation.reason === 'stale_ref' || validation.reason === 'invalid_response', true);
    }
  });

  test('strips credential-shaped keys from sanitized sources', () => {
    const read = validRead();
    read.sources = [{ anchor: { id: 'p1' }, text: 't', bearer_token: 'secret', authorization: 'x' }];
    const validation = validateSourceMemoryProjectionDocument(read, VALID_REF);
    assert.equal(validation.ok, true);
    const source = validation.sources![0] as Record<string, unknown>;
    assert.equal('bearer_token' in source, false);
    assert.equal('authorization' in source, false);
  });
});

describe('buildSourceProjectionSemanticView', () => {
  test('complete qualifiers — conditions/omissions/gap acknowledgement whole', () => {
    const validation = validateSourceMemoryProjectionDocument(validRead(), VALID_REF);
    const view = buildSourceProjectionSemanticView(validation)!;
    assert.equal(view.overall_coverage, 'complete');
    assert.deepEqual(view.conditions, ['Applies only to production releases after 2026-07-01.']);
    assert.deepEqual(view.omissions, ['Page 2 of the source tape was withheld (unreviewed).']);
    assert.equal((view.nodes as unknown[]).length, 2);
    assert.equal((view.edges as unknown[]).length, 1);
    assert.equal(view.content_trust, 'derived_memory_projection');
  });

  test('renders aggregate gaps whole', () => {
    const read = validRead();
    read.projection.document = validDocument({
      overall_coverage: 'partial',
      gap_acknowledgement: 'page 2 was never reviewed',
      aggregate: { verified_pages: 3, total_pages: 4, gaps: [{ status: 'unreviewed', first_page: 2, last_page: 2 }] },
    });
    const view = buildSourceProjectionSemanticView(validateSourceMemoryProjectionDocument(read, VALID_REF))!;
    const aggregate = view.aggregate as Record<string, unknown>;
    assert.equal(aggregate.total_pages, 4);
    assert.deepEqual(aggregate.gaps, [{ status: 'unreviewed', first_page: 2, last_page: 2 }]);
    assert.equal(view.gap_acknowledgement, 'page 2 was never reviewed');
  });

  test('returns undefined when the whole view exceeds budget — never a cut qualifier', () => {
    const read = validRead();
    // Many qualifiers, each inside the per-string bound but exceeding the
    // whole-item view budget when serialized.
    read.projection.document = validDocument({
      conditions: Array.from({ length: 64 }, () => 'c'.repeat(8_000)),
      summary: 's'.repeat(8_000),
    });
    const validation = validateSourceMemoryProjectionDocument(read, VALID_REF);
    assert.equal(validation.ok, true);
    const view = buildSourceProjectionSemanticView(validation, MAX_PROJECTION_VIEW_CHARS);
    assert.equal(view, undefined);
  });
});

describe('expandSourceReferences', () => {
  const responseFor = (ref: string) => ({
    branches: [{ source: 'agent_memory', status: 'ok', items: [{ ref, kind: 'source_reference', text: 'meta' }] }],
  });

  test('expanded: validated read yields complete semantic view', async () => {
    const calls: string[] = [];
    const expansions = await expandSourceReferences(responseFor(VALID_REF), async ({ projectionRef }) => {
      calls.push(projectionRef);
      return validRead();
    });
    assert.deepEqual(calls, [VALID_REF]);
    assert.equal(expansions.length, 1);
    assert.equal(expansions[0].status, 'expanded');
    assert.equal((expansions[0].semantic_view as any).goal, 'Retention audit policy');
  });

  const failureMatrix: Array<[string, any, string]> = [
    ['capability_unavailable', undefined, 'capability_unavailable'],
    ['http_401', Object.assign(new Error('unauthorized'), { status: 401 }), 'http_401'],
    ['http_403', Object.assign(new Error('forbidden'), { status: 403 }), 'http_403'],
    ['http_404', Object.assign(new Error('gone'), { status: 404 }), 'http_404'],
    ['http_error', Object.assign(new Error('boom'), { status: 500 }), 'http_error'],
    ['network_error', new Error('socket hangup'), 'network_error'],
    ['aborted', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'aborted'],
  ];
  for (const [name, error, expected] of failureMatrix) {
    test(`degrades to reference_only on ${name}`, async () => {
      const expandFn = error === undefined
        ? undefined
        : async () => { throw error; };
      const expansions = await expandSourceReferences(responseFor(VALID_REF), expandFn as any);
      assert.equal(expansions[0].status, 'reference_only');
      assert.equal(expansions[0].expansion_error, expected);
      assert.equal(expansions[0].semantic_view, undefined);
    });
  }

  test('stale/invalid reads degrade typed, never thrown', async () => {
    const stale = await expandSourceReferences(responseFor(VALID_REF), async () => {
      const read = validRead();
      read.projection.revision = 'e'.repeat(64);
      return read;
    });
    assert.equal(stale[0].status, 'reference_only');
    assert.equal(stale[0].expansion_error, 'stale_ref');
    const invalid = await expandSourceReferences(responseFor(VALID_REF), async () => ({ nope: 1 }));
    assert.equal(invalid[0].status, 'reference_only');
    assert.equal(invalid[0].expansion_error, 'invalid_response');
  });
});

describe('finishRefKind', () => {
  const delivered = new Set([VALID_REF]);
  const observed = new Set([VALID_REF, OTHER_REF]);

  test('delivered pool ref → remote_delivered', () => {
    assert.equal(finishRefKind(VALID_REF, delivered, observed), 'remote_delivered');
  });
  test('observed-only pool ref → remote_reference_only', () => {
    assert.equal(finishRefKind(OTHER_REF, delivered, observed), 'remote_reference_only');
  });
  test('invented pool ref → remote_unobserved', () => {
    assert.equal(finishRefKind(`ref_${'f'.repeat(64)}`, delivered, observed), 'remote_unobserved');
  });
  test('canonical/knowledge refs classify as canonical (tracker gates separately)', () => {
    assert.equal(finishRefKind('chat/2026-01-01/a.jsonl#3', delivered, observed), 'canonical');
    assert.equal(finishRefKind('kb:KB-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', delivered, observed), 'canonical');
  });
});

describe('classifyExpansionError', () => {
  test('typed classes', () => {
    assert.equal(classifyExpansionError(Object.assign(new Error(), { status: 401 })), 'http_401');
    assert.equal(classifyExpansionError(Object.assign(new Error(), { status: 429 })), 'http_error');
    assert.equal(classifyExpansionError(new Error('dns')), 'network_error');
    assert.equal(classifyExpansionError(Object.assign(new Error(), { name: 'AbortError' })), 'aborted');
    assert.equal(classifyExpansionError(new Error(), AbortSignal.abort()), 'aborted');
  });
});
