import * as crypto from 'crypto';
import type {
  CatscoBranchResponse,
  CatscoSourceMemoryProjectionRead,
} from '../utils/catsco-log-agent-client';
import { isCatsLogPoolCitationRef } from '../utils/catsco-log-agent-client';
import { isMemoryCitationRef } from '../tools/memory-branch-tools';

/**
 * Client adoption of the server-typed `source_reference` locator emitted by
 * the `agent_memory` lane of /catsco/agent/branch.
 *
 * Contract (see /tmp/catslog-client-projection-wire.md):
 *
 * - A `kind === 'source_reference'` item is a BOUNDED METADATA LOCATOR only.
 *   Its `ref` (`ref_<64hex>`, the pool-citation shape) expands through the
 *   device-bound POST /catsco/agent/knowledge/source/read {projection_ref}
 *   route. Its `text` is the server's finite-count locator — never treated
 *   as semantic content, never promoted to a fact, and never a substitute
 *   for the expanded document.
 * - Expansion is deliberately bounded: at most MAX_SOURCE_REFERENCE_EXPANSIONS
 *   refs, sequential, under the caller's cancellation signal, one attempt
 *   each (no retry). Every failure class (capability absent, HTTP
 *   401/403/404, network, abort, validation) degrades the ref to
 *   `reference_only` with a typed `expansion_error` — the metadata locator
 *   stays in the pack either way.
 * - Validation re-derives the server opaque ref from the returned
 *   projection's identity (revision + stream) and requires it to equal the
 *   requested ref, so a stale or cross-projection read can never be adopted
 *   under the ref the branch actually cited.
 * - The semantic view is all-or-nothing: conditions/omissions/
 *   gap_acknowledgement/node texts are never text-truncated. A validated
 *   document whose bounded view exceeds MAX_PROJECTION_VIEW_CHARS drops to
 *   `reference_only` with `semantic_view_over_budget` — a partial qualifier
 *   can never be presented.
 * - Ref status vocabulary is explicit: `discovered` (in the branch
 *   response), `expanded` (validated view built), `delivered` (view present
 *   in the evidence pack the branch model saw), `retained` (carried into
 *   the injected observation). A finish that cites a ref the run never
 *   observed is downgraded — see finishRefKind.
 */

/** Hard cap on source-read expansions per branch run. */
export const MAX_SOURCE_REFERENCE_EXPANSIONS = 4;
/** Whole-item presentation budget for one expanded semantic view (UTF-16 units). */
export const MAX_PROJECTION_VIEW_CHARS = 16_000;
/** Whole-item budget for the retained view carried into the parent observation. */
export const MAX_RETAINED_REMOTE_VIEW_CHARS = MAX_PROJECTION_VIEW_CHARS;
/** Aggregate bounds mirroring the server's document contract. */
const MAX_PROJECTION_NODES = 32;
const MAX_PROJECTION_EDGES = 64;
const MAX_PROJECTION_QUALIFIERS = 64;
const MAX_PROJECTION_MAPPINGS = 64;
const MAX_PROJECTION_SOURCES = 32;
const MAX_PROJECTION_AGGREGATE_GAPS = 32;
const MAX_PROJECTION_STRING_CHARS = 8_000;
const MAX_PROJECTION_REF_CHARS = 512;
const MAX_PROJECTION_NODE_ID_CHARS = 128;
const MAX_PROJECTION_KIND_CHARS = 64;
const MAX_PROJECTION_ANCHOR_CHARS = 4_000;
const MAX_PROJECTION_DIGEST_CHARS = 128;

export type SourceProjectionFailureClass =
  | 'capability_unavailable'
  | 'http_401'
  | 'http_403'
  | 'http_404'
  | 'http_error'
  | 'network_error'
  | 'aborted'
  | 'invalid_response'
  | 'stale_ref'
  | 'semantic_view_over_budget';

export interface SourceReferenceItem {
  ref: string;
  kind: 'source_reference';
  /** The server's bounded metadata locator text (finite counts only). */
  text: string;
  score_hint?: number;
}

export interface SourceReferenceExpansion {
  ref: string;
  /** `expanded` only when a complete bounded semantic view was built. */
  status: 'expanded' | 'reference_only';
  /** Present only when status === 'expanded'. Never text-truncated. */
  semantic_view?: Record<string, unknown>;
  /** Bounded reason for reference_only (typed class, never a raw message). */
  expansion_error?: SourceProjectionFailureClass;
}

