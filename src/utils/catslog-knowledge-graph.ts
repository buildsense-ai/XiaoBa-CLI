import type { CatsLogKnowledgeAnchor, CatsLogKnowledgeEntry, CatsLogKnowledgeLink } from './catslog-knowledge-types';

export interface CatsLogKnowledgeGraphQuery {
  seeds: CatsLogKnowledgeAnchor[];
  node_budget?: number;
  edge_budget?: number;
  byte_budget?: number;
}
export interface CatsLogKnowledgeGraph {
  contract: 'memory-graph/1';
  seeds: CatsLogKnowledgeAnchor[];
  closure_complete: true;
  nodes: Array<{ anchor: CatsLogKnowledgeAnchor; day: string; entry: CatsLogKnowledgeEntry;
    head_revision: string; current_status: CatsLogKnowledgeEntry['status']; ref?: string }>;
  edges: Array<{ link: CatsLogKnowledgeLink; source: CatsLogKnowledgeAnchor; target: CatsLogKnowledgeAnchor; document_revision: string }>;
}
export const DEFAULT_KNOWLEDGE_GRAPH_URL = '/catsco/agent/knowledge/graph';
const statuses = new Set(['draft', 'active', 'superseded', 'retired']);
export function graphAnchorKey(a: CatsLogKnowledgeAnchor): string {
  return `${a.document_id}:${a.revision}:${a.id}`;
}
export function graphEntryAnchor(value: unknown): CatsLogKnowledgeAnchor {
  const a = value as CatsLogKnowledgeAnchor;
  if (!a || a.kind !== 'knowledge_entry' || !/^akd-[a-f0-9]{24}$/.test(a.document_id ?? '')
    || !/^ake-[a-f0-9]{24}$/.test(a.id ?? '') || !/^akr-[a-f0-9]{64}$/.test(a.revision ?? '')
    || Object.keys(a).some(k => !['kind', 'document_id', 'id', 'revision'].includes(k))) {
    throw new Error('memory graph requires exact knowledge-entry anchors');
  }
  return { kind: a.kind, document_id: a.document_id, id: a.id, revision: a.revision };
}
export function validateKnowledgeGraphQuery(input: CatsLogKnowledgeGraphQuery): CatsLogKnowledgeGraphQuery {
  if (!Array.isArray(input.seeds) || !input.seeds.length || input.seeds.length > 8) throw new Error('memory graph requires 1..8 seeds');
  const out: CatsLogKnowledgeGraphQuery = { seeds: input.seeds.map(graphEntryAnchor) };
  for (const [key, fallback, min, max] of [['node_budget',16,1,32], ['edge_budget',64,1,128], ['byte_budget',65536,256,262144]] as const) {
    const n = input[key] ?? fallback;
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`memory graph invalid ${key}`);
    out[key] = n;
  }
  return out;
}
/** Fail closed on an incomplete, unpinned, dangling or over-budget wire response. */
export function validateKnowledgeGraph(value: unknown, query: CatsLogKnowledgeGraphQuery): CatsLogKnowledgeGraph {
  const q = validateKnowledgeGraphQuery(query), g = value as CatsLogKnowledgeGraph;
  const fail = (): never => { throw new Error('invalid memory graph closure'); };
  if (!g || g.contract !== 'memory-graph/1' || g.closure_complete !== true || !Array.isArray(g.nodes)
    || !Array.isArray(g.edges) || !Array.isArray(g.seeds) || g.nodes.length > q.node_budget! || g.edges.length > q.edge_budget!
    || Buffer.byteLength(JSON.stringify(g),'utf8') > q.byte_budget!) fail();
  const seeds = q.seeds.map(graphAnchorKey);
  if (g.seeds.length !== seeds.length || g.seeds.some((a,i) => graphAnchorKey(graphEntryAnchor(a)) !== seeds[i])) fail();
  const keys = new Set<string>();
  for (const node of g.nodes) {
    const key = graphAnchorKey(graphEntryAnchor(node.anchor));
    if (keys.has(key) || node.entry?.id !== node.anchor.id || typeof node.entry.text !== 'string'
      || typeof node.entry.title !== 'string' || !statuses.has(node.entry.status) || !statuses.has(node.current_status)
      || !/^akr-[a-f0-9]{64}$/.test(node.head_revision) || !/^\d{4}-\d{2}-\d{2}$/.test(node.day)) fail();
    keys.add(key);
  }
  if (seeds.some(key => !keys.has(key))) fail();
  const edgeKeys = new Set<string>();
  for (const edge of g.edges) {
    const source = graphEntryAnchor(edge.source), target = graphEntryAnchor(edge.target);
    if (!keys.has(graphAnchorKey(source)) || !keys.has(graphAnchorKey(target))
      || !['requires','corrects','supplements'].includes(edge.link?.kind)
      || !/^akl-[a-f0-9]{64}$/.test(edge.link.id) || !/^akr-[a-f0-9]{64}$/.test(edge.document_revision)) fail();
    for (const [raw, pinned] of [[edge.link.source, source], [edge.link.target, target]]) {
      if (!raw || raw.kind !== 'knowledge_entry' || raw.id !== pinned.id || raw.document_id !== pinned.document_id
        || (raw.revision || edge.document_revision) !== pinned.revision) fail();
    }
    const key = `${edge.link.id}:${edge.document_revision}`;
    if (edgeKeys.has(key)) fail();
    edgeKeys.add(key);
  }
  // This checks consistency of returned structure, not the semantic truth of
  // assertions or the completeness of a server's database discovery.
  return g;
}
