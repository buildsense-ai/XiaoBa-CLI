import { createHash } from 'crypto';
import type { CatsLogKnowledgeAnchor } from '../utils/catslog-knowledge-types';

/** A body-free channel contract. Exact source text is only fetched by the owner reader. */
export interface MemoryBranchReader {
  kind: 'source' | 'projection' | 'assertion';
  projection_ref?: string;
  revision?: string;
  member_ref?: string;
  node_id?: string;
  anchor?: CatsLogKnowledgeAnchor;
}
export interface MemoryBranchGraphNode {
  id: string;
  kind: string;
  label: string;
  ref: string;
  reader: MemoryBranchReader;
}
export interface MemoryBranchEvent {
  schema: 'catsco.memory_branch.v1';
  branch_run_id: string;
  origin_turn_id: string;
  sequence: number;
  status: 'running' | 'ready' | 'empty' | 'failed' | 'cancelled' | 'expired' | 'injected' | 'answered' | 'deferred' | 'unavailable';
  consumed_turn_id?: string;
  observation_id?: string;
  nodes: MemoryBranchGraphNode[];
  edges: Array<{ id: string; from: string; to: string; kind: string; link_id?: string }>;
  read_refs: string[];
  injected_refs: string[];
  answer_refs: string[];
  truncated?: boolean;
}
const LABELS: Record<string, string> = { assertion: '记忆断言', condition: '适用条件', omission: '已知缺口', correction: '更正', uncertainty: '不确定项', session_query: '历史提问', session_result: '历史回答', learning_node: '学习记录', memory_node: '记忆节点', source_memory_projection_node: '记忆节点', message: '原始消息', tool_call: '工具调用' };
const key = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

