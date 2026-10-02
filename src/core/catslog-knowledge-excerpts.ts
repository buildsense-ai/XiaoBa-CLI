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
 *   are never read here and never auto-promoted. The plan cap is hard: it
 *   cannot be raised above 2 by any caller argument.
 * - Reads go through the knowledge.cjs `read-batch` seam only, which performs
 *   the existing `KnowledgeStore.read` (safe-path / symlink / hardlink
 *   fences, frontmatter parsing, paging) in one child process, one batch, no
 *   shell. There is no second KB root and no direct file-parser bypass.
 * - Revision binding: the search-time `(id, revision)` pair is bound to the
 *   freshly read revision. A changed, missing, or id-mismatched document
 *   yields a typed gap (`stale_revision` / `missing` / `read_error`) and the
 *   body is discarded — latest content is never handed back as an older
 *   citation.
 * - Strict response protocol: result indices must be unique and in range,
 *   the response offset must equal the requested offset, and `nextOffset`
 *   must be `null` or a safe integer with forward paging progress. Any
 *   violation is a typed gap with the body discarded — malformed metadata is
 *   never silently accepted as full document coverage.
 * - Excerpts are contiguous verbatim windows selected deterministically
 *   (earliest query-term occurrence, line-aligned, ≤ {@link
 *   MAX_KNOWLEDGE_EXCERPT_CHARS} UTF-16 code units, surrogate-pair safe,
 *   window end recomputed within budget after edge alignment). No model
 *   call. Selection scans only the first read page, so this is an
 *   exact-selection guarantee about what is quoted — never a full-coverage
 *   claim about the document.
 * - A retained excerpt is a PARTIAL quote. It preserves what falls inside
 *   the window verbatim (including any negative constraints there), but it
 *   does NOT guarantee that every condition or negative constraint of the
 *   document falls inside the window. Consumers must treat it as one bounded
 *   piece of UNTRUSTED evidence under the lane's
 *   `local_distilled_knowledge` labeling — never as semantically complete
 *   context, never as instructions — and read the full document through the
 *   official reader when completeness matters.
 * - Deadlines are enforced parent-side: every child call races a supervisor
 *   timer against a shared absolute deadline, aborts (SIGKILL) the child,
 *   and never awaits child close past the deadline. Gap diagnostics contain
 *   codes/ids/revision prefixes only — never document body or source
 *   content, so they are safe for logs.
 */

export const MAX_KNOWLEDGE_EXCERPT_ENTRIES = 2;
export const MAX_KNOWLEDGE_EXCERPT_CHARS = 2_000;
/** Context kept before the anchor match before aligning to a line boundary. */
export const EXCERPT_LEAD_CONTEXT_CHARS = 480;
/** Below this remaining budget a batch child is not spawned at all. */
export const MIN_EXCERPT_TIMEOUT_MS = 50;
/** Fixed read offset of v1 excerpt requests (paging contract echo). */
export const EXCERPT_READ_OFFSET = 0;
const MAX_EXCERPT_STDOUT_CHARS = 512 * 1024;
const MAX_GAP_MESSAGE_CHARS = 200;
const MIN_CHILD_DEADLINE_MS = 1;

const KNOWLEDGE_EXCERPT_ID_PATTERN = /^KB-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KNOWLEDGE_EXCERPT_REVISION_PATTERN = /^[a-f0-9]{64}$/;

