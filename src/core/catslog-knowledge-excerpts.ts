import { execFile } from 'child_process';
import { promisify } from 'util';
import type { LocalKnowledgeEntry } from './catslog-knowledge-lane';

const execFileAsync = promisify(execFile);

/**
 * Bounded, revision-bound body enrichment for the local knowledge lane.
 *
 * Contract (v1):
 * - At most {@link MAX_KNOWLEDGE_EXCERPT_ENTRIES} MANAGED candidate entries
 *   (`kb:…` documents) are enriched; raw `file:documents/…` source documents
 *   are never read here and never auto-promoted.
 * - Reads go through the knowledge.cjs `read-batch` seam only, which performs
 *   the existing `KnowledgeStore.read` (safe-path / symlink / hardlink
 *   fences, frontmatter parsing, paging) in one child process, one batch, no
 *   shell. There is no second KB root and no direct file-parser bypass.
 * - Revision binding: the search-time `(id, revision)` pair is bound to the
   * freshly read revision. A changed, missing, or id-mismatched document
 *   yields a typed gap (`stale_revision` / `missing` / `read_error`) and the
 *   body is discarded — latest content is never handed back as an older
 *   citation.
 * - Excerpts are contiguous verbatim windows selected deterministically
 *   (earliest query-term occurrence, line-aligned, ≤ {@link
 *   MAX_KNOWLEDGE_EXCERPT_CHARS} UTF-16 code units, surrogate-pair safe).
 *   No model call. Selection scans only the first read page, so this is an
 *   exact-selection guarantee about what is quoted — never a full-coverage
 *   claim about the document.
 * - Excerpt text is UNTRUSTED evidence: documents may contain text that
 *   looks like instructions. Callers keep it inside the lane's
 *   `local_distilled_knowledge` trust labeling and never execute it.
 */

export const MAX_KNOWLEDGE_EXCERPT_ENTRIES = 2;
export const MAX_KNOWLEDGE_EXCERPT_CHARS = 2_000;
/** Context kept before the anchor match before aligning to a line boundary. */
export const EXCERPT_LEAD_CONTEXT_CHARS = 480;
/** Below this remaining budget a batch child is not spawned at all. */
export const MIN_EXCERPT_TIMEOUT_MS = 50;
const MAX_EXCERPT_STDOUT_CHARS = 512 * 1024;
const MAX_GAP_MESSAGE_CHARS = 200;

const KNOWLEDGE_EXCERPT_ID_PATTERN = /^KB-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KNOWLEDGE_EXCERPT_REVISION_PATTERN = /^[a-f0-9]{64}$/;

export interface KnowledgeExcerptRequest {
  /** Citable ref (`kb:<KB-ID>`); mirrors the lane entry. */
  ref: string;
  /** Full KB-ID of a managed document. */
  id: string;
  /** Search-time revision the read must match verbatim. */
  revision: string;
}

export interface KnowledgeExcerptRetained {
  status: 'retained';
  ref: string;
  /** Revision verified equal to the search-time binding. */
  revision: string;
  /** Verbatim contiguous window; quotes and negative constraints are preserved as-is. */
  text: string;
  /** Inclusive start (UTF-16 code units) within the parsed document body. */
  charStart: number;
  /** Exclusive end (UTF-16 code units) within the parsed document body. */
  charEnd: number;
  /** Content before `charStart` exists but was omitted. */
  omittedBefore: boolean;
  /** Content from `charEnd` onward exists but was omitted (this page or later pages). */
  omittedAfter: boolean;
  /** Explicit truncation marker: any omission (before, after, or paging). */
  truncated: boolean;
  /** The document continues beyond the first read page (`nextOffset !== null`). */
  truncatedByPaging: boolean;
  /** Size of the first read page scanned for selection — selection scope, not full coverage. */
  pageChars: number;
  /** Read paging contract echo. */
  offset: number;
  nextOffset: number | null;
}

export type KnowledgeExcerptGapStatus = 'stale_revision' | 'missing' | 'read_error' | 'unavailable';

export interface KnowledgeExcerptGap {
  status: KnowledgeExcerptGapStatus;
  ref: string;
  /** The search-time revision that could not be confirmed. */
  revision: string;
  /** Bounded diagnostic; never contains document body content. */
  message?: string;
}