export class MemoryBranchPresentation {
  private event: MemoryBranchEvent;
  private projectionNodes = new Map<string, string>();
  private deltaRelations: Array<{ ref: string; relation: any }> = [];
  private byAnchor = new Map<string, Set<string>>();
  private relations: Array<{ id: string; kind: string; from: CatsLogKnowledgeAnchor; to: CatsLogKnowledgeAnchor }> = [];
  constructor(id: string, private readonly update?: (event: MemoryBranchEvent) => void) {
    this.event = { schema: 'catsco.memory_branch.v1', branch_run_id: id, origin_turn_id: '', sequence: 0, status: 'running', nodes: [], edges: [], read_refs: [], injected_refs: [], answer_refs: [] };
  }
  publish(status: MemoryBranchEvent['status'] = this.event.status): MemoryBranchEvent {
    this.event.status = status;
    this.event.sequence++;
    const snapshot = structuredClone(this.event);
    while (Buffer.byteLength(JSON.stringify(snapshot)) > 48 * 1024 && snapshot.nodes.length) {
      snapshot.truncated = true;
      snapshot.nodes.pop();
      const ids = new Set(snapshot.nodes.map(node => node.id));
      snapshot.edges = snapshot.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
    }
    try { this.update?.(snapshot); } catch { /* presentation never interrupts the turn */ }
    return snapshot;
  }
  snapshot(): MemoryBranchEvent { return structuredClone(this.event); }
  private addNode(node: MemoryBranchGraphNode): void {
    if (this.event.nodes.some(item => item.id === node.id)) return;
    if (this.event.nodes.length >= 64) { this.event.truncated = true; return; }
    this.event.nodes.push(node);
  }
  private addEdge(from: string, to: string, kind: string, linkId?: string): void {
    if (!this.event.nodes.some(n => n.id === from) || !this.event.nodes.some(n => n.id === to)) return;
    const id = key([from, to, kind, linkId]);
    if (this.event.edges.some(edge => edge.id === id)) return;
    if (this.event.edges.length >= 128) { this.event.truncated = true; return; }
    this.event.edges.push({ id, from, to, kind, ...(linkId ? { link_id: linkId } : {}) });
  }
  private remember(ref: string): void { if (!this.event.read_refs.includes(ref)) this.event.read_refs.push(ref); }
  source(handle: string, anchor: CatsLogKnowledgeAnchor, context?: any): void {
    this.remember(handle);
    const rows = Array.isArray(context?.nodes) && context.nodes.length ? context.nodes : [{ id: anchor.id, kind: anchor.kind }];
    const ids = new Map<string, string>();
    for (const n of rows) {
      const id = key([handle, { ...anchor, id: n.id }]); ids.set(n.id, id);
      const anchorKey = key({ ...anchor, id: n.id });
      const aliases = this.byAnchor.get(anchorKey) ?? new Set<string>();
      aliases.add(id); this.byAnchor.set(anchorKey, aliases);
      this.addNode({ id, kind: n.kind, label: LABELS[n.kind] ?? '记忆节点', ref: handle, reader: { kind: 'source', anchor } });
    }
    for (const edge of context?.edges ?? []) {
      const from = ids.get(edge.from), to = ids.get(edge.to);
      if (from && to) this.addEdge(from, to, edge.kind);
    }
    this.resolveRelations(); this.publish();
  }
  projection(ref: string, view: Record<string, any>, notify = true): void {
    this.remember(ref);
    const rawNodes = Array.isArray(view.nodes) ? view.nodes : [];
    const ids = new Map<string, string>();
    for (const n of rawNodes) {
      if (typeof n?.id !== 'string' || typeof n?.kind !== 'string') continue;
      const member = typeof n.member_ref === 'string' ? n.member_ref : ref;
      const id = key([ref, member, n.id]); ids.set(n.id, id);
      this.projectionNodes.set(JSON.stringify([ref, member, n.id]), id);
      this.addNode({ id, kind: n.kind, label: LABELS[n.kind] ?? '记忆节点', ref,
        reader: member !== ref ? { kind: 'assertion', projection_ref: ref, member_ref: member, node_id: n.id }
          : { kind: 'projection', projection_ref: ref, ...(typeof view.revision === 'string' ? { revision: view.revision } : {}) } });
    }
    for (const e of Array.isArray(view.edges) ? view.edges : []) {
      const from = ids.get(e?.from), to = ids.get(e?.to);
      if (from && to && typeof e.kind === 'string') this.addEdge(from, to, e.kind);
    }
    for (const relation of view.aggregate?.delta_relations ?? []) this.deltaRelations.push({ ref, relation });
    this.resolveDeltaRelations();
    if (notify) this.publish();
  }
  assertion(ref: string, member: string, closure: Record<string, any>): void {
    this.remember(ref);
    const rows = [closure.assertion, ...(closure.entries ?? []).map((e: any) => e.node)].filter(Boolean);
    const ids = new Map<string, string>();
    for (const n of rows) {
      const id = key([ref, member, n.id]); ids.set(n.id, id);
      this.projectionNodes.set(JSON.stringify([ref, member, n.id]), id);
      this.addNode({ id, kind: n.kind, label: LABELS[n.kind] ?? '记忆节点', ref,
        reader: { kind: 'assertion', projection_ref: ref, member_ref: member, node_id: closure.assertion.id } });
    }
    for (const entry of closure.entries ?? []) for (const edge of entry.path ?? []) {
      const from = ids.get(edge.from), to = ids.get(edge.to);
      if (from && to) this.addEdge(from, to, edge.kind);
    }
    for (const relation of closure.relations ?? []) this.deltaRelations.push({ ref, relation });
    this.resolveDeltaRelations();
    this.publish();
  }
  private resolveDeltaRelations(): void {
    for (const { ref, relation } of this.deltaRelations) {
      const endpoint = (end: any) => this.projectionNodes.get(JSON.stringify([ref, end.kind === 'new' ? ref : end.member_ref, end.node_id]));
      const from = endpoint(relation.from), to = endpoint(relation.to);
      if (from && to) this.addEdge(from, to, relation.kind);
    }
  }
  relation(id: string, kind: string, from: CatsLogKnowledgeAnchor, to: CatsLogKnowledgeAnchor): void {
    if (!this.relations.some(row => row.id === id)) this.relations.push({ id, kind, from, to });
    this.resolveRelations();
  }
  private resolveRelations(): void {
    for (const relation of this.relations) {
      for (const from of this.byAnchor.get(key(relation.from)) ?? []) {
        for (const to of this.byAnchor.get(key(relation.to)) ?? []) this.addEdge(from, to, relation.kind, relation.id);
      }
    }
  }
}