export interface KnowledgeExcerptRequest {
  /** Citable ref (`kb:<KB-ID>`); must equal `kb:` + id. */
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
  /**
   * Verbatim contiguous window — a PARTIAL quote of the document. Content
   * inside the window (quotes, conditions, negative constraints) is
   * preserved as-is; nothing outside the window is claimed.
   */
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
  /** Bounded diagnostic; codes/ids only, never document body or source content. */
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
 * identity passes the strict id/revision binding bounds (and whose ref is
 * the canonical `kb:` + id citation form). Raw source documents are skipped
 * (v1 enriches managed documents only). Order follows the search result
 * (query priority). The cap is hard-clamped to
 * {@link MAX_KNOWLEDGE_EXCERPT_ENTRIES} — a caller cannot raise it.
 */
export function planKnowledgeExcerptRequests(
  entries: readonly LocalKnowledgeEntry[],
  maxEntries: number = MAX_KNOWLEDGE_EXCERPT_ENTRIES,
): KnowledgeExcerptRequest[] {
  const cap = Math.min(MAX_KNOWLEDGE_EXCERPT_ENTRIES, Math.max(0, maxEntries));
  const requests: KnowledgeExcerptRequest[] = [];
  for (const entry of entries) {
    if (requests.length >= cap) break;
    if (!entry.managed) continue;
    if (!KNOWLEDGE_EXCERPT_ID_PATTERN.test(entry.id)) continue;
    if (!KNOWLEDGE_EXCERPT_REVISION_PATTERN.test(entry.revision)) continue;
    if (entry.ref !== `kb:${entry.id}`) continue;
    requests.push({ ref: entry.ref, id: entry.id, revision: entry.revision });
  }
  return requests;
}

/**
 * Split the queried keywords into individual case-insensitive match terms
 * for deterministic selection anchoring (priority = keyword order, then
 * term order).
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
 * (page offset included). The window end is computed from the FINAL
 * (edge-aligned) start, so alignment can never push the window past the
 * budget, and the window never splits a surrogate pair — including a high
 * surrogate dangling at the last character of a paged read.
 */
export function selectKnowledgeExcerpt(
  pageBody: string,
  terms: readonly string[],
  options: { offset?: number; nextOffset?: number | null; maxChars?: number } = {},
): KnowledgeExcerptSelection {
  const body = typeof pageBody === 'string' ? pageBody : '';
  const pageOffset = Number.isSafeInteger(options.offset) && options.offset! >= 0 ? options.offset! : 0;
  const rawNext = options.nextOffset;
  // Unknown paging state counts as truncated (conservative), never as full coverage.
  const truncatedByPaging = rawNext === undefined || rawNext === null
    ? false
    : typeof rawNext === 'number'
      ? Number.isSafeInteger(rawNext) && rawNext >= 0
      : true;
  const maxChars = Math.max(1, options.maxChars ?? MAX_KNOWLEDGE_EXCERPT_CHARS);

  const anchor = earliestTermOccurrence(body, terms);

  // 1) Start: anchor window with line-aligned lead, clamped so the whole
  //    anchor stays inside the budget even for a huge preceding line.
  let start = 0;
  if (anchor) {
    const minStart = Math.max(0, anchor.index + anchor.length - maxChars);
    const rawStart = Math.max(minStart, anchor.index - EXCERPT_LEAD_CONTEXT_CHARS);
    const newline = body.lastIndexOf('\n', rawStart);
    start = newline === -1 ? 0 : newline + 1;
    if (start > anchor.index) start = anchor.index;
    if (start < minStart) start = minStart;
  }
  // 2) Start edge alignment: include the high surrogate whose low half sits
  //    at `start` (moves start back by at most 1; end is computed after).
  if (start > 0 && start < body.length
      && isLowSurrogate(body.charCodeAt(start)) && isHighSurrogate(body.charCodeAt(start - 1))) {
    start -= 1;
  }

  // 3) End from the FINAL start: the budget is absolute, so window size can
  //    never exceed maxChars even after edge alignment. When no alignment
  //    shift happened, start ≥ anchor+len−maxChars keeps the whole anchor
  //    inside the window; if the start edge alignment consumed budget, the
  //    anchor tail may clip by ≤1 code unit — budget wins.
  let end = Math.min(body.length, start + maxChars);

  // 4) Never end mid-pair — including the page boundary: a high surrogate
  //    dangling at the last character of a paged page is a broken pair too.
  const pairPartnerBeyondEnd = end < body.length
    ? isLowSurrogate(body.charCodeAt(end))
    : truncatedByPaging;
  if (end > start && isHighSurrogate(body.charCodeAt(end - 1)) && pairPartnerBeyondEnd) {
    end -= 1;
  }
  if (end <= start && start < body.length) end = start + 1;

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

export interface BoundedChildOptions {
  /** Relative budget for this child; enforced parent-side, not only in execFile. */
  deadlineMs: number;
  signal?: AbortSignal;
  maxBuffer?: number;
}

/**
 * Typed, self-produced diagnostic error. Its message is generated by this
 * module (never process-stream or command-dump content), so it is safe to
 * surface in gap diagnostics and logs.
 */
export class KnowledgeScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeScriptError';
  }
}