export interface KnowledgeExcerptBatchResult {
  /** Retained excerpts keyed by ref. */
  retained: Map<string, KnowledgeExcerptRetained>;
  /** Requested-but-not-retained excerpts, typed per request. */
  gaps: KnowledgeExcerptGap[];
}

export interface ReadKnowledgeExcerptsOptions {
  scriptPath: string;
  knowledgeRoot: string;
  requests: readonly KnowledgeExcerptRequest[];
  /** Remaining shared lane budget for the whole batch (not per read). */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Query keywords used to anchor selection (same strings the search used). */
  keywords?: readonly string[];
}

interface KnowledgeScriptBatchItem {
  index?: unknown;
  id?: unknown;
  status?: unknown;
  revision?: unknown;
  body?: unknown;
  offset?: unknown;
  nextOffset?: unknown;
  code?: unknown;
  message?: unknown;
}

/**
 * Pick the enrichment candidates: the top managed entries whose search-time
 * identity passes the strict id/revision binding bounds. Raw source documents
 * are skipped (v1 enriches managed documents only). Order follows the search
 * result (query priority), capped at {@link MAX_KNOWLEDGE_EXCERPT_ENTRIES}.
 */
export function planKnowledgeExcerptRequests(
  entries: readonly LocalKnowledgeEntry[],
  maxEntries: number = MAX_KNOWLEDGE_EXCERPT_ENTRIES,
): KnowledgeExcerptRequest[] {
  const requests: KnowledgeExcerptRequest[] = [];
  for (const entry of entries) {
    if (requests.length >= Math.max(0, maxEntries)) break;
    if (!entry.managed) continue;
    if (!KNOWLEDGE_EXCERPT_ID_PATTERN.test(entry.id)) continue;
    if (!KNOWLEDGE_EXCERPT_REVISION_PATTERN.test(entry.revision)) continue;
    requests.push({ ref: entry.ref, id: entry.id, revision: entry.revision });
  }
  return requests;
}

/**
 * Split the queried keywords into individual lowercase-insensitive match
 * terms for deterministic selection anchoring (priority = keyword order,
 * then term order).
 */
export function excerptSelectionTerms(keywords: readonly string[]): string[] {
  const terms: string[] = [];
  for (const keyword of keywords) {
    if (typeof keyword !== 'string') continue;
    for (const term of keyword.split(/\s+/)) {
      if (term && !terms.includes(term)) terms.push(term);
    }
  }
  return terms;
}

export interface KnowledgeExcerptSelection {
  text: string;
  charStart: number;
  charEnd: number;
  omittedBefore: boolean;
  omittedAfter: boolean;
  truncated: boolean;
  truncatedByPaging: boolean;
  pageChars: number;
}

/**
 * Deterministic contiguous verbatim window over one read page. Prefers the
 * earliest query-term occurrence with bounded leading context aligned to a
 * line boundary; falls back to the head of the page when no term occurs.
 * Positions are UTF-16 code-unit offsets into the parsed document body
 * (page offset included). Never splits surrogate pairs.
 */
export function selectKnowledgeExcerpt(
  pageBody: string,
  terms: readonly string[],
  options: { offset?: number; nextOffset?: number | null; maxChars?: number } = {},
): KnowledgeExcerptSelection {
  const body = typeof pageBody === 'string' ? pageBody : '';
  const pageOffset = Number.isSafeInteger(options.offset) && options.offset! >= 0 ? options.offset! : 0;
  const nextOffset = options.nextOffset === null || typeof options.nextOffset === 'number' ? options.nextOffset : null;
  const maxChars = options.maxChars ?? MAX_KNOWLEDGE_EXCERPT_CHARS;
  const truncatedByPaging = nextOffset !== null;

  const anchor = earliestTermOccurrence(body, terms);
  let start = 0;
  if (anchor) {
    // Keep the whole anchor inside the budget even if the preceding line is
    // longer than the lead context: start stays within
    // [anchor+length-maxChars, anchor].
    const minStart = Math.max(0, anchor.index + anchor.length - Math.max(1, maxChars));
    const rawStart = Math.max(minStart, anchor.index - EXCERPT_LEAD_CONTEXT_CHARS);
    const newline = body.lastIndexOf('\n', rawStart);
    start = newline === -1 ? 0 : newline + 1;
    if (start > anchor.index) start = anchor.index;
    if (start < minStart) start = minStart;
  }
  let end = Math.min(body.length, start + Math.max(1, maxChars));
  if (anchor) end = Math.max(end, Math.min(body.length, anchor.index + anchor.length));
  // Never split a surrogate pair at the window edges.
  if (end < body.length && isHighSurrogate(body.charCodeAt(end - 1)) && isLowSurrogate(body.charCodeAt(end))) {
    end -= 1;
  }
  if (start > 0 && start < end && isLowSurrogate(body.charCodeAt(start)) && isHighSurrogate(body.charCodeAt(start - 1))) {
    start -= 1;
  }

  const omittedBefore = pageOffset + start > 0;
  const omittedAfter = pageOffset + end < pageOffset + body.length || truncatedByPaging;
  return {
    text: body.slice(start, end),
    charStart: pageOffset + start,
    charEnd: pageOffset + end,
    omittedBefore,
    omittedAfter,
    truncated: omittedBefore || omittedAfter,
    truncatedByPaging,
    pageChars: body.length,
  };
}