export interface SourceProjectionValidation {
  ok: boolean;
  reason?: SourceProjectionFailureClass;
  /** Validated projection document (the graph under `projection.document`). */
  document?: Record<string, unknown>;
  /** Bounded authorized supplied-page sources (reproof payloads, untrusted). */
  sources?: unknown[];
}

export type FinishRefKind =
  | 'canonical'
  | 'local_remote'
  | 'remote_delivered'
  | 'remote_reference_only'
  | 'remote_unobserved';

/**
 * Recompute the server opaque ref for a projection revision/stream pair.
 * Mirrors store.SourceMemoryProjectionOpaqueRef:
 * `ref_<sha256("smp_" + revision + "\x00" + "source-memory:" + stream + ":" + revision)>`.
 */
export function recomputeSourceProjectionRef(revision: unknown, streamId: unknown): string | undefined {
  const rev = typeof revision === 'string' ? revision.trim() : '';
  const stream = typeof streamId === 'string' ? streamId.trim() : '';
  if (!rev || !stream || rev.length > 256 || stream.length > 512) return undefined;
  const digest = crypto
    .createHash('sha256')
    .update(`smp_${rev}\x00source-memory:${stream}:${rev}`)
    .digest('hex');
  return `ref_${digest}`;
}

/**
 * Typed source_reference candidates from one /branch response. An item is a
 * candidate ONLY when `kind === 'source_reference'` AND `ref` is a valid
 * `ref_<64hex>` pool ref — a pool ref on any other kind (including a note
 * whose text mentions a ref) is never expanded. Deduped, discovery order,
 * capped at MAX_SOURCE_REFERENCE_EXPANSIONS (extras remain discovered-only).
 */
export function discoverSourceReferenceItems(response: CatscoBranchResponse | unknown): SourceReferenceItem[] {
  const source = asRecord(response);
  const branches = Array.isArray(source?.branches) ? source.branches : [];
  const items: SourceReferenceItem[] = [];
  const seen = new Set<string>();
  for (const branch of branches) {
    const record = asRecord(branch);
    if (!record || record.source !== 'agent_memory') continue;
    const rawItems = Array.isArray(record.items) ? record.items : [];
    for (const raw of rawItems) {
      const item = asRecord(raw);
      if (!item || item.kind !== 'source_reference') continue;
      const ref = item.ref;
      if (!isCatsLogPoolCitationRef(ref) || seen.has(ref)) continue;
      seen.add(ref);
      items.push({
        ref,
        kind: 'source_reference',
        text: typeof item.text === 'string' ? boundedText(item.text, MAX_PROJECTION_STRING_CHARS) : '',
        ...(finiteNumber(item.score_hint) !== undefined ? { score_hint: finiteNumber(item.score_hint) } : {}),
      });
      if (items.length >= MAX_SOURCE_REFERENCE_EXPANSIONS) return items;
    }
  }
  return items;
}

/**
 * Bounded projection of the source-read response envelope. The projection
 * field is passed through structurally (the validator owns the document
 * contract); sources are bounded and sanitized of receipt/token-shaped keys.
 */
export function projectSourceProjectionRead(
  read: CatscoSourceMemoryProjectionRead | unknown,
): { projection?: Record<string, unknown>; sources: unknown[] } {
  const source = asRecord(read);
  const projection = asRecord(source?.projection);
  const sources = Array.isArray(source?.sources) ? source.sources : [];
  return {
    ...(projection ? { projection: sanitizeJson(projection) as Record<string, unknown> } : {}),
    sources: sources.slice(0, MAX_PROJECTION_SOURCES).map(entry => sanitizeJson(entry)),
  };
}

/**
 * Validate one source-read response against the client-side contract.
 *
 * Failure precedence: envelope shape → stale/foreign ref → document fields.
 * Anything that fails is `reference_only` upstream; the function never
 * throws on malformed input.
 */
