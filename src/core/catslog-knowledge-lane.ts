import * as fs from 'fs';
import * as path from 'path';
import { PathResolver } from '../utils/path-resolver';
import { KNOWLEDGE_SCRIPT_FILE } from '../skills/builtin-knowledge-skill';
import { hasCatsLogControlCodePoint } from '../utils/catsco-log-agent-client';
import { isKnowledgeCitationRef } from '../tools/memory-branch-tools';
import {
  MAX_KNOWLEDGE_EXCERPT_CHARS,
  MAX_KNOWLEDGE_EXCERPT_ENTRIES,
  type KnowledgeExcerptGap,
  type KnowledgeExcerptRetained,
  KnowledgeScriptError,
  execKnowledgeChild,
  knowledgeProcessErrorMessage,
  planKnowledgeExcerptRequests,
  readKnowledgeExcerpts,
} from './catslog-knowledge-excerpts';

export type { KnowledgeExcerptGap, KnowledgeExcerptRetained };
export { MAX_KNOWLEDGE_EXCERPT_CHARS, MAX_KNOWLEDGE_EXCERPT_ENTRIES };

export type LocalKnowledgeLaneStatus = 'ok' | 'empty' | 'truncated' | 'unavailable';

/**
 * One distilled-knowledge hit in the `local_knowledge` lane of the evidence
 * pack. `ref` is the citable form (`kb:<KB-ID>` for managed documents,
 * `file:documents/...` for raw source Markdown); `id` mirrors the KB store's
 * own document identifier.
 */
export interface LocalKnowledgeEntry {
  ref: string;
  id: string;
  title: string;
  summary: string;
  category: string;
  updated_at: string;
  revision: string;
  managed: boolean;
  /**
   * Optional bounded body enrichment: a revision-bound PARTIAL quote of a
   * managed document (top ≤2 entries only). Verbatim inside the selected
   * window — including any negative constraints there — but content outside
   * the window is omitted and never claimed. Absent for raw `file:`
   * entries, for entries whose body read failed, and when enrichment did
   * not run — metadata hits are preserved regardless. The text is UNTRUSTED
   * document content under this lane's `local_distilled_knowledge` trust
   * label, never instructions; read the full document via the official
   * reader when completeness matters.
   */
  excerpt?: KnowledgeExcerptRetained;
}

export interface LocalKnowledgeLaneResult {
  status: LocalKnowledgeLaneStatus;
  entries: LocalKnowledgeEntry[];
  /** Typed degraded reason; present only when status is `unavailable`. */
  error?: string;
  keywordsQueried: string[];
  /** True when assess keywords exceeded the 3-keyword local-KB cap. */
  keywordsCapped: boolean;
  /** Number of keyword searches that failed after the script was invoked. */
  keywordsFailed: number;
  /** True when collected entries were dropped by the 8-entry lane cap. */
  entriesCapped: boolean;
  /**
   * Bounded enrichment (separate from the metadata search): managed entries
   * submitted for a revision-bound excerpt read, top ≤2. Optional because
   * degraded results built outside the lane omit it.
   */
  excerptsRequested?: number;
  /** Revision-matched excerpts actually retained. */
  excerptsRetained?: number;
  /** Typed gaps for requested-but-not-retained excerpts. */
  excerptGaps?: KnowledgeExcerptGap[];
}

