/**
 * XiaoBa client DTOs for the CatsLog per-Agent per-day knowledge corpus
 * (POST /catsco/agent/knowledge/search|read|expand and source/read).
 *
 * The daily corpus DTOs mirror the shared Go contract in
 * `catslog/internal/knowledge` types.go (`knowledge/1`). The additive source
 * reader v1 mirrors /tmp/knowledge-coverage-source-contract.md. JSON fields
 * are the wire schema — coordinate any changes with the contract owner. Scope identifiers (principal/agent subject/
 * memory scope) are deliberately absent: the server derives them from the
 * device-bound token and never echoes them back.
 */

export type CatsLogKnowledgeAnchorKind =
  | 'session_query'
  | 'session_result'
  | 'graph_node'
  | 'learning_node'
  | 'knowledge_entry'
  | 'skill_program'
  | 'skill_node';

export const CATSLOG_KNOWLEDGE_ANCHOR_KINDS: readonly CatsLogKnowledgeAnchorKind[] = [
  'session_query', 'session_result', 'graph_node', 'learning_node', 'knowledge_entry',
  'skill_program', 'skill_node',
];

/**
 * Typed source anchor. Mirrors knowledge.Anchor. Field requirements per kind
 * are enforced server-side (ValidateAnchor); the client checks the shape
 * mechanically so a malformed call fails before any HTTP dispatch.
 */
export interface CatsLogKnowledgeAnchor {
  kind: CatsLogKnowledgeAnchorKind;
  id: string;
  /** Holding day document (akd-…); required for knowledge_entry, forbidden elsewhere. */
  document_id?: string;
  revision?: string;
  session_id?: string;
  session_type?: string;
  stream_id?: string;
  byte_offset?: number;
  byte_length?: number;
  /** Skill lineage anchors only: the program version. skill_program's `id`
   * equals this value; skill_node's `id` is the node ID inside that version. */
  skill_version_id?: string;
}

export type CatsLogKnowledgeEntryStatus = 'draft' | 'active' | 'superseded' | 'retired';

export const CATSLOG_KNOWLEDGE_ENTRY_STATUSES: readonly CatsLogKnowledgeEntryStatus[] = [
  'draft', 'active', 'superseded', 'retired',
];

/** Mirrors knowledge.Entry. Entry IDs (ake-…) are stable across wording revisions. */
export interface CatsLogKnowledgeEntry {
  id: string;
  title: string;
  /** Full body; the wire never truncates entry text. */
  text: string;
  source_anchors?: CatsLogKnowledgeAnchor[];
  tags?: string[];
  status: CatsLogKnowledgeEntryStatus;
  /** Successor entry ID when status is superseded. */
  merged_into?: string;
}

export type CatsLogKnowledgeLinkKind =
  | 'derived_from' | 'supplements' | 'corrects' | 'continues' | 'related' | 'used';

export const CATSLOG_KNOWLEDGE_LINK_KINDS: readonly CatsLogKnowledgeLinkKind[] = [
  'derived_from', 'supplements', 'corrects', 'continues', 'related', 'used',
];

/**
 * One directed relation stored once server-side (`akl-…` content-derived ID).
 * in/out/both are query views of the same single edge, never second edges.
 */
export interface CatsLogKnowledgeLink {
  id: string;
  kind: CatsLogKnowledgeLinkKind;
  source: CatsLogKnowledgeAnchor;
  target: CatsLogKnowledgeAnchor;
  supporting?: CatsLogKnowledgeAnchor[];
}

export type CatsLogKnowledgeLinkDirection = 'out' | 'in' | 'both';

/** Hint that later relations exist; intentionally carries no counts or titles. */
export interface CatsLogKnowledgeFollowOnHint {
  has_later: boolean;
  expand_cursor?: string;
}

/** Mirrors knowledge.SearchHit. Metadata only; full text is fetched via read. */
export interface CatsLogKnowledgeSearchHit {
  document_id: string;
  /** YYYY-MM-DD event day (server-projected from the scope-internal DayKey). */
  day: string;
  entry_id: string;
  title: string;
  status: CatsLogKnowledgeEntryStatus;
  /** Document revision containing this entry version. */
  revision: string;
  follow_on?: CatsLogKnowledgeFollowOnHint;
}

/**
 * Mirrors knowledge.SearchQuery (json tags are the wire schema). Decoded
 * server-side directly into knowledge.SearchQuery; no scope fields exist.
 */
export interface CatsLogKnowledgeSearchQuery {
  query: string;
  /** 1..50; server default 10 when omitted. */
  limit?: number;
  /** Opaque; replay unmodified for continuation. */
  cursor?: string;
  /** YYYY-MM-DD inclusive, optional. */
  date_from?: string;
  /** YYYY-MM-DD inclusive, optional. */
  date_to?: string;
  statuses?: CatsLogKnowledgeEntryStatus[];
  include_draft?: boolean;
}

/** Mirrors knowledge.SearchPage. */
export interface CatsLogKnowledgeSearchPage {
  hits: CatsLogKnowledgeSearchHit[];
  /** Present ⇒ the server stopped at the limit; absent ⇒ no further pages claimed either way. */
  next_cursor?: string;
  exhausted: boolean;
}

export type CatsLogKnowledgeReadFormat = 'json' | 'okf';

/** Mirrors knowledge.ReadQuery. */
export interface CatsLogKnowledgeReadQuery {
  document_id: string;
  /** Empty ⇒ head; explicit older revisions read immutable history. */
  revision?: string;
  /** Optional single-entry projection. */
  entry_id?: string;
  format?: CatsLogKnowledgeReadFormat;
  /** 1..100 entries per page; server default 20 when omitted. */
  limit?: number;
  cursor?: string;
}

