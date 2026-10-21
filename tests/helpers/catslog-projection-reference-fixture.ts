import { createHash } from 'node:crypto';
// Mirrors Go encoding/json: SourceMemoryProjection has no tags, Document has snake_case tags.
export const revision = 'a'.repeat(64);
export const stream = 'fixture-stream';
export const fixtureRef = (r = revision, s = stream) => `ref_${createHash('sha256').update(`smp_${r}\0source-memory:${s}:${r}`).digest('hex')}`;
export function fixtureDocument() {
  return {
    schema_version: 1, goal: 'Meridian retention policy', summary: 'Retention applies only to audited releases.',
    transform_contract: 'result_synthesis/v2',
    provenance: 'derived', model_steps: 'unknown', causality: 'unknown', overall_coverage: 'partial',
    gap_acknowledgement: 'Page 2 has not been reviewed; no metric can be inferred.',
    nodes: [
      { id: 'n1', kind: 'assertion', text: 'Audit retention is 90 days.' },
      { id: 'n2', kind: 'condition', text: 'Only production releases after 2026-07-01.' },
      { id: 'n3', kind: 'omission', text: 'Page 2 remains unknown.' },
    ],
    edges: [{ from: 'n2', to: 'n1', kind: 'qualifies' }, { from: 'n3', to: 'n1', kind: 'omits' }],
    mappings: ['n1', 'n2', 'n3'].map(node_id => ({ node_id, source_digest: 'b'.repeat(64), source_ref: fixtureRef() })),
    conditions: ['Only production releases after 2026-07-01.'], omissions: ['Page 2 remains unknown.'],
    aggregate: {
      contract: 'result_synthesis/v2', disclosure: 'derived_memory_projection', version: 2,
      coverage_digest: 'c'.repeat(64), source_basis: 'd'.repeat(64),
      root_proof: { page: 0, pages: 5 },
      leaves: [{ leaf_kind: 'result_synthesis', leaf_ref: fixtureRef(), leaf_revision: revision }],
      ranges: [{ first_page: 0, last_page: 1 }, { first_page: 3, last_page: 4 }],
      gaps: [{ first_page: 2, last_page: 2, status: 'unreviewed' }],
    },
  };
}
export function fixtureRead(r = revision, s = stream): any {
  return { schema_version: 1, content_trust: 'derived_memory_projection',
    projection: { PrincipalID: 'PRIVATE_PRINCIPAL', MemoryScopeID: 'PRIVATE_SCOPE', Revision: r, StreamID: s, Document: fixtureDocument() },
    sources: [{ text: 'RAW_PAGE_REPROOF_ONLY', receipt: 'PRIVATE_RECEIPT' }],
  };
}
export function fixtureBranch(ref = fixtureRef(), request_id = 'request-1'): any {
  return { schema_version: 1, request_id, status: 'partial', branches: [{
    source: 'agent_memory', status: 'error', truncated: true,
    items: [{ source: 'agent_memory', kind: 'source_reference', ref, text: 'metadata-only read_required' }],
  }] };
}