interface TermOccurrence { index: number; length: number }

/** Earliest occurrence across the priority-ordered terms; ties keep term order. */
function earliestTermOccurrence(body: string, terms: readonly string[]): TermOccurrence | null {
  if (!body || !terms.length) return null;
  let best: TermOccurrence | null = null;
  for (const term of terms) {
    if (!term) continue;
    const match = body.match(new RegExp(escapeRegExp(term), 'i'));
    if (!match || match.index === undefined) continue;
    if (!best || match.index < best.index) best = { index: match.index, length: match[0].length || term.length };
  }
  return best;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Run one `read-batch` child for all requests and bind each result to the
 * request's revision. Any process-level failure (timeout, abort, non-JSON,
 * unusable envelope) marks every request `unavailable`; per-document
 * problems are typed individually. Never throws.
 */
export async function readKnowledgeExcerpts(options: ReadKnowledgeExcerptsOptions): Promise<KnowledgeExcerptBatchResult> {
  const retained = new Map<string, KnowledgeExcerptRetained>();
  const gaps: KnowledgeExcerptGap[] = [];
  const requests = options.requests;
  if (!requests.length) return { retained, gaps };

  if (options.signal?.aborted || options.timeoutMs < MIN_EXCERPT_TIMEOUT_MS) {
    for (const request of requests) {
      gaps.push({
        status: 'unavailable',
        ref: request.ref,
        revision: request.revision,
        message: options.signal?.aborted ? 'knowledge excerpt read aborted' : 'knowledge excerpt deadline exhausted',
      });
    }
    return { retained, gaps };
  }

  let items: KnowledgeScriptBatchItem[];
  try {
    items = await runKnowledgeReadBatch(options);
  } catch (error: any) {
    const message = boundedGapMessage(knowledgeProcessErrorMessage(error, options.signal));
    for (const request of requests) {
      gaps.push({ status: 'unavailable', ref: request.ref, revision: request.revision, message });
    }
    return { retained, gaps };
  }

  const byIndex = new Map<number, KnowledgeScriptBatchItem>();
  if (Array.isArray(items)) {
    for (const item of items.slice(0, requests.length * 2)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const index = typeof item.index === 'number' && Number.isSafeInteger(item.index) ? item.index : -1;
      if (index >= 0 && index < requests.length) byIndex.set(index, item);
    }
  }
  const terms = excerptSelectionTerms(options.keywords ?? []);
  requests.forEach((request, position) => {
    const outcome = bindExcerpt(request, byIndex.get(position), terms);
    if (outcome.status === 'retained') retained.set(request.ref, outcome);
    else gaps.push(outcome);
  });
  return { retained, gaps };
}