/** Mirrors knowledge.ReadPage (JSON format). Links are read through expand, never duplicated here. */
export interface CatsLogKnowledgeReadPage {
  document_id: string;
  revision: string;
  previous_revision?: string;
  day: string;
  generated_at: string;
  generated_by: string;
  entries: CatsLogKnowledgeEntry[];
  next_cursor?: string;
  exhausted: boolean;
}

/**
 * Read result. `format: "okf"` returns the raw deterministic Open Knowledge
 * Format text/markdown body (renderer output, no model calls) instead of a
 * JSON ReadPage — a clipped OKF string is never emitted (422 typed error).
 */
export type CatsLogKnowledgeReadResult =
  | { format: 'json'; page: CatsLogKnowledgeReadPage }
  | { format: 'okf'; body: string };

export type CatsLogKnowledgeEdgeEndpointStatus = 'resolved' | 'target_missing' | 'source_revoked';

/** Mirrors knowledge.LinkEdge: the opposite endpoint resolved from the queried anchor's perspective. */
export interface CatsLogKnowledgeLinkEdge {
  link: CatsLogKnowledgeLink;
  remote: CatsLogKnowledgeAnchor;
  /** Store-proven authored revision for a blank local endpoint's read pin. */
  origin_revision?: string;
  remote_status: CatsLogKnowledgeEdgeEndpointStatus;
}

/** Mirrors knowledge.ExpandQuery. */
export interface CatsLogKnowledgeExpandQuery {
  anchor: CatsLogKnowledgeAnchor;
  /** Default "both" when omitted. */
  direction?: CatsLogKnowledgeLinkDirection;
  kinds?: CatsLogKnowledgeLinkKind[];
  /** 1..100; server default 20 when omitted. */
  limit?: number;
  cursor?: string;
}

/** Mirrors knowledge.LinkPage. */
export interface CatsLogKnowledgeLinkPage {
  edges: CatsLogKnowledgeLinkEdge[];
  next_cursor?: string;
  exhausted: boolean;
}

/** Frozen source reader v1: /tmp/knowledge-coverage-source-contract.md.
 * Raw sources are redacted stored projections, never original log bytes.
 */
export interface CatsLogKnowledgeSourceQuery {
  anchor: CatsLogKnowledgeAnchor;
  before?: number;
  after?: number;
  max_bytes?: number;
}
export type CatsLogKnowledgeSourceStatus = 'read' | 'missing' | 'revoked' | 'stale' | 'unsupported';
export interface CatsLogKnowledgeSourceContent {
  anchor: CatsLogKnowledgeAnchor;
  status: CatsLogKnowledgeSourceStatus;
  role: 'organic' | 'learning' | 'knowledge';
  speaker: 'user' | 'assistant' | 'user_assistant' | 'structure' | 'knowledge';
  occurred_at: string | null;
  text: string;
  content_hash?: string;
  coverage: 'complete' | 'partial' | 'structural_only';
  truncated: boolean;
  redacted: boolean;
  missing: boolean;
  revoked: boolean;
  reason?: string;
  /** Declared provenance; separate from the learning selected set. */
  source_anchors?: CatsLogKnowledgeAnchor[];
  selected_anchors?: CatsLogKnowledgeAnchor[];
  node_kind?: 'query' | 'action' | 'result' | 'teachback';
  /** Skill program reads only: one independently proved mapping per node,
   * preserved exactly as stored — never collapsed into a program-wide union. */
  node_sources?: CatsLogKnowledgeSourceNodeMapping[];
}

/** Mirrors knowledge.SourceNodeMapping (node_sources entries). */
export interface CatsLogKnowledgeSourceNodeMapping {
  anchor: CatsLogKnowledgeAnchor;
  source_anchors: CatsLogKnowledgeAnchor[];
}
export interface CatsLogKnowledgeSourcePage {
  source: CatsLogKnowledgeSourceContent;
  before: CatsLogKnowledgeSourceContent[];
  after: CatsLogKnowledgeSourceContent[];
  before_exhausted: boolean;
  after_exhausted: boolean;
  context_truncated: boolean;
  served_at: string;
}

/** Stable route defaults owned by CatsLog; capability responses may override. */
export const DEFAULT_KNOWLEDGE_SEARCH_URL = '/catsco/agent/knowledge/search';
export const DEFAULT_KNOWLEDGE_READ_URL = '/catsco/agent/knowledge/read';
export const DEFAULT_KNOWLEDGE_SOURCE_READ_URL = '/catsco/agent/knowledge/source/read';
export const DEFAULT_KNOWLEDGE_EXPAND_URL = '/catsco/agent/knowledge/expand';

/** Wire bounds (knowledge/types.go). Upper bounds only — nothing truncates. */
export const KNOWLEDGE_MAX_SEARCH_QUERY_BYTES = 4 << 10;
export const KNOWLEDGE_MAX_SEARCH_LIMIT = 50;
export const KNOWLEDGE_MAX_READ_LIMIT = 100;
export const KNOWLEDGE_MAX_EXPAND_LIMIT = 100;
export const KNOWLEDGE_MAX_CURSOR_BYTES = 2048;
export const KNOWLEDGE_MAX_DOCUMENT_ID_BYTES = 256;
export const KNOWLEDGE_MAX_REVISION_BYTES = 128;
export const KNOWLEDGE_MAX_OPAQUE_ID_BYTES = 128;
/** Expanded via the client's opaque-identifier grammar; used for anchor/entry IDs. */
export const KNOWLEDGE_MAX_ANCHOR_ID_BYTES = 128;
