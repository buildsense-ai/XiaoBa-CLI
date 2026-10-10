import type { CatsLogMemoryBackend } from '../utils/catslog-memory-provider';
import type {
  CatsLogKnowledgeAnchor,
  CatsLogKnowledgeLinkKind,
  CatsLogKnowledgeSearchHit,
  CatsLogKnowledgeSourceContent,
  CatsLogKnowledgeSourceNodeMapping,
  CatsLogKnowledgeSourcePage,
  CatsLogKnowledgeSourceStatus,
} from '../utils/catslog-knowledge-types';
import { hashedRecallRef } from './native-recall-attribution';
import { catslogKnowledgeCitationRef } from '../tools/memory-branch-tools';

export type DailyKnowledgeLaneStatus = 'ok' | 'empty' | 'truncated' | 'unavailable';

/**
 * One projected daily-knowledge hit in the Branch evidence pack.
 * `ref` is the citable typed corpus ref
 * (`catslog:knowledge:<document_id>:<revision>:<entry_id>`) observed by the
 * branch's refs tracker, so the finish model may cite exactly what it saw.
 */
export interface DailyKnowledgeHit {
  ref: string;
  document_id: string;
  day: string;
  entry_id: string;
  title: string;
  status: string;
  revision: string;
  follow_on?: { has_later: boolean; expand_cursor?: string };
}

/**
 * One bounded ACTUAL read retained by the lane: the full entry text fetched
 * through read (entry-scoped, revision-pinned), an exact typed anchor, and
 * its citable ref. Reads are whole-item: text beyond the lane's presentation
 * bound is explicitly marked `text_truncated`, never silently clipped.
 * `is_remote_update` marks a NEWER entry fetched because an older hit had a
 * supplements/corrects/continues relation: it is the authoritative updated
 * content, and the superseded read carries `newer_updates` pointers to it.
 */
export interface DailyKnowledgeRead {
  ref: string;
  document_id: string;
  day: string;
  entry_id: string;
  revision: string;
  title: string;
  text: string;
  text_truncated: boolean;
  /** Body omitted from this presentation; the ref identifies only the anchor. */
  text_omitted?: boolean;
  updates_omitted?: number;
  status: string;
  /** Exact original source identities, retained independently from body text. */
  source_anchors?: CatsLogKnowledgeAnchor[];
  source_anchors_omitted?: number;
  read_error?: string;
  is_related_read?: boolean;
  is_remote_update?: boolean;
  /**
   * Newer relations observed FROM this read (one row per resolved remote
   * edge). Anchor-only by design: unless the remote entry was actually read
   * (its own DailyKnowledgeRead row exists), only the anchor/revision is
   * known — full text is NEVER claimed from anchors.
   */
  newer_updates?: Array<{
    link_kind: string;
    remote_ref: string | null;
    remote_status: 'resolved' | 'target_missing' | 'source_revoked';
    /** Present only when remote_status = resolved AND the remote was read; absent means anchor-only knowledge. */
    remote_read_ref?: string;
    remote_text_omitted?: boolean;
  }>;
}

/**
 * One bounded expansion page over a read entry's six relation kinds in both
 * directions. Actual endpoints distinguish newer inbound updates from
 * outgoing history; page limits never claim the graph is exhausted.
 */
export interface DailyKnowledgeExpansion {
  anchor_ref: string;
  direction?: 'both';
  edges: Array<{
    link_kind: string;
    /** Derived from actual endpoints; outgoing updates do not supersede this read. */
    direction?: 'in' | 'out' | 'unknown';
    remote_anchor?: CatsLogKnowledgeAnchor;
    remote_ref: string | null;
    remote_status: 'resolved' | 'target_missing' | 'source_revoked';
  }>;
  truncated: boolean;
  edges_omitted?: number;
  error?: string;
}

export interface DailyKnowledgeSourceContent extends CatsLogKnowledgeSourceContent {
  ref: string;
  disclosure: 'text' | 'metadata';
  text_truncated?: boolean;
  text_omitted?: boolean;
  /** Wire content hash, moved here when the presentation omits a prefix tail. */
  read_content_hash?: string;
  source_anchors_omitted?: number;
  /**
   * Skill program reads only: server-proved PER-NODE mappings, kept exactly as
   * returned. Bounded here; overflow is counted, never silently clipped, and a
   * program is never collapsed into one program-wide provenance union.
   */
  node_sources?: CatsLogKnowledgeSourceNodeMapping[];
  node_sources_omitted?: number;
}
export interface DailyKnowledgeSourceRead extends Omit<CatsLogKnowledgeSourcePage, 'source' | 'before' | 'after'> {
  requested_anchor: CatsLogKnowledgeAnchor;
  source: DailyKnowledgeSourceContent;
  before: DailyKnowledgeSourceContent[];
  after: DailyKnowledgeSourceContent[];
  context_omitted?: number;
  error?: string;
}

/**
 * Truthful Skill-lineage outcome of THIS run. Derived only from what the lane
 * actually attempted and what the server actually returned for a
 * server-returned skill anchor — never from a skill name or a summary.
 *
 * - `resolved`: at least one skill_program/skill_node read was proved by the
 *   server and returned its per-node mapping (program) or node body (node).
 * - `unsupported`: the server answered, but reported no captured mapping or
 *   no captured body (e.g. `node_source_mapping_not_captured`,
 *   `body_not_captured`, program/node missing, revoked or stale).
 * - `unavailable`: no source reader/backend, or the fixed read budget/abort
 *   prevented the attempt. Absence of an attempt is NOT evidence of absence.
 * - `not_observed`: no skill anchor appeared in this run's provenance or
 *   expand edges. Skill handles are never guessed into source anchors.
 */
export type DailyKnowledgeSkillLineageState = 'resolved' | 'unsupported' | 'unavailable' | 'not_observed';

/** Per-anchor outcome. Node provenance is never collapsed into one row. */
export interface DailyKnowledgeSkillLineageAnchor {
  anchor: CatsLogKnowledgeAnchor;
  outcome: 'resolved' | 'unsupported' | 'rejected' | 'unavailable';
  /** Per-node mappings actually retained from the program read. */
  node_mappings?: number;
  /** True only when this read actually disclosed a node body (never inferred). */
  body_disclosed?: boolean;
  /** Exact server reason verbatim, when one was returned. */
  server_reason?: string;
  stop_reason?: string;
}

