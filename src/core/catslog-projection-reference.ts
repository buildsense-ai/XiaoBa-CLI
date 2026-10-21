import { createHash } from 'crypto';
import type { CatscoBranchResponse, CatscoSourceMemoryProjectionRead } from '../utils/catsco-log-agent-client';
import { isCatsLogPoolCitationRef } from '../utils/catsco-log-agent-client';

export const MAX_SOURCE_REFERENCE_EXPANSIONS = 2;
/** UTF-8 bytes, including retained_remote_evidence JSON framing, across the run. */
export const MAX_TOTAL_PROJECTION_VIEW_CHARS = 16_000;
export const MAX_PROJECTION_VIEW_CHARS = MAX_TOTAL_PROJECTION_VIEW_CHARS;
export const MAX_RETAINED_REMOTE_VIEW_CHARS = MAX_TOTAL_PROJECTION_VIEW_CHARS;
const MAX_CANDIDATES = 8;

export type SourceProjectionFailureClass = 'capability_unavailable' | 'http_401' | 'http_403' | 'http_404'
  | 'http_error' | 'network_error' | 'aborted' | 'invalid_response' | 'stale_ref' | 'semantic_view_over_budget';
export interface SourceReferenceItem { ref: string; kind: 'source_reference'; text: string; score_hint?: number }
export interface SourceReferenceExpansion {
  ref: string;
  status: 'expanded' | 'reference_only';
  semantic_view?: Record<string, unknown>;
  expansion_error?: SourceProjectionFailureClass;
}
export interface SourceProjectionValidation {
  ok: boolean;
  reason?: SourceProjectionFailureClass;
  contentTrust?: 'derived_memory_projection' | 'derived_membership_index';
  document?: Record<string, any>;
  sources?: unknown[];
}

export function recomputeSourceProjectionRef(revision: unknown, streamId: unknown): string | undefined {
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)
    || typeof streamId !== 'string' || !streamId || Buffer.byteLength(streamId) > 512) return undefined;
  return `ref_${createHash('sha256').update(`smp_${revision}\x00source-memory:${streamId}:${revision}`).digest('hex')}`;
}

/** Known wire positions only: prose containing a ref never discovers a candidate. */
export function discoverSourceReferenceItems(response: CatscoBranchResponse | unknown): SourceReferenceItem[] {
  const items: SourceReferenceItem[] = [];
  const seen = new Set<string>();
  const branches = record(response)?.branches;
  for (const branch of Array.isArray(branches) ? branches.slice(0, 8) : []) {
    if (record(branch)?.source !== 'agent_memory' || !Array.isArray(branch.items)) continue;
    for (const item of branch.items.slice(0, 50)) {
      if (!record(item) || item.source !== 'agent_memory' || item.kind !== 'source_reference'
        || !isCatsLogPoolCitationRef(item.ref) || seen.has(item.ref)) continue;
      seen.add(item.ref);
      // Never copy free producer text as a fact; the locator is a fixed client label.
      items.push({ ref: item.ref, kind: 'source_reference', text: 'Metadata locator only; read_required.' });
      if (items.length >= MAX_CANDIDATES) return items;
    }
  }
  return items;
}

/** Keep only identity + document; never copy the scope-bearing Go projection envelope. */
export function projectSourceProjectionRead(read: unknown): { projection?: Record<string, any>; sources: unknown[] } {
  const envelope = record(read);
  const projection = record(envelope?.projection);
  return {
    ...(projection ? { projection: {
      Revision: projection.Revision, StreamID: projection.StreamID, Document: projection.Document,
    } } : {}),
    sources: Array.isArray(envelope?.sources) ? envelope.sources : [],
  };
}

