import type { SyntheticObservation, SyntheticObservationRefLane, SyntheticObservationRefLaneTag } from './synthetic-observation';
import type { Message } from '../types';
import { isCatsLogPoolCitationRef } from '../utils/catsco-log-agent-client';

/**
 * Downstream citation matching for memory-branch injections.
 *
 * After the parent agent's reply for the turn that consumed an injection,
 * the reply text is substring-matched against the injected ref strings.
 * Server pool refs (`ref_<64hex>`) become reportable citations for
 * POST /catsco/agent/branch/citations; local knowledge refs (`kb:` /
 * `file:documents/...`) cannot enter the server's ref_-only column and are
 * returned separately for a local-only observation event.
 *
 * Matching is deliberately plain substring containment: refs are opaque,
 * high-entropy tokens the model can only have copied from the injection.
 */
export interface BranchCitationReport {
  requestId: string;
  refs: string[];
}

export interface BranchCitationMatch {
  reports: BranchCitationReport[];
  knowledgeRefs: string[];
  /** Typed source refs stay local; never enter ref_-only reports. */
  sourceRefs?: string[];
}

const MAX_REPORTED_REFS_PER_REQUEST = 64;
const MAX_KNOWLEDGE_CITED_REFS = 32;
const MAX_REQUEST_ID_CHARS = 256;

export function matchBranchCitations(
  observations: readonly SyntheticObservation[],
  replyText: string | undefined,
): BranchCitationMatch {
  const reports = new Map<string, Set<string>>();
  const knowledgeRefs = new Set<string>();
  const sourceRefs = new Set<string>();
  const text = typeof replyText === 'string' ? replyText : '';
  if (!text || observations.length === 0) {
    return { reports: [], knowledgeRefs: [] };
  }

  for (const observation of observations) {
    const metadata = observation.metadata;
    if (!metadata) continue;
    const citation = metadata.citation;
    if (citation && typeof citation === 'object' && !Array.isArray(citation)) {
      const requestId = typeof citation.requestId === 'string' ? citation.requestId.trim() : '';
      if (requestId && requestId.length <= MAX_REQUEST_ID_CHARS && !hasControlChar(requestId)) {
        const cited = reports.get(requestId) ?? new Set<string>();
        for (const ref of citation.refs ?? []) {
          if (cited.size >= MAX_REPORTED_REFS_PER_REQUEST) break;
          if (isCatsLogPoolCitationRef(ref) && text.includes(ref)) cited.add(ref);
        }
        if (cited.size > 0) reports.set(requestId, cited);
      }
    }
    for (const ref of Array.isArray(metadata.refs) ? metadata.refs : []) {
      if (knowledgeRefs.size < MAX_KNOWLEDGE_CITED_REFS && isKnowledgeLaneRef(ref) && knowledgeRefAppearsIn(ref, text)) knowledgeRefs.add(ref);
      if (typeof ref === 'string' && SOURCE_NODE_LANE_REF_PATTERN.test(ref) && text.includes(ref) && sourceRefs.size < MAX_LANED_REFS) sourceRefs.add(ref);
    }
  }

  return {
    reports: Array.from(reports.entries())
      .map(([requestId, refs]) => ({ requestId, refs: Array.from(refs) })),
    knowledgeRefs: Array.from(knowledgeRefs),
    ...(sourceRefs.size ? { sourceRefs: Array.from(sourceRefs) } : {}),
  };
}

function isKnowledgeLaneRef(ref: unknown): ref is string {
  return typeof ref === 'string' && (ref.startsWith('kb:') || ref.startsWith('file:') || isDailyKnowledgeLaneRef(ref));
}

/**
 * Knowledge refs surface in two spellings: the literal `kb:`/`file:` ref, or
 * the bare identifier embedded in a filesystem path — reading
 * `knowledge/documents/KB-<uuid>.md` via read_file is a citation of
 * `kb:KB-<uuid>` even though the ref prefix never appears. Matching the bare
 * KB-ID is safe because the UUID is unforgeable context; `file:` refs match
 * on the documents-relative path or its basename.
 */