export interface DailyKnowledgeLaneResult {
  status: DailyKnowledgeLaneStatus;
  hits: DailyKnowledgeHit[];
  /** Bounded revision-pinned reads (originals + remote updates + related entries). */
  reads: DailyKnowledgeRead[];
  /** Bounded bidirectional relation pages (as-seen, not recursive). */
  expansions: DailyKnowledgeExpansion[];
  source_reads?: DailyKnowledgeSourceRead[];
  source_errors?: Array<{ anchor: CatsLogKnowledgeAnchor; error: string }>;
  /** Typed degraded reason; present only when status is `unavailable`. */
  error?: string;
  queryUsed: string;
  keywordsQueried: string[];
  /** True when hits were dropped by the lane's 8-hit cap. */
  hitsCapped: boolean;
  /** True when the server page reported more content beyond this lane slice. */
  serverTruncated: boolean;
  /** Cumulative presentation omissions when tightening an already bounded view. */
  presentationOmitted?: { hits: number; reads: number; updates: number; edges: number; sources?: number; contexts?: number; skill_nodes?: number };
  searches?: string[];
  stop_reasons?: string[];
  budgets?: Record<string, number>;
  /** Real outcome of this run's Skill-lineage attempts; see the state union. */
  skill_lineage?: DailyKnowledgeSkillLineageState;
  /** One row per skill anchor actually attempted or budget-stopped. */
  skill_lineage_anchors?: DailyKnowledgeSkillLineageAnchor[];
  /** Distinct reasons behind every non-resolved Skill-lineage row. */
  skill_lineage_stop_reason?: string;
}

export interface DailyKnowledgeLaneOptions {
  backend?: CatsLogMemoryBackend;
  /** Assess query text; primary search term. */
  queryText: string;
  /** Assess keywords used by one empty-search fallback; no additional inference. */
  keywords: string[];
  signal?: AbortSignal;
  /** Overrides PathResolver-style defaults (tests). */
  maxReads?: number;
}

/** Lane cap on projected hits (well inside the search wire limit of 50). */
export const MAX_DAILY_KNOWLEDGE_HITS = 8;
/** Bounded ACTUAL reads per retrieval for ORIGINAL hits (read cost accepted; no model call). */
export const MAX_DAILY_KNOWLEDGE_READS = 2;
/**
 * Bounded relation pages over original reads only; each queries both views
 * of all six link kinds, with at most 20 edges and no cursor continuation.
 */
export const MAX_DAILY_KNOWLEDGE_EXPANDS = 2;
/**
 * Bounded reads of REMOTE NEWER entries surfaced by inbound expansions.
 * Related entries have a separate allowance and cannot consume this cap.
 */
export const MAX_DAILY_KNOWLEDGE_REMOTE_READS = 2;
const EXPAND_LINK_KINDS: CatsLogKnowledgeLinkKind[] = ['supplements', 'corrects', 'continues', 'derived_from', 'used', 'related'];
const UPDATE_LINK_KINDS = new Set(['supplements', 'corrects', 'continues']);
export const MAX_DAILY_KNOWLEDGE_RELATED_READS = 2;
/** Presentation bound on per-node mappings retained for ONE skill program read. */
export const MAX_DAILY_KNOWLEDGE_NODE_MAPPINGS = 8;
/** Bound on the compressed source anchors kept for ONE mapped node. */
export const MAX_DAILY_KNOWLEDGE_NODE_SOURCE_ANCHORS = 8;
/**
 * Bounded follow-on node-body reads unlocked by a proved skill program read.
 * They consume the SAME MAX_DAILY_KNOWLEDGE_SOURCE_READS budget and only ever
 * use node anchors the server itself returned; nothing is guessed.
 */
export const MAX_DAILY_KNOWLEDGE_SKILL_NODE_READS = 2;
export const MAX_DAILY_KNOWLEDGE_SOURCE_ANCHORS = 8;
export const MAX_DAILY_KNOWLEDGE_SOURCE_READS = 3;
const MAX_SOURCE_READ_BYTES = 2_048;
const MAX_SOURCE_CANDIDATES = 32;
/** Presentation bound per retained read text; overflow is explicitly marked. */
export const MAX_DAILY_KNOWLEDGE_READ_TEXT_CHARS = 4_000;

function boundTitle(title: unknown): string {
  const text = typeof title === 'string' ? title : '';
  // Titles are bounded at write time (512B) by the store contract; this is a
  // defensive projection bound only, and it marks, never silently clips.
  return Array.from(text).length > 200 ? `${Array.from(text).slice(0, 200).join('')}…` : text;
}

function projectHit(hit: CatsLogKnowledgeSearchHit): DailyKnowledgeHit | null {
  const documentId = String(hit.document_id ?? '');
  const revision = String(hit.revision ?? '');
  const entryId = String(hit.entry_id ?? '');
  // A hit without a well-formed citable anchor is not projectable; dropping
  // it is explicit (the lane stays honest about what it retained).
  const ref = catslogKnowledgeCitationRef(documentId, revision, entryId);
  if (!ref) return null;
  return {
    ref,
    document_id: documentId,
    day: String(hit.day ?? ''),
    entry_id: entryId,
    title: boundTitle(hit.title),
    status: String(hit.status ?? ''),
    revision,
    ...(hit.follow_on
      ? { follow_on: { has_later: hit.follow_on.has_later === true, ...(hit.follow_on.expand_cursor ? { expand_cursor: hit.follow_on.expand_cursor } : {}) } }
      : {}),
  };
}

function boundReadText(text: string): { text: string; truncated: boolean } {
  const chars = Array.from(text ?? '');
  if (chars.length <= MAX_DAILY_KNOWLEDGE_READ_TEXT_CHARS) {
    return { text, truncated: false };
  }
  return { text: `${chars.slice(0, MAX_DAILY_KNOWLEDGE_READ_TEXT_CHARS).join('')}…[truncated]`, truncated: true };
}

function sourceAnchorIdentity(anchor: CatsLogKnowledgeAnchor): Record<string, unknown> {
  // Go's raw byte_offset uses omitempty: absent and explicit zero identify
  // the same first turn. Other anchor domains have no implicit raw coordinate.
  return anchor.kind === 'session_query' || anchor.kind === 'session_result'
    ? { ...anchor, byte_offset: anchor.byte_offset ?? 0 } : { ...anchor };
}

/** Skill lineage anchors are their own identity domain (no stream/document coords). */
function isSkillAnchor(anchor: CatsLogKnowledgeAnchor | undefined): anchor is CatsLogKnowledgeAnchor {
  return anchor?.kind === 'skill_program' || anchor?.kind === 'skill_node';
}

/** Stable dedupe/projection key for one anchor identity (Go omitempty normalized). */
function skillAnchorKey(anchor: CatsLogKnowledgeAnchor): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(sourceAnchorIdentity(anchor)).sort(([a], [b]) => a.localeCompare(b)),
  ));
}

/**
 * Mechanical proof of a node mapping's identity. The client never invents a
 * version or node id: every field must match the anchor the server just proved.
 * A mapping that fails is dropped and counted, never merged into another node.
 */