/** Structural admission only. Server source/read owns current head/basis/child/page proof checks. */
export function validateSourceMemoryProjectionDocument(
  read: CatscoSourceMemoryProjectionRead | unknown, requestedRef: string,
): SourceProjectionValidation {
  const envelope = record(read);
  const { projection, sources } = projectSourceProjectionRead(read);
  if (envelope?.schema_version !== 1 || !['derived_memory_projection', 'derived_membership_index'].includes(envelope.content_trust)
    || !projection || !record(projection.Document) || !Array.isArray(envelope.sources)) return invalid();
  if (recomputeSourceProjectionRef(projection.Revision, projection.StreamID) !== requestedRef) {
    return { ok: false, reason: 'stale_ref' };
  }
  const d = projection.Document;
  const membershipIndex = d.transform_contract === 'result_collection/v1';
  const expectedTrust = membershipIndex ? 'derived_membership_index' : 'derived_memory_projection';
  if (envelope.content_trust !== expectedTrust || d.schema_version !== 1 || d.provenance !== 'derived'
    || d.model_steps !== 'unknown' || d.causality !== 'unknown' || !text(d.goal) || !text(d.summary)
    || !['complete', 'partial'].includes(d.overall_coverage)
    || (d.overall_coverage === 'partial' && !text(d.gap_acknowledgement))) return invalid();
  if (!Array.isArray(d.nodes) || d.nodes.length > 32
    || membershipIndex && d.nodes.length !== 0 || !membershipIndex && d.nodes.length === 0
    || !d.nodes.every((n: any) => record(n) && text(n.id) && ['assertion', 'condition', 'omission'].includes(n.kind) && text(n.text))
    || !Array.isArray(d.edges) || membershipIndex && d.edges.length !== 0
    || !Array.isArray(d.edges) && !membershipIndex
    || !strings(d.conditions) || !strings(d.omissions)
    || !Array.isArray(d.mappings) || membershipIndex && d.mappings.length !== 0
    || !membershipIndex && d.mappings.length === 0 || d.mappings.length > 128) return invalid();
  const ids = new Set(d.nodes.map((n: any) => n.id));
  if (ids.size !== d.nodes.length || d.edges.length > 64
    || !d.edges.every((e: any) => record(e) && ids.has(e.from) && ids.has(e.to) && ['supports', 'qualifies', 'omits'].includes(e.kind))
    || !d.mappings.every((m: any) => record(m) && ids.has(m.node_id))) return invalid();
  if (d.aggregate !== undefined && d.aggregate !== null && d.aggregate.contract !== d.transform_contract) return invalid();
  if (d.transform_contract !== undefined && (!text(d.transform_contract) || d.aggregate?.contract !== d.transform_contract)) return invalid();
  if (membershipIndex && (!validAggregate(d.aggregate) || d.aggregate.contract !== 'result_collection/v1')) return invalid();
  if (d.aggregate !== undefined && d.aggregate !== null && !validAggregate(d.aggregate)) return invalid();
  // No shortening, slicing, depth replacement, or filtering of semantic arrays before validation.
  return { ok: true, contentTrust: expectedTrust, document: d, sources };
}

/** Complete semantic fields; proofs/body sources remain server revalidation material. */
export function buildSourceProjectionSemanticView(
  validation: SourceProjectionValidation, maxBytes = MAX_PROJECTION_VIEW_CHARS,
): Record<string, unknown> | undefined {
  if (!validation.ok || !validation.document) return undefined;
  const d = validation.document;
  const a = record(d.aggregate);
  const memberContract = a?.contract === 'result_collection/v1' || a?.contract === 'result_synthesis_delta/v1';
  const deltaContract = a?.contract === 'result_synthesis_delta/v1';
  const semanticEndpoint = (endpoint: any) => ({ kind: endpoint.kind, node_id: endpoint.node_id,
    ...(endpoint.kind === 'existing' ? { member_ref: endpoint.member_ref } : {}) });
  const view: Record<string, unknown> = {
    content_trust: validation.contentTrust ?? 'derived_memory_projection',
    schema_version: d.schema_version,
    goal: d.goal, summary: d.summary,
    provenance: d.provenance, model_steps: d.model_steps, causality: d.causality,
    overall_coverage: d.overall_coverage,
    ...(typeof d.transform_contract === 'string' ? { transform_contract: d.transform_contract } : {}),
    gap_acknowledgement: d.gap_acknowledgement ?? '',
    conditions: d.conditions ?? [], omissions: d.omissions ?? [],
    nodes: d.nodes.map((n: any) => ({ id: n.id, kind: n.kind, text: n.text })),
    edges: (d.edges ?? []).map((e: any) => ({ from: e.from, to: e.to, kind: e.kind })),
    mappings: (d.mappings ?? []).map((m: any) => ({
      node_id: m.node_id,
      ...(isCatsLogPoolCitationRef(m.source_ref) ? { source_ref: m.source_ref } : {}),
      ...(typeof m.digest === 'string' ? { digest: m.digest } : {}),
      ...(typeof m.source_digest === 'string' ? { source_digest: m.source_digest } : {}),
    })),
    ...(a ? { aggregate: {
      contract: a.contract,
      coverage_digest: a.coverage_digest, source_basis: a.source_basis,
      ...(memberContract ? { qualifier_bindings: (a.qualifier_bindings ?? []).map((b: any) => ({ member_ref: b.member_ref, node_id: b.node_id, kind: b.kind })) } : {}),
      ...(deltaContract ? {
        collection_ref: a.collection_ref, collection_revision: a.collection_revision, delta_scope: a.delta_scope,
        delta_relations: (a.delta_relations ?? []).map((r: any) => ({
          relation_id: r.relation_id, kind: r.kind, from: semanticEndpoint(r.from), to: semanticEndpoint(r.to), scope: r.scope,
        })),
      } : {}),
      ranges: (a.ranges ?? []).map((r: any) => ({ first_page: r.first_page, last_page: r.last_page })),
      gaps: (aggregateGaps(a) ?? []).map((g: any) => ({ first_page: g.first_page, last_page: g.last_page, status: g.status })),
      // The Go protocol carries page counts inside root_proof/pages, not verified_pages.
      total_pages: a.root_proof?.pages ?? a.pages?.[0]?.pages,
      verified_pages: Array.isArray(a.ranges)
        ? a.ranges.reduce((sum: number, r: any) => sum + r.last_page - r.first_page + 1, 0)
        : (a.pages ?? []).length,
      pages: (a.pages ?? []).map((p: any) => ({ page: p.page, pages: p.pages })),
      leaves: (a.leaves ?? []).map((l: any) => ({
        leaf_kind: l.leaf_kind, leaf_ref: l.leaf_ref, leaf_revision: l.leaf_revision, coverage_digest: l.coverage_digest,
        ...(memberContract ? { covered_ranges: (l.covered_ranges ?? []).map((r: any) => ({ first_page: r.first_page, last_page: r.last_page })) } : {}),
      })),
    } } : {}),
  };
  return Buffer.byteLength(JSON.stringify(view), 'utf8') <= maxBytes ? view : undefined;
}

