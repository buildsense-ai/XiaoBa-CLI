import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { PathResolver } from '../utils/path-resolver';
import { KNOWLEDGE_SCRIPT_FILE } from '../skills/builtin-knowledge-skill';
import { hasCatsLogControlCodePoint } from '../utils/catsco-log-agent-client';
import { isKnowledgeCitationRef } from '../tools/memory-branch-tools';

const execFileAsync = promisify(execFile);

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
}

export const MAX_LOCAL_KNOWLEDGE_KEYWORDS = 3;
export const MAX_LOCAL_KNOWLEDGE_ENTRIES = 8;
export const KNOWLEDGE_SEARCH_TIMEOUT_MS = 3_000;
const MAX_KNOWLEDGE_RESULT_CHARS = 8_000;
const MAX_ENTRY_TEXT_CHARS = 600;
const MAX_SCRIPT_STDOUT_CHARS = 512 * 1024;
const KNOWLEDGE_KB_ID_PATTERN = /^KB-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/**
 * L0 lane of the mechanical retrieval stage: search the per-host,
 * agent-owned distilled knowledge KB that the xiaoba-knowledge Skill writes
 * under the runtime data root. The KB is local, read-only here, and carries
 * no cross-agent scope labels — provenance is marked on the lane itself, so
 * no server round-trip or scope fencing applies.
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
  const keywords = (options.keywords ?? [])
    .filter(keyword => typeof keyword === 'string' && keyword.trim() && !hasCatsLogControlCodePoint(keyword));
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
  const settled = await Promise.all(queried.map(keyword =>
    runKnowledgeSearch(scriptPath, root, keyword, timeoutMs, options.signal)
      .then(output => ({ keyword, output, error: undefined as string | undefined }))
      .catch((error: any) => ({
        keyword,
        output: undefined as KnowledgeSearchOutput | undefined,
        error: boundedText(String(error?.message || error || 'knowledge search failed'), 200),
      })),
  ));

  const entries: LocalKnowledgeEntry[] = [];
  const seen = new Set<string>();
  let entriesCapped = false;
  let keywordsFailed = 0;
  let firstError: string | undefined;
  for (const attempt of settled) {
    if (!attempt.output || attempt.error) {
      keywordsFailed += 1;
      firstError ??= attempt.error;
      continue;
    }
    for (const entry of projectScriptItems(attempt.output.items)) {
      if (seen.has(entry.ref)) continue;
      if (entries.length >= MAX_LOCAL_KNOWLEDGE_ENTRIES) {
        entriesCapped = true;
        break;
      }
      seen.add(entry.ref);
      entries.push(entry);
    }
  }

  if (entries.length === 0 && keywordsFailed > 0) {
    return {
      ...base,
      status: 'unavailable',
      error: firstError ? `knowledge search failed: ${firstError}` : 'knowledge search failed',
      keywordsFailed,
    };
  }
  return {
    ...base,
    status: 'ok',
    entries,
    keywordsFailed,
    entriesCapped,
  };
}

/**
 * Bounded, trust-labeled projection of the local knowledge lane for the
 * evidence pack. `provenance: 'local_knowledge'` tells refine these are
 * distilled, per-host agent-owned documents — not server evidence — and that
 * `ref` values (`kb:...` / `file:...`) are the only citable forms.
 */
export function projectLocalKnowledgeLane(
  result: LocalKnowledgeLaneResult,
  maxLength: number = MAX_KNOWLEDGE_RESULT_CHARS,
): Record<string, unknown> {
  if (result.status === 'unavailable') {
    return {
      content_trust: 'local_distilled_knowledge',
      provenance: 'local_knowledge',
      scope: 'per_host_agent_owned',
      status: 'unavailable',
      ...(result.error ? { note: `Local knowledge search failed: ${result.error}` } : {}),
    };
  }
  const entries = result.entries.map(projectKnowledgeEntry);
  const projected: Record<string, unknown> = {
    content_trust: 'local_distilled_knowledge',
    provenance: 'local_knowledge',
    scope: 'per_host_agent_owned',
    status: result.status,
    entries,
    keywords_queried: result.keywordsQueried.length,
    ...(result.keywordsCapped ? { keywords_capped: true } : {}),
    ...(result.keywordsFailed > 0 ? { keywords_failed: result.keywordsFailed } : {}),
    truncated: result.entriesCapped,
  };
  let encoded = JSON.stringify(projected);
  while (encoded.length > maxLength && entries.length > 0) {
    entries.pop();
    projected.truncated = true;
    encoded = JSON.stringify(projected);
  }
  return projected;
}

function runKnowledgeSearch(
  scriptPath: string,
  root: string,
  keyword: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<KnowledgeSearchOutput> {
  // execFile passes the keyword as a single argv entry — no shell, so the
  // term can never broaden into option parsing or command injection beyond
  // the script's own manual argv handling (which fails closed).
  return execFileAsync(
    knowledgeNodeExecutable(),
    [scriptPath, '--root', root, 'search', keyword],
    {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_SCRIPT_STDOUT_CHARS,
      signal,
      windowsHide: true,
    },
  ).then(
    ({ stdout }) => parseKnowledgeOutput(stdout),
    (error: any) => { throw new Error(knowledgeSearchErrorMessage(error)); },
  );
}

/** Prefer the script's own JSON error envelope over execFile command noise. */
function knowledgeSearchErrorMessage(error: any): string {
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
      return boundedText(text, 200);
    }
  }
  return boundedText(String(error?.message || error || 'knowledge search failed'), 200);
}

function parseKnowledgeOutput(stdout: string): KnowledgeSearchOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('knowledge script returned non-JSON output');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || (parsed as KnowledgeSearchOutput).ok !== true) {
    throw new Error('knowledge script returned an unusable envelope');
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