function knowledgeRefAppearsIn(ref: string, corpus: string): boolean {
  if (corpus.includes(ref)) return true;
  if (ref.startsWith('kb:')) {
    return corpus.includes(ref.slice(3));
  }
  if (ref.startsWith('file:documents/')) {
    const rel = ref.slice('file:'.length);
    return corpus.includes(rel) || corpus.includes(rel.split('/').pop()!);
  }
  return false;
}

const MAX_CITATION_CORPUS_CHARS = 256 * 1024;

/**
 * The citation corpus for a turn: every assistant-authored surface, not just
 * the final reply. Assistant text blocks and tool_call arguments both carry
 * model intent — reading an injected KB document by path or quoting a pool
 * ref inside a tool call is a citation even when the final answer narrates
 * the source without printing the ref literally. Tool results and injected
 * user-role observations are excluded: refs appearing there are the
 * injection's own evidence, not the model's use of it.
 */
export function collectAssistantCitationText(
  newMessages: readonly Message[] | undefined,
  replyText: string | undefined,
): string {
  const parts: string[] = [];
  let size = 0;
  const push = (chunk: string | undefined) => {
    if (!chunk || size >= MAX_CITATION_CORPUS_CHARS) return;
    parts.push(chunk);
    size += chunk.length;
  };
  if (Array.isArray(newMessages)) {
    for (const message of newMessages) {
      if (!message || message.role !== 'assistant') continue;
      if (typeof message.content === 'string') {
        push(message.content);
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
            push((block as { text: string }).text);
          }
        }
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          push(call?.function?.arguments);
        }
      }
    }
  }
  push(replyText);
  return parts.join('\n');
}

