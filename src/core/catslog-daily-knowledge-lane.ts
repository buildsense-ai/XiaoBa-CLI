import type { CatsLogMemoryBackend } from '../utils/catslog-memory-provider';
import type { CatsLogKnowledgeSearchHit } from '../utils/catslog-knowledge-types';
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
  status: string;
  read_error?: string;
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
  }>;
}

/**
 * One bounded expansion page (≤ MAX_DAILY_KNOWLEDGE_EXPANDS per retrieval,
 * one server page each) over a read entry's inbound corrections/supplements.
 * The page is reported as-seen: `truncated`/`next_cursor` presence means
 * MORE relations may exist — the lane never claims an exhaustive total.
 */
export interface DailyKnowledgeExpansion {
  anchor_ref: string;
  edges: Array<{
    link_kind: string;
    remote_ref: string | null;
    remote_status: 'resolved' | 'target_missing' | 'source_revoked';
  }>;
  truncated: boolean;
  error?: string;
}

export interface DailyKnowledgeLaneResult {
  status: DailyKnowledgeLaneStatus;
  hits: DailyKnowledgeHit[];
  /** Bounded revision-pinned reads (originals + remote updates). */
  reads: DailyKnowledgeRead[];
  /** Bounded inbound correction/supplement expansion pages (as-seen). */
  expansions: DailyKnowledgeExpansion[];
  /** Typed degraded reason; present only when status is `unavailable`. */
  error?: string;
  queryUsed: string;
  keywordsQueried: string[];
  /** True when hits were dropped by the lane's 8-hit cap. */
  hitsCapped: boolean;
  /** True when the server page reported more content beyond this lane slice. */
  serverTruncated: boolean;
}

