import type { DailyKnowledgeLaneResult, DailyKnowledgeHit } from './catslog-daily-knowledge-lane';
import type { CatsLogMemoryBackend } from '../utils/catslog-memory-provider';
import { validateKnowledgeGraph, type CatsLogKnowledgeGraph } from '../utils/catslog-knowledge-graph';
import { dailyKnowledgeRef } from './native-recall-attribution';

export function graphNodeRef(node: CatsLogKnowledgeGraph['nodes'][number]): string {
  return dailyKnowledgeRef(node.anchor.document_id!, node.anchor.revision!, node.anchor.id);
}

export async function readDailyGraphs(backend: CatsLogMemoryBackend, base: DailyKnowledgeLaneResult,
  hits: DailyKnowledgeHit[], signal?: AbortSignal): Promise<DailyKnowledgeLaneResult> {
  const graphs: CatsLogKnowledgeGraph[] = [], stops: string[] = [];
  for (const hit of hits) {
    if (signal?.aborted) { stops.push('aborted'); break; }
    const query = { seeds: [{ kind: 'knowledge_entry' as const, document_id: hit.document_id, revision: hit.revision, id: hit.entry_id }],
      node_budget: 16, edge_budget: 64, byte_budget: 16_000 };
    try {
      const graph = validateKnowledgeGraph(await backend.readKnowledgeGraph!(query, signal), query);
      if (signal?.aborted) { stops.push('aborted'); break; }
      graphs.push(graph);
    } catch { stops.push(signal?.aborted ? 'aborted' : 'graph_closure_unavailable'); }
  }
  // No old single-entry/partial expansion fallback when a graph read fails.
  return { ...base, graphs, status: stops.length ? 'truncated' : graphs.length ? 'ok' : 'empty',
    stop_reasons: stops, reads: graphs.flatMap(g => g.nodes.map(n => ({
      ref: graphNodeRef(n), document_id: n.anchor.document_id!, entry_id: n.anchor.id, revision: n.anchor.revision!,
      day: n.day, title: n.entry.title, status: n.entry.status, text: n.entry.text, text_truncated: false,
      source_anchors: n.entry.source_anchors,
    }))), expansions: [], budgets: { graph_reads: hits.length, node_budget: 16, edge_budget: 64, byte_budget: 16_000 } };
}

/** Each graph is indivisible at BOTH full and refine presentation boundaries. */
export function projectDailyGraphs(lane: DailyKnowledgeLaneResult, maxChars: number, maxHits: number): Record<string, unknown> {
  const out = { content_trust: 'agent_private_daily_knowledge', provenance: 'catslog_daily_knowledge',
    status: lane.status, graph_mode: true, graphs: [] as CatsLogKnowledgeGraph[], hits: [] as DailyKnowledgeHit[], reads: [], expansions: [],
    graph_omitted: 0, stop_reasons: lane.stop_reasons ?? [],
    note: 'Graphs are complete required-context groups. Preserve all their nodes, conditions and correction edges when selecting a graph. Hits alone are metadata; unavailable or omitted groups provide no body. Drafts and historical versions are not verified current guidance.' };
  const fits = () => JSON.stringify(out).length <= maxChars;
  for (const graph of lane.graphs ?? []) {
    const projected = { ...graph, nodes: graph.nodes.map(n => ({ ...n, ref: graphNodeRef(n) })) };
    out.graphs.push(projected);
    if (!fits()) { out.graphs.pop(); out.graph_omitted++; out.status = 'truncated'; }
  }
  for (const hit of lane.hits.slice(0, maxHits)) { out.hits.push(hit); if (!fits()) out.hits.pop(); }
  if (!fits()) return { graph_mode: true, graphs: [], hits: [], reads: [], expansions: [], status: 'truncated', graph_omitted: lane.graphs?.length ?? 0 };
  return out;
}

export function selectedDailyGraphs(pack: Record<string, unknown> | undefined, refs: string[]): CatsLogKnowledgeGraph[] {
  const selected = new Set(refs);
  return ((pack?.graphs ?? []) as CatsLogKnowledgeGraph[]).filter(graph => graph.nodes.some(n => selected.has(graphNodeRef(n))));
}