function hasControlChar(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

// ------------------------------------------------------------------------
// Lane-level citation usage (local telemetry only)
//
// The server's downstream_citations column accepts ref_-prefixed pool refs
// exclusively, so session (`stream#n`) and knowledge (`kb:`/`file:`) refs can
// never be reported remotely. To still measure per-lane usefulness, injections
// tag each injected ref with the lane that produced it at injection time, and
// the parent turn emits a sanitized local `branch_citation_usage` runtime
// event: injected vs cited counts per lane. Nothing here widens the server
// schema and no ref string ever leaves the device through this path.
// ------------------------------------------------------------------------

/** Re-exported lane/tag vocabulary from the observation schema. */
export type BranchCitationLane = SyntheticObservationRefLane;
export type BranchRefLaneTag = SyntheticObservationRefLaneTag;

/** Per-lane counters carried by the `branch_citation_usage` event. */
export interface BranchLaneCounts {
  remote_pool: number;
  session: number;
  knowledge: number;
  /** Exact typed source-node corpus refs (not independent distilled facts). */
  source: number;
}

export interface BranchCitationUsage {
  /** Distinct sanitized /branch request_ids of the consumed injections. */
  requestIds: string[];
  /** Injected refs per lane (deduped across the turn's observations). */
  injectedByLane: BranchLaneCounts;
  /** Injected refs that appeared in this turn's assistant corpus, per lane. */
  citedByLane: BranchLaneCounts;
  /** True when any consumed observation was carryover from a previous turn. */
  carryover: boolean;
}

const MAX_LANED_REFS = 128;
const MAX_USAGE_REQUEST_IDS = 16;
const MAX_REF_LENGTH = 512;

const SOURCE_NODE_LANE_REF_PATTERN = /^catslog:source:[a-f0-9]{64}$/;

/** `catslog:session:<24hex>` — the session-hash citation namespace. */
const SESSION_HASH_LANE_REF_PATTERN = /^catslog:session:[a-f0-9]{24}$/;
/** `<stream>#<n|summary>` — session-lane stream citations (turn or summary). */
const SESSION_STREAM_LANE_REF_PATTERN = /^(.+)#(?:[1-9][0-9]*|summary)$/;

/** Session-shaped ref: stream turn/summary citation or the session-hash namespace. */
export function isSessionLaneRef(ref: unknown): ref is string {
  if (typeof ref !== 'string' || !ref || ref.length > MAX_REF_LENGTH) return false;
  if (SESSION_HASH_LANE_REF_PATTERN.test(ref)) return true;
  const match = ref.match(SESSION_STREAM_LANE_REF_PATTERN);
  return Boolean(match && match[1].length > 0 && match[1].length <= MAX_REF_LENGTH);
}

export function isDailyKnowledgeLaneRef(ref: string): boolean {
  return ref.length <= 512 && /^catslog:knowledge:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(ref);
}

function isKnowledgeLaneShape(ref: string): boolean {
  return ref.startsWith('kb:') || ref.startsWith('file:') || isDailyKnowledgeLaneRef(ref);
}

/**
 * Lane that produced `ref`, per the measurement taxonomy: remote pool refs
 * are `ref_`-prefixed AND members of the request's remote pool (an unpoolled
 * `ref_` string is not a pool ref); session refs are `stream#n`/`#summary` or
 * session-hash shaped; knowledge refs are `kb:`/`file:` or daily corpus refs;
 * exact `catslog:source:<64hex>` refs are typed source-node evidence. Everything
 * else (skill citations, arbitrary hashed refs, garbage) is `other`.
 */
export function deriveBranchRefLane(
  ref: unknown,
  remotePoolRefs?: ReadonlySet<string>,
): BranchCitationLane {
  if (typeof ref !== 'string' || !ref || ref.length > MAX_REF_LENGTH) return 'other';
  if (SOURCE_NODE_LANE_REF_PATTERN.test(ref)) return 'source';
  if (isKnowledgeLaneShape(ref)) return 'knowledge';
  if (isSessionLaneRef(ref)) return 'session';
  if (isCatsLogPoolCitationRef(ref) && (!remotePoolRefs || remotePoolRefs.has(ref))) return 'remote_pool';
  return 'other';
}

/**
 * Injection-time lane tags for the refs a memory branch is about to inject.
 * Purely mechanical: shape rules plus membership in the producing request's
 * remote pool (the presentation's own /branch response — the raw retrieval
 * pool is never counted, only used to recognize pool membership).
 */
export function collectBranchRefLanes(
  refs: readonly unknown[],
  remotePoolRefs: ReadonlySet<string>,
): BranchRefLaneTag[] {
  const tags: BranchRefLaneTag[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (tags.length >= MAX_LANED_REFS) break;
    if (typeof ref !== 'string' || !ref || ref.length > MAX_REF_LENGTH || seen.has(ref)) continue;
    seen.add(ref);
    tags.push({ ref, lane: deriveBranchRefLane(ref, remotePoolRefs) });
  }
  return tags;
}

/** Valid lane value of a tagged entry, or undefined. */
function parseLane(value: unknown): BranchCitationLane | undefined {
  return value === 'remote_pool' || value === 'session' || value === 'knowledge' || value === 'source' || value === 'other'
    ? value
    : undefined;
}

/**
 * Validated ref→lane map from `metadata.refLanes`, or undefined when the
 * field itself is malformed (wrong type/shape) so callers can fall back to
 * shape-derived lanes over `metadata.refs`. Malformed ENTRIES are skipped;
 * the remaining valid entries still count.
 */
function parseObservationRefLanes(
  observation: SyntheticObservation,
): Map<string, BranchCitationLane> | undefined {
  const refLanes = observation.metadata?.refLanes;
  if (refLanes === undefined) return undefined;
  if (!Array.isArray(refLanes)) return undefined;
  const lanes = new Map<string, BranchCitationLane>();
  for (const entry of refLanes.slice(0, MAX_LANED_REFS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const ref = (entry as { ref?: unknown }).ref;
    const lane = parseLane((entry as { lane?: unknown }).lane);
    if (typeof ref !== 'string' || !ref || ref.length > MAX_REF_LENGTH || lane === undefined) continue;
    if (!lanes.has(ref)) lanes.set(ref, lane);
  }
  return lanes;
}

/** Sanitized citation-pool set from valid citation metadata (reporter-side fallback). */
function citationPoolRefs(observation: SyntheticObservation): Set<string> {
  const citation = observation.metadata?.citation;
  const pool = new Set<string>();
  if (!citation || typeof citation !== 'object' || Array.isArray(citation)) return pool;
  const refs = (citation as { refs?: unknown }).refs;
  if (!Array.isArray(refs)) return pool;
  for (const ref of refs) {
    if (typeof ref === 'string' && ref && ref.length <= MAX_REF_LENGTH) pool.add(ref);
  }
  return pool;
}

/** Whether the ref's citation evidence appears in the assistant corpus, per lane. */
function laneRefAppearsInCorpus(ref: string, lane: BranchCitationLane, corpus: string): boolean {
  if (!corpus) return false;
  if (lane === 'knowledge') return knowledgeRefAppearsIn(ref, corpus);
  if (lane === 'session' || lane === 'remote_pool' || lane === 'source') return corpus.includes(ref);
  return false;
}

function emptyLaneCounts(): BranchLaneCounts {
  return { remote_pool: 0, session: 0, knowledge: 0, source: 0 };
}

/**
 * Lane-level citation usage for one turn's consumed injections. Counts cover
 * exactly the ACTUAL injected refs (the tagged/observed injection metadata),
 * deduped across observations — never the raw retrieval pool. Cited means the
 * ref's lane-appropriate citation evidence appeared in the turn's assistant
 * corpus (final reply, interim assistant text, or tool_call arguments).
 * Returns undefined when there were no observations, so callers can skip the
 * event entirely for turns without injections.
 */
export function collectBranchCitationUsage(
  observations: readonly SyntheticObservation[],
  corpusText: string | undefined,
): BranchCitationUsage | undefined {
  if (!Array.isArray(observations) || observations.length === 0) return undefined;
  const corpus = typeof corpusText === 'string' ? corpusText : '';

  const requestIds = new Set<string>();
  let carryover = false;
  const injected = new Map<string, BranchCitationLane>();

  for (const observation of observations) {
    if (!observation || typeof observation !== 'object') continue;
    const metadata = observation.metadata;

    const citation = metadata?.citation;
    if (citation && typeof citation === 'object' && !Array.isArray(citation)) {
      const requestId = typeof (citation as { requestId?: unknown }).requestId === 'string'
        ? (citation as { requestId: string }).requestId.trim()
        : '';
      if (requestId && requestId.length <= MAX_REQUEST_ID_CHARS && !hasControlChar(requestId)) {
        requestIds.add(requestId);
      }
    }

    if ((observation.timing ?? metadata?.timing) === 'late_previous_turn') carryover = true;

    const tagged = parseObservationRefLanes(observation);
    const fallbackRefs = tagged === undefined && Array.isArray(metadata?.refs)
      ? (metadata?.refs as unknown[])
      : [];
    const entries: Array<[string, BranchCitationLane]> = tagged
      ? Array.from(tagged.entries())
      : fallbackRefs
        .filter((ref): ref is string => typeof ref === 'string' && !!ref && ref.length <= MAX_REF_LENGTH)
        .map(ref => [ref, deriveBranchRefLane(ref, citationPoolRefs(observation))]);

    for (const [ref, lane] of entries) {
      if (injected.size >= MAX_LANED_REFS) break;
      if (!injected.has(ref)) injected.set(ref, lane);
    }
  }

  const injectedByLane = emptyLaneCounts();
  const citedByLane = emptyLaneCounts();
  for (const [ref, lane] of injected) {
    if (lane === 'remote_pool') {
      injectedByLane.remote_pool += 1;
      if (laneRefAppearsInCorpus(ref, lane, corpus)) citedByLane.remote_pool += 1;
    } else if (lane === 'session') {
      injectedByLane.session += 1;
      if (laneRefAppearsInCorpus(ref, lane, corpus)) citedByLane.session += 1;
    } else if (lane === 'knowledge') {
      injectedByLane.knowledge += 1;
      if (laneRefAppearsInCorpus(ref, lane, corpus)) citedByLane.knowledge += 1;
    } else if (lane === 'source') {
      injectedByLane.source += 1;
      if (laneRefAppearsInCorpus(ref, lane, corpus)) citedByLane.source += 1;
    }
  }

  return {
    requestIds: Array.from(requestIds).slice(0, MAX_USAGE_REQUEST_IDS),
    injectedByLane,
    citedByLane,
    carryover,
  };
}