export function retainedEvidenceBytes(items: Array<{ ref: string; semantic_view: Record<string, unknown> }>): number {
  return Buffer.byteLength(JSON.stringify({ retained_remote_evidence: items }), 'utf8');
}

/** Standalone bounded consumer; the active session additionally reserves its run budget before each call. */
export async function expandSourceReferences(
  response: unknown,
  expandFn: ((input: { projectionRef: string }, signal?: AbortSignal) => Promise<unknown>) | undefined,
  options: { maxExpansions?: number; totalViewChars?: number; signal?: AbortSignal } = {},
): Promise<SourceReferenceExpansion[]> {
  const limit = Math.min(MAX_SOURCE_REFERENCE_EXPANSIONS, Math.max(0, options.maxExpansions ?? MAX_SOURCE_REFERENCE_EXPANSIONS));
  const budget = Math.min(MAX_TOTAL_PROJECTION_VIEW_CHARS, Math.max(0, options.totalViewChars ?? MAX_TOTAL_PROJECTION_VIEW_CHARS));
  const results: SourceReferenceExpansion[] = [];
  const kept: Array<{ ref: string; semantic_view: Record<string, unknown> }> = [];
  for (const candidate of discoverSourceReferenceItems(response).slice(0, limit)) {
    let result: SourceReferenceExpansion = { ref: candidate.ref, status: 'reference_only' };
    if (!expandFn) result.expansion_error = 'capability_unavailable';
    else if (options.signal?.aborted) result.expansion_error = 'aborted';
    else {
      try {
        const read = await expandFn({ projectionRef: candidate.ref }, options.signal);
        if (options.signal?.aborted) result.expansion_error = 'aborted';
        else {
          const validation = validateSourceMemoryProjectionDocument(read, candidate.ref);
          const view = buildSourceProjectionSemanticView(validation, budget);
          if (!validation.ok) result.expansion_error = validation.reason;
          else if (!view || retainedEvidenceBytes([...kept, { ref: candidate.ref, semantic_view: view }]) > budget) {
            result.expansion_error = 'semantic_view_over_budget';
          } else {
            kept.push({ ref: candidate.ref, semantic_view: view });
            result = { ref: candidate.ref, status: 'expanded', semantic_view: view };
          }
        }
      } catch (error) { result.expansion_error = classifyExpansionError(error, options.signal); }
    }
    results.push(result);
    if (options.signal?.aborted) break;
  }
  return results;
}

export function classifyExpansionError(error: any, signal?: AbortSignal): SourceProjectionFailureClass {
  if (signal?.aborted || error?.name === 'AbortError') return 'aborted';
  const status = Number(error?.status);
  if (status === 401 || status === 403 || status === 404) return `http_${status}` as SourceProjectionFailureClass;
  return status >= 400 ? 'http_error' : 'network_error';
}

