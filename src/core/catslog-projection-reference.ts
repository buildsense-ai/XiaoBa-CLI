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
export interface ProjectionNodeReference {
  kind: 'source_memory_projection_node';
  source_projection_ref: string;
  revision: string;
  id: string;
}
export interface ProjectionReferenceObservation {
  hit: { projection_ref: string };
  read?: { projection_ref: string; revision: string; node_refs: ProjectionNodeReference[] };
  consumer_model_call_id?: string;
  returned_to_branch: boolean;
  cited_node_refs: string[];
  retained_node_refs: string[];
}
export interface SourceReferenceExpansion {
  ref: string;
  status: 'expanded' | 'reference_only';
  semantic_view?: Record<string, unknown>;
  observation?: ProjectionReferenceObservation;
  expansion_error?: SourceProjectionFailureClass;
}
export interface SourceProjectionValidation {
  ok: boolean;
  reason?: SourceProjectionFailureClass;
  document?: Record<string, any>;
  sources?: unknown[];
  projectionRef?: string;
  revision?: string;
}

export function sourceProjectionGenerationContextID(proof: any): string {
  const tuple = [proof.source_session_id, proof.source_episode_id, proof.source_model_call_id, proof.source_revision, proof.source_basis];
  return `ctx_${createHash('sha256').update(`memory-graph/3/context\0${tuple.join('\0')}`).digest('hex')}`;
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
  if (envelope?.schema_version !== 1 || envelope.content_trust !== 'derived_memory_projection'
    || !projection || !record(projection.Document) || !Array.isArray(envelope.sources)) return invalid();
  if (recomputeSourceProjectionRef(projection.Revision, projection.StreamID) !== requestedRef) {
    return { ok: false, reason: 'stale_ref' };
  }
  const d = projection.Document;
  if (d.schema_version !== 1 || d.provenance !== 'derived' || d.model_steps !== 'unknown'
    || d.causality !== 'unknown' || !text(d.goal) || !text(d.summary)
    || !['complete', 'partial'].includes(d.overall_coverage)
    || (d.overall_coverage === 'partial' && !text(d.gap_acknowledgement))) return invalid();
  if (!Array.isArray(d.nodes) || !d.nodes.length || d.nodes.length > 32
    || !d.nodes.every((n: any) => validProjectionNode(n))
    || !Array.isArray(d.edges) && d.edges !== null
    || !strings(d.conditions) || !strings(d.omissions)
    || !Array.isArray(d.mappings) && d.mappings !== null) return invalid();
  const ids = new Set<string>(d.nodes.map((n: any) => n.id));
  if (ids.size !== d.nodes.length || (d.edges ?? []).length > 64
    || !(d.edges ?? []).every((e: any) => record(e) && ids.has(e.from) && ids.has(e.to) && ['supports', 'qualifies', 'omits'].includes(e.kind))
    || !Array.isArray(d.mappings) || d.mappings.length === 0 || d.mappings.length > 128
    || !(d.mappings ?? []).every((m: any) => validProjectionMapping(m, ids))) return invalid();
  const proofs = new Map<string, any>();
  if (d.output_proofs !== undefined && (!Array.isArray(d.output_proofs) || d.output_proofs.length > 128
    || !d.output_proofs.every((proof: any) => {
      if (!validOutputProof(proof) || proofs.has(proof.ref)) return false;
      proofs.set(proof.ref, proof);
      return true;
    }))) return invalid();
  const contexts = new Map<string, string>();
  for (const proof of proofs.values()) {
    const id = sourceProjectionGenerationContextID(proof);
    const identity = JSON.stringify([proof.input_refs ?? [], proof.query_refs ?? [], proof.turn_result_refs ?? [], proof.hyperedge_output_refs]);
    const previous = contexts.get(id);
    if (previous !== undefined && previous !== identity) return invalid();
    contexts.set(id, identity);
  }
  const mappedOutputRefs = new Set<string>();
  const mappedNodeRefs = new Map<string, Set<string>>();
  for (const mapping of d.mappings) {
    const refs = Array.isArray(mapping.output_refs) ? mapping.output_refs : [];
    const nodeRefs = mappedNodeRefs.get(mapping.node_id) ?? new Set<string>();
    for (const ref of refs) {
      const proof = proofs.get(ref);
      const node = d.nodes.find((candidate: any) => candidate.id === mapping.node_id);
      if (!proof || !node) return invalid();
      if (!['message', 'tool_call'].includes(node.kind) || proof.kind !== node.kind) return invalid();
      nodeRefs.add(ref); mappedOutputRefs.add(ref);
    }
    mappedNodeRefs.set(mapping.node_id, nodeRefs);
  }
  for (const node of d.nodes) {
    const declared = node.kind === 'message' || node.kind === 'tool_call'
      ? new Set<string>(node.output_evidence_refs as string[]) : new Set<string>();
    const aligned = mappedNodeRefs.get(node.id) ?? new Set<string>();
    if (declared.size !== aligned.size || [...declared].some(ref => !aligned.has(ref))) return invalid();
    for (const ref of declared) if (proofs.get(ref)?.kind !== node.kind) return invalid();
  }
  // Every proof must participate in at least one explicit alignment. Reuse by
  // multiple cleaned nodes is valid and preserves one-to-many/many-to-one work.
  if (mappedOutputRefs.size !== proofs.size) return invalid();
  if (d.aggregate !== undefined && d.aggregate !== null && !validAggregate(d.aggregate)) return invalid();
  // No shortening, slicing, depth replacement, or filtering of semantic arrays before validation.
  return { ok: true, document: d, sources, projectionRef: requestedRef, revision: projection.Revision };
}