function validSkillNodeMapping(
  mapping: CatsLogKnowledgeSourceNodeMapping,
  requested: CatsLogKnowledgeAnchor,
): boolean {
  const anchor = mapping?.anchor;
  if (!isSkillAnchor(anchor)) return false;
  if (!anchor.skill_version_id || anchor.skill_version_id !== requested.skill_version_id) return false;
  if (anchor.kind === 'skill_program' && anchor.id !== anchor.skill_version_id) return false;
  if (anchor.kind !== requested.kind && requested.kind === 'skill_node') return false;
  return Array.isArray(mapping.source_anchors) && mapping.source_anchors.length > 0;
}

function shortenSourceContent(content: DailyKnowledgeSourceContent, maxChars: number): void {
  if (content.text.length <= maxChars) return;
  const chars = Array.from(content.text);
  let prefix = '';
  for (const char of chars) {
    if (prefix.length + char.length > maxChars) break;
    prefix += char;
  }
  content.text = prefix;
  content.text_truncated = true;
  content.coverage = 'partial';
  content.truncated = true;
  if (content.content_hash) {
    content.read_content_hash = content.content_hash;
    delete content.content_hash;
  }
  if (!prefix) { content.text_omitted = true; content.disclosure = 'metadata'; }
}

/** All citable refs carried by the lane (hits + actual source/context results). */
export function collectDailyKnowledgeRefs(lane: DailyKnowledgeLaneResult | undefined): string[] {
  if (!lane) return [];
  return collectProjectedDailyKnowledgeRefs(projectDailyKnowledgeLane(lane));
}

/** Refs from the final bounded view only, including explicitly anchor-only edges. */
export function collectProjectedDailyKnowledgeRefs(projected: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  for (const row of [...(projected.hits as DailyKnowledgeHit[] ?? []), ...(projected.reads as DailyKnowledgeRead[] ?? [])]) {
    refs.add(row.ref);
    for (const update of (row as DailyKnowledgeRead).newer_updates ?? []) {
      if (update.remote_ref) refs.add(update.remote_ref);
    }
  }
  for (const expansion of projected.expansions as DailyKnowledgeExpansion[] ?? []) {
    refs.add(expansion.anchor_ref);
    for (const edge of expansion.edges) {
      if (edge.remote_ref) refs.add(edge.remote_ref);
    }
  }
  for (const page of projected.source_reads as DailyKnowledgeSourceRead[] ?? []) {
    for (const content of [page.source, ...page.before, ...page.after]) refs.add(content.ref);
  }
  return [...refs];
}

/** Human/model-visible one-line summary of the newer relations on a read. */
function updateNote(updates: NonNullable<DailyKnowledgeRead['newer_updates']>): string {
  const readRefs = updates.filter(update => update.remote_read_ref).length;
  const anchorOnly = updates.length - readRefs;
  const parts: string[] = [];
  if (readRefs > 0) parts.push(`${readRefs} 条更新的内容已呈现（见 remote_read_ref 的 read 行；text_truncated 表示仅有片段）`);
  if (anchorOnly > 0) parts.push(`${anchorOnly} 条更新仅有锚点信息（未读全文，不得声称其内容）`);
  return `本条目存在更新的补充/修正关系：${parts.join('；')}。引用本条旧内容时必须同时引用对应更新。`;
}

/** Stable projected lane envelope for the evidence pack / audit JSON. */
function dailyKnowledgeProjection(lane: DailyKnowledgeLaneResult): Record<string, unknown> {
  // Presentation truth for Skill lineage: a row whose read page was shed by the
  // budget is still a real retrieval outcome, but its mapping is NOT on screen.
  const presentedSkillAnchors = new Set((lane.source_reads ?? []).map(page => skillAnchorKey(page.requested_anchor)));
  return {
    content_trust: 'agent_private_daily_knowledge',
    provenance: 'catslog_daily_knowledge',
    status: lane.status,
    hits: lane.hits.map(hit => ({
      ref: hit.ref,
      document_id: hit.document_id,
      day: hit.day,
      entry_id: hit.entry_id,
      title: hit.title,
      status: hit.status,
      revision: hit.revision,
      ...(hit.follow_on
        ? { follow_on: { has_later: hit.follow_on.has_later, ...(hit.follow_on.expand_cursor ? { expand_cursor: hit.follow_on.expand_cursor } : {}) } }
        : {}),
    })),
    reads: lane.reads.map(read => ({
      ref: read.ref,
      document_id: read.document_id,
      day: read.day,
      entry_id: read.entry_id,
      revision: read.revision,
      title: read.title,
      text: read.text,
      ...(read.text_truncated ? { text_truncated: true } : {}),
      ...(read.text_omitted ? { text_omitted: true } : {}),
      ...(read.updates_omitted ? { updates_omitted: read.updates_omitted } : {}),
      status: read.status,
      ...(read.source_anchors?.length ? { source_anchors: read.source_anchors } : {}),
      ...(read.source_anchors_omitted ? { source_anchors_omitted: read.source_anchors_omitted } : {}),
      ...(read.is_related_read ? { is_related_read: true } : {}),
      ...(read.is_remote_update ? { is_remote_update: true } : {}),
      ...(read.newer_updates?.length || read.updates_omitted ? {
        newer_updates: (read.newer_updates ?? []).map(update => ({
          link_kind: update.link_kind,
          remote_status: update.remote_status,
          remote_ref: update.remote_ref ?? undefined,
          ...(update.remote_read_ref ? { remote_read_ref: update.remote_read_ref } : {}),
          ...(update.remote_text_omitted ? { remote_text_omitted: true } : {}),
        })),
        newer_updates_note: [
          read.newer_updates?.length ? updateNote(read.newer_updates) : '',
          read.updates_omitted ? `另有 ${read.updates_omitted} 条补充/修正关系未呈现；本条旧内容不能作为最终未修正结论引用，须按精确版本回读更新。` : '',
        ].filter(Boolean).join(' '),
        ...(read.updates_omitted ? { has_unpresented_updates: true } : {}),
      } : {}),
      ...(read.read_error ? { read_error: read.read_error } : {}),
    })),
    expansions: (lane.expansions ?? []).map(expansion => ({
      anchor_ref: expansion.anchor_ref,
      ...(expansion.direction ? { direction: expansion.direction } : {}),
      edges: expansion.edges.map(edge => ({
        link_kind: edge.link_kind,
        ...(edge.direction ? { direction: edge.direction } : {}),
        ...(edge.remote_anchor ? { remote_anchor: edge.remote_anchor } : {}),
        remote_status: edge.remote_status,
        ...(edge.remote_ref ? { remote_ref: edge.remote_ref } : {}),
      })),
      ...(expansion.truncated ? { truncated: true } : {}),
      ...(expansion.edges_omitted ? { edges_omitted: expansion.edges_omitted } : {}),
      ...(expansion.error ? { error: expansion.error } : {}),
    })),
    ...(lane.source_reads ? { source_reads: lane.source_reads } : {}),
    ...(lane.source_errors?.length ? { source_errors: lane.source_errors } : {}),
    source_note: 'source_reads 是授权的脱敏存储投影，不是原 log bytes。每个 source/before/after 独立 anchor/ref；status!=read、structural_only、disclosure=metadata 或 text_omitted 不代表读到正文。coverage=partial、truncated、text_truncated 表示仅见片段；context_truncated/context_omitted 及 exhausted=false 表示上下文未读全。',
    ...(lane.error ? { error: lane.error } : {}),
    ...(lane.searches ? { searches: lane.searches } : {}),
    ...(lane.stop_reasons ? { stop_reasons: lane.stop_reasons } : {}),
    ...(lane.budgets ? { budgets: lane.budgets } : {}),
    // 'not_observed' means no skill anchor was ever attempted, so it carries
    // no information and must not spend bounded-view budget. The unprojected
    // lane result keeps the full truthful state for observability.
    ...(lane.skill_lineage && lane.skill_lineage !== 'not_observed' ? {
      skill_lineage: lane.skill_lineage,
      skill_lineage_note: '本轮 Skill lineage 真实结果；每节点独立 proved，不合并为全局 lineage。',
    } : {}),
    ...(lane.skill_lineage_anchors?.length ? {
      skill_lineage_anchors: lane.skill_lineage_anchors.map(row => ({
        ...row,
        // presented=false means the budget dropped the read row that carries
        // this mapping; the outcome above stays true about RETRIEVAL.
        presented: presentedSkillAnchors.has(skillAnchorKey(row.anchor)),
      })),
    } : {}),
    ...(lane.skill_lineage_stop_reason ? { skill_lineage_stop_reason: lane.skill_lineage_stop_reason } : {}),
    query_used: lane.queryUsed,
    keywords_queried: lane.keywordsQueried,
    hits_capped: lane.hitsCapped,
    server_truncated: lane.serverTruncated,
    refs_note: 'hits/reads 的 ref（catslog:knowledge:…）是本轮已观察的可引用 ref：引用片段事实时使用对应 read 的 ref；is_remote_update 的 read 是更新的权威内容，被标记 newer_updates 的旧 read 内容可能已被补充/修正，引用旧内容时必须同时给出 newer_updates 的 ref；仅列出 anchor（无 remote_read_ref）的更新只有锚点信息，不代表已读其全文；expansion 页截断时可能还有未见的更新，本 lane 不声称完整。',
  };
}