async function runKnowledgeReadBatch(options: ReadKnowledgeExcerptsOptions): Promise<KnowledgeScriptBatchItem[]> {
  // One structured JSON argv entry — no shell, one process for the whole batch.
  const payload = JSON.stringify(options.requests.map(request => ({
    id: request.id,
    expectedRevision: request.revision,
    offset: 0,
  })));
  const { stdout } = await execFileAsync(
    knowledgeNodeExecutable(),
    [options.scriptPath, '--root', options.knowledgeRoot, 'read-batch', payload],
    {
      timeout: options.timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_EXCERPT_STDOUT_CHARS,
      signal: options.signal,
      windowsHide: true,
    },
  ).catch((error: any) => { throw new Error(knowledgeProcessErrorMessage(error, options.signal)); });

  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error('knowledge excerpt batch returned non-JSON output'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || (parsed as { ok?: unknown }).ok !== true
    || !Array.isArray((parsed as { results?: unknown }).results)) {
    throw new Error('knowledge excerpt batch returned an unusable envelope');
  }
  return (parsed as { results: KnowledgeScriptBatchItem[] }).results;
}

/** Revision binding: the body survives only a full (id, revision, body) match. */
function bindExcerpt(
  request: KnowledgeExcerptRequest,
  item: KnowledgeScriptBatchItem | undefined,
  terms: readonly string[],
): KnowledgeExcerptRetained | KnowledgeExcerptGap {
  const gap = (status: KnowledgeExcerptGapStatus, message: string): KnowledgeExcerptGap => (
    { status, ref: request.ref, revision: request.revision, message: boundedGapMessage(message) }
  );
  if (!item) return gap('unavailable', 'knowledge excerpt batch result missing');
  if (item.id !== request.id) return gap('read_error', 'knowledge excerpt batch returned a different document id');
  if (item.status === 'revision_mismatch') {
    return gap('stale_revision', `document changed since search (current revision ${typeof item.revision === 'string' ? item.revision.slice(0, 12) : 'unknown'}…); body discarded`);
  }
  if (item.status === 'not_found') return gap('missing', 'document disappeared after search');
  if (item.status !== 'ok') {
    const code = typeof item.code === 'string' && item.code ? item.code : 'READ_ERROR';
    const message = typeof item.message === 'string' ? item.message : 'document read failed';
    return gap('read_error', `${code}: ${message}`);
  }
  // Defense in depth: even a status:'ok' item is discarded unless the read
  // revision equals the search-time binding verbatim.
  if (item.revision !== request.revision) {
    return gap('stale_revision', 'document revision does not match the search binding; body discarded');
  }
  if (typeof item.body !== 'string') return gap('read_error', 'knowledge excerpt batch returned no body');
  const selection = selectKnowledgeExcerpt(item.body, terms, {
    offset: typeof item.offset === 'number' ? item.offset : 0,
    nextOffset: item.nextOffset === null || typeof item.nextOffset === 'number' ? item.nextOffset : null,
  });
  return {
    status: 'retained',
    ref: request.ref,
    revision: request.revision,
    text: selection.text,
    charStart: selection.charStart,
    charEnd: selection.charEnd,
    omittedBefore: selection.omittedBefore,
    omittedAfter: selection.omittedAfter,
    truncated: selection.truncated,
    truncatedByPaging: selection.truncatedByPaging,
    pageChars: selection.pageChars,
    offset: typeof item.offset === 'number' ? item.offset : 0,
    nextOffset: item.nextOffset === null || typeof item.nextOffset === 'number' ? item.nextOffset : null,
  };
}

/** Prefer the script's own JSON error envelope over execFile command noise. */
export function knowledgeProcessErrorMessage(error: any, signal?: AbortSignal): string {
  if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return 'knowledge script aborted';
  }
  if (error?.killed === true || (typeof error?.signal === 'string' && error.signal)) {
    return 'knowledge script timed out';
  }
  for (const stream of [error?.stderr, error?.stdout]) {
    const text = typeof stream === 'string' ? stream.trim() : '';
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as { ok?: unknown; code?: unknown; message?: unknown };
      if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') {
        const code = typeof parsed.code === 'string' && parsed.code ? parsed.code : 'KNOWLEDGE_ERROR';
        return `${code}: ${parsed.message}`;
      }
    } catch {
      return boundedGapMessage(text);
    }
  }
  return boundedGapMessage(String(error?.message || error || 'knowledge script failed'));
}

function boundedGapMessage(message: string): string {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_GAP_MESSAGE_CHARS) return text;
  return `${text.slice(0, MAX_GAP_MESSAGE_CHARS - 16)}…[truncated]`;
}

function knowledgeNodeExecutable(): string {
  return process.env.XIAOBA_NODE_EXECUTABLE?.trim() || process.execPath;
}