export function validateSourceMemoryProjectionDocument(
  read: CatscoSourceMemoryProjectionRead | unknown,
  requestedRef: string,
): SourceProjectionValidation {
  const { projection, sources } = projectSourceProjectionRead(read);
  if (!projection) return { ok: false, reason: 'invalid_response' };
  const document = asRecord(projection.document);
  if (!document) return { ok: false, reason: 'invalid_response' };

  // Currentness fence: the returned projection's own identity must recompute
  // to the exact requested ref — a stale revision or a foreign projection
  // can never be adopted under the ref the branch cited.
  const revision = projection.revision;
  const streamId = projection.stream_id ?? projection.streamId;
  const recomputed = recomputeSourceProjectionRef(revision, streamId);
  if (!recomputed || recomputed !== requestedRef) {
    return { ok: false, reason: 'stale_ref' };
  }

  if (document.schema_version !== 1
    || document.provenance !== 'derived'
    || document.model_steps !== 'unknown'
    || document.causality !== 'unknown') {
    return { ok: false, reason: 'invalid_response' };
  }
  if (!isNonEmptyString(document.goal) || !isNonEmptyString(document.summary)) {
    return { ok: false, reason: 'invalid_response' };
  }
  const coverage = document.overall_coverage;
  if (coverage !== 'complete' && coverage !== 'partial') {
    return { ok: false, reason: 'invalid_response' };
  }
  if (coverage === 'partial' && !isNonEmptyString(document.gap_acknowledgement)) {
    // A partial document without a gap acknowledgement would silently hide
    // the hole — reject rather than present it as whole.
    return { ok: false, reason: 'invalid_response' };
  }
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];
  if (nodes.length < 1 || nodes.length > MAX_PROJECTION_NODES) {
    return { ok: false, reason: 'invalid_response' };
  }
  if (!nodes.every(isProjectionNode)) return { ok: false, reason: 'invalid_response' };
  const edges = Array.isArray(document.edges) ? document.edges : [];
  if (edges.length > MAX_PROJECTION_EDGES || !edges.every(isProjectionEdge)) {
    return { ok: false, reason: 'invalid_response' };
  }
  if (!isStringArrayBounded(document.conditions, MAX_PROJECTION_QUALIFIERS)
    || !isStringArrayBounded(document.omissions, MAX_PROJECTION_QUALIFIERS)) {
    return { ok: false, reason: 'invalid_response' };
  }
  const mappings = Array.isArray(document.mappings) ? document.mappings : [];
  if (mappings.length > MAX_PROJECTION_MAPPINGS || !mappings.every(isProjectionMapping)) {
    return { ok: false, reason: 'invalid_response' };
  }
  const aggregate = asRecord(document.aggregate);
  if (aggregate !== undefined && !isProjectionAggregate(aggregate)) {
    return { ok: false, reason: 'invalid_response' };
  }
  return { ok: true, document, sources };
}

/**
 * Complete bounded semantic view of one validated projection document.
 * Every qualifier is whole: conditions/omissions are numbered verbatim
 * strings, the gap acknowledgement is verbatim, nodes/edges/mappings keep
 * their graph identities, and aggregate coverage/gaps are rendered whole.
 * Returns undefined when the honest view cannot fit the budget — the caller
 * degrades the whole item rather than presenting a cut qualifier.
 */