/**
 * Bound the entire JSON envelope, including hits, reads, relations and metadata.
 * Only the displayed portion is readable: text_truncated/text_omitted mark
 * partial/absent bodies, and remote_read_ref names a displayed body row.
 */
export function projectDailyKnowledgeLane(
  lane: DailyKnowledgeLaneResult,
  maxChars = 16_000,
  maxHits = MAX_DAILY_KNOWLEDGE_HITS,
): Record<string, unknown> {
  if (!Number.isSafeInteger(maxChars) || maxChars < 256) {
    throw new RangeError('daily knowledge presentation budget must be at least 256 characters');
  }
  // Work on a copy: retrieval/audit retains the originally read bodies.
  const view = JSON.parse(JSON.stringify(lane)) as DailyKnowledgeLaneResult;
  const omitted = { hits: 0, reads: 0, updates: 0, edges: 0, ...view.presentationOmitted };
  omitted.hits += Math.max(0, view.hits.length - maxHits);
  view.hits = view.hits.slice(0, maxHits);
  let shortened = Object.values(omitted).some(count => count > 0);
  const render = (): Record<string, unknown> => {
    const bodyRefs = new Set(view.reads.filter(read => !read.read_error && read.text.length > 0).map(read => read.ref));
    for (const read of view.reads) {
      for (const update of read.newer_updates ?? []) {
        if (update.remote_read_ref && !bodyRefs.has(update.remote_read_ref)) {
          delete update.remote_read_ref;
          update.remote_text_omitted = true;
        }
      }
    }
    return {
      ...dailyKnowledgeProjection(view),
      ...(shortened ? {
        status: 'truncated', truncated: true, presentation_omitted: omitted,
        note: '本视图预算省略了正文或元数据；text_truncated 是片段，text_omitted 或 remote_text_omitted 仅有锚点；按精确版本回读后再引用遗漏正文。',
      } : {}),
    };
  };
  let projected = render();
  const fits = () => JSON.stringify(projected).length <= maxChars;
  const refresh = () => { shortened = true; projected = render(); };

  // Keep old→actually displayed correction relationships first. Expansion
  // pages duplicate those relations, so shed their tail before body text.
  for (const expansion of [...view.expansions].reverse()) {
    while (!fits() && expansion.edges.length > 0) {
      expansion.edges.pop();
      expansion.edges_omitted = (expansion.edges_omitted ?? 0) + 1;
      expansion.truncated = true;
      omitted.edges += 1;
      refresh();
    }
  }
  for (const read of [...view.reads].reverse()) {
    const updates = read.newer_updates ?? [];
    while (!fits()) {
      const index = updates.map(update => !update.remote_read_ref).lastIndexOf(true);
      if (index < 0) break;
      updates.splice(index, 1);
      read.updates_omitted = (read.updates_omitted ?? 0) + 1;
      omitted.updates += 1;
      refresh();
    }
  }
  // Context neighbors are independent evidence, never interchangeable with
  // the primary. Drop context tails before losing a primary source identity.
  for (const page of [...(view.source_reads ?? [])].reverse()) {
    while (!fits() && (page.after.length || page.before.length)) {
      if (page.after.length) page.after.pop(); else page.before.pop();
      page.context_omitted = (page.context_omitted ?? 0) + 1;
      omitted.contexts = (omitted.contexts ?? 0) + 1;
      page.context_truncated = true;
      refresh();
    }
  }
  // Skill node mappings are independent per-node provenance, not body text.
  // Shed their tail before any whole source page identity is lost.
  for (const page of [...(view.source_reads ?? [])].reverse()) {
    while (!fits() && (page.source.node_sources?.length ?? 0) > 0) {
      page.source.node_sources!.pop();
      page.source.node_sources_omitted = (page.source.node_sources_omitted ?? 0) + 1;
      omitted.skill_nodes = (omitted.skill_nodes ?? 0) + 1;
      refresh();
    }
  }
  // Equal per-body reductions retain both stale and corrected text and their
  // immutable anchors, instead of dropping the remote bodies first.
  for (let textCap = 1_600; !fits() && textCap >= 100; textCap = Math.floor(textCap / 2)) {
    for (const read of view.reads) {
      const chars = Array.from(read.text);
      if (chars.length <= textCap) continue;
      read.text = chars.slice(0, textCap).join('') + '…[truncated]';
      read.text_truncated = true;
    }
    for (const page of view.source_reads ?? []) {
      for (const content of [page.source, ...page.before, ...page.after]) shortenSourceContent(content, textCap);
    }
    refresh();
  }
  while (!fits() && view.hits.length > 0) {
    view.hits.pop(); omitted.hits += 1; refresh();
  }
  // Very small budgets may omit a whole body. Clear every content pointer
  // to it in render(), retaining the exact remote_ref and an explicit gap.
  for (const read of [...view.reads].reverse()) {
    if (fits()) break;
    read.text = '';
    read.text_truncated = true;
    read.text_omitted = true;
    refresh();
  }
  while (!fits() && (view.source_reads?.length ?? 0) > 0) {
    view.source_reads!.pop(); omitted.sources = (omitted.sources ?? 0) + 1; refresh();
  }
  while (!fits() && view.reads.length > 0) {
    view.reads.pop(); omitted.reads += 1; refresh();
  }
  while (!fits() && view.expansions.length > 0) {
    view.expansions.pop(); refresh();
  }
  if (!fits()) {
    // Envelope-only overflow (e.g. a long query/cursor) must also be bounded.
    return {
      content_trust: 'agent_private_daily_knowledge', provenance: 'catslog_daily_knowledge',
      status: 'truncated', truncated: true, presentation_overflow: true,
      note: '本视图预算省略了正文与锚点；请用原查询重新检索。',
    };
  }
  return projected;
}