/** Complete semantic fields; proofs/body sources remain server revalidation material. */
export function buildSourceProjectionSemanticView(
  validation: SourceProjectionValidation, maxBytes = MAX_PROJECTION_VIEW_CHARS,
): Record<string, unknown> | undefined {
  if (!validation.ok || !validation.document) return undefined;
  const d = validation.document;
  const a = record(d.aggregate);
  const view: Record<string, unknown> = {
    contract_version: 'memory-graph/3',
    output_identity_status: Array.isArray(d.output_proofs) && d.output_proofs.length ? 'supported' : 'unsupported_legacy_identity',
    content_trust: 'derived_memory_projection',
    schema_version: d.schema_version,
    goal: d.goal, summary: d.summary,
    provenance: d.provenance, model_steps: d.model_steps, causality: d.causality,
    overall_coverage: d.overall_coverage,
    gap_acknowledgement: d.gap_acknowledgement ?? '',
    qualifiers: {
      conditions: qualifierReferences(d.conditions ?? [], d.nodes, 'condition'),
      omissions: qualifierReferences(d.omissions ?? [], d.nodes, 'omission'),
    },
    nodes: d.nodes.map((n: any) => ({ id: n.id, kind: n.kind, text: n.text,
      ...(Array.isArray(n.output_evidence_refs) ? { output_proof_refs: [...n.output_evidence_refs] } : {}),
    })),
    edges: (d.edges ?? []).map((e: any) => ({ from: e.from, to: e.to, kind: e.kind })),
    mappings: (d.mappings ?? []).map((m: any) => ({
      node_id: m.node_id,
      ...(isCatsLogPoolCitationRef(m.source_ref) ? { source_ref: m.source_ref } : {}),
      ...(typeof m.digest === 'string' ? { digest: m.digest } : {}),
      ...(typeof m.source_digest === 'string' ? { source_digest: m.source_digest } : {}),
      ...(Array.isArray(m.output_refs) && m.output_refs.length ? { output_refs: [...m.output_refs] } : {}),
    })),
      generation_contexts: Array.isArray(d.output_proofs) ? Object.fromEntries(d.output_proofs.map((proof: any) => [sourceProjectionGenerationContextID(proof), {
        source_session_id: proof.source_session_id, source_episode_id: proof.source_episode_id,
        source_model_call_id: proof.source_model_call_id, source_revision: proof.source_revision,
        source_basis: proof.source_basis, input_refs: proof.input_refs ?? [], query_refs: proof.query_refs ?? [],
        turn_result_refs: proof.turn_result_refs ?? [], hyperedge_output_refs: [...proof.hyperedge_output_refs],
      }])) : {},
      output_proofs: Array.isArray(d.output_proofs) ? d.output_proofs.map(semanticOutputProof) : [],
    ...(a ? { aggregate: {
      contract: a.contract, version: a.version, disclosure: a.disclosure,
      coverage_digest: a.coverage_digest,
      ranges: a.ranges ?? [], gaps: a.gaps ?? [],
      // The Go protocol carries page counts inside root_proof/pages, not verified_pages.
      total_pages: a.root_proof?.pages ?? a.pages?.[0]?.pages,
      verified_pages: Array.isArray(a.ranges)
        ? a.ranges.reduce((sum: number, r: any) => sum + r.last_page - r.first_page + 1, 0)
        : (a.pages ?? []).length,
      pages: (a.pages ?? []).map((p: any) => ({ page: p.page, pages: p.pages })),
      leaves: (a.leaves ?? []).map((l: any) => ({
        leaf_kind: l.leaf_kind, leaf_ref: l.leaf_ref, leaf_revision: l.leaf_revision, coverage_digest: l.coverage_digest,
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
            result = {
              ref: candidate.ref, status: 'expanded', semantic_view: view,
              observation: {
                hit: { projection_ref: candidate.ref },
                read: {
                  projection_ref: candidate.ref,
                  revision: validation.revision!,
                  node_refs: validation.document!.nodes.map((node: any) => ({
                    kind: 'source_memory_projection_node', source_projection_ref: candidate.ref,
                    revision: validation.revision!, id: node.id,
                  })),
                },
                returned_to_branch: true, cited_node_refs: [], retained_node_refs: [],
              },
            };
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
function uniqueStrings(v: unknown, max: number, requireNonEmpty = false): v is string[] {
  if (!Array.isArray(v) || v.length > max || (requireNonEmpty && v.length === 0)) return false;
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== 'string' || (requireNonEmpty && !item.trim()) || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}
function validProjectionNode(node: any): boolean {
  if (!record(node) || !text(node.id) || !text(node.text)) return false;
  if (['assertion', 'condition', 'omission'].includes(node.kind)) {
    return node.output_evidence_refs === undefined;
  }
  return ['message', 'tool_call'].includes(node.kind)
    && uniqueStrings(node.output_evidence_refs, 128, true);
}
function validProjectionMapping(mapping: any, ids: Set<string>): boolean {
  if (!record(mapping) || !text(mapping.node_id) || !ids.has(mapping.node_id)) return false;
  return mapping.output_refs === undefined || uniqueStrings(mapping.output_refs, 128, true);
}
function validOutputProof(proof: any): boolean {
  if (!record(proof) || !text(proof.ref) || proof.ref.length > 256
    || !['message', 'tool_call'].includes(proof.kind) || !/^[a-f0-9]{64}$/.test(proof.body_sha256)
    || !text(proof.source_session_id) || !text(proof.source_episode_id) || !text(proof.source_model_call_id)
    || !Number.isSafeInteger(proof.output_position) || proof.output_position < 0
    || !/^assistant\.outputs\[(0|[1-9]\d{0,8})\]\.body$/.test(proof.body_path)
    || !/^[a-f0-9]{64}$/.test(proof.source_revision) || !/^[a-f0-9]{64}$/.test(proof.source_basis)
    || proof.generation_hyperedge_ref !== proof.source_model_call_id
    || !record(proof.parent_anchor) || !/^[a-f0-9]{64}$/.test(proof.parent_digest)
    || !text(proof.generation_hyperedge_ref) || !text(proof.source_ref)
    || !uniqueStrings(proof.hyperedge_output_refs, 512, true) || !proof.hyperedge_output_refs.includes(proof.ref)) return false;
  if (proof.subtype !== undefined && !text(proof.subtype)) return false;
  if (proof.kind === 'tool_call' && (proof.subtype !== 'tool_call' || !text(proof.provider_call_id) || !text(proof.name))) return false;
  if (proof.provider_call_id !== undefined && !text(proof.provider_call_id)) return false;
  if (proof.name !== undefined && !text(proof.name)) return false;
  return ['input_refs', 'query_refs', 'turn_result_refs'].every(key =>
    proof[key] === undefined || uniqueStrings(proof[key], 512, true));
}
function semanticOutputProof(proof: any): Record<string, unknown> {
  return {
    ref: proof.ref, source_ref: proof.source_ref, kind: proof.kind,
    ...(proof.subtype !== undefined ? { subtype: proof.subtype } : {}),
    body_sha256: proof.body_sha256, context_id: sourceProjectionGenerationContextID(proof),
    ...(proof.provider_call_id !== undefined ? { provider_call_id: proof.provider_call_id } : {}),
    ...(proof.name !== undefined ? { name: proof.name } : {}),
    output_position: proof.output_position, body_path: proof.body_path,
  };
}
function qualifierReferences(literals: string[], nodes: any[], kind: 'condition' | 'omission'): Array<{node_id: string} | {text: string}> {
  return literals.map(text => {
    const node = nodes.find(candidate => candidate.kind === kind && candidate.text === text);
    return node ? { node_id: node.id } : { text };
  });
}
function invalid(): SourceProjectionValidation { return { ok: false, reason: 'invalid_response' }; }
function validAggregate(a: any): boolean {
  if (!record(a)) return false;
  const range = (r: any) => Boolean(record(r)) && Number.isSafeInteger(r.first_page) && r.first_page >= 0
    && Number.isSafeInteger(r.last_page) && r.last_page >= r.first_page && r.last_page < 4096;
  const array = (v: unknown, cap: number, check: (item: any) => boolean) =>
    v === undefined || v === null || Array.isArray(v) && v.length <= cap && v.every(check);
  const page = (p: any) => Boolean(record(p)) && Number.isSafeInteger(p.page) && p.page >= 0
    && Number.isSafeInteger(p.pages) && p.pages > p.page && p.pages <= 4096;
  return ['result_synthesis/v1', 'result_synthesis/v2'].includes(a.contract)
    && a.disclosure === 'derived_memory_projection'
    && (a.gaps === null || Array.isArray(a.gaps) && a.gaps.length <= 4096
      && a.gaps.every((g: any) => range(g) && ['unreviewed', 'rejected', 'unknown', 'not_selected'].includes(g.status)))
    && array(a.ranges, 4096, range)
    && array(a.leaves, 8, (l: any) => Boolean(record(l)) && isCatsLogPoolCitationRef(l.leaf_ref) && text(l.leaf_kind) && text(l.leaf_revision))
    && array(a.pages, 4096, page)
    && (a.root_proof === undefined || a.root_proof === null || page(a.root_proof));
}
