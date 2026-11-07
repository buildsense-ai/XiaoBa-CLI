import { createHash } from 'node:crypto';
import type {
  CatsLogKnowledgeAnchor, CatsLogKnowledgeSourceContent, CatsLogKnowledgeSourcePage,
  CatsLogKnowledgeSourceProjectionContext,
} from '../utils/catslog-knowledge-types';

const SHA = /^[a-f0-9]{64}$/;
const NODE_ID = /^(?:output-)?[a-f0-9]{64}$/;
type Obj = Record<string, any>;
const obj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(str) && new Set(v).size === v.length;
const sha = (v: unknown): v is string => typeof v === 'string' && SHA.test(v);
function onlyKeys(v: Obj, allowed: readonly string[]): boolean { return Object.keys(v).every(key => allowed.includes(key)); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (obj(value)) return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
function contextID(c: Obj): string {
  const tuple = [c.source_session_id, c.source_episode_id, c.source_model_call_id, c.source_revision, c.source_basis];
  return `ctx_${createHash('sha256').update(`memory-graph/3/context\0${tuple.join('\0')}`).digest('hex')}`;
}
function validAnchor(a: any): boolean {
  if (!obj(a) || !onlyKeys(a, ['kind', 'id', 'document_id', 'revision', 'session_id', 'session_type', 'stream_id', 'byte_offset', 'byte_length', 'skill_version_id', 'source_projection_ref'])
    || !['session_query', 'session_result', 'graph_node', 'learning_node', 'knowledge_entry',
      'source_memory_projection_node', 'skill_program', 'skill_node'].includes(a.kind) || !str(a.id)) return false;
  if (a.kind === 'session_query' || a.kind === 'session_result') {
    return str(a.session_id) && str(a.stream_id) && (a.revision === undefined || str(a.revision))
      && (a.byte_offset === undefined || Number.isSafeInteger(a.byte_offset) && a.byte_offset >= 0)
      && (a.byte_length === undefined || Number.isSafeInteger(a.byte_length) && a.byte_length >= 0);
  }
  return true;
}
function projectionContextValid(c: any, anchor: any): c is CatsLogKnowledgeSourceProjectionContext {
  if (!obj(c) || !onlyKeys(c, ['contract_version', 'output_identity_status', 'selected_node_id', 'nodes', 'edges', 'mappings', 'qualifiers', 'generation_contexts', 'output_proofs'])
    || c.contract_version !== 'memory-graph/3'
    || !['supported', 'unsupported_legacy_identity'].includes(c.output_identity_status)
    || c.selected_node_id !== anchor.id || !Array.isArray(c.nodes) || !Array.isArray(c.edges)
    || !Array.isArray(c.mappings) || !obj(c.qualifiers) || !Array.isArray(c.qualifiers.conditions)
    || !Array.isArray(c.qualifiers.omissions) || !obj(c.generation_contexts) || !Array.isArray(c.output_proofs)
    || Object.prototype.hasOwnProperty.call(c, 'output_nodes')
    || Object.prototype.hasOwnProperty.call(c, 'cleaned_content')
    || Object.prototype.hasOwnProperty.call(c, 'conditions') || Object.prototype.hasOwnProperty.call(c, 'omissions')) return false;
  const nodes = new Map<string, Obj>();
  for (const n of c.nodes) {
    if (!obj(n) || !onlyKeys(n, ['id', 'kind', 'text', 'output_proof_refs'])
      || !str(n.id) || !['assertion', 'condition', 'omission', 'message', 'tool_call'].includes(n.kind)
      || typeof n.text !== 'string' || nodes.has(n.id)) return false;
    if (n.output_proof_refs !== undefined && (!Array.isArray(n.output_proof_refs) || !strings(n.output_proof_refs))) return false;
    if (n.output_proof_refs?.length && !['message', 'tool_call'].includes(n.kind)) return false;
    nodes.set(n.id, n);
  }
  const selected = nodes.get(anchor.id);
  if (!selected || typeof selected.text !== 'string') return false;
  const edges = new Set<string>();
  for (const e of c.edges) {
    if (!obj(e) || !onlyKeys(e, ['from', 'to', 'kind']) || !nodes.has(e.from) || !nodes.has(e.to) || !['supports', 'qualifies', 'omits'].includes(e.kind)) return false;
    const key = `${e.from}\0${e.to}\0${e.kind}`;
    if (edges.has(key)) return false;
    edges.add(key);
  }
  const mappings = new Set<string>();
  for (const m of c.mappings) {
    if (!obj(m) || !onlyKeys(m, ['node_id', 'anchor', 'source_anchors']) || !nodes.has(m.node_id) || !validAnchor(m.anchor) || !Array.isArray(m.source_anchors) || !m.source_anchors.every(validAnchor)) return false;
    const key = canonical([m.node_id, m.anchor, m.source_anchors]);
    if (mappings.has(key)) return false;
    mappings.add(key);
  }
  for (const key of ['conditions', 'omissions'] as const) {
    for (const q of c.qualifiers[key]) {
      if (!obj(q) || !onlyKeys(q, ['node_id', 'text']) || (typeof q.node_id === 'string') === (typeof q.text === 'string')) return false;
      if (q.node_id !== undefined && (!nodes.has(q.node_id) || typeof nodes.get(q.node_id)!.text !== 'string')) return false;
      if (q.text !== undefined && typeof q.text !== 'string') return false;
    }
  }
  const proofs = new Map<string, Obj>();
  for (const p of c.output_proofs) {
    if (!obj(p) || !onlyKeys(p, ['ref', 'source_ref', 'kind', 'subtype', 'body_sha256', 'context_id', 'provider_call_id', 'name', 'output_position', 'body_path', 'generation_hyperedge_ref'])
      || !str(p.ref) || proofs.has(p.ref) || !['message', 'tool_call'].includes(p.kind)
      || !sha(p.body_sha256) || !str(p.context_id) || !str(p.source_ref)
      || !Number.isSafeInteger(p.output_position) || p.output_position < 0
      || !/^assistant\.outputs\[(0|[1-9]\d{0,8})\]\.body$/.test(p.body_path)
      || !str(p.generation_hyperedge_ref)
      || p.subtype !== undefined && !str(p.subtype)
      || p.provider_call_id !== undefined && !str(p.provider_call_id)
      || p.name !== undefined && !str(p.name)) return false;
    const ctx = c.generation_contexts[p.context_id];
    if (!obj(ctx) || !onlyKeys(ctx, ['source_session_id', 'source_episode_id', 'source_model_call_id', 'source_revision', 'source_basis', 'input_refs', 'query_refs', 'turn_result_refs', 'hyperedge_output_refs'])
      || contextID(ctx) !== p.context_id
      || ![ctx.source_session_id, ctx.source_episode_id, ctx.source_model_call_id].every(str)
      || !sha(ctx.source_revision) || !sha(ctx.source_basis) || !strings(ctx.hyperedge_output_refs) || !ctx.hyperedge_output_refs.length
      || !ctx.hyperedge_output_refs.includes(p.ref)
      || p.generation_hyperedge_ref !== ctx.source_model_call_id) return false;
    for (const k of ['input_refs', 'query_refs', 'turn_result_refs'] as const) if (ctx[k] !== undefined && !strings(ctx[k])) return false;
    proofs.set(p.ref, p);
  }
  const supported = c.output_identity_status === 'supported';
  if (!supported && (proofs.size || Object.keys(c.generation_contexts).length)) return false;
  if (supported && (!proofs.size || !Object.keys(c.generation_contexts).length)) return false;
  const used = new Set<string>();
  for (const n of nodes.values()) {
    const refs = n.output_proof_refs ?? [];
    if ((n.kind === 'message' || n.kind === 'tool_call') && supported && !refs.length) return false;
    for (const ref of refs) {
      const p = proofs.get(ref);
      if (!p || p.kind !== n.kind) return false;
      used.add(ref);
    }
  }
  if (used.size !== proofs.size) return false;
  for (const n of nodes.values()) {
    if ((n.kind === 'message' || n.kind === 'tool_call')
      && !c.mappings.some((mapping: Obj) => mapping.node_id === n.id)) return false;
  }
  for (const id of Object.keys(c.generation_contexts)) if (!proofs.size || !c.output_proofs.some((p: Obj) => p.context_id === id)) return false;
  return true;
}

function validatePageShape(raw: any): raw is CatsLogKnowledgeSourcePage {
  return obj(raw) && obj(raw.source) && Array.isArray(raw.before) && Array.isArray(raw.after)
    && typeof raw.before_exhausted === 'boolean' && typeof raw.after_exhausted === 'boolean'
    && typeof raw.context_truncated === 'boolean' && typeof raw.served_at === 'string';
}

/** Validates source/read responses before returning any selected projection body. */
export function decodeKnowledgeSourcePage(raw: unknown, requested: CatsLogKnowledgeAnchor): CatsLogKnowledgeSourcePage {
  if (!validatePageShape(raw)) throw new Error('CatsLog knowledge source read failed: invalid source page');
  const page = raw as CatsLogKnowledgeSourcePage;
  const source: any = page.source;
  if (requested.kind === 'source_memory_projection_node' && !canonicalProjectionAnchorMatches(source.anchor, requested)) {
    throw new Error('CatsLog knowledge source read failed: source anchor scope/revision mismatch');
  }
  if (requested.kind === 'source_memory_projection_node' && source.status === 'read') {
    const wireSource = (raw as any).source;
    const context = wireSource.projection_context;
    if (context?.contract_version === 'memory-graph/3') {
      if (Object.prototype.hasOwnProperty.call(wireSource, 'text') || Object.prototype.hasOwnProperty.call(wireSource, 'cleaned_content')
      || ['output_nodes', 'conditions', 'omissions', 'source_anchors', 'node_sources'].some(key => Object.prototype.hasOwnProperty.call(wireSource, key))
      || !projectionContextValid(context, requested) || wireSource.node_kind !== undefined
        && wireSource.node_kind !== context.nodes.find((n: any) => n.id === requested.id)?.kind) {
        throw new Error('CatsLog knowledge source read failed: invalid memory-graph/3 projection context');
      }
      const selected = context.nodes.find((n: any) => n.id === context.selected_node_id)!;
      if (typeof wireSource.content_hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(wireSource.content_hash)
        || wireSource.content_hash.slice(7) !== createHash('sha256').update(selected.text).digest('hex')) {
        throw new Error('CatsLog knowledge source read failed: selected body hash mismatch');
      }
      return { ...page, source: { ...wireSource, text: selected.text } as CatsLogKnowledgeSourceContent };
    }
    if (context?.contract_version === 'memory-graph/1' || context?.contract_version === 'memory-graph/2'
      || context?.contract_version === undefined && Array.isArray(context?.output_nodes)
        && context.output_proofs === undefined && context.generation_contexts === undefined) {
      if (!Array.isArray(context.nodes) || !str(context.selected_node_id)
        || !context.nodes.some((n: any) => obj(n) && n.id === context.selected_node_id && typeof n.text === 'string')
        || context.selected_node_id !== requested.id || typeof wireSource.text !== 'string') {
        throw new Error('CatsLog knowledge source read failed: invalid explicit legacy projection context');
      }
      return page;
    }
    throw new Error('CatsLog knowledge source read failed: unsupported projection context version');
  }
  if (source.projection_context !== undefined) throw new Error('CatsLog knowledge source read failed: projection context on non-projection source');
  return page;
}

export function canonicalProjectionAnchorMatches(actual: unknown, requested: CatsLogKnowledgeAnchor): boolean {
  if (!obj(actual) || actual.kind !== requested.kind || actual.id !== requested.id) return false;
  const fields = requested.kind === 'source_memory_projection_node'
    ? ['source_projection_ref', 'revision']
    : ['document_id', 'revision', 'session_id', 'session_type', 'stream_id', 'byte_offset', 'byte_length', 'skill_version_id'];
  for (const key of fields) {
    const expected = (requested as any)[key];
    const received = actual[key];
    if (key === 'revision' && typeof expected === 'string' && typeof received === 'string') {
      if (expected.replace(/^sha256:/, '') !== received.replace(/^sha256:/, '')) return false;
    } else if (expected !== undefined && received !== expected) return false;
  }
  return true;
}

export function validateCanonicalProjectionSourceContent(source: unknown): source is CatsLogKnowledgeSourceContent {
  if (!obj(source) || source.anchor?.kind !== 'source_memory_projection_node'
    || !/^ref_[a-f0-9]{64}$/.test(source.anchor.source_projection_ref)
    || !SHA.test(source.anchor.revision) || !NODE_ID.test(source.anchor.id)
    || !projectionContextValid(source.projection_context, source.anchor) || typeof source.text !== 'string'
    || typeof source.content_hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(source.content_hash)) return false;
  return source.content_hash.slice(7) === createHash('sha256').update(source.text).digest('hex')
    && source.projection_context.nodes.find((n: any) => n.id === source.projection_context.selected_node_id)?.text === source.text;
}

/** Revalidates a JSON tool body at the execution-membership boundary. */
export function validateCanonicalSourceToolBody(body: unknown): boolean {
  if (!obj(body) || !obj(body.source)) return false;
  const s = body.source;
  if (!obj(s.anchor) || s.anchor.kind !== 'source_memory_projection_node'
    || !/^ref_[a-f0-9]{64}$/.test(s.anchor.source_projection_ref) || !SHA.test(s.anchor.revision)
    || !NODE_ID.test(s.anchor.id) || !projectionContextValid(s.projection_context, s.anchor)
    || ['output_nodes', 'conditions', 'omissions', 'source_anchors', 'node_sources', 'cleaned_content'].some(key => Object.prototype.hasOwnProperty.call(s, key))
    || s.status !== 'read' || s.coverage !== 'complete' || s.truncated || !str(s.content_hash)
    || Object.prototype.hasOwnProperty.call(s, 'text')) return false;
  const selected = s.projection_context.nodes.find((n: any) => n.id === s.projection_context.selected_node_id);
  return !!selected && /^sha256:[a-f0-9]{64}$/.test(s.content_hash)
    && s.content_hash.slice(7) === createHash('sha256').update(selected.text).digest('hex');
}

export function canonicalProjectionContextHash(context: CatsLogKnowledgeSourceProjectionContext): string {
  return createHash('sha256').update(canonical(context)).digest('hex');
}