/**
 * L-DK lane of the mechanical retrieval stage: one bounded search plus top
 * ≤2 ACTUAL reads over the caller's Agent-private CatsLog daily knowledge
 * corpus, via the same device-bound provider the native recall tool uses.
 * No extra model call (read cost is accepted); each retained read carries an
 * exact typed anchor and its citable ref, observed by the branch refs
 * tracker, so the finish pass can cite it. Unpresented hits stay reachable
 * through the native recall tool — never silently dropped knowledge.
 *
 * Degradation is typed and never throws; an unavailable backend or capability
 * yields `status: 'unavailable'` — never a fake-empty ok, and never a
 * fallback into the local shared KB (that stays the separate `local_knowledge`
 * lane; the private corpus is never synced locally).
 */
export async function searchDailyKnowledgeLane(
  options: DailyKnowledgeLaneOptions,
): Promise<DailyKnowledgeLaneResult> {
  const backend = options.backend;
  const requestedReads = options.maxReads ?? MAX_DAILY_KNOWLEDGE_READS;
  const maxReads = Number.isSafeInteger(requestedReads)
    ? Math.min(MAX_DAILY_KNOWLEDGE_READS, Math.max(0, requestedReads)) : MAX_DAILY_KNOWLEDGE_READS;
  const queryText = (options.queryText ?? '').trim();
  const keywords = (options.keywords ?? []).filter(keyword => typeof keyword === 'string' && keyword.trim());
  const keywordsQueried = keywords.slice(0, 3);
  const fallbackQuery = keywordsQueried[0] ?? '';
  const queryUsed = queryText || fallbackQuery;

  if (!backend?.searchKnowledge || !backend.isKnowledgeRecallAvailable?.()) {
    return {
      status: 'unavailable',
      hits: [],
      reads: [],
      expansions: [],
      error: 'catslog_daily_knowledge_unavailable',
      queryUsed,
      keywordsQueried,
      hitsCapped: false,
      serverTruncated: false,
    };
  }
  if (!queryUsed) {
    return {
      status: 'unavailable',
      hits: [],
      reads: [],
      expansions: [],
      error: 'daily_knowledge_query_empty',
      queryUsed,
      keywordsQueried,
      hitsCapped: false,
      serverTruncated: false,
    };
  }

  let page;
  const searches: string[] = [];
  const stopReasons = new Set<string>();
  let originalReadAttempts = 0;
  try {
    if (options.signal?.aborted) throw new Error('aborted');
    searches.push(queryUsed);
    page = await backend.searchKnowledge({
      query: queryUsed,
      limit: MAX_DAILY_KNOWLEDGE_HITS,
      // Fresh daily knowledge is EntryStatusDraft; the store default would
      // exclude it. Include drafts here — the lane keeps `status` visible on
      // every hit, and draft is untrusted/unreviewed, never verified.
      include_draft: true,
    }, options.signal);
    // One deterministic rewrite using assess task clues, only after a truly
    // exhausted empty search. Never replace an incomplete page with "empty".
    const rewrite = keywordsQueried.join(' ').trim();
    if (page.hits.length === 0 && page.exhausted === true && !page.next_cursor
      && rewrite && rewrite !== queryUsed && !options.signal?.aborted) {
      searches.push(rewrite);
      try {
        page = await backend.searchKnowledge({ query: rewrite, limit: MAX_DAILY_KNOWLEDGE_HITS, include_draft: true }, options.signal);
      } catch (error: any) {
        stopReasons.add(`rewrite_failed:${String(error?.message || error).slice(0, 100)}`);
      }
    }
  } catch (error: any) {
    return {
      status: 'unavailable',
      hits: [],
      reads: [],
      expansions: [],
      error: String(error?.message || error || 'daily knowledge search failed').slice(0, 200),
      queryUsed,
      keywordsQueried,
      hitsCapped: false,
      serverTruncated: false,
    };
  }
  const hits = (Array.isArray(page.hits) ? page.hits : [])
    .map(projectHit)
    .filter((hit): hit is DailyKnowledgeHit => hit !== null);
  const hitsCapped = hits.length > MAX_DAILY_KNOWLEDGE_HITS;
  const slicedHits = hits.slice(0, MAX_DAILY_KNOWLEDGE_HITS);

  // Original, update and related reads have separate fixed allowances. A
  // related edge cannot consume the correction allowance. No recursive tool
  // loop: only original reads get one expansion page each.
  const reads: DailyKnowledgeRead[] = [];
  const readAnchors: DailyKnowledgeHit[] = [];
  const readEntry = async (
    hit: DailyKnowledgeHit, purpose?: 'update' | 'related',
  ): Promise<DailyKnowledgeRead> => {
    const base = { ref: hit.ref, document_id: hit.document_id, day: hit.day,
      entry_id: hit.entry_id, revision: hit.revision, title: hit.title, status: hit.status,
      ...(purpose === 'update' ? { is_remote_update: true } : {}),
      ...(purpose === 'related' ? { is_related_read: true } : {}) };
    try {
      if (options.signal?.aborted) throw new Error('aborted');
      if (!backend.readKnowledge) throw new Error('read route unavailable');
      const result = await backend.readKnowledge({ document_id: hit.document_id,
        revision: hit.revision, entry_id: hit.entry_id, format: 'json', limit: 1 }, options.signal);
      if (result.format !== 'json' || result.page.document_id !== hit.document_id
        || result.page.revision !== hit.revision) throw new Error('entry_identity_mismatch');
      const entry = result.page.entries.find(entry => entry.id === hit.entry_id);
      if (!entry) throw new Error('entry_not_returned');
      const bounded = boundReadText(String(entry.text ?? ''));
      const anchors = entry.source_anchors ?? [];
      const sourceAnchors = anchors.slice(0, MAX_DAILY_KNOWLEDGE_SOURCE_ANCHORS).map(anchor => ({ ...anchor }));
      if (anchors.length > sourceAnchors.length) stopReasons.add('source_anchor_cap');
      return { ...base, title: boundTitle(entry.title) || hit.title, status: entry.status,
        text: bounded.text, text_truncated: bounded.truncated,
        ...(sourceAnchors.length ? { source_anchors: sourceAnchors } : {}),
        ...(anchors.length > sourceAnchors.length ? { source_anchors_omitted: anchors.length - sourceAnchors.length } : {}) };
    } catch (error: any) {
      stopReasons.add(options.signal?.aborted ? 'aborted' : 'entry_read_failed');
      return { ...base, text: '', text_truncated: false,
        read_error: String(error?.message || error || 'entry read failed').slice(0, 200) };
    }
  };
  for (const hit of slicedHits.slice(0, maxReads)) {
    if (options.signal?.aborted) { stopReasons.add('aborted'); break; }
    originalReadAttempts += 1;
    const read = await readEntry(hit);
    reads.push(read);
    if (!read.read_error) readAnchors.push(hit);
  }
  if (slicedHits.length > maxReads) stopReasons.add('original_read_cap');

  const expansions: DailyKnowledgeExpansion[] = [];
  const newerByAnchor = new Map<string, NonNullable<DailyKnowledgeRead['newer_updates']>>();
  const pendingUpdates = new Map<string, DailyKnowledgeHit>();
  const pendingRelated = new Map<string, DailyKnowledgeHit>();
  // Source endpoints are queued by exact identity once the reader contract
  // is available; edge resolution alone is never treated as a body read.
  const sourceCandidates: CatsLogKnowledgeAnchor[] = reads.flatMap(read => read.source_anchors ?? []);
  const endpointMatches = (anchor: CatsLogKnowledgeAnchor | undefined, hit: DailyKnowledgeHit): boolean =>
    anchor?.kind === 'knowledge_entry' && anchor.id === hit.entry_id
    && anchor.document_id === hit.document_id && (!anchor.revision || anchor.revision === hit.revision);
  if (backend.expandKnowledge) {
    for (const hit of readAnchors.slice(0, MAX_DAILY_KNOWLEDGE_EXPANDS)) {
      if (options.signal?.aborted) { stopReasons.add('aborted'); break; }
      try {
        const linkPage = await backend.expandKnowledge({
          anchor: { kind: 'knowledge_entry', id: hit.entry_id, document_id: hit.document_id, revision: hit.revision },
          direction: 'both', kinds: [...EXPAND_LINK_KINDS], limit: 20,
        }, options.signal);
        const wireEdges = Array.isArray(linkPage.edges) ? linkPage.edges : [];
        const edges: DailyKnowledgeExpansion['edges'] = [];
        for (const edge of wireEdges.slice(0, 20)) {
          const remote = edge.remote;
          const direction = endpointMatches(edge.link?.target, hit) ? 'in'
            : endpointMatches(edge.link?.source, hit) ? 'out' : 'unknown';
          const status = ['resolved', 'target_missing', 'source_revoked'].includes(edge.remote_status)
            ? edge.remote_status : 'target_missing';
          const kind = edge.link?.kind;
          const remoteRef = remote?.kind === 'knowledge_entry' && status === 'resolved'
            ? catslogKnowledgeCitationRef(remote.document_id ?? '', remote.revision ?? '', remote.id) : null;
          edges.push({ link_kind: kind, direction, remote_anchor: remote ? { ...remote } : undefined,
            remote_ref: remoteRef, remote_status: status });
          // Incomplete legacy fixtures lack endpoints; classify them as
          // unknown, never guess that an outgoing correction is newer.
          const inboundUpdate = direction === 'in' && UPDATE_LINK_KINDS.has(kind);
          if (inboundUpdate) {
            newerByAnchor.set(hit.ref, [...(newerByAnchor.get(hit.ref) ?? []),
              { link_kind: kind, remote_ref: remoteRef, remote_status: status }]);
          }
          if (status !== 'resolved') { stopReasons.add(status); continue; }
          if (remoteRef) {
            const candidate: DailyKnowledgeHit = { ref: remoteRef, document_id: remote.document_id!,
              revision: remote.revision!, entry_id: remote.id, day: '', title: '', status: '' };
            (inboundUpdate ? pendingUpdates : pendingRelated).set(remoteRef, candidate);
          } else if (remote && remote.kind !== 'knowledge_entry') sourceCandidates.push({ ...remote });
          else stopReasons.add('unpinned_relation');
        }
        const truncated = Boolean(linkPage.next_cursor) || linkPage.exhausted !== true || wireEdges.length > 20;
        if (truncated) stopReasons.add('relation_page_cap');
        expansions.push({ anchor_ref: hit.ref, direction: 'both', edges, truncated,
          ...(wireEdges.length > 20 ? { edges_omitted: wireEdges.length - 20 } : {}) });
      } catch (error: any) {
        stopReasons.add(options.signal?.aborted ? 'aborted' : 'expansion_failed');
        expansions.push({ anchor_ref: hit.ref, direction: 'both', edges: [], truncated: false,
          error: String(error?.message || error || 'expansion failed').slice(0, 200) });
      }
    }
  } else if (readAnchors.length) stopReasons.add('expansion_unavailable');

  const seen = new Set(reads.map(read => read.ref));
  let updateReads = 0, relatedReads = 0;
  for (const [candidates, purpose, cap] of [
    [pendingUpdates, 'update', MAX_DAILY_KNOWLEDGE_REMOTE_READS],
    [pendingRelated, 'related', MAX_DAILY_KNOWLEDGE_RELATED_READS],
  ] as const) {
    let attempted = 0;
    for (const hit of candidates.values()) {
      if (seen.has(hit.ref)) continue;
      if (attempted >= cap) { stopReasons.add(`${purpose}_read_cap`); break; }
      if (options.signal?.aborted) { stopReasons.add('aborted'); break; }
      seen.add(hit.ref); attempted += 1;
      const read = await readEntry(hit, purpose);
      reads.push(read);
      if (purpose === 'update') sourceCandidates.unshift(...(read.source_anchors ?? []));
      else sourceCandidates.push(...(read.source_anchors ?? []));
    }
    if (purpose === 'update') updateReads = attempted; else relatedReads = attempted;
  }
  for (const read of reads) {
    const updates = newerByAnchor.get(read.ref);
    if (!updates) continue;
    for (const update of updates) {
      const actual = reads.find(candidate => candidate.ref === update.remote_ref && !candidate.read_error && candidate.text.length > 0);
      if (actual) update.remote_read_ref = actual.ref;
    }
    read.newer_updates = updates;
  }

  const sourceReads: DailyKnowledgeSourceRead[] = [];
  const sourceErrors: NonNullable<DailyKnowledgeLaneResult['source_errors']> = [];
  const skillLineageRows: DailyKnowledgeSkillLineageAnchor[] = [];
  const skillRowIndex = new Map<string, DailyKnowledgeSkillLineageAnchor>();
  let sourceAttempts = 0;
  let skillNodeReads = 0;
  let skillNodeMappings = 0;
  const uniqueSources = new Map<string, CatsLogKnowledgeAnchor>();
  // Related knowledge-entry provenance is also readable. A skill anchor is
  // read only when the SERVER returned it as provenance or as an expand edge
  // endpoint; a skill handle is never converted into a guessed source node.
  for (const anchor of sourceCandidates) {
    const key = skillAnchorKey(anchor);
    if (!uniqueSources.has(key)) uniqueSources.set(key, anchor);
    if (uniqueSources.size >= MAX_SOURCE_CANDIDATES) { stopReasons.add('source_candidate_cap'); break; }
  }
  /** One truth-bearing row per skill anchor; later stages only refine it. */
  const skillRow = (anchor: CatsLogKnowledgeAnchor): DailyKnowledgeSkillLineageAnchor => {
    const key = skillAnchorKey(anchor);
    const existing = skillRowIndex.get(key);
    if (existing) return existing;
    const row: DailyKnowledgeSkillLineageAnchor = { anchor: { ...anchor }, outcome: 'unavailable' };
    skillRowIndex.set(key, row);
    skillLineageRows.push(row);
    return row;
  };
  const queuedSources = new Set([...uniqueSources.keys()]);
  const skillCandidates = [...uniqueSources.values()].filter(isSkillAnchor);
  const otherCandidates = [...uniqueSources.values()].filter(anchor => !isSkillAnchor(anchor));
  // Skill lineage goes first inside the SAME fixed read budget: an unpinned or
  // unmapped program would otherwise be silently starved by ordinary session
  // context, which is exactly the gap this lane exists to close.
  const orderedSources: CatsLogKnowledgeAnchor[] = [...skillCandidates, ...otherCandidates];
  if (uniqueSources.size && !backend.readKnowledgeSource) stopReasons.add('source_reader_unavailable');
  if (skillCandidates.length && !backend.readKnowledgeSource) {
    stopReasons.add('skill_lineage_reader_unavailable');
    for (const anchor of skillCandidates) skillRow(anchor).stop_reason = 'skill_lineage_reader_unavailable';
  }
  if (backend.readKnowledgeSource) {
    for (let cursor = 0; cursor < orderedSources.length; cursor += 1) {
      const anchor = orderedSources[cursor];
      const skill = isSkillAnchor(anchor);
      if (sourceAttempts >= MAX_DAILY_KNOWLEDGE_SOURCE_READS) {
        stopReasons.add('source_read_cap');
        if (skill) {
          stopReasons.add('skill_lineage_read_cap');
          const row = skillRow(anchor);
          row.outcome = 'unavailable';
          row.stop_reason = 'skill_lineage_read_cap';
        }
        continue;
      }
      if (options.signal?.aborted) {
        stopReasons.add('aborted');
        if (skill) {
          const row = skillRow(anchor);
          row.outcome = 'unavailable';
          row.stop_reason = 'aborted';
        }
        break;
      }
      sourceAttempts += 1;
      try {
        const page = await backend.readKnowledgeSource({ anchor, before: 1, after: 1, max_bytes: MAX_SOURCE_READ_BYTES }, options.signal);
        const normalizeRevision = (value: string | undefined) => value?.replace(/^sha256:/, '');
        const canonical = page.source.anchor;
        const requestedIdentity = sourceAnchorIdentity(anchor);
        const canonicalIdentity = sourceAnchorIdentity(canonical);
        // skill_version_id joins the equality check: a program/node answer for
        // a different version is a rejected read, exactly like any other kind.
        if (canonical.kind !== anchor.kind || canonical.id !== anchor.id
          || ['document_id', 'session_id', 'stream_id', 'byte_offset', 'skill_version_id'].some(key =>
            requestedIdentity[key] !== undefined && requestedIdentity[key] !== canonicalIdentity[key])
          || (isSkillAnchor(canonical)
            && (!canonical.skill_version_id
              || (canonical.kind === 'skill_program' && canonical.id !== canonical.skill_version_id)
              || Boolean(canonical.session_id) || Boolean(canonical.stream_id) || Boolean(canonical.document_id)))
          || (anchor.revision && normalizeRevision(anchor.revision) !== normalizeRevision(canonical.revision))) {
          throw new Error('source_identity_mismatch');
        }
        const content = (item: CatsLogKnowledgeSourceContent): DailyKnowledgeSourceContent => {
          const nodeMappings = Array.isArray(item.node_sources) ? item.node_sources : undefined;
          let rejectedNodes = 0;
          const proven = (nodeMappings ?? []).filter(mapping => {
            if (validSkillNodeMapping(mapping, item.anchor)) return true;
            rejectedNodes += 1;
            return false;
          });
          if (rejectedNodes) stopReasons.add('skill_node_mapping_identity_mismatch');
          const kept = proven.slice(0, MAX_DAILY_KNOWLEDGE_NODE_MAPPINGS);
          if (kept.length < proven.length) stopReasons.add('skill_node_mapping_cap');
          return {
            ...item, anchor: { ...item.anchor },
            ...(item.source_anchors ? { source_anchors: item.source_anchors.slice(0, MAX_DAILY_KNOWLEDGE_SOURCE_ANCHORS) } : {}),
            ...(item.source_anchors && item.source_anchors.length > MAX_DAILY_KNOWLEDGE_SOURCE_ANCHORS
              ? { source_anchors_omitted: item.source_anchors.length - MAX_DAILY_KNOWLEDGE_SOURCE_ANCHORS } : {}),
            ...(nodeMappings ? {
              node_sources: kept.map(mapping => ({
                anchor: { ...mapping.anchor },
                source_anchors: mapping.source_anchors.slice(0, MAX_DAILY_KNOWLEDGE_NODE_SOURCE_ANCHORS),
              })),
            } : {}),
            ...(nodeMappings && nodeMappings.length - kept.length > 0
              ? { node_sources_omitted: nodeMappings.length - kept.length } : {}),
            ref: hashedRecallRef('source', [item.anchor, item.content_hash ?? null]),
            disclosure: item.status === 'read' && item.coverage !== 'structural_only' && item.text.length > 0 ? 'text' : 'metadata',
            // Non-readable endpoints cannot disclose text even if a malformed
            // backend returns it; no fallback into a history search.
            ...(item.status !== 'read' || item.coverage === 'structural_only' ? { text: '', content_hash: undefined } : {}),
          };
        };
        const primary = content(page.source);
        const readable = primary.status === 'read';
        const row: DailyKnowledgeSourceRead = { ...page, requested_anchor: { ...anchor }, source: primary,
          before: readable ? page.before.slice(-1).map(content) : [],
          after: readable ? page.after.slice(0, 1).map(content) : [] };
        sourceReads.push(row);
        if (primary.status !== 'read') stopReasons.add(`source_${primary.status}`);
        if (primary.coverage === 'structural_only') stopReasons.add('source_structural_only');
        if (!page.before_exhausted || !page.after_exhausted) stopReasons.add('source_context_window');
        if (page.context_truncated || primary.coverage === 'partial' || primary.truncated
          || [...row.before, ...row.after].some(item => item.status !== 'read' || item.coverage !== 'complete' || item.truncated)) stopReasons.add('source_incomplete');
        if (skill) {
          const lineage = skillRow(anchor);
          lineage.server_reason = page.source.reason || undefined;
          if (!readable) {
            // Server answered with a typed gap: truthful unsupported, not a
            // claim that the lineage never existed.
            lineage.outcome = 'unsupported';
            lineage.stop_reason = `skill_lineage_source_${primary.status}`;
            stopReasons.add(`skill_lineage_source_${primary.status}`);
            continue;
          }
          const provenNodes = primary.node_sources ?? [];
          const nodeAnchors = provenNodes.map(mapping => mapping.anchor);
          skillNodeMappings += provenNodes.length;
          if (provenNodes.length) {
            lineage.outcome = 'resolved';
            lineage.node_mappings = provenNodes.length;
            delete lineage.stop_reason;
            // Queue the server's own node anchors for bounded body reads,
            // immediately behind their program so lineage survives the budget.
            let inserted = 0;
            for (const node of nodeAnchors) {
              const key = skillAnchorKey(node);
              if (queuedSources.has(key)) continue;
              queuedSources.add(key);
              if (skillNodeReads >= MAX_DAILY_KNOWLEDGE_SKILL_NODE_READS) {
                stopReasons.add('skill_lineage_node_read_cap');
                const skipped = skillRow(node);
                skipped.outcome = 'unavailable';
                skipped.stop_reason = 'skill_lineage_node_read_cap';
                continue;
              }
              skillNodeReads += 1;
              orderedSources.splice(cursor + 1 + inserted, 0, node);
              inserted += 1;
            }
          } else if (page.source.coverage !== 'structural_only' && primary.disclosure === 'text') {
            // skill_node: the body itself is the proved lineage.
            lineage.outcome = 'resolved';
            lineage.body_disclosed = true;
            delete lineage.stop_reason;
          } else {
            lineage.outcome = 'unsupported';
            lineage.stop_reason = 'skill_lineage_mapping_not_captured';
            stopReasons.add('skill_lineage_mapping_not_captured');
          }
        }
      } catch (error: any) {
        const reason = String(error?.message || error);
        stopReasons.add(options.signal?.aborted ? 'aborted' : 'source_read_failed');
        sourceErrors.push({ anchor: { ...anchor }, error: reason.slice(0, 200) });
        if (skill) {
          const lineage = skillRow(anchor);
          lineage.outcome = reason === 'source_identity_mismatch' ? 'rejected' : 'unavailable';
          lineage.stop_reason = reason === 'source_identity_mismatch'
            ? 'skill_lineage_identity_mismatch' : 'skill_lineage_read_failed';
          stopReasons.add(lineage.stop_reason);
        }
      }
    }
  }
  const skillLineage: DailyKnowledgeSkillLineageState = skillLineageRows.length === 0
    ? 'not_observed'
    : skillLineageRows.some(row => row.outcome === 'resolved') ? 'resolved'
    : skillLineageRows.every(row => row.outcome === 'unavailable') ? 'unavailable'
    : 'unsupported';
  const skillLineageStopReason = [...new Set(
    skillLineageRows.filter(row => row.outcome !== 'resolved').map(row => row.stop_reason).filter(Boolean) as string[],
  )].sort().join(';') || undefined;
  const readsIncomplete = reads.some(read => read.read_error)
    || reads.length < Math.min(slicedHits.length, maxReads);
  const truncated = hitsCapped || Boolean(page.next_cursor) || page.exhausted !== true
    || slicedHits.length > maxReads
    || expansions.some(expansion => expansion.truncated || expansion.error)
    || reads.some(read => read.text_truncated) || readsIncomplete || stopReasons.size > 0;
  return {
    status: slicedHits.length === 0 ? (truncated ? 'truncated' : 'empty') : (truncated ? 'truncated' : 'ok'),
    hits: slicedHits,
    reads,
    expansions,
    source_reads: sourceReads,
    source_errors: sourceErrors,
    searches,
    stop_reasons: [...stopReasons],
    skill_lineage: skillLineage,
    ...(skillLineageRows.length ? { skill_lineage_anchors: skillLineageRows } : {}),
    ...(skillLineageStopReason ? { skill_lineage_stop_reason: skillLineageStopReason } : {}),
    budgets: { searches: searches.length, original_reads: originalReadAttempts,
      expansion_pages: expansions.length, update_reads: updateReads, related_reads: relatedReads,
      source_reads: sourceReads.length, source_read_attempts: sourceAttempts, source_read_cap: MAX_DAILY_KNOWLEDGE_SOURCE_READS,
      source_bytes_per_read: MAX_SOURCE_READ_BYTES,
      // Skill counters appear only when a skill anchor was attempted, so an
      // unobserved lineage costs the bounded view nothing.
      ...(skillLineageRows.length ? {
        skill_lineage_reads: skillLineageRows.filter(row => row.outcome === 'resolved').length,
        skill_lineage_nodes: skillNodeMappings,
        skill_lineage_node_read_cap: MAX_DAILY_KNOWLEDGE_SKILL_NODE_READS,
        skill_lineage_mapping_cap: MAX_DAILY_KNOWLEDGE_NODE_MAPPINGS,
      } : {}) },
    queryUsed,
    keywordsQueried,
    hitsCapped,
    serverTruncated: Boolean(page.next_cursor) || page.exhausted !== true,
  };
}
