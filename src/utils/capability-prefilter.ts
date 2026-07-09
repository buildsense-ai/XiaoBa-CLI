import {
  CapabilityRegistryEntry,
  CapabilityRegistryState,
  CapabilityStatus,
} from './capability-registry';
import { DistilledKnowledgeCandidate } from './capability-distiller';

/**
 * Capability Prefilter (issue #18).
 *
 * A deterministic recall step that searches the Capability Registry for a
 * bounded set of potentially related existing capabilities for a new capability
 * candidate. It does **not** make final deduplication or consolidation
 * decisions; it only narrows scope for a later Promotion Review Branch by
 * returning top-N related capability summaries in stable order.
 *
 * Scoring is deterministic and testable: it compares the candidate's title,
 * applicability, action pattern, boundaries, and solved-loop evidence against
 * registry fields such as `capabilityId` and `routingDescription`. Text
 * similarity is treated as recall only, not as final truth.
 *
 * The prefilter reads registry summaries only. It never reads installed
 * `SKILL.md` snapshot bodies directly.
 *
 * See ADR 0003: Capability Prefilter Before Reviewer Match.
 * See docs/prd/runtime-capability-registry-v2.md.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single related capability returned by the prefilter. */
export interface CapabilityPrefilterMatch {
  /** Stable capability identity. */
  capabilityId: string;
  /** Active Snapshot identity (the current executable expression). */
  activeSnapshotId: string;
  /** Lifecycle status of the related capability. */
  status: CapabilityStatus;
  /** Routable When/Do summary from the registry entry. */
  routingDescription: string;
  /** Deterministic recall score (0–100). Higher means more overlap. */
  score: number;
  /** Number of evidence refs backing the related capability. */
  evidenceCount: number;
  /** Number of related snapshot identities preserved for the capability. */
  relatedSnapshotCount: number;
  /** ISO timestamp of registry entry creation. */
  createdAt: string;
  /** ISO timestamp of the last registry update. */
  updatedAt: string;
}

/** Output shape of the Capability Prefilter. */
export interface CapabilityPrefilterResult {
  /** Capability identity of the candidate that was searched. */
  candidateCapabilityId: string;
  /** Maximum number of matches requested (the bound). */
  limit: number;
  /** Total number of capabilities in the registry at search time. */
  totalRegistryCapabilities: number;
  /** Top-N related capability summaries in stable order. */
  matches: CapabilityPrefilterMatch[];
}