export interface LocalKnowledgeLaneOptions {
  /**
   * Contract-valid search keywords (deduped, ≤64 code points, wire-capped by
   * the caller, e.g. the `searchAny` list built for the session lane). The
   * lane takes the top 3 in assess order.
   */
  keywords: string[];
  /** Overrides PathResolver.getRuntimeDataRoot()/knowledge (tests). */
  knowledgeRoot?: string;
  /** Overrides the bundled knowledge.cjs resolution (tests). */
  scriptPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * The knowledge.cjs CLI emits `{ ok, total, items: [...], nextOffset }` with
 * `items` entries shaped `{ id, title, summary, category, updatedAt, revision,
 * managed, file }` (frontmatter fields for managed KB documents, synthesized
 * heading/preview fields for raw `documents/**.md` source files).
 */
interface KnowledgeScriptItem {
  id?: unknown;
  title?: unknown;
  summary?: unknown;
  category?: unknown;
  updatedAt?: unknown;
  revision?: unknown;
  managed?: unknown;
  file?: unknown;
}

interface KnowledgeSearchOutput {
  ok?: unknown;
  total?: unknown;
  items?: unknown;
  truncated?: unknown;
}

export const MAX_LOCAL_KNOWLEDGE_KEYWORDS = 3;
export const MAX_LOCAL_KNOWLEDGE_ENTRIES = 8;
/** Shared lane budget: search + excerpt enrichment together, never per read. */
export const KNOWLEDGE_SEARCH_TIMEOUT_MS = 3_000;
const MAX_KNOWLEDGE_RESULT_CHARS = 8_000;
const MAX_ENTRY_TEXT_CHARS = 600;
const MAX_SCRIPT_STDOUT_CHARS = 512 * 1024;
const KNOWLEDGE_KB_ID_PATTERN = /^KB-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/**
 * L0 lane of the mechanical retrieval stage: search the explicitly shared
 * per-instance KB that the xiaoba-knowledge Skill writes under the runtime
 * data root. This is not an agent-private session source. The lane is
 * local/read-only and its shared provenance is marked explicitly.
 *
 * After the metadata search, the top ≤2 managed entries may be enriched with
 * a bounded, revision-bound body excerpt (see catslog-knowledge-excerpts):
 * one extra batch process, inside the same 3s lane deadline, metadata hits
 * preserved on any failure. A keyword hit is a pointer, not complete or
 * authoritative history; parallel remote lanes and the full scope are
 * unchanged.
 *
 * Degradation is typed and never throws: a missing knowledge root, a failing
 * script, or non-JSON output yields status `unavailable` exactly like the
 * session-error pattern of the remote lanes.
 */
export async function searchLocalKnowledgeLane(
  options: LocalKnowledgeLaneOptions,
): Promise<LocalKnowledgeLaneResult> {
  const root = path.resolve(options.knowledgeRoot
    ?? path.join(PathResolver.getRuntimeDataRoot(), 'knowledge'));
  const scriptPath = path.resolve(options.scriptPath ?? KNOWLEDGE_SCRIPT_FILE);
  // Defensive re-check of the wire contract: control-character terms can never
  // be argv-safe, so they are dropped here regardless of the caller.
  const keywords = [...new Set((options.keywords ?? [])
    .filter(keyword => typeof keyword === 'string' && keyword.trim()
      && Array.from(keyword).length <= 64 && !hasCatsLogControlCodePoint(keyword))
    .map(keyword => keyword.trim()))];
  const keywordsCapped = keywords.length > MAX_LOCAL_KNOWLEDGE_KEYWORDS;
  const queried = keywords.slice(0, MAX_LOCAL_KNOWLEDGE_KEYWORDS);

  const base: LocalKnowledgeLaneResult = {
    status: 'empty',
    entries: [],
    keywordsQueried: queried,
    keywordsCapped,
    keywordsFailed: 0,
    entriesCapped: false,
  };
  if (queried.length === 0) {
    return { ...base, status: 'empty' };
  }
  if (!fileExists(root)) {
    return { ...base, status: 'unavailable', error: 'knowledge_root_missing' };
  }
  if (!fileExists(scriptPath)) {
    return { ...base, status: 'unavailable', error: 'knowledge_script_missing' };
  }

  const timeoutMs = options.timeoutMs ?? KNOWLEDGE_SEARCH_TIMEOUT_MS;
  const searchStartedAt = Date.now();
  let output: KnowledgeSearchOutput;
  try {
    // One process and one filesystem scan, still bounded by a single 3s
    // deadline. The script preserves per-keyword priority and OR semantics.
    output = await runKnowledgeSearch(scriptPath, root, queried, timeoutMs, options.signal);
  } catch (error: any) {
    return {
      ...base,
      status: 'unavailable',
      error: boundedText(String(error?.message || error || 'knowledge search failed'), 200),
      keywordsFailed: queried.length,
    };
  }
  const entries: LocalKnowledgeEntry[] = [];
  const seen = new Set<string>();
  let entriesCapped = output.truncated === true;
  for (const entry of projectScriptItems(output.items)) {
    if (seen.has(entry.ref)) continue;
    if (entries.length >= MAX_LOCAL_KNOWLEDGE_ENTRIES) {
      entriesCapped = true;
      break;
    }
    seen.add(entry.ref);
    entries.push(entry);
  }
  // Optional bounded enrichment inside the SAME lane deadline: top ≤2 managed
  // entries, one extra batch process, revision-bound. Failure here degrades
  // to typed gaps; metadata hits and the lane status are preserved.
  const enrichment = await enrichKnowledgeEntries({
    entries,
    scriptPath,
    root,
    keywords: queried,
    timeoutMs,
    signal: options.signal,
    searchStartedAt,
  });
  const enrichedEntries = entries.map(entry => {
    const excerpt = enrichment.byRef.get(entry.ref);
    return excerpt ? { ...entry, excerpt } : entry;
  });
  return {
    ...base,
    status: entriesCapped ? 'truncated' : entries.length === 0 ? 'empty' : 'ok',
    entries: enrichedEntries,
    entriesCapped,
    ...(enrichment.requested > 0 ? {
      excerptsRequested: enrichment.requested,
      excerptsRetained: enrichment.retained,
      excerptGaps: enrichment.gaps,
    } : {}),
  };
}

/**
 * Read bounded excerpts for the top managed candidates. The batch gets only
 * the time left inside the shared lane budget (search already ran), and the
 * helper itself enforces the floor. Never throws; gaps are typed per request.
 */
async function enrichKnowledgeEntries(context: {
  entries: LocalKnowledgeEntry[];
  scriptPath: string;
  root: string;
  keywords: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  searchStartedAt: number;
}): Promise<{
  requested: number;
  retained: number;
  byRef: Map<string, KnowledgeExcerptRetained>;
  gaps: KnowledgeExcerptGap[];
}> {
  const requests = planKnowledgeExcerptRequests(context.entries, MAX_KNOWLEDGE_EXCERPT_ENTRIES);
  if (!requests.length) return { requested: 0, retained: 0, byRef: new Map(), gaps: [] };
  const remainingMs = context.timeoutMs - (Date.now() - context.searchStartedAt);
  try {
    const { retained, gaps } = await readKnowledgeExcerpts({
      scriptPath: context.scriptPath,
      knowledgeRoot: context.root,
      requests,
      timeoutMs: remainingMs,
      signal: context.signal,
      keywords: context.keywords,
    });
    return { requested: requests.length, retained: retained.size, byRef: retained, gaps };
  } catch (error: any) {
    // readKnowledgeExcerpts is designed never to throw; this guard keeps an
    // unexpected failure from turning metadata hits into a lane error.
    return {
      requested: requests.length,
      retained: 0,
      byRef: new Map(),
      gaps: requests.map(request => ({
        status: 'unavailable' as const,
        ref: request.ref,
        revision: request.revision,
        message: boundedText(String(error?.message || error || 'knowledge excerpt enrichment failed'), 200),
      })),
    };
  }
}

/**
 * Bounded, trust-labeled projection of the local knowledge lane for the
 * evidence pack. `provenance: 'local_knowledge'` tells refine these are
 * distilled, per-host agent-owned documents — not server evidence — and that
 * `ref` values (`kb:...` / `file:...`) are the only citable forms.
 *
 * Excerpt budgeting never displaces metadata: phase 1 fits the mandatory
 * metadata/status/gap content exactly like the pre-enrichment baseline
 * (those refs are the floor); phase 2 adds excerpts out of the spare budget
 * only, shortening or skipping excerpts before any extra metadata entry
 * could be dropped. `excerpts_projected` counts what is actually in the
 * projection (vs `excerpts_retained`, how many reads were verified), and
 * `excerpt_projection_capped` marks any shortening or skipping.
 */
export function projectLocalKnowledgeLane(
  result: LocalKnowledgeLaneResult,
  maxLength: number = MAX_KNOWLEDGE_RESULT_CHARS,
): Record<string, unknown> {
  if (result.status === 'unavailable') {
    return {
      content_trust: 'local_distilled_knowledge',
      provenance: 'local_knowledge',
      scope: 'per_instance_shared',
      status: 'unavailable',
      ...(result.error ? { note: `Local knowledge search failed: ${result.error}` } : {}),
    };
  }
  // Phase 1 — floor: the EXACT pre-enrichment metadata envelope (same
  // fields, same pop behavior as the original metadata-only function).
  // Excerpt diagnostics are deliberately absent here so they can never cost
  // a metadata entry; the surviving refs are identical to the original
  // projection on the same input and maxLength.
  const entries = result.entries.map(({ excerpt: _excerpt, ...metadata }) => projectKnowledgeEntry(metadata));
  const projected: Record<string, unknown> = {
    content_trust: 'local_distilled_knowledge',
    provenance: 'local_knowledge',
    scope: 'per_instance_shared',
    status: result.status,
    entries,
    keywords_queried: result.keywordsQueried.length,
    ...(result.keywordsCapped ? { keywords_capped: true } : {}),
    ...(result.entriesCapped ? { entries_capped: true } : {}),
    ...(result.keywordsFailed > 0 ? { keywords_failed: result.keywordsFailed } : {}),
    truncated: result.entriesCapped,
  };
  let encoded = JSON.stringify(projected);
  while (encoded.length > maxLength && entries.length > 0) {
    entries.pop();
    projected.truncated = true;
    projected.projection_capped = true;
    projected.status = 'truncated';
    encoded = JSON.stringify(projected);
  }

  // Phase 2 — optional excerpt diagnostics/gaps/excerpts from the spare
  // only, in degradation tiers: full block → counters only → nothing, with
  // an omission marker whenever it fits. Tier cost is measured exactly
  // (comma + key + value) so no over-budget key is ever left behind and the
  // floor entries are never touched.
  const retainedByRef = new Map<string, KnowledgeExcerptRetained>();
  for (const entry of result.entries) {
    if (entry.excerpt) retainedByRef.set(entry.ref, entry.excerpt);
  }
  const excerptGaps = (result.excerptGaps ?? [])
    .map(gap => ({ ref: gap.ref, status: gap.status, revision: gap.revision, ...(gap.message ? { note: gap.message } : {}) }));
  const kvCost = (key: string, value: unknown): number =>
    1 + JSON.stringify(key).length + 1 + JSON.stringify(value === undefined ? null : value).length;
  const spareBytes = maxLength - encoded.length;
  const gapsEntries: Array<[string, unknown]> = excerptGaps.length ? [['excerpt_gaps', excerptGaps]] : [];
  const diagnosticTiers: Array<Array<[string, unknown]>> = [
    [
      ['excerpts_requested', result.excerptsRequested ?? 0],
      ['excerpts_retained', result.excerptsRetained ?? 0],
      ['excerpts_projected', 0],
      ['excerpt_projection_capped', false],
      ...gapsEntries,
    ],
    [
      ['excerpts_requested', result.excerptsRequested ?? 0],
      ['excerpts_retained', result.excerptsRetained ?? 0],
      ['excerpts_projected', 0],
    ],
    [],
  ];
  const FULL_TIER_LENGTH = 4 + gapsEntries.length;
  let addedDiagnostics: Array<[string, unknown]> | undefined;
  for (const tier of diagnosticTiers) {
    const cost = tier.reduce((sum, [key, value]) => sum + kvCost(key, value), 0);
    if (cost <= spareBytes) {
      addedDiagnostics = tier;
      break;
    }
  }
  const diagnosticsOmitted = addedDiagnostics === undefined || addedDiagnostics.length !== FULL_TIER_LENGTH;
  for (const [key, value] of addedDiagnostics ?? []) projected[key] = value;
  let projectedExcerpts = 0;
  let excerptProjectionCapped = false;
  for (const entry of entries) {
    const excerpt = retainedByRef.get(String(entry.ref));
    if (!excerpt) continue;
    const fit = fitProjectedExcerpt(projected, entry, excerpt, maxLength);
    if (!fit) {
      excerptProjectionCapped = true;
      continue;
    }
    projectedExcerpts += 1;
    if (fit.shortened) excerptProjectionCapped = true;
  }
  // Post-fitting finalizations are same-length or shorter than the reserved
  // forms, so they can never push the projection past the cap.
  if ('excerpts_projected' in projected) projected.excerpts_projected = projectedExcerpts;
  if ('excerpt_projection_capped' in projected) {
    if (excerptProjectionCapped) projected.excerpt_projection_capped = true;
    else delete projected.excerpt_projection_capped;
  }
  if (diagnosticsOmitted) {
    // Free the (meaningless when detail is omitted) capped reservation so
    // the omission marker itself can fit.
    delete projected.excerpt_projection_capped;
    const markerCost = kvCost('excerpt_diagnostics_omitted', true);
    if (markerCost <= maxLength - JSON.stringify(projected).length) {
      projected.excerpt_diagnostics_omitted = true;
    }
  }
  return projected;
}

/** Minimum useful projected text before shortening is not worth keeping. */
const MIN_PROJECTED_EXCERPT_CHARS = 64;

function isHighSurrogateUnit(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogateUnit(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function escapedJsonLength(text: string): number {
  return JSON.stringify(text).length - 2;
}

/**
 * Fit one retained excerpt into the projection's spare budget: full text if
 * it fits, else the largest verbatim prefix (surrogate-safe cut, honestly
 * re-ranged and flagged `projection_shortened`), else skip. The mandatory
 * metadata baseline is never reduced to make room.
 */
function fitProjectedExcerpt(
  projected: Record<string, unknown>,
  entry: Record<string, unknown>,
  excerpt: KnowledgeExcerptRetained,
  maxLength: number,
): { projectedExcerpt: Record<string, unknown>; shortened: boolean } | undefined {
  const finish = (projectedExcerpt: Record<string, unknown>, shortened: boolean) => {
    entry.excerpt = projectedExcerpt;
    return { projectedExcerpt, shortened };
  };
  // Measure the fixed overhead with an empty text first. The skeleton
  // carries the projection_shortened marker so its key cost is inside the
  // measured budget (the full-fit form without the marker only shrinks).
  const skeleton = projectKnowledgeExcerpt({ ...excerpt, text: '' });
  skeleton.projection_shortened = true;
  entry.excerpt = skeleton;
  const budget = maxLength - JSON.stringify(projected).length;
  const text = excerpt.text;
  if (escapedJsonLength(text) <= budget) {
    return finish(projectKnowledgeExcerpt(excerpt), false);
  }
  let lo = 1;
  let hi = text.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (escapedJsonLength(text.slice(0, mid)) <= budget) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Never split a surrogate pair at the projection cut.
  while (best > 0 && best < text.length
      && isHighSurrogateUnit(text.charCodeAt(best - 1)) && isLowSurrogateUnit(text.charCodeAt(best))) {
    best -= 1;
  }
  if (best < Math.min(MIN_PROJECTED_EXCERPT_CHARS, text.length)) {
    delete entry.excerpt;
    return undefined;
  }
  const shortenedText = text.slice(0, best);
  const shortenedExcerpt = projectKnowledgeExcerpt({
    ...excerpt,
    text: shortenedText,
    charEnd: excerpt.charStart + shortenedText.length,
    omittedAfter: true,
    truncated: true,
  });
  shortenedExcerpt.projection_shortened = true;
  return finish(shortenedExcerpt, true);
}

async function runKnowledgeSearch(
  scriptPath: string,
  root: string,
  keywords: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<KnowledgeSearchOutput> {
  // A JSON array is a single argv entry — no shell. The helper enforces
  // the 3-keyword/64-code-point bounds and scans the KB once for the batch.
  // Parent-side hard deadline: the await races a supervisor timer, so a
  // slow child close can never extend the shared lane budget.
  try {
    const stdout = await execKnowledgeChild(
      knowledgeNodeExecutable(),
      [scriptPath, '--root', root, 'search-any', JSON.stringify(keywords)],
      { deadlineMs: timeoutMs, signal, maxBuffer: MAX_SCRIPT_STDOUT_CHARS },
    );
    return parseKnowledgeOutput(stdout);
  } catch (error: any) {
    throw new Error(knowledgeProcessErrorMessage(error, signal));
  }
}

function parseKnowledgeOutput(stdout: string): KnowledgeSearchOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new KnowledgeScriptError('knowledge script returned non-JSON output');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || (parsed as KnowledgeSearchOutput).ok !== true
    || !Array.isArray((parsed as KnowledgeSearchOutput).items)) {
    throw new KnowledgeScriptError('knowledge script returned an unusable envelope');
  }
  return parsed as KnowledgeSearchOutput;
}

function projectScriptItems(items: unknown): LocalKnowledgeEntry[] {
  if (!Array.isArray(items)) return [];
  const entries: LocalKnowledgeEntry[] = [];
  for (const raw of items.slice(0, MAX_LOCAL_KNOWLEDGE_ENTRIES * 4)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as KnowledgeScriptItem;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) continue;
    const ref = knowledgeEntryRef(id, item.file);
    if (!ref || !isKnowledgeCitationRef(ref)) continue;
    entries.push({
      ref,
      id,
      title: boundedText(item.title, 200),
      summary: boundedText(item.summary, MAX_ENTRY_TEXT_CHARS),
      category: boundedText(item.category, 64),
      updated_at: boundedText(item.updatedAt, 64),
      revision: boundedText(item.revision, 128),
      managed: item.managed === true,
    });
  }
  return entries;
}

/**
 * Map the KB store's document identity to its citable ref form: managed
 * `KB-…` documents become `kb:<KB-ID>`; raw source documents are already
 * identified as `file:documents/...` and validated against the safe
 * documents path shape.
 */
function knowledgeEntryRef(id: string, file: unknown): string | undefined {
  if (KNOWLEDGE_KB_ID_PATTERN.test(id)) return `kb:${id}`;
  if (id.startsWith('file:')) {
    const relative = typeof file === 'string' && file.trim() ? file.trim() : id.slice(5);
    const ref = `file:${relative}`;
    return isKnowledgeCitationRef(ref) ? ref : undefined;
  }
  return undefined;
}

function projectKnowledgeEntry(entry: LocalKnowledgeEntry): Record<string, unknown> {
  return {
    ref: entry.ref,
    id: entry.id,
    title: entry.title,
    summary: entry.summary,
    category: entry.category,
    updated_at: entry.updated_at,
    revision: entry.revision,
    managed: entry.managed,
    ...(entry.excerpt ? { excerpt: projectKnowledgeExcerpt(entry.excerpt) } : {}),
  };
}

/**
 * Excerpt projection: verbatim text plus the truncation markers and the read
 * paging contract. The text stays inside this lane's
 * `local_distilled_knowledge` trust labeling; ref/revision keep it citable.
 */
function projectKnowledgeExcerpt(excerpt: KnowledgeExcerptRetained): Record<string, unknown> {
  return {
    status: excerpt.status,
    ref: excerpt.ref,
    revision: excerpt.revision,
    text: excerpt.text,
    char_start: excerpt.charStart,
    char_end: excerpt.charEnd,
    omitted_before: excerpt.omittedBefore,
    omitted_after: excerpt.omittedAfter,
    truncated: excerpt.truncated,
    truncated_by_paging: excerpt.truncatedByPaging,
    page_chars: excerpt.pageChars,
    offset: excerpt.offset,
    next_offset: excerpt.nextOffset,
  };
}

function knowledgeNodeExecutable(): string {
  return process.env.XIAOBA_NODE_EXECUTABLE?.trim() || process.execPath;
}

function fileExists(target: string): boolean {
  try {
    return fs.statSync(target).isFile() || fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function boundedText(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 32))}…[truncated]`;
}