export interface DailyKnowledgeLaneOptions {
  backend?: CatsLogMemoryBackend;
  /** Assess query text; primary search term. */
  queryText: string;
  /** Contract-valid assess keywords; first is appended as a fallback term. */
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
 * Bounded inbound-correction expansion pages per retrieval (one server page
 * each, ≤20 edges). Corrections/supplements are how older entries gain NEWER
 * authoritative content — the lane expands them instead of citing stale text.
 */
export const MAX_DAILY_KNOWLEDGE_EXPANDS = 2;
/**
 * Bounded reads of REMOTE NEWER entries surfaced by expansions. Combined with
 * the original-read cap the lane never exceeds MAX_DAILY_KNOWLEDGE_READS +
 * MAX_DAILY_KNOWLEDGE_REMOTE_READS total reads.
 */
export const MAX_DAILY_KNOWLEDGE_REMOTE_READS = 2;
const EXPAND_LINK_KINDS = ['supplements', 'corrects', 'continues'] as const;
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

/** All citable refs carried by the lane (hits + reads), for refs-tracker registration. */
export function collectDailyKnowledgeRefs(lane: DailyKnowledgeLaneResult | undefined): string[] {
  if (!lane) return [];
  const refs = new Set<string>();
  for (const hit of lane.hits) refs.add(hit.ref);
  for (const read of lane.reads) refs.add(read.ref);
  for (const expansion of lane.expansions ?? []) {
    for (const edge of expansion.edges) {
      if (edge.remote_ref) refs.add(edge.remote_ref);
    }
  }
  return [...refs];
}

/** Human/model-visible one-line summary of the newer relations on a read. */
function updateNote(updates: NonNullable<DailyKnowledgeRead['newer_updates']>): string {
  const readRefs = updates.filter(update => update.remote_read_ref).length;
  const anchorOnly = updates.length - readRefs;
  const parts: string[] = [];
  if (readRefs > 0) parts.push(`${readRefs} 条更新的权威内容已回读（见 remote_read_ref 的 read 行）`);
  if (anchorOnly > 0) parts.push(`${anchorOnly} 条更新仅有锚点信息（未读全文，不得声称其内容）`);
  return `本条目存在更新的补充/修正关系：${parts.join('；')}。引用本条旧内容时必须同时引用对应更新。`;
}

/** Stable projected lane envelope for the evidence pack / audit JSON. */
export function projectDailyKnowledgeLane(lane: DailyKnowledgeLaneResult): Record<string, unknown> {
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
      status: read.status,
      ...(read.is_remote_update ? { is_remote_update: true } : {}),
      ...(read.newer_updates?.length ? {
        newer_updates: read.newer_updates.map(update => ({
          link_kind: update.link_kind,
          remote_status: update.remote_status,
          remote_ref: update.remote_ref ?? undefined,
          ...(update.remote_read_ref ? { remote_read_ref: update.remote_read_ref } : {}),
        })),
        newer_updates_note: updateNote(read.newer_updates),
      } : {}),
      ...(read.read_error ? { read_error: read.read_error } : {}),
    })),
    expansions: (lane.expansions ?? []).map(expansion => ({
      anchor_ref: expansion.anchor_ref,
      edges: expansion.edges.map(edge => ({
        link_kind: edge.link_kind,
        remote_status: edge.remote_status,
        ...(edge.remote_ref ? { remote_ref: edge.remote_ref } : {}),
      })),
      ...(expansion.truncated ? { truncated: true } : {}),
      ...(expansion.error ? { error: expansion.error } : {}),
    })),
    ...(lane.error ? { error: lane.error } : {}),
    query_used: lane.queryUsed,
    keywords_queried: lane.keywordsQueried,
    hits_capped: lane.hitsCapped,
    server_truncated: lane.serverTruncated,
    refs_note: 'hits/reads 的 ref（catslog:knowledge:…）是本轮已观察的可引用 ref：引用片段事实时使用对应 read 的 ref；is_remote_update 的 read 是更新的权威内容，被标记 newer_updates 的旧 read 内容可能已被补充/修正，引用旧内容时必须同时给出 newer_updates 的 ref；仅列出 anchor（无 remote_read_ref）的更新只有锚点信息，不代表已读其全文；expansion 页截断时可能还有未见的更新，本 lane 不声称完整。',
  };
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
  const maxReads = options.maxReads ?? MAX_DAILY_KNOWLEDGE_READS;
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
  try {
    page = await backend.searchKnowledge({
      query: queryUsed,
      limit: MAX_DAILY_KNOWLEDGE_HITS,
      // Fresh daily knowledge is EntryStatusDraft; the store default would
      // exclude it. Include drafts here — the lane keeps `status` visible on
      // every hit, and draft is untrusted/unreviewed, never verified.
      include_draft: true,
    }, options.signal);
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

  // Bounded actual reads: top ≤2 hits, entry-scoped and revision-pinned.
  // Per-read failures are typed on the read itself; metadata hits survive.
  const reads: DailyKnowledgeRead[] = [];
  const readAnchors: DailyKnowledgeHit[] = [];
  for (const hit of slicedHits.slice(0, maxReads)) {
    const base = {
      ref: hit.ref,
      document_id: hit.document_id,
      day: hit.day,
      entry_id: hit.entry_id,
      revision: hit.revision,
      title: hit.title,
      status: hit.status,
    };
    try {
      if (!backend.readKnowledge) throw new Error('read route unavailable');
      const result = await backend.readKnowledge({
        document_id: hit.document_id,
        revision: hit.revision,
        entry_id: hit.entry_id,
        format: 'json',
        limit: 1,
      }, options.signal);
      if (result.format !== 'json' || result.page.entries.length === 0) {
        reads.push({ ...base, text: '', text_truncated: false, read_error: 'entry_not_returned' });
        continue;
      }
      const entry = result.page.entries[0];
      const bounded = boundReadText(String(entry.text ?? ''));
      reads.push({
        ...base,
        title: boundTitle(entry.title) || hit.title,
        text: bounded.text,
        text_truncated: bounded.truncated,
      });
      readAnchors.push(hit);
    } catch (error: any) {
      reads.push({
        ...base,
        text: '',
        text_truncated: false,
        read_error: String(error?.message || error || 'entry read failed').slice(0, 200),
      });
    }
  }

  // Bounded inbound correction/supplement expansion over the read entries:
  // older entries gain NEWER authoritative content through these relations,
  // so citing stale text without pointing at the update would mislead. Pages
  // are as-seen (truncated flag + no total claim); failures are typed on the
  // expansion row. Abort + capability revalidation ride on every backend call
  // (provider refreshes 401 per call; the signal cancels each request).
  const expansions: DailyKnowledgeExpansion[] = [];
  const newerByAnchor = new Map<string, NonNullable<DailyKnowledgeRead['newer_updates']>>();
  const pendingRemote = new Map<string, { anchor: AnchorTriple; edge: NonNullable<ReturnType<typeof edgeRow>> }>();
  type AnchorTriple = { document_id: string; revision: string; entry_id: string };
  function edgeRow(kind: string, remote: any, status: any) {
    const documentId = String(remote?.document_id ?? '');
    const revision = String(remote?.revision ?? '');
    const entryId = String(remote?.id ?? '');
    const remoteRef = status === 'resolved'
      ? catslogKnowledgeCitationRef(documentId, revision, entryId)
      : null;
    return {
      link_kind: String(kind ?? ''),
      remote_ref: remoteRef,
      remote_status: (['resolved', 'target_missing', 'source_revoked'].includes(status) ? status : 'target_missing') as 'resolved' | 'target_missing' | 'source_revoked',
      _remote: { document_id: documentId, revision, entry_id: entryId } as AnchorTriple,
    };
  }
  if (backend.expandKnowledge) {
    for (const hit of readAnchors.slice(0, MAX_DAILY_KNOWLEDGE_EXPANDS)) {
      try {
        const linkPage = await backend.expandKnowledge({
          anchor: { kind: 'knowledge_entry', id: hit.entry_id, document_id: hit.document_id, revision: hit.revision },
          direction: 'in',
          kinds: [...EXPAND_LINK_KINDS],
          limit: 20,
        }, options.signal);
        const edges = (Array.isArray(linkPage.edges) ? linkPage.edges : []).map(edge => edgeRow(
          edge.link?.kind, edge.remote, edge.remote_status,
        ));
        const truncated = Boolean(linkPage.next_cursor) || linkPage.exhausted !== true;
        expansions.push({
          anchor_ref: hit.ref,
          edges: edges.map(({ link_kind, remote_ref, remote_status }) => ({ link_kind, remote_ref, remote_status })),
          truncated,
        });
        for (const edge of edges) {
          // All edges (incl. revoked/missing endpoints) stay visible on the
          // read; only resolved+ref edges become remote-read candidates.
          newerByAnchor.set(hit.ref, [
            ...(newerByAnchor.get(hit.ref) ?? []),
            {
              link_kind: edge.link_kind,
              remote_ref: edge.remote_ref,
              remote_status: edge.remote_status,
            },
          ]);
          if (edge.remote_ref) pendingRemote.set(edge.remote_ref, { anchor: edge._remote, edge });
        }
      } catch (error: any) {
        expansions.push({
          anchor_ref: hit.ref,
          edges: [],
          truncated: false,
          error: String(error?.message || error || 'expansion failed').slice(0, 200),
        });
      }
    }
  }

  // Read the remote NEWER entries when visible (resolved), bounded. A remote
  // read becomes its own authoritative row; the older read gains a
  // `remote_read_ref` pointer on the matching newer_update. Entries whose
  // read fails or exceeds the budget stay ANCHOR-ONLY — the lane never claims
  // their full text from anchors alone.
  let remoteReads = 0;
  const seenRemotes = new Set(reads.map(read => read.ref));
  for (const read of reads) {
    const updates = newerByAnchor.get(read.ref);
    if (!updates) continue;
    for (const update of updates) {
      if (!update.remote_ref || update.remote_status !== 'resolved') continue;
      if (seenRemotes.has(update.remote_ref)) {
        const existing = reads.find(candidate => candidate.ref === update.remote_ref);
        if (existing?.is_remote_update) update.remote_read_ref = existing.ref;
        continue;
      }
      if (remoteReads >= MAX_DAILY_KNOWLEDGE_REMOTE_READS) continue; // stays anchor-only
      const remote = pendingRemote.get(update.remote_ref)?.anchor;
      if (!remote) continue;
      seenRemotes.add(update.remote_ref);
      remoteReads += 1;
      try {
        if (!backend.readKnowledge) throw new Error('read route unavailable');
        const result = await backend.readKnowledge({
          document_id: remote.document_id,
          revision: remote.revision,
          entry_id: remote.entry_id,
          format: 'json',
          limit: 1,
        }, options.signal);
        if (result.format !== 'json' || result.page.entries.length === 0) {
          continue; // anchor-only; no text claimed
        }
        const entry = result.page.entries[0];
        const bounded = boundReadText(String(entry.text ?? ''));
        reads.push({
          ref: update.remote_ref,
          document_id: remote.document_id,
          day: '', // remote day is not carried by the expand edge; anchor fields only
          entry_id: remote.entry_id,
          revision: remote.revision,
          title: boundTitle(entry.title),
          text: bounded.text,
          text_truncated: bounded.truncated,
          status: String(entry.status ?? ''),
          is_remote_update: true,
        });
        update.remote_read_ref = update.remote_ref;
      } catch {
        // Typed anchor-only: the edge + status remain visible, no fake text.
      }
    }
    if (updates.length > 0) read.newer_updates = updates;
  }

  const readsIncomplete = reads.some(read => read.read_error)
    || reads.length < Math.min(slicedHits.length, maxReads);
  const truncated = hitsCapped || Boolean(page.next_cursor) || page.exhausted !== true
    || slicedHits.length > maxReads
    || expansions.some(expansion => expansion.truncated || expansion.error)
    || reads.some(read => read.text_truncated) || readsIncomplete;
  return {
    status: slicedHits.length === 0 ? 'empty' : (truncated ? 'truncated' : 'ok'),
    hits: slicedHits,
    reads,
    expansions,
    queryUsed,
    keywordsQueried,
    hitsCapped,
    serverTruncated: Boolean(page.next_cursor) || page.exhausted !== true,
  };
}