/** Options controlling prefilter recall behavior. */
export interface CapabilityPrefilterOptions {
  /** Maximum number of related capabilities to return. Default: 5. */
  limit?: number;
  /**
   * Minimum score (0–100) required for a capability to appear in the result.
   * Default: 1. Set to 0 to include zero-score entries up to `limit`.
   */
  minScore?: number;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Search the Capability Registry for a bounded set of potentially related
 * capabilities for a new capability candidate.
 *
 * The result is a stable top-N list ordered by descending score, with
 * deterministic tie-breaking by `capabilityId` ascending. The prefilter is
 * pure: it does not mutate the registry or the candidate.
 */
export function prefilterCapabilities(
  candidate: DistilledKnowledgeCandidate,
  registry: CapabilityRegistryState,
  options: CapabilityPrefilterOptions = {},
): CapabilityPrefilterResult {
  const limit = normalizeLimit(options.limit);
  const minScore = normalizeMinScore(options.minScore);

  const candidateTokens = tokenizeCandidate(candidate);
  const candidateEvidenceSources = candidateEvidenceSourcePaths(candidate);

  const matches: CapabilityPrefilterMatch[] = [];
  for (const entry of Object.values(registry.capabilities)) {
    const score = computeMatchScore(candidate, candidateTokens, candidateEvidenceSources, entry);
    if (score < minScore) continue;
    matches.push(buildMatch(entry, score));
  }

  // Stable ordering: score descending, then capabilityId ascending.
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.capabilityId.localeCompare(b.capabilityId, 'en');
  });

  return {
    candidateCapabilityId: candidate.capabilityId,
    limit,
    totalRegistryCapabilities: Object.keys(registry.capabilities).length,
    matches: matches.slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// Internal: scoring
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic recall score (0–100) between a candidate and a
 * registry entry.
 *
 * Scoring signals:
 *  - Exact `capabilityId` match is the strongest recall signal.
 *  - Text overlap (Jaccard-style) between candidate summary fields and the
 *    registry `routingDescription` captures near-duplicates.
 *  - Evidence source overlap adds a small bonus when the candidate's provenance
 *    points at a session log already referenced by the registry entry.
 */
function computeMatchScore(
  candidate: DistilledKnowledgeCandidate,
  candidateTokens: ReadonlySet<string>,
  candidateEvidenceSources: ReadonlySet<string>,
  entry: CapabilityRegistryEntry,
): number {
  let score = 0;

  // Strong signal: exact capability identity match.
  if (candidate.capabilityId === entry.capabilityId) {
    score = 100;
    return score;
  }

  // Text overlap signal.
  const registryTokens = tokenizeRegistryEntry(entry);
  score += jaccardScore(candidateTokens, registryTokens);

  // Evidence metadata signal: the candidate shares a provenance source file
  // with an existing registry entry.
  const entryEvidenceSources = entryEvidenceSourcePaths(entry);
  if (hasIntersection(candidateEvidenceSources, entryEvidenceSources)) {
    score += 10;
  }

  return Math.min(100, score);
}

/** Jaccard-style overlap scaled to 0–100. */
function jaccardScore(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = countIntersection(a, b);
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return Math.floor((intersection / union) * 100);
}

// ---------------------------------------------------------------------------
// Internal: tokenization
// ---------------------------------------------------------------------------

/** Extract a normalized token set from candidate summary fields. */
function tokenizeCandidate(candidate: DistilledKnowledgeCandidate): Set<string> {
  const pieces: string[] = [
    candidate.title,
    candidate.applicability,
    candidate.actionPattern,
    candidate.solvedLoop.problem,
    candidate.solvedLoop.action,
    candidate.solvedLoop.verification,
    ...candidate.boundaries,
    ...candidate.risks,
  ];
  return tokenizeText(pieces.join(' '));
}

/** Extract a normalized token set from a registry entry.
 *
 * The registry entry's `capabilityId` is intentionally excluded from the text
 * overlap signal: an exact `capabilityId` match already produces the maximum
 * score, and the shared `cap-` prefix would otherwise create false overlap
 * across unrelated capabilities.
 */
function tokenizeRegistryEntry(entry: CapabilityRegistryEntry): Set<string> {
  return tokenizeText(entry.routingDescription);
}

// Domain boilerplate and common stop words that appear in nearly every
// capability summary and would otherwise create false recall overlap.
const STOP_WORDS = new Set<string>([
  // Common English stop words
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from',
  'as', 'it', 'its', 'this', 'that', 'these', 'those', 'then', 'than', 'so',
  'if', 'when', 'where', 'which', 'who', 'what', 'how', 'why', 'can', 'could',
  'will', 'would', 'should', 'may', 'might', 'must', 'shall', 'do', 'does',
  'did', 'done', 'doing', 'have', 'has', 'had', 'having', 'use', 'used',
  'using', 'make', 'made', 'making', 'get', 'got', 'apply', 'applies', 'only',
  'not', 'no', 'yes', 'one', 'all', 'any', 'some', 'more', 'most', 'other',
  'such', 'each', 'every', 'both', 'few', 'many', 'much', 'very', 'just',
  'also', 'too', 'so', 'up', 'out', 'over', 'under', 'again', 'further',
  // Domain boilerplate repeated across most capability summaries
  'distilled', 'capability', 'capabilities', 'solved', 'loop', 'problem',
  'action', 'pattern', 'verification', 'candidate', 'source', 'review',
  'promote', 'append', 'supersede', 'snapshot', 'active',
]);

/**
 * Tokenize text into lowercase alphanumeric tokens.
 *
 * Deterministic: no stemming, no model calls. A small stop-word list removes
 * domain boilerplate that would otherwise create false recall overlap.
 */
export function tokenizeText(text: string): Set<string> {
  const normalized = (text || '').toLowerCase();
  const tokens = new Set<string>();
  for (const match of normalized.match(/[a-z0-9]+/g) ?? []) {
    if (match.length > 1 && !STOP_WORDS.has(match)) {
      tokens.add(match);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Internal: evidence source overlap
// ---------------------------------------------------------------------------

function candidateEvidenceSourcePaths(candidate: DistilledKnowledgeCandidate): Set<string> {
  const paths = new Set<string>();
  for (const ref of candidate.provenance) {
    if (ref.filePath) paths.add(ref.filePath);
  }
  return paths;
}

function entryEvidenceSourcePaths(entry: CapabilityRegistryEntry): Set<string> {
  const paths = new Set<string>();
  for (const ref of entry.evidenceRefs) {
    if (ref.sourceFilePath) paths.add(ref.sourceFilePath);
  }
  return paths;
}

function hasIntersection(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

function countIntersection(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const value of a) {
    if (b.has(value)) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Internal: result construction
// ---------------------------------------------------------------------------

function buildMatch(entry: CapabilityRegistryEntry, score: number): CapabilityPrefilterMatch {
  return {
    capabilityId: entry.capabilityId,
    activeSnapshotId: entry.activeSnapshotId,
    status: entry.status,
    routingDescription: entry.routingDescription,
    score,
    evidenceCount: entry.evidenceRefs.length,
    relatedSnapshotCount: entry.relatedSnapshotIds.length,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Internal: option normalization
// ---------------------------------------------------------------------------

function normalizeLimit(limit: unknown): number {
  const value = typeof limit === 'number' ? limit : 5;
  if (!Number.isFinite(value) || value < 1) return 5;
  return Math.floor(value);
}

function normalizeMinScore(minScore: unknown): number {
  const value = typeof minScore === 'number' ? minScore : 1;
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(100, Math.floor(value)));
}