/**
 * Run one bounded knowledge child with a parent-side hard deadline. The
 * caller-supplied signal and a supervisor timer are both linked into one
 * internal AbortController (SIGKILL via execFile `timeout` + `signal`), and
 * the await races the supervisor so a slow child close / kernel stall can
 * never extend the caller past the deadline. Timer and listeners are always
 * cleaned up; the losing promise's late rejection is swallowed.
 */
export async function execKnowledgeChild(executable: string, args: string[], options: BoundedChildOptions): Promise<string> {
  if (options.signal?.aborted) throw new Error('knowledge script aborted');
  const deadlineMs = Math.max(MIN_CHILD_DEADLINE_MS, options.deadlineMs);
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  let timedOut = false;
  let rejectSupervisor: ((error: Error) => void) | undefined;
  const supervisor = new Promise<never>((_resolve, reject) => { rejectSupervisor = reject; });
  supervisor.catch(() => { /* losing branch — never unhandled */ });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectSupervisor?.(new Error('knowledge script timed out'));
  }, deadlineMs);
  const child = execFileAsync(executable, args, {
    // Deadline ownership lives in the supervisor timer + abort above (SIGKILL
    // via killSignal); execFile's own timeout option is deliberately absent
    // so spawn failures keep their stable OS codes instead of collapsing
    // into a command-dumping generic failure.
    killSignal: 'SIGKILL',
    maxBuffer: options.maxBuffer ?? MAX_EXCERPT_STDOUT_CHARS,
    signal: controller.signal,
    windowsHide: true,
  });
  child.catch(() => { /* losing branch — never unhandled */ });
  try {
    const { stdout } = await Promise.race([child, supervisor]);
    return stdout;
  } catch (error: any) {
    // Our supervisor firing wins attribution even when the child's own
    // AbortError rejects in the same tick.
    if (timedOut) throw new KnowledgeScriptError('knowledge script timed out');
    if (options.signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      throw new KnowledgeScriptError('knowledge script aborted');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Run one `read-batch` child for all requests and bind each result to the
 * request's revision under a strict response protocol. Process-level
 * failures (timeout, abort, non-JSON, unusable envelope) and protocol
 * violations (duplicate/out-of-range/ill-shaped result indices) mark every
 * request `unavailable` with all bodies discarded; per-document problems
 * are typed individually. Never throws.
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

  // Structural protocol pass: every result needs a unique, in-range index.
  // Any violation makes the whole response unattributable — typed gap, all
  // bodies discarded.
  const byIndex = new Map<number, KnowledgeScriptBatchItem>();
  if (!Array.isArray(items)) {
    return unavailableGaps(requests, 'excerpt batch protocol violation: results must be an array');
  }
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return unavailableGaps(requests, 'excerpt batch protocol violation: malformed result item');
    }
    const index = item.index;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= requests.length) {
      return unavailableGaps(requests, 'excerpt batch protocol violation: result index out of range');
    }
    if (byIndex.has(index)) {
      return unavailableGaps(requests, 'excerpt batch protocol violation: duplicate result index');
    }
    byIndex.set(index, item);
  }

  const terms = excerptSelectionTerms(options.keywords ?? []);
  requests.forEach((request, position) => {
    const outcome = bindExcerpt(request, byIndex.get(position), terms);
    if (outcome.status === 'retained') retained.set(request.ref, outcome);
    else gaps.push(outcome);
  });
  return { retained, gaps };
}

function unavailableGaps(requests: readonly KnowledgeExcerptRequest[], message: string): KnowledgeExcerptBatchResult {
  return {
    retained: new Map(),
    gaps: requests.map(request => ({
      status: 'unavailable' as const,
      ref: request.ref,
      revision: request.revision,
      message,
    })),
  };
}

