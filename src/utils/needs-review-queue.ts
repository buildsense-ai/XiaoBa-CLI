import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  CapabilityProvenanceRef,
  DistilledKnowledgeCandidate,
} from './capability-distiller';
import {
  CapabilityRegistryEntry,
  CapabilityRegistryState,
  getCapability,
} from './capability-registry';
import { PromotionPacket, PromotionReviewResult } from './promotion-reviewer';

/**
 * Needs Review Queue (issue #19).
 *
 * A durable agent-review queue for promotion packets that cannot be safely
 * auto-promoted, appended, superseded, or rejected by the current reviewer
 * pass. This is **not** a human approval workflow. Entries preserve the
 * candidate, related capability refs, reviewer rationale, reviewer questions,
 * source refs, reviewer version, evidence fingerprint, registry-state
 * fingerprint, status, and retry eligibility metadata.
 *
 * Entries become eligible for retry only when:
 *  - the evidence fingerprint changes (new evidence arrived),
 *  - the reviewer version changes (reviewer capability improved),
 *  - the relevant registry-state fingerprint changes (capabilities evolved), or
 *  - an explicit runtime command requests retry.
 *
 * The queue is persisted atomically (temp file + rename) and recovers safely
 * from corrupt state by quarantining the corrupt file, following the same
 * conventions as the Capability Registry.
 *
 * See docs/prd/runtime-capability-registry-v2.md.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Schema version for forward compatibility. */
export const NEEDS_REVIEW_QUEUE_SCHEMA_VERSION = 1 as const;

/** Lifecycle status of a queue entry. */
export type NeedsReviewQueueStatus =
  | 'pending'
  | 'retry_eligible'
  | 'resolved'
  | 'dropped';

const VALID_QUEUE_STATUSES = new Set<NeedsReviewQueueStatus>([
  'pending',
  'retry_eligible',
  'resolved',
  'dropped',
]);

/**
 * A source ref identifies a provenance record that the reviewer used when it
 * produced the `needs_review` decision. It is a subset of
 * `CapabilityProvenanceRef` kept stable for queue storage.
 */
export interface NeedsReviewSourceRef {
  /** Session log file path that holds the source turn. */
  filePath: string;
  /** Turn number within the source session log file. */
  turn: number;
  /** Role this source turn plays in the solved loop. */
  role: 'problem-action' | 'verification';
  /** Byte range of the source distillation unit. */
  unitByteRange: { start: number; end: number };
}

/**
 * Retry-eligibility metadata for a queue entry.
 *
 * An entry tracks the last set of fingerprints / reviewer version it was
 * checked against, plus when it last became eligible, so retry gating is
 * deterministic and auditable.
 */
export interface RetryEligibility {
  /** Whether the entry is currently eligible for retry. */
  eligible: boolean;
  /** Human-readable reason for the current eligibility state. */
  reason: string;
  /** ISO timestamp of the last eligibility check. */
  lastCheckedAt: string;
  /** ISO timestamp of the last time the entry became eligible, if ever. */
  lastEligibleAt?: string;
}

/**
 * A durable Needs Review Queue entry.
 */
export interface NeedsReviewQueueEntry {
  /** Stable queue entry identity. */
  entryId: string;
  /** Capability identity echoed from the candidate. */
  capabilityId: string;
  /** Full candidate payload that was held for review. */
  candidatePayload: DistilledKnowledgeCandidate;
  /** Capability IDs from the Capability Prefilter that appeared relevant. */
  matchedCapabilityIds: string[];
  /** Reviewer rationale for the `needs_review` decision. */
  rationale: string;
  /** Reviewer questions describing what evidence or context is missing. */
  questions: string[];
  /** Source refs used by the reviewer. */
  sourceRefs: NeedsReviewSourceRef[];
  /** Reviewer version that produced this decision. */
  reviewerVersion: string;
  /** Stable fingerprint of the evidence that produced this decision. */
  evidenceFingerprint: string;
  /** Stable fingerprint of the relevant registry state at decision time. */
  registryStateFingerprint: string;
  /** Lifecycle status of the queue entry. */
  status: NeedsReviewQueueStatus;
  /** Retry eligibility metadata. */
  retryEligibility: RetryEligibility;
  /** ISO timestamp of entry creation. */
  createdAt: string;
  /** ISO timestamp of the last queue update. */
  updatedAt: string;
}

/**
 * The durable Needs Review Queue state file payload.
 */