export function buildSourceProjectionSemanticView(
  validation: SourceProjectionValidation,
  maxChars: number = MAX_PROJECTION_VIEW_CHARS,
): Record<string, unknown> | undefined {
  const document = validation.document;
  if (!validation.ok || !document) return undefined;
  const conditions = asStringArray(document.conditions);
  const omissions = asStringArray(document.omissions);
  const nodes = (Array.isArray(document.nodes) ? document.nodes : []).map(node => {
    const record = node as Record<string, unknown>;
    return {
      id: boundedText(record.id, MAX_PROJECTION_NODE_ID_CHARS),
      kind: boundedText(record.kind, MAX_PROJECTION_KIND_CHARS),
      text: boundedText(record.text, MAX_PROJECTION_STRING_CHARS),
    };
  });
  const edges = (Array.isArray(document.edges) ? document.edges : []).map(edge => {
    const record = edge as Record<string, unknown>;
    return {
      from: boundedText(record.from, MAX_PROJECTION_NODE_ID_CHARS),
      to: boundedText(record.to, MAX_PROJECTION_NODE_ID_CHARS),
      kind: boundedText(record.kind, MAX_PROJECTION_KIND_CHARS),
    };
  });
  const mappings = (Array.isArray(document.mappings) ? document.mappings : []).map(mapping => {
    const record = mapping as Record<string, unknown>;
    return {
      node_id: boundedText(record.node_id, MAX_PROJECTION_NODE_ID_CHARS),
      ...(typeof record.source_ref === 'string' && record.source_ref
        ? { source_ref: boundedText(record.source_ref, MAX_PROJECTION_REF_CHARS) } : {}),
      ...(typeof record.digest === 'string' && record.digest
        ? { digest: boundedText(record.digest, MAX_PROJECTION_DIGEST_CHARS) } : {}),
    };
  });
  const aggregate = asRecord(document.aggregate);
  const aggregateView = aggregate
    ? {
      ...(finiteInteger(aggregate.verified_pages) !== undefined
        ? { verified_pages: finiteInteger(aggregate.verified_pages) } : {}),
      ...(finiteInteger(aggregate.total_pages) !== undefined
        ? { total_pages: finiteInteger(aggregate.total_pages) } : {}),
      gaps: (Array.isArray(aggregate.gaps) ? aggregate.gaps : [])
        .slice(0, MAX_PROJECTION_AGGREGATE_GAPS)
        .map(gap => {
          const record = asRecord(gap) ?? {};
          return {
            status: boundedText(record.status, MAX_PROJECTION_KIND_CHARS),
            ...(finiteInteger(record.first_page) !== undefined ? { first_page: finiteInteger(record.first_page) } : {}),
            ...(finiteInteger(record.last_page) !== undefined ? { last_page: finiteInteger(record.last_page) } : {}),
          };
        }),
    }
    : undefined;
  const view: Record<string, unknown> = {
    content_trust: 'derived_memory_projection',
    goal: boundedText(document.goal, MAX_PROJECTION_STRING_CHARS),
    summary: boundedText(document.summary, MAX_PROJECTION_STRING_CHARS),
    overall_coverage: document.overall_coverage,
    ...(isNonEmptyString(document.gap_acknowledgement)
      ? { gap_acknowledgement: boundedText(document.gap_acknowledgement, MAX_PROJECTION_STRING_CHARS) } : {}),
    conditions,
    omissions,
    nodes,
    edges,
    mappings,
    ...(aggregateView ? { aggregate: aggregateView } : {}),
    ...(validation.sources && validation.sources.length > 0
      ? { sources_count: validation.sources.length } : {}),
  };
  // Whole-item budget: the serialized view must fit or the item is dropped
  // upstream. Serialized size is the honest measure of what the model sees.
  if (JSON.stringify(view).length > maxChars) return undefined;
  return view;
}

/**
 * Expand the discovered source_reference candidates of one branch response.
 * Sequential, one attempt per ref, under the caller's signal. `expandFn` is
 * the device-capability read seam (backend.readSourceMemoryProjection or an
 * injected fake). Never throws: each ref resolves to `expanded` or
 * `reference_only` with a typed error class.
 */
export async function expandSourceReferences(
  response: CatscoBranchResponse | unknown,
  expandFn: ((input: { projectionRef: string }, signal?: AbortSignal) => Promise<unknown>) | undefined,
  options: { maxExpansions?: number; signal?: AbortSignal } = {},
): Promise<SourceReferenceExpansion[]> {
  const candidates = discoverSourceReferenceItems(response);
  const limit = Math.min(
    candidates.length,
    Number.isSafeInteger(options.maxExpansions) && (options.maxExpansions as number) > 0
      ? options.maxExpansions!
      : MAX_SOURCE_REFERENCE_EXPANSIONS,
  );
  const expansions: SourceReferenceExpansion[] = [];
  for (const candidate of candidates.slice(0, limit)) {
    expansions.push(await expandOneSourceReference(candidate, expandFn, options.signal));
  }
  return expansions;
}

async function expandOneSourceReference(
  candidate: SourceReferenceItem,
  expandFn: ((input: { projectionRef: string }, signal?: AbortSignal) => Promise<unknown>) | undefined,
  signal?: AbortSignal,
): Promise<SourceReferenceExpansion> {
  if (!expandFn) {
    return { ref: candidate.ref, status: 'reference_only', expansion_error: 'capability_unavailable' };
  }
  let read: unknown;
  try {
    read = await expandFn({ projectionRef: candidate.ref }, signal);
  } catch (error: any) {
    return {
      ref: candidate.ref,
      status: 'reference_only',
      expansion_error: classifyExpansionError(error, signal),
    };
  }
  const validation = validateSourceMemoryProjectionDocument(read, candidate.ref);
  if (!validation.ok) {
    return {
      ref: candidate.ref,
      status: 'reference_only',
      expansion_error: validation.reason ?? 'invalid_response',
    };
  }
  const view = buildSourceProjectionSemanticView(validation);
  if (!view) {
    return { ref: candidate.ref, status: 'reference_only', expansion_error: 'semantic_view_over_budget' };
  }
  return { ref: candidate.ref, status: 'expanded', semantic_view: view };
}