export function finishRefKind(ref: string, delivered: ReadonlySet<string>, observed: ReadonlySet<string>): string {
  if (!isCatsLogPoolCitationRef(ref)) return 'canonical';
  return delivered.has(ref) ? 'remote_delivered' : observed.has(ref) ? 'remote_reference_only' : 'remote_unobserved';
}
function record(v: unknown): Record<string, any> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : undefined;
}
function text(v: unknown): v is string { return typeof v === 'string' && v.trim().length > 0; }
function strings(v: unknown): boolean { return v === null || Array.isArray(v) && v.length <= 4096 && v.every(x => typeof x === 'string'); }
function invalid(): SourceProjectionValidation { return { ok: false, reason: 'invalid_response' }; }
function validAggregate(a: any): boolean {
  if (!record(a)) return false;
  const hasOwn = (value: Record<string, any>, field: string) => Object.prototype.hasOwnProperty.call(value, field);
  const range = (r: any) => Boolean(record(r)) && Number.isSafeInteger(r.first_page) && r.first_page >= 0
    && Number.isSafeInteger(r.last_page) && r.last_page >= r.first_page && r.last_page < 4096;
  const array = (v: unknown, cap: number, check: (item: any) => boolean) =>
    v === undefined || v === null || Array.isArray(v) && v.length <= cap && v.every(check);
  const page = (p: any) => Boolean(record(p)) && Number.isSafeInteger(p.page) && p.page >= 0
    && Number.isSafeInteger(p.pages) && p.pages > p.page && p.pages <= 4096;
  const leaves = (a.leaves ?? []) as unknown[];
  const contracts = ['result_synthesis/v1', 'result_synthesis/v2', 'result_collection/v1', 'result_synthesis_delta/v1'];
  if (!contracts.includes(a.contract) || a.disclosure !== (a.contract === 'result_collection/v1' ? 'derived_membership_index' : 'derived_memory_projection')
    || !isDigest(a.coverage_digest) || !isDigest(a.source_basis)
    || !Array.isArray(a.leaves) || a.leaves.length < 1 || a.leaves.length > 128
    || !leaves.every((l: any) => Boolean(record(l)) && isCatsLogPoolCitationRef(l.leaf_ref)
      && text(l.leaf_kind) && text(l.leaf_revision)
      && (l.covered_ranges === undefined || Array.isArray(l.covered_ranges) && l.covered_ranges.length <= 4096 && l.covered_ranges.every(range)))) return false;
  const decodedGaps = aggregateGaps(a);
  if (!decodedGaps || decodedGaps.length > 4096 || !decodedGaps.every((g: any) => range(g) && ['unreviewed', 'rejected', 'unknown', 'not_selected'].includes(g.status))
    || !aggregateCoverageValid(a, decodedGaps)) return false;
  const expectedTrust = a.contract === 'result_collection/v1' ? 'derived_membership_index' : 'derived_memory_projection';
  const memberContract = a.contract === 'result_collection/v1' || a.contract === 'result_synthesis_delta/v1';
  if (a.contract === 'result_synthesis/v1' ? hasOwn(a, 'version')
    : a.version !== (a.contract === 'result_synthesis/v2' ? 2 : 1)) return false;
  if (!memberContract && hasOwn(a, 'qualifier_bindings')) return false;
  if (leaves.some((leaf: any) => record(leaf) && hasOwn(leaf, 'covered_ranges')) && !memberContract) return false;
  if (a.contract === 'result_synthesis/v1') {
    if (hasOwn(a, 'root_proof') || hasOwn(a, 'ranges') || !Array.isArray(a.pages) || a.pages.length === 0) return false;
  } else if (Array.isArray(a.pages) && a.pages.length > 0) return false;
  const hasOwnAggregateField = (field: string) => hasOwn(a, field);
  if (a.contract !== 'result_synthesis_delta/v1'
    && ['collection_ref', 'collection_revision', 'delta_scope', 'delta_relations'].some(hasOwnAggregateField)) return false;
  if (a.contract === 'result_synthesis_delta/v1' && (!isCatsLogPoolCitationRef(a.collection_ref)
    || !isDigest(a.collection_revision) || !text(a.delta_scope))) return false;
  const leafRefs = new Set(leaves.map((leaf: any) => leaf.leaf_ref));
  const bindings = a.qualifier_bindings ?? [];
  if (!Array.isArray(bindings) || bindings.length > 4096 || !bindings.every((b: any) => record(b)
    && leafRefs.has(b.member_ref) && isDigest(b.node_id) && ['condition', 'omission'].includes(b.kind))) return false;
  const endpoint = (value: any) => Boolean(record(value)) && ['new', 'existing'].includes(value.kind)
    && isDigest(value.node_id)
    && (value.kind === 'new'
      ? !Object.prototype.hasOwnProperty.call(value, 'member_ref')
      : typeof value.member_ref === 'string' && isCatsLogPoolCitationRef(value.member_ref) && leafRefs.has(value.member_ref));
  const relations = a.delta_relations ?? [];
  if (!Array.isArray(relations) || relations.length > 32 || !relations.every((r: any) => record(r)
    && isDigest(r.relation_id) && ['supports', 'qualifies', 'contradicts', 'depends_on', 'scoped_to'].includes(r.kind)
    && endpoint(r.from) && endpoint(r.to) && text(r.scope))) return false;
  return (a.trust === undefined || a.trust === expectedTrust)
    && (a.gaps === undefined || a.gaps === null || Array.isArray(a.gaps))
    && (a.gap_encoding === undefined || a.gap_encoding === 'synthesis-gap-table/v1')
    && array(a.ranges, 4096, range)
    && array(a.leaves, 128, (l: any) => Boolean(record(l)) && isCatsLogPoolCitationRef(l.leaf_ref) && text(l.leaf_kind) && text(l.leaf_revision))
    && array(a.pages, 4096, page)
    && (a.root_proof === undefined || a.root_proof === null || page(a.root_proof));
}
function aggregateCoverageValid(a: any, gaps: Array<Record<string, unknown>>): boolean {
  const totalPages = Number.isSafeInteger(a.root_proof?.pages) ? a.root_proof.pages
    : Number.isSafeInteger(a.pages?.[0]?.pages) ? a.pages[0].pages : 0;
  if (totalPages < 1 || totalPages > 4096) return false;
  const covered = new Uint8Array(totalPages);
  const mark = (first: number, last: number) => {
    if (first < 0 || last < first || last >= totalPages) return false;
    for (let page = first; page <= last; page++) { if (covered[page]) return false; covered[page] = 1; }
    return true;
  };
  if (Array.isArray(a.ranges)) {
    for (const item of a.ranges) if (!mark(item.first_page, item.last_page)) return false;
  } else if (Array.isArray(a.pages)) {
    for (const item of a.pages) if (!mark(item.page, item.page)) return false;
  }
  for (const gap of gaps) if (!mark(gap.first_page as number, gap.last_page as number)) return false;
  return covered.every(value => value === 1);
}
function aggregateGaps(a: any): Array<Record<string, unknown>> | undefined {
  if (Array.isArray(a?.gaps)) return a.gaps;
  if (a?.gaps === null && a?.gap_encoding === undefined && a?.gap_table === undefined) return [];
  if (a?.gap_encoding !== 'synthesis-gap-table/v1' || !record(a.gap_table)
    || a.gap_table.contract !== 'synthesis-gap-table/v1' || !Array.isArray(a.gap_table.reasons)
    || !Array.isArray(a.gap_table.ranges) || Buffer.byteLength(JSON.stringify(a.gap_table), 'utf8') > 64 * 1024
    || a.gap_table.reasons.length > 4 || a.gap_table.ranges.length > 4096) return undefined;
  const totalPages = Number.isSafeInteger(a.root_proof?.pages) ? a.root_proof.pages
    : Number.isSafeInteger(a.pages?.[0]?.pages) ? a.pages[0].pages : 0;
  if (totalPages < 1 || totalPages > 4096) return undefined;
  const allowed = new Set(['unreviewed', 'rejected', 'unknown', 'not_selected']);
  if (!a.gap_table.reasons.every((r: unknown) => typeof r === 'string' && allowed.has(r))) return undefined;
  const occupied = new Set<number>(); const used = new Set<number>(); let nextReason = 0;
  const gaps: Array<Record<string, unknown>> = [];
  for (const raw of a.gap_table.ranges) {
    if (!Array.isArray(raw) || raw.length !== 3 || !raw.every(Number.isSafeInteger)) return undefined;
    const [first, last, reason] = raw;
    if (first < 0 || last < first || last >= totalPages || reason < 0 || reason >= a.gap_table.reasons.length) return undefined;
    if (!used.has(reason)) { if (reason !== nextReason) return undefined; used.add(reason); nextReason++; }
    for (let page = first; page <= last; page++) {
      if (occupied.has(page) || (a.pages ?? []).some((proof: any) => proof?.page === page)
        || (a.ranges ?? []).some((range: any) => range?.first_page <= page && page <= range?.last_page)) return undefined;
      occupied.add(page);
    }
    gaps.push({ first_page: first, last_page: last, status: a.gap_table.reasons[reason] });
  }
  if (nextReason !== a.gap_table.reasons.length) return undefined;
  return gaps;
}
function isDigest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