export interface NeedsReviewQueueState {
  schemaVersion: typeof NEEDS_REVIEW_QUEUE_SCHEMA_VERSION;
  /** Map of entryId → queue entry. */
  entries: Record<string, NeedsReviewQueueEntry>;
  /** Set when the state file was corrupt and quarantined on load. */
  stateCorrupt?: boolean;
}

/** Input for creating a new queue entry from a review outcome. */
export interface AddNeedsReviewEntryInput {
  /** The reviewed promotion packet. */
  packet: PromotionPacket;
  /** The reviewer's `needs_review` result. */
  review: PromotionReviewResult;
  /** Capability IDs returned by the Capability Prefilter for this candidate. */
  matchedCapabilityIds: string[];
  /** The registry state used to compute the registry-state fingerprint. */
  registry: CapabilityRegistryState;
  /** Reviewer version string. */
  reviewerVersion: string;
  /** Explicit questions from the reviewer (falls back to sensible defaults). */
  questions?: string[];
  /** ISO timestamp of entry creation. */
  createdAt: string;
}

/** Options for re-evaluating retry eligibility. */
export interface ReevaluateEligibilityInput {
  /** The current evidence fingerprint to compare against. */
  evidenceFingerprint: string;
  /** The current registry-state fingerprint to compare against. */
  registryStateFingerprint: string;
  /** The current reviewer version to compare against. */
  reviewerVersion: string;
  /** ISO timestamp of the check. */
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Public: empty / load / save
// ---------------------------------------------------------------------------

/** Return a fresh empty queue state. */
export function emptyNeedsReviewQueueState(): NeedsReviewQueueState {
  return {
    schemaVersion: NEEDS_REVIEW_QUEUE_SCHEMA_VERSION,
    entries: {},
  };
}

/**
 * Load the Needs Review Queue state file from a runtime data root.
 *
 * When the state file does not exist, returns an empty queue. When the state
 * file is corrupt (unparseable JSON), the corrupt file is quarantined
 * (renamed to `<path>.corrupt.<timestamp>`) and an empty queue with
 * `stateCorrupt: true` is returned — installed snapshots and audit logs are
 * never touched.
 */
export function loadNeedsReviewQueue(queueFilePath: string): NeedsReviewQueueState {
  if (!fs.existsSync(queueFilePath)) {
    return emptyNeedsReviewQueueState();
  }

  const raw = fs.readFileSync(queueFilePath, 'utf-8');
  try {
    const parsed = JSON.parse(raw) as Partial<NeedsReviewQueueState>;
    if (
      !isRecord(parsed)
      || parsed.schemaVersion !== NEEDS_REVIEW_QUEUE_SCHEMA_VERSION
      || !isRecord(parsed.entries)
    ) {
      throw new Error('Needs Review Queue state has an invalid structure.');
    }
    return {
      schemaVersion: NEEDS_REVIEW_QUEUE_SCHEMA_VERSION,
      entries: sanitizeEntries(parsed.entries),
    };
  } catch {
    quarantineCorruptState(queueFilePath);
    return { ...emptyNeedsReviewQueueState(), stateCorrupt: true };
  }
}

/**
 * Atomically persist the Needs Review Queue state file.
 *
 * Uses a temp file + `renameSync` so an interruption never leaves a partial
 * JSON state. The temp file is cleaned up on failure.
 */
export function saveNeedsReviewQueue(
  queueFilePath: string,
  state: NeedsReviewQueueState,
): void {
  fs.mkdirSync(path.dirname(queueFilePath), { recursive: true });
  const payload: NeedsReviewQueueState = {
    schemaVersion: NEEDS_REVIEW_QUEUE_SCHEMA_VERSION,
    entries: state.entries || {},
  };
  const tmpPath = `${queueFilePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(tmpPath, queueFilePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only; preserve the original error.
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Public: add entry transition
// ---------------------------------------------------------------------------

/**
 * `needs_review` transition: create a durable queue entry without mutating
 * the Capability Registry.
 *
 * Computes evidence and registry-state fingerprints from the supplied packet
 * and registry, records the reviewer rationale, questions, source refs,
 * reviewer version, status, timestamps, and initial retry eligibility.
 *
 * Throws if the review decision is not `needs_review`.
 */
export function addNeedsReviewEntry(
  state: NeedsReviewQueueState,
  input: AddNeedsReviewEntryInput,
): NeedsReviewQueueEntry {
  if (input.review.decision !== 'needs_review') {
    throw new Error(
      `Cannot enqueue review decision "${input.review.decision}" in the needs-review queue: only "needs_review" decisions are allowed.`,
    );
  }

  assertNonEmpty(input.review.capabilityId, 'capabilityId');
  assertNonEmpty(input.reviewerVersion, 'reviewerVersion');

  const capabilityId = input.review.capabilityId;
  const evidenceFingerprint = computeEvidenceFingerprint(input.packet);
  const registryStateFingerprint = computeRegistryStateFingerprint(
    input.registry,
    input.matchedCapabilityIds,
  );

  const entryId = buildEntryId(
    capabilityId,
    evidenceFingerprint,
    registryStateFingerprint,
    input.reviewerVersion,
  );
  const questions = normalizeQuestions(input.questions ?? input.review.questions ?? []);
  const sourceRefs = normalizeSourceRefs(input.packet.provenance);

  const entry: NeedsReviewQueueEntry = {
    entryId,
    capabilityId,
    candidatePayload: input.packet.candidate,
    matchedCapabilityIds: dedupeStrings(input.matchedCapabilityIds),
    rationale: input.review.rationale,
    questions,
    sourceRefs,
    reviewerVersion: input.reviewerVersion,
    evidenceFingerprint,
    registryStateFingerprint,
    status: 'pending',
    retryEligibility: {
      eligible: false,
      reason:
        'Newly queued entry: awaiting evidence, reviewer, or registry change before retry.',
      lastCheckedAt: input.createdAt,
    },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };

  state.entries[entryId] = entry;
  return entry;
}

// ---------------------------------------------------------------------------
// Public: retry eligibility
// ---------------------------------------------------------------------------

/**
 * Re-evaluate a single queue entry's retry eligibility.
 *
 * An entry is not eligible when its stored reviewer version, evidence
 * fingerprint, and registry-state fingerprint all match the current values.
 * It becomes eligible when any of those three fingerprints changes.
 *
 * Resolved or dropped entries are never made eligible.
 */
export function reevaluateRetryEligibility(
  state: NeedsReviewQueueState,
  entryId: string,
  input: ReevaluateEligibilityInput,
): NeedsReviewQueueEntry {
  const entry = state.entries[entryId];
  if (!entry) {
    throw new Error(
      `Cannot reevaluate retry eligibility for entry "${entryId}": no such queue entry.`,
    );
  }

  if (entry.status === 'resolved' || entry.status === 'dropped') {
    entry.retryEligibility = {
      eligible: false,
      reason: `Entry status is "${entry.status}" and will not be retried.`,
      lastCheckedAt: input.checkedAt,
    };
    entry.updatedAt = input.checkedAt;
    return entry;
  }

  const unchanged =
    entry.reviewerVersion === input.reviewerVersion &&
    entry.evidenceFingerprint === input.evidenceFingerprint &&
    entry.registryStateFingerprint === input.registryStateFingerprint;

  if (unchanged) {
    entry.retryEligibility = {
      eligible: false,
      reason:
        'Reviewer version, evidence fingerprint, and registry-state fingerprint are unchanged.',
      lastCheckedAt: input.checkedAt,
    };
  } else {
    const changed: string[] = [];
    if (entry.reviewerVersion !== input.reviewerVersion) changed.push('reviewer version');
    if (entry.evidenceFingerprint !== input.evidenceFingerprint) changed.push('evidence fingerprint');
    if (entry.registryStateFingerprint !== input.registryStateFingerprint) {
      changed.push('registry-state fingerprint');
    }

    entry.retryEligibility = {
      eligible: true,
      reason: `Retry eligible because ${changed.join(', ')} changed.`,
      lastCheckedAt: input.checkedAt,
      lastEligibleAt: input.checkedAt,
    };
    entry.status = 'retry_eligible';
  }

  entry.updatedAt = input.checkedAt;
  return entry;
}

/**
 * Re-evaluate every queue entry whose status allows retry.
 */
export function reevaluateAllRetryEligibility(
  state: NeedsReviewQueueState,
  input: ReevaluateEligibilityInput,
): NeedsReviewQueueEntry[] {
  return Object.keys(state.entries).map(entryId =>
    reevaluateRetryEligibility(state, entryId, input),
  );
}

/**
 * Mark a queue entry as eligible for retry explicitly (e.g., via a runtime
 * command). This does not recompute fingerprints; it is an explicit gate.
 */
export function markRetryEligible(
  state: NeedsReviewQueueState,
  entryId: string,
  reason: string,
  updatedAt: string,
): NeedsReviewQueueEntry {
  const entry = state.entries[entryId];
  if (!entry) {
    throw new Error(
      `Cannot mark entry "${entryId}" as retry eligible: no such queue entry.`,
    );
  }

  if (entry.status === 'resolved' || entry.status === 'dropped') {
    throw new Error(
      `Cannot mark entry "${entryId}" as retry eligible: status is "${entry.status}".`,
    );
  }

  entry.status = 'retry_eligible';
  entry.retryEligibility = {
    eligible: true,
    reason,
    lastCheckedAt: updatedAt,
    lastEligibleAt: updatedAt,
  };
  entry.updatedAt = updatedAt;
  return entry;
}

/**
 * Mark a queue entry as resolved. Resolved entries are no longer retried.
 */
export function markResolved(
  state: NeedsReviewQueueState,
  entryId: string,
  resolvedAt: string,
): NeedsReviewQueueEntry {
  const entry = state.entries[entryId];
  if (!entry) {
    throw new Error(`Cannot mark entry "${entryId}" as resolved: no such queue entry.`);
  }

  const previousEligibility = entry.retryEligibility;
  entry.status = 'resolved';
  entry.retryEligibility = {
    eligible: false,
    reason: previousEligibility.reason
      ? `Entry was resolved and removed from retry pool. Last eligibility trigger: ${previousEligibility.reason}`
      : 'Entry was resolved and removed from retry pool.',
    lastCheckedAt: resolvedAt,
    lastEligibleAt: previousEligibility.lastEligibleAt,
  };
  entry.updatedAt = resolvedAt;
  return entry;
}

/**
 * Mark a queue entry as dropped. Dropped entries are no longer retried.
 */
export function markDropped(
  state: NeedsReviewQueueState,
  entryId: string,
  droppedAt: string,
  reason?: string,
): NeedsReviewQueueEntry {
  const entry = state.entries[entryId];
  if (!entry) {
    throw new Error(`Cannot mark entry "${entryId}" as dropped: no such queue entry.`);
  }

  entry.status = 'dropped';
  entry.retryEligibility = {
    eligible: false,
    reason: reason ?? 'Entry was dropped and removed from retry pool.',
    lastCheckedAt: droppedAt,
  };
  entry.updatedAt = droppedAt;
  return entry;
}

// ---------------------------------------------------------------------------
// Public: matching-evidence refresh + renewed needs_review
// ---------------------------------------------------------------------------

/**
 * Find a pending or retry-eligible queue entry whose candidate carries the
 * given capability identity. Returns the most recently updated matching entry,
 * or `undefined` when none exists. Resolved/dropped entries are ignored so a
 * later occurrence of the same capability can be queued fresh.
 */
export function findPendingEntryByCapabilityId(
  state: NeedsReviewQueueState,
  capabilityId: string,
): NeedsReviewQueueEntry | undefined {
  const candidates = Object.values(state.entries).filter(
    e =>
      e.capabilityId === capabilityId &&
      (e.status === 'pending' || e.status === 'retry_eligible'),
  );
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt, 'en'));
  return candidates[0];
}

/**
 * Find a pending or retry-eligible queue entry that matches a newly distilled
 * candidate. Matching prefers exact capabilityId, then falls back to a
 * normalized title + solved-loop problem comparison so repeated occurrences of
 * the same solved loop can refresh one durable queue entry even when the
 * distiller emits per-occurrence capability identities.
 */
export function findPendingEntryForCandidate(
  state: NeedsReviewQueueState,
  candidate: DistilledKnowledgeCandidate,
): NeedsReviewQueueEntry | undefined {
  const exact = findPendingEntryByCapabilityId(state, candidate.capabilityId);
  if (exact) return exact;

  const normalizedTitle = normalizeMatcherText(candidate.title);
  const normalizedProblem = normalizeMatcherText(candidate.solvedLoop.problem);
  const candidates = Object.values(state.entries).filter(e => {
    if (e.status !== 'pending' && e.status !== 'retry_eligible') return false;
    return (
      normalizeMatcherText(e.candidatePayload.title) === normalizedTitle &&
      normalizeMatcherText(e.candidatePayload.solvedLoop.problem) === normalizedProblem
    );
  });
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt, 'en'));
  return candidates[0];
}

/** Input for refreshing a queued entry with newly distilled matching evidence. */
export interface RefreshQueueEntryInput {
  /** The newly distilled candidate that matches the queued capability. */
  newCandidate: DistilledKnowledgeCandidate;
  /** Human-readable reason for the eligibility state (e.g. new evidence). */
  reason: string;
  /** ISO timestamp of the refresh. */
  updatedAt: string;
}

/**
 * Refresh a pending/retry-eligible queue entry with newly distilled matching
 * evidence (issue #29).
 *
 * The new candidate's solved-loop evidence and provenance refs are merged into
 * the queued candidate payload, the evidence fingerprint is recomputed so the
 * change is detectable, all durable source references are refreshed, and the
 * entry is marked retry-eligible with the supplied reason. The previous review
 * rationale/questions remain in place until the eligible entry is re-reviewed
 * during the heartbeat. The registry-state fingerprint and reviewer version
 * are likewise re-evaluated when the heartbeat consumes eligible entries.
 *
 * Throws when the entry does not exist or is already resolved/dropped.
 */
export function refreshQueueEntryWithMatchingEvidence(
  state: NeedsReviewQueueState,
  entryId: string,
  input: RefreshQueueEntryInput,
): NeedsReviewQueueEntry {
  const entry = state.entries[entryId];
  if (!entry) {
    throw new Error(
      `Cannot refresh entry "${entryId}": no such queue entry.`,
    );
  }
  if (entry.status === 'resolved' || entry.status === 'dropped') {
    throw new Error(
      `Cannot refresh entry "${entryId}": status is "${entry.status}".`,
    );
  }

  const mergedProvenance = dedupeProvenanceRefs([
    ...entry.candidatePayload.provenance,
    ...input.newCandidate.provenance,
  ]);
  const mergedCandidate: DistilledKnowledgeCandidate = {
    ...entry.candidatePayload,
    solvedLoop: input.newCandidate.solvedLoop,
    provenance: mergedProvenance,
  };

  entry.candidatePayload = mergedCandidate;
  entry.sourceRefs = normalizeSourceRefs(mergedProvenance);
  entry.evidenceFingerprint = computeEvidenceFingerprintFromCandidate(mergedCandidate);
  entry.status = 'retry_eligible';
  entry.retryEligibility = {
    eligible: true,
    reason: input.reason,
    lastCheckedAt: input.updatedAt,
    lastEligibleAt: input.updatedAt,
  };
  entry.updatedAt = input.updatedAt;
  return entry;
}

/** Input for renewing a queue entry after a re-review returned `needs_review`. */
export interface RenewNeedsReviewEntryInput {
  /** The reviewer's renewed `needs_review` result. */
  review: PromotionReviewResult;
  /** Current reviewer version to pin so an unchanged version won't re-trigger. */
  reviewerVersion: string;
  /** Current relevant registry-state fingerprint to pin. */
  registryStateFingerprint: string;
  /** ISO timestamp of the renewal. */
  updatedAt: string;
}

/**
 * Renew a queue entry after a re-review returned `needs_review` again (issue #29).
 *
 * The rationale/questions are updated from the renewed review, and the stored
 * reviewer version and registry-state fingerprint are pinned to the current
 * values so the entry is not retried again until another meaningful change
 * arrives. The evidence fingerprint is left unchanged (no new evidence was
 * supplied by a re-review). The entry returns to `pending`.
 *
 * Throws when the entry does not exist or is already resolved/dropped.
 */
export function renewNeedsReviewEntry(
  state: NeedsReviewQueueState,
  entryId: string,
  input: RenewNeedsReviewEntryInput,
): NeedsReviewQueueEntry {
  const entry = state.entries[entryId];
  if (!entry) {
    throw new Error(
      `Cannot renew entry "${entryId}": no such queue entry.`,
    );
  }
  if (entry.status === 'resolved' || entry.status === 'dropped') {
    throw new Error(
      `Cannot renew entry "${entryId}": status is "${entry.status}".`,
    );
  }

  const previousEligibility = entry.retryEligibility;
  entry.rationale = input.review.rationale;
  entry.questions = normalizeQuestions(input.review.questions ?? entry.questions);
  entry.reviewerVersion = input.reviewerVersion;
  entry.registryStateFingerprint = input.registryStateFingerprint;
  entry.status = 'pending';
  entry.retryEligibility = {
    eligible: false,
    reason: previousEligibility.reason
      ? `Renewed needs_review after re-review; awaiting next meaningful change before retry. Last eligibility trigger: ${previousEligibility.reason}`
      : 'Renewed needs_review after re-review; awaiting next meaningful change before retry.',
    lastCheckedAt: input.updatedAt,
    lastEligibleAt: previousEligibility.lastEligibleAt,
  };
  entry.updatedAt = input.updatedAt;
  return entry;
}

// ---------------------------------------------------------------------------
// Public: fingerprint computation
// ---------------------------------------------------------------------------

/**
 * Compute a stable fingerprint of the evidence that produced a `needs_review`
 * decision. The fingerprint covers the candidate's solved-loop evidence,
 * provenance refs, and source-unit identity so that any material evidence
 * change produces a new fingerprint.
 */
export function computeEvidenceFingerprint(packet: PromotionPacket): string {
  const candidate = packet.candidate;
  const fingerprintable = {
    capabilityId: candidate.capabilityId,
    solvedLoop: packet.solvedLoopEvidence,
    provenance: packet.provenance,
    sourceUnit: candidate.sourceUnit,
  };
  return sha256Hex(JSON.stringify(fingerprintable));
}

/**
 * Compute a stable evidence fingerprint directly from a candidate payload.
 * Used when refreshing a queued entry with merged evidence without rebuilding
 * a full Promotion Packet. The fingerprint covers the same fields as
 * {@link computeEvidenceFingerprint} so refresh fingerprints are comparable.
 */
export function computeEvidenceFingerprintFromCandidate(
  candidate: DistilledKnowledgeCandidate,
): string {
  const fingerprintable = {
    capabilityId: candidate.capabilityId,
    solvedLoop: candidate.solvedLoop,
    provenance: candidate.provenance,
    sourceUnit: candidate.sourceUnit,
  };
  return sha256Hex(JSON.stringify(fingerprintable));
}

/**
 * Compute a stable fingerprint of the relevant registry state for a set of
 * matched capability IDs. The fingerprint covers the active snapshot ID,
 * status, routing description, and evidence ref count of each matched entry in
 * deterministic order. If a matched capability is absent from the registry it
 * is represented as `null` so the fingerprint changes when the capability
 * later appears.
 */
export function computeRegistryStateFingerprint(
  registry: CapabilityRegistryState,
  capabilityIds: string[],
): string {
  const sortedIds = dedupeStrings([...capabilityIds]).sort();
  const fingerprintable = sortedIds.map(id => {
    const entry = getCapability(registry, id);
    if (!entry) return { capabilityId: id, present: false };
    return {
      capabilityId: entry.capabilityId,
      activeSnapshotId: entry.activeSnapshotId,
      status: entry.status,
      routingDescription: entry.routingDescription,
      evidenceRefCount: entry.evidenceRefs.length,
      relatedSnapshotCount: entry.relatedSnapshotIds.length,
      updatedAt: entry.updatedAt,
    };
  });
  return sha256Hex(JSON.stringify(fingerprintable));
}

// ---------------------------------------------------------------------------
// Public: lookup helpers
// ---------------------------------------------------------------------------

/** Return a queue entry by entryId, or `undefined`. */
export function getQueueEntry(
  state: NeedsReviewQueueState,
  entryId: string,
): NeedsReviewQueueEntry | undefined {
  return state.entries[entryId];
}

/** Return all queue entries in insertion order by entryId. */
export function listQueueEntries(state: NeedsReviewQueueState): NeedsReviewQueueEntry[] {
  return Object.values(state.entries).sort((a, b) => a.entryId.localeCompare(b.entryId, 'en'));
}

/** Return all entries currently eligible for retry. */
export function listRetryEligibleEntries(
  state: NeedsReviewQueueState,
): NeedsReviewQueueEntry[] {
  return listQueueEntries(state).filter(
    e => e.status === 'retry_eligible' && e.retryEligibility.eligible,
  );
}

// ---------------------------------------------------------------------------
// Internal: validation + sanitization
// ---------------------------------------------------------------------------

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (!isNonEmptyString(value)) {
    throw new Error(`Needs Review Queue: ${label} must be a non-empty string.`);
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function buildEntryId(
  capabilityId: string,
  evidenceFingerprint: string,
  registryStateFingerprint: string,
  reviewerVersion: string,
): string {
  const raw = [
    capabilityId,
    evidenceFingerprint,
    registryStateFingerprint,
    reviewerVersion,
  ].join('|');
  return `${capabilityId}:${sha256Hex(raw).slice(0, 16)}`;
}

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeSourceRefs(
  refs: CapabilityProvenanceRef[],
): NeedsReviewSourceRef[] {
  return dedupeSourceRefs(
    refs
      .filter(
        r =>
          r &&
          isNonEmptyString(r.filePath) &&
          typeof r.turn === 'number' &&
          r.unitByteRange &&
          typeof r.unitByteRange.start === 'number' &&
          typeof r.unitByteRange.end === 'number',
      )
      .map(r => ({
        filePath: r.filePath,
        turn: r.turn,
        role: r.role === 'verification' ? ('verification' as const) : ('problem-action' as const),
        unitByteRange: {
          start: r.unitByteRange.start,
          end: r.unitByteRange.end,
        },
      })),
  );
}

function dedupeSourceRefs(refs: NeedsReviewSourceRef[]): NeedsReviewSourceRef[] {
  const seen = new Set<string>();
  const result: NeedsReviewSourceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.filePath}|${ref.turn}|${ref.role}|${ref.unitByteRange.start}|${ref.unitByteRange.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function normalizeQuestions(questions: string[]): string[] {
  return dedupeStrings(questions.map(q => (q || '').trim()).filter(Boolean));
}

function normalizeMatcherText(value: string): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function sanitizeEntries(
  raw: unknown,
): Record<string, NeedsReviewQueueEntry> {
  if (!raw || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  const result: Record<string, NeedsReviewQueueEntry> = {};
  for (const key of Object.keys(source)) {
    const entry = source[key];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Partial<NeedsReviewQueueEntry>;
    if (!isNonEmptyString(e.entryId) || !isNonEmptyString(e.capabilityId)) continue;
    result[e.entryId] = {
      entryId: e.entryId,
      capabilityId: e.capabilityId,
      candidatePayload: sanitizeCandidatePayload(e.candidatePayload),
      matchedCapabilityIds: sanitizeStringList(e.matchedCapabilityIds),
      rationale: isString(e.rationale) ? e.rationale : '',
      questions: sanitizeStringList(e.questions),
      sourceRefs: sanitizeSourceRefs(e.sourceRefs),
      reviewerVersion: isString(e.reviewerVersion) ? e.reviewerVersion : '',
      evidenceFingerprint: isString(e.evidenceFingerprint) ? e.evidenceFingerprint : '',
      registryStateFingerprint: isString(e.registryStateFingerprint)
        ? e.registryStateFingerprint
        : '',
      status: sanitizeStatus(e.status),
      retryEligibility: sanitizeRetryEligibility(e.retryEligibility),
      createdAt: isString(e.createdAt) ? e.createdAt : '',
      updatedAt: isString(e.updatedAt) ? e.updatedAt : '',
    };
  }
  return result;
}

function sanitizeStatus(value: unknown): NeedsReviewQueueStatus {
  return isString(value) && VALID_QUEUE_STATUSES.has(value as NeedsReviewQueueStatus)
    ? (value as NeedsReviewQueueStatus)
    : 'pending';
}

function sanitizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return dedupeStrings(raw.filter(isString));
}

function sanitizeSourceRefs(raw: unknown): NeedsReviewSourceRef[] {
  if (!Array.isArray(raw)) return [];
  const refs: NeedsReviewSourceRef[] = [];
  for (const ref of raw) {
    if (!ref || typeof ref !== 'object') continue;
    const candidate = ref as Partial<NeedsReviewSourceRef>;
    if (
      !isNonEmptyString(candidate.filePath) ||
      typeof candidate.turn !== 'number' ||
      !candidate.unitByteRange ||
      typeof candidate.unitByteRange.start !== 'number' ||
      typeof candidate.unitByteRange.end !== 'number'
    ) {
      continue;
    }
    refs.push({
      filePath: candidate.filePath,
      turn: candidate.turn,
      role: candidate.role === 'verification' ? 'verification' : 'problem-action',
      unitByteRange: {
        start: candidate.unitByteRange.start,
        end: candidate.unitByteRange.end,
      },
    });
  }
  return dedupeSourceRefs(refs);
}

function sanitizeRetryEligibility(
  raw: unknown,
): RetryEligibility {
  if (!raw || typeof raw !== 'object') {
    return {
      eligible: false,
      reason: 'Sanitized: missing retry eligibility metadata.',
      lastCheckedAt: '',
    };
  }
  const el = raw as Partial<RetryEligibility>;
  return {
    eligible: el.eligible === true,
    reason: isString(el.reason) ? el.reason : '',
    lastCheckedAt: isString(el.lastCheckedAt) ? el.lastCheckedAt : '',
    lastEligibleAt: isString(el.lastEligibleAt) ? el.lastEligibleAt : undefined,
  };
}

function sanitizeCandidatePayload(
  raw: unknown,
): DistilledKnowledgeCandidate {
  if (!raw || typeof raw !== 'object') {
    return buildPlaceholderCandidate('unknown-capability');
  }
  const c = raw as Partial<DistilledKnowledgeCandidate>;
  const capabilityId = isNonEmptyString(c.capabilityId) ? c.capabilityId : 'unknown-capability';
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId,
    title: isString(c.title) ? c.title : '',
    applicability: isString(c.applicability) ? c.applicability : '',
    actionPattern: isString(c.actionPattern) ? c.actionPattern : '',
    boundaries: sanitizeStringList(c.boundaries),
    risks: sanitizeStringList(c.risks),
    solvedLoop: sanitizeSolvedLoop(c.solvedLoop),
    provenance: sanitizeProvenance(c.provenance),
    generatedAt: isString(c.generatedAt) ? c.generatedAt : '',
    sourceUnit: sanitizeSourceUnit(c.sourceUnit),
  };
}

function sanitizeSolvedLoop(
  raw: unknown,
): DistilledKnowledgeCandidate['solvedLoop'] {
  if (!raw || typeof raw !== 'object') {
    return { problem: '', action: '', verification: '', noCorrection: '' };
  }
  const sl = raw as Partial<DistilledKnowledgeCandidate['solvedLoop']>;
  return {
    problem: isString(sl.problem) ? sl.problem : '',
    action: isString(sl.action) ? sl.action : '',
    verification: isString(sl.verification) ? sl.verification : '',
    noCorrection: isString(sl.noCorrection) ? sl.noCorrection : '',
  };
}

function sanitizeProvenance(
  raw: unknown,
): CapabilityProvenanceRef[] {
  if (!Array.isArray(raw)) return [];
  const refs: CapabilityProvenanceRef[] = [];
  for (const ref of raw) {
    if (!ref || typeof ref !== 'object') continue;
    const candidate = ref as Partial<CapabilityProvenanceRef>;
    if (
      !isNonEmptyString(candidate.filePath) ||
      typeof candidate.turn !== 'number' ||
      !candidate.unitByteRange ||
      typeof candidate.unitByteRange.start !== 'number' ||
      typeof candidate.unitByteRange.end !== 'number'
    ) {
      continue;
    }
    refs.push({
      filePath: candidate.filePath,
      turn: candidate.turn,
      role: candidate.role === 'verification' ? 'verification' : 'problem-action',
      unitByteRange: {
        start: candidate.unitByteRange.start,
        end: candidate.unitByteRange.end,
      },
    });
  }
  return dedupeProvenanceRefs(refs);
}

function dedupeProvenanceRefs(refs: CapabilityProvenanceRef[]): CapabilityProvenanceRef[] {
  const seen = new Set<string>();
  const result: CapabilityProvenanceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.filePath}|${ref.turn}|${ref.role}|${ref.unitByteRange.start}|${ref.unitByteRange.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function sanitizeSourceUnit(
  raw: unknown,
): DistilledKnowledgeCandidate['sourceUnit'] {
  if (!raw || typeof raw !== 'object') {
    return { filePath: '', byteRange: { start: 0, end: 0 }, generatedAt: '' };
  }
  const su = raw as Partial<DistilledKnowledgeCandidate['sourceUnit']>;
  return {
    filePath: isString(su.filePath) ? su.filePath : '',
    byteRange: su.byteRange &&
      typeof su.byteRange.start === 'number' &&
      typeof su.byteRange.end === 'number'
      ? { start: su.byteRange.start, end: su.byteRange.end }
      : { start: 0, end: 0 },
    generatedAt: isString(su.generatedAt) ? su.generatedAt : '',
  };
}

function buildPlaceholderCandidate(capabilityId: string): DistilledKnowledgeCandidate {
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId,
    title: '',
    applicability: '',
    actionPattern: '',
    boundaries: [],
    risks: [],
    solvedLoop: {
      problem: '',
      action: '',
      verification: '',
      noCorrection: '',
    },
    provenance: [],
    generatedAt: '',
    sourceUnit: {
      filePath: '',
      byteRange: { start: 0, end: 0 },
      generatedAt: '',
    },
  };
}

// ---------------------------------------------------------------------------
// Internal: corrupt-state quarantine
// ---------------------------------------------------------------------------

/**
 * Quarantine a corrupt state file by renaming it to
 * `<path>.corrupt.<timestamp>`. This preserves the corrupt file for inspection
 * while letting the next load start from a clean empty queue. It never touches
 * installed snapshots or audit logs.
 */
function quarantineCorruptState(queueFilePath: string): void {
  try {
    if (!fs.existsSync(queueFilePath)) return;
    const corruptPath = `${queueFilePath}.corrupt.${Date.now()}`;
    fs.renameSync(queueFilePath, corruptPath);
  } catch {
    // Best-effort quarantine only. If quarantine fails the next load will
    // re-attempt to parse and quarantine; an empty queue is still returned.
  }
}