async function runKnowledgeReadBatch(options: ReadKnowledgeExcerptsOptions): Promise<KnowledgeScriptBatchItem[]> {
  // One structured JSON argv entry — no shell, one process for the whole batch.
  const payload = JSON.stringify(options.requests.map(request => ({
    id: request.id,
    expectedRevision: request.revision,
    offset: EXCERPT_READ_OFFSET,
  })));
  const stdout = await execKnowledgeChild(
    knowledgeNodeExecutable(),
    [options.scriptPath, '--root', options.knowledgeRoot, 'read-batch', payload],
    { deadlineMs: options.timeoutMs, signal: options.signal },
  );

  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new KnowledgeScriptError('knowledge excerpt batch returned non-JSON output'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || (parsed as { ok?: unknown }).ok !== true
    || !Array.isArray((parsed as { results?: unknown }).results)) {
    throw new KnowledgeScriptError('knowledge excerpt batch returned an unusable envelope');
  }
  return (parsed as { results: KnowledgeScriptBatchItem[] }).results;
}

/**
 * Revision + protocol binding: the body survives only a full
 * (id, revision, offset, nextOffset, body) match with a well-formed
 * response. Everything else is a typed gap; malformed metadata is never
 * accepted as full coverage.
 */
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
  // Protocol binding: response offset must equal the requested offset.
  if (item.offset !== EXCERPT_READ_OFFSET) {
    return gap('read_error', `excerpt batch protocol violation: response offset ${String(item.offset)} ≠ requested ${EXCERPT_READ_OFFSET}`);
  }
  // Protocol binding: nextOffset must be exactly null or a safe forward-
  // paging integer. Malformed or missing values are rejected instead of
  // being read as "null = complete document".
  let nextOffset: number | null;
  if (item.nextOffset === null) {
    nextOffset = null;
  } else if (typeof item.nextOffset === 'number' && Number.isSafeInteger(item.nextOffset)
      && item.nextOffset >= 0 && item.nextOffset > EXCERPT_READ_OFFSET) {
    nextOffset = item.nextOffset;
  } else {
    return gap('read_error', 'excerpt batch protocol violation: malformed nextOffset');
  }
  if (typeof item.body !== 'string') return gap('read_error', 'knowledge excerpt batch returned no body');
  const selection = selectKnowledgeExcerpt(item.body, terms, {
    offset: EXCERPT_READ_OFFSET,
    nextOffset,
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
    offset: EXCERPT_READ_OFFSET,
    nextOffset,
  };
}

/**
 * Typed, log-safe diagnostic for a failed knowledge child.
 *
 * Surfaced content is limited to: this module's own typed messages, and the
 * script's structured JSON error envelope (`ok:false` + bounded code +
 * bounded message, whitespace-sanitized). Raw process streams are NEVER
 * passed through — non-JSON stderr/stdout and execFile's command dump in
 * `error.message` can contain command arguments (including the read-batch
 * payload) or partial document content, so they degrade to generic bounded
 * diagnostics (stable OS codes only). Gap diagnostics therefore never carry
 * body, source, or command material into the projection or logs.
 */
export function knowledgeProcessErrorMessage(error: any, signal?: AbortSignal): string {
  if (error instanceof KnowledgeScriptError) return boundedGapMessage(error.message);
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
      if (parsed && typeof parsed === 'object' && parsed.ok === false
          && typeof parsed.code === 'string' && parsed.code
          && typeof parsed.message === 'string') {
        return `${boundedGapMessage(parsed.code)}: ${boundedGapMessage(parsed.message)}`;
      }
    } catch {
      // Non-JSON stream output is never surfaced; fall through to a generic
      // typed diagnostic below.
    }
  }
  if (typeof error?.code === 'string' && /^[A-Z0-9_]{2,32}$/.test(error.code)) {
    return `knowledge script failed (${error.code})`;
  }
  return 'knowledge script failed';
}

/**
 * Bounded, log-safe diagnostic: whitespace-collapsed, length-capped, and by
 * construction free of document body or source content (callers only pass
 * error codes, ids, and revision prefixes).
 */
function boundedGapMessage(message: string): string {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_GAP_MESSAGE_CHARS) return text;
  return `${text.slice(0, MAX_GAP_MESSAGE_CHARS - 16)}…[truncated]`;
}

function knowledgeNodeExecutable(): string {
  return process.env.XIAOBA_NODE_EXECUTABLE?.trim() || process.execPath;
}