/** Typed failure classes for expansion; raw error text never leaks upstream. */
export function classifyExpansionError(error: any, signal?: AbortSignal): SourceProjectionFailureClass {
  if (signal?.aborted || error?.name === 'AbortError') return 'aborted';
  const status = Number(error?.status);
  if (status === 401) return 'http_401';
  if (status === 403) return 'http_403';
  if (status === 404) return 'http_404';
  if (Number.isFinite(status) && status >= 400) return 'http_error';
  return 'network_error';
}

/**
 * Classify one finish-cited ref against this run's tracked sets.
 * `deliveredRemoteRefs` = refs whose complete view was in the pack the
 * branch model saw; `observedRemoteRefs` = every valid pool ref the branch
 * response carried (delivered ⊆ observed).
 *
 * A `ref_<64hex>` ref maps to remote_delivered / remote_reference_only /
 * remote_unobserved; any other citation-shaped ref is `local_remote` when it
 * is a remote-shaped citation the run surfaced, else `canonical`. Anything
 * isMemoryCitationRef rejects stays `remote_unobserved` upstream-safe only
 * when the caller treats non-citation shapes as unobserved — callers must
 * pre-validate with isMemoryCitationRef.
 */
export function finishRefKind(
  ref: string,
  deliveredRemoteRefs: ReadonlySet<string>,
  observedRemoteRefs: ReadonlySet<string>,
): FinishRefKind {
  if (isCatsLogPoolCitationRef(ref)) {
    if (deliveredRemoteRefs.has(ref)) return 'remote_delivered';
    if (observedRemoteRefs.has(ref)) return 'remote_reference_only';
    return 'remote_unobserved';
  }
  if (!isMemoryCitationRef(ref)) return 'remote_unobserved';
  // Any non-pool citation shape (canonical jsonl ref, stream#n, catslog:*,
  // knowledge refs) — the observed-refs tracker gates membership; here they
  // classify as the existing local lane.
  return 'canonical';
}

// ─── internal helpers ────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, any> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function boundedText(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 32))}\n...[truncated]`;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function isStringArrayBounded(value: unknown, maxEntries: number): boolean {
  return value === undefined
    || (Array.isArray(value)
      && value.length <= maxEntries
      && value.every(entry => typeof entry === 'string' && entry.length <= MAX_PROJECTION_STRING_CHARS));
}

function isProjectionNode(value: unknown): boolean {
  const node = asRecord(value);
  return Boolean(node)
    && isNonEmptyString(node!.id) && node!.id.length <= MAX_PROJECTION_NODE_ID_CHARS
    && isNonEmptyString(node!.kind) && node!.kind.length <= MAX_PROJECTION_KIND_CHARS
    && typeof node!.text === 'string' && node!.text.length <= MAX_PROJECTION_STRING_CHARS;
}

function isProjectionEdge(value: unknown): boolean {
  const edge = asRecord(value);
  return Boolean(edge)
    && isNonEmptyString(edge!.from) && edge!.from.length <= MAX_PROJECTION_NODE_ID_CHARS
    && isNonEmptyString(edge!.to) && edge!.to.length <= MAX_PROJECTION_NODE_ID_CHARS
    && isNonEmptyString(edge!.kind) && edge!.kind.length <= MAX_PROJECTION_KIND_CHARS;
}

function isProjectionMapping(value: unknown): boolean {
  const mapping = asRecord(value);
  return Boolean(mapping)
    && isNonEmptyString(mapping!.node_id) && mapping!.node_id.length <= MAX_PROJECTION_NODE_ID_CHARS;
}

function isProjectionAggregate(value: Record<string, unknown>): boolean {
  const gaps = value.gaps;
  return gaps === undefined
    || (Array.isArray(gaps)
      && gaps.length <= MAX_PROJECTION_AGGREGATE_GAPS
      && gaps.every(gap => asRecord(gap) !== undefined));
}

/**
 * Recursively drop receipt/credential-shaped keys and bound strings/arrays —
 * same redaction posture as the branch projection's sanitizeJSON.
 */
function sanitizeJson(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[nested data omitted]';
  if (typeof value === 'string') return boundedText(value, MAX_PROJECTION_STRING_CHARS);
  if (Array.isArray(value)) return value.slice(0, 64).map(item => sanitizeJson(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/receipt|token|authorization|password|secret|api[_-]?key/i.test(key)) continue;
    result[key] = sanitizeJson(child, depth + 1);
  }
  return result;
}
