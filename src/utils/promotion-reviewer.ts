import {
  CapabilityProvenanceRef,
  DistilledKnowledgeCandidate,
  SolvedLoopEvidence,
} from './capability-distiller';

/**
 * Promotion Reviewer (issue #4).
 *
 * Reviews a Promotion Packet built from a capability candidate, solved-loop
 * evidence, risks, and provenance refs, and returns one of `promote`,
 * `needs_review`, or `reject` with review rationale.
 *
 * The reviewer may perform a **Faithful Rewrite** — editing structured fields
 * to improve wording or structure — but it must **not** add capability claims
 * that are not supported by the supplied provenance.
 *
 * The reviewer is deterministic only: no model calls, no file writes. Its
 * output is structured JSON and does **not** directly produce or write the
 * final `SKILL.md`. A later installer step (issue #5) will consume the
 * reviewer's output.
 *
 * See CONTEXT.md → "Promotion Packet", "Promotion Reviewer", "Faithful Rewrite",
 * "Solved Loop", "Capability Provenance", "Traceability Contract".
 * See docs/issues/heartbeat-log-distillation/04-promotion-reviewer.md.
 */

// ---------------------------------------------------------------------------
// Public schema
// ---------------------------------------------------------------------------

/**
 * Reviewer decision on a Promotion Packet.
 *
 * - `promote`     — the candidate is ready to be installed as a skill draft.
 * - `needs_review`— the candidate has potential but needs human or model
 *                   attention before installation.
 * - `reject`      — the candidate should not be installed.
 */
export type PromotionDecision =
  | 'promote'
  | 'needs_review'
  | 'reject'
  | 'new_capability'
  | 'append_evidence'
  | 'supersede_snapshot';

/**
 * Version identifier for the deterministic promotion reviewer. Bumps when
 * the review heuristics change materially, so needs-review retry gating can
 * detect that a stronger/changed reviewer should revisit queued entries.
 */
export const PROMOTION_REVIEWER_VERSION = 'promotion-reviewer-v1';

/**
 * Risks surfaced during review that are independent of the candidate's own
 * `risks` field. These are reviewer-observed risks.
 */
export interface ReviewerRisk {
  /** Short label for the risk. */
  label: string;
  /** Human-readable explanation. */
  detail: string;
}

/**
 * A Promotion Packet is the complete review bundle used to decide whether a
 * skill draft should become an installed skill.
 *
 * It bundles the candidate, solved-loop evidence, provenance refs, additional
 * risks, and a recommendation.
 */
export interface PromotionPacket {
  /** Schema version for forward compatibility. */
  schemaVersion: 1;
  /** The capability candidate under review. */
  candidate: DistilledKnowledgeCandidate;
  /** Solved-loop evidence carried forward from the candidate. */
  solvedLoopEvidence: SolvedLoopEvidence;
  /** Provenance refs carried forward from the candidate. */
  provenance: CapabilityProvenanceRef[];
  /** Reviewer-observed risks (separate from the candidate's own risks). */
  reviewRisks: ReviewerRisk[];
  /** Preliminary recommendation before the reviewer decides. */
  recommendation: 'promote' | 'needs_review' | 'reject';
}

export interface BuildPromotionPacketOptions {
  /** Solved-loop evidence supplied by the promotion branch, if different from the candidate copy. */
  solvedLoopEvidence?: SolvedLoopEvidence;
  /** Provenance refs supplied by the promotion branch, if different from the candidate copy. */
  provenance?: CapabilityProvenanceRef[];
  /** Reviewer-observed risks to carry into the packet. */
  reviewRisks?: ReviewerRisk[];
}

/**
 * Faithful Rewrite — improved structured fields that do not introduce new
 * capability claims beyond what the provenance supports.
 *
 * Every field is optional; the reviewer only populates fields it actually
 * rewrote. Fields left `undefined` mean "use the candidate's original value".
 */
export interface FaithfulRewrite {
  /** Rewritten title, or undefined when the original is kept. */
  title?: string;
  /** Rewritten applicability description, or undefined. */
  applicability?: string;
  /** Rewritten action pattern, or undefined. */
  actionPattern?: string;
  /** Rewritten boundaries list, or undefined. */
  boundaries?: string[];
  /** Rewritten risks list, or undefined. */
  risks?: string[];
}

/**
 * Structured output of the Promotion Reviewer.
 *
 * The output does **not** directly write the final `SKILL.md`. A later
 * installer step consumes this result.
 */
export interface PromotionReviewResult {
  /** Schema version for forward compatibility. */
  schemaVersion: 1;
  /** The capability identity under review (echoed from the candidate). */
  capabilityId: string;
  /** The final reviewer decision. */
  decision: PromotionDecision;
  /** Human-readable rationale for the decision. */
  rationale: string;
  /** Reviewer-observed risks (may be empty when none were found). */
  reviewRisks: ReviewerRisk[];
  /** Faithful rewrite of structured fields, or null when no rewrite was needed. */
  rewrite: FaithfulRewrite | null;
  /**
   * Reviewer questions describing what evidence or context is missing.
   * Populated mainly for `needs_review` decisions so a later retry pass
   * knows what to look for.
   */
  questions?: string[];
  /** ISO timestamp of the review. */
  reviewedAt: string;
}

// ---------------------------------------------------------------------------
// Heuristic constants
// ---------------------------------------------------------------------------

/** Maximum field lengths for faithful rewrite trimming. */
const MAX_TITLE_LEN = 100;
const MAX_APPLICABILITY_LEN = 200;
const MAX_ACTION_PATTERN_LEN = 200;
const MAX_BOUNDARY_LEN = 200;
const MAX_RISK_LEN = 200;
/** Maximum number of boundaries/risks to retain after rewrite. */
const MAX_BOUNDARIES = 6;
const MAX_RISKS = 6;

/**
 * Minimum number of provenance refs required for a `promote` decision.
 * A solved loop needs at least a problem-action ref and a verification ref.
 */
const MIN_PROVENANCE_REFS_FOR_PROMOTE = 2;

// ---------------------------------------------------------------------------
// Public: build a Promotion Packet
// ---------------------------------------------------------------------------

/**
 * Build a Promotion Packet from a capability candidate.
 *
 * The packet bundles the candidate, its solved-loop evidence, provenance
 * refs, reviewer-observed risks, and a preliminary recommendation. The
 * recommendation is derived from a quick pre-review of the candidate and can
 * be overridden by the full reviewer.
 *
 * @param candidate The distilled knowledge candidate to package.
 * @returns A structured Promotion Packet ready for review.
 */
export function buildPromotionPacket(
  candidate: DistilledKnowledgeCandidate,
  options: BuildPromotionPacketOptions = {},
): PromotionPacket {
  const solvedLoopEvidence = options.solvedLoopEvidence ?? candidate.solvedLoop;
  const provenance = options.provenance ?? candidate.provenance;
  const reviewRisks: ReviewerRisk[] = [...(options.reviewRisks ?? [])];
  const recommendation = preReviewRecommendation(
    solvedLoopEvidence,
    provenance,
    reviewRisks,
  );

  return {
    schemaVersion: 1,
    candidate,
    solvedLoopEvidence,
    provenance,
    reviewRisks,
    recommendation,
  };
}

// ---------------------------------------------------------------------------
// Public: review a Promotion Packet
// ---------------------------------------------------------------------------

/**
 * Review a Promotion Packet and return a structured decision.
 *
 * The reviewer is deterministic. It validates that the candidate's claims are
 * supported by the supplied provenance and solved-loop evidence, performs a
 * Faithful Rewrite where useful, and returns one of `promote`, `needs_review`,
 * or `reject` with rationale.
 *
 * Decision logic:
 *  - **reject**      — essential evidence is missing, provenance is empty or
 *                      malformed, or the solved loop is incomplete.
 *  - **needs_review** — core evidence exists but some claims are unsupported
 *                      or some fields are too sparse to trust.
 *  - **promote**      — all checks pass and the candidate is ready to become a
 *                      skill draft.
 *
 * @param packet The Promotion Packet to review.
 * @returns Structured review result (never writes SKILL.md).
 */
export function reviewPromotionPacket(packet: PromotionPacket): PromotionReviewResult {
  const risks: ReviewerRisk[] = [];
  const rewrite: FaithfulRewrite = {};

  const candidate = packet.candidate;
  const evidence = packet.solvedLoopEvidence;
  const provenance = packet.provenance;

  // ------------------------------------------------------------------
  // Check 1: Solved-loop evidence completeness
  // ------------------------------------------------------------------
  const evidenceGaps = checkSolvedLoopEvidence(evidence);
  if (evidenceGaps.length > 0) {
    return makeResult(
      candidate.capabilityId,
      'reject',
      `Solved-loop evidence is incomplete: ${evidenceGaps.join('; ')}.`,
      [...risks, ...packet.reviewRisks],
      hasRewrite(rewrite) ? rewrite : null,
    );
  }

  // ------------------------------------------------------------------
  // Check 2: Provenance validity
  // ------------------------------------------------------------------
  // Empty provenance is a hard reject — we cannot trust a candidate we
  // cannot trace.
  if (provenance.length === 0) {
    return makeResult(
      candidate.capabilityId,
      'reject',
      'Provenance is empty; the candidate cannot be traced to source logs.',
      [...risks, ...packet.reviewRisks],
      hasRewrite(rewrite) ? rewrite : null,
    );
  }
  const provenanceIssues = checkProvenance(provenance);
  if (provenanceIssues.length > 0) {
    risks.push(...provenanceIssues);
  }

  // ------------------------------------------------------------------
  // Check 3: Unsupported claims
  // ------------------------------------------------------------------
  const unsupportedClaimIssues = checkUnsupportedClaims(candidate, evidence);
  if (unsupportedClaimIssues.length > 0) {
    risks.push(...unsupportedClaimIssues);
  }

  // ------------------------------------------------------------------
  // Check 4: Faithful Rewrite
  // ------------------------------------------------------------------
  applyFaithfulRewrite(candidate, rewrite);

  // ------------------------------------------------------------------
  // Decision
  // ------------------------------------------------------------------
  const hasUnsupportedClaims = unsupportedClaimIssues.length > 0;
  const hasInvalidProvenance = provenanceIssues.some(isInvalidProvenanceIssue);
  const hasWeakProvenance = provenanceIssues.length > 0;

  if (hasInvalidProvenance) {
    return makeResult(
      candidate.capabilityId,
      'reject',
      'Provenance is malformed; the candidate cannot be traced reliably.',
      [...risks, ...packet.reviewRisks],
      hasRewrite(rewrite) ? rewrite : null,
    );
  }

  // Reject when provenance is too sparse for a promote.
  if (provenance.length < MIN_PROVENANCE_REFS_FOR_PROMOTE) {
    risks.push({
      label: 'insufficient-provenance',
      detail: `Only ${provenance.length} provenance ref(s); at least ${MIN_PROVENANCE_REFS_FOR_PROMOTE} required for promote.`,
    });
    return makeResult(
      candidate.capabilityId,
      'needs_review',
      'Insufficient provenance for a promote decision; held for review.',
      [...risks, ...packet.reviewRisks],
      hasRewrite(rewrite) ? rewrite : null,
      [
        `Why does this candidate only have ${provenance.length} provenance ref(s)?`,
        'Can a second source turn (problem-action and verification) be provided?',
      ],
    );
  }

  if (hasWeakProvenance) {
    return makeResult(
      candidate.capabilityId,
      'needs_review',
      'Provenance is present but incomplete for an automatic promote decision.',
      [...risks, ...packet.reviewRisks],
      hasRewrite(rewrite) ? rewrite : null,
      [
        'Which provenance refs are incomplete and why?',
        'Can the missing file paths, turn numbers, or byte ranges be recovered?',
      ],
    );
  }

  if (hasUnsupportedClaims) {
    return makeResult(
      candidate.capabilityId,
      'needs_review',
      'Candidate contains unsupported claims; downgraded to needs_review.',
      [...risks, ...packet.reviewRisks],
      hasRewrite(rewrite) ? rewrite : null,
      [
        'Which claims in the candidate are not grounded in the solved-loop evidence?',
        'Can additional evidence be provided to support the unsupported claims?',
      ],
    );
  }

  // All checks pass → promote.
  return makeResult(
    candidate.capabilityId,
    'promote',
    'All checks passed: solved-loop evidence is complete, provenance is sufficient, and no unsupported claims were detected.',
    [...risks, ...packet.reviewRisks],
    hasRewrite(rewrite) ? rewrite : null,
  );
}

// ---------------------------------------------------------------------------
// Internal: pre-review recommendation
// ---------------------------------------------------------------------------

function preReviewRecommendation(
  evidence: SolvedLoopEvidence,
  provenance: CapabilityProvenanceRef[],
  risks: ReviewerRisk[],
): 'promote' | 'needs_review' | 'reject' {
  if (provenance.length === 0) {
    risks.push({
      label: 'no-provenance',
      detail: 'Candidate has no provenance refs.',
    });
    return 'reject';
  }
  if (!evidence.problem || !evidence.action || !evidence.verification) {
    risks.push({
      label: 'incomplete-evidence',
      detail: 'Solved-loop evidence has one or more empty fields.',
    });
    return 'reject';
  }
  return 'promote';
}

// ---------------------------------------------------------------------------
// Internal: solved-loop evidence checks
// ---------------------------------------------------------------------------

function checkSolvedLoopEvidence(evidence: SolvedLoopEvidence): string[] {
  const gaps: string[] = [];
  if (!evidence.problem.trim()) gaps.push('problem is empty');
  if (!evidence.action.trim()) gaps.push('action is empty');
  if (!evidence.verification.trim()) gaps.push('verification is empty');
  if (!evidence.noCorrection.trim()) gaps.push('noCorrection is empty');
  return gaps;
}

// ---------------------------------------------------------------------------
// Internal: provenance checks
// ---------------------------------------------------------------------------

function checkProvenance(provenance: CapabilityProvenanceRef[]): ReviewerRisk[] {
  const risks: ReviewerRisk[] = [];
  if (provenance.length === 0) return risks;

  for (const ref of provenance) {
    if (!ref.filePath || !ref.filePath.trim()) {
      risks.push({
        label: 'missing-file-path',
        detail: `Provenance ref for turn ${ref.turn} has an empty filePath.`,
      });
    }
    if (ref.turn < 0) {
      risks.push({
        label: 'invalid-turn',
        detail: `Provenance ref has an invalid turn number: ${ref.turn}.`,
      });
    }
    if (ref.unitByteRange.start < 0 || ref.unitByteRange.end < ref.unitByteRange.start) {
      risks.push({
        label: 'invalid-byte-range',
        detail: `Provenance ref for turn ${ref.turn} has an invalid byte range.`,
      });
    }
  }

  // Check that at least one problem-action and one verification ref exist.
  const hasProblemAction = provenance.some(r => r.role === 'problem-action');
  const hasVerification = provenance.some(r => r.role === 'verification');
  if (!hasProblemAction) {
    risks.push({
      label: 'missing-problem-action-ref',
      detail: 'No provenance ref with role=problem-action.',
    });
  }
  if (!hasVerification) {
    risks.push({
      label: 'missing-verification-ref',
      detail: 'No provenance ref with role=verification.',
    });
  }

  return risks;
}

function isInvalidProvenanceIssue(risk: ReviewerRisk): boolean {
  return [
    'missing-file-path',
    'invalid-turn',
    'invalid-byte-range',
  ].includes(risk.label);
}

// ---------------------------------------------------------------------------
// Internal: unsupported-claim detection
// ---------------------------------------------------------------------------

/**
 * Detect claims in the candidate that are not supported by the solved-loop
 * evidence. The reviewer is conservative: it checks that tools mentioned in
 * the action pattern also appear in the solved-loop action text, and that the
 * applicability text references the problem domain from the evidence.
 *
 * Unsupported claims are **not** a hard reject — they downgrade the decision to
 * `needs_review` rather than discarding the candidate outright, because the
 * core evidence may still be valid even if the wording over-generalises.
 */
function checkUnsupportedClaims(
  candidate: DistilledKnowledgeCandidate,
  evidence: SolvedLoopEvidence,
): ReviewerRisk[] {
  const risks: ReviewerRisk[] = [];

  // Check that tools mentioned in actionPattern are grounded in the evidence
  // action text. Extract tool names from bracket notation [tool1, tool2].
  const actionPatternTools = extractBracketItems(candidate.actionPattern);
  const evidenceTools = extractBracketItems(evidence.action);

  for (const tool of actionPatternTools) {
    if (!evidenceTools.includes(tool)) {
      risks.push({
        label: 'unsupported-tool-claim',
        detail: `Action pattern references tool "${tool}" which does not appear in the solved-loop evidence action.`,
      });
    }
  }

  // Check that applicability doesn't introduce a completely unrelated domain.
  // We compare key content words between the applicability and the evidence
  // problem. If there is zero overlap of substantive words, it's suspicious.
  const applicabilityWords = extractContentWords(candidate.applicability);
  const problemWords = extractContentWords(evidence.problem);
  const overlap = applicabilityWords.filter(w => problemWords.includes(w));
  if (applicabilityWords.length > 0 && overlap.length === 0) {
    risks.push({
      label: 'unsupported-applicability',
      detail: 'Applicability text has no content-word overlap with the solved-loop problem.',
    });
  }

  return risks;
}

function extractBracketItems(text: string): string[] {
  const matches = text.matchAll(/\[([^\]]+)\]/g);
  const items: string[] = [];
  for (const match of matches) {
    items.push(
      ...match[1]
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean),
    );
  }
  return [...new Set(items)];
}

function extractContentWords(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on',
    'for', 'with', 'when', 'that', 'this', 'and', 'or', 'not', 'it', 'as', 'at',
    'by', 'from', 'use', 'applies', 'similar', 'problem', 'raises', 'situation',
  ]);
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w));
  return [...new Set(words)];
}

// ---------------------------------------------------------------------------
// Internal: Faithful Rewrite
// ---------------------------------------------------------------------------

/**
 * Apply Faithful Rewrite to the candidate's structured fields. This improves
 * wording or structure (whitespace normalization, trimming, ensuring required
 * lists are present) **without adding capability claims**.
 *
 * The rewrites are written into the `rewrite` object. Only fields that were
 * actually changed are populated.
 */
function applyFaithfulRewrite(
  candidate: DistilledKnowledgeCandidate,
  rewrite: FaithfulRewrite,
): void {
  // Title: normalize whitespace and trim.
  const rewrittenTitle = normalizeText(candidate.title);
  if (rewrittenTitle !== candidate.title) {
    rewrite.title = rewrittenTitle.slice(0, MAX_TITLE_LEN);
  } else if (candidate.title.length > MAX_TITLE_LEN) {
    rewrite.title = candidate.title.slice(0, MAX_TITLE_LEN).trimEnd() + '...';
  }

  // Applicability: normalize whitespace and trim.
  const rewrittenApplicability = normalizeText(candidate.applicability);
  if (rewrittenApplicability !== candidate.applicability) {
    rewrite.applicability = rewrittenApplicability.slice(0, MAX_APPLICABILITY_LEN);
  } else if (candidate.applicability.length > MAX_APPLICABILITY_LEN) {
    rewrite.applicability =
      candidate.applicability.slice(0, MAX_APPLICABILITY_LEN).trimEnd() + '...';
  }

  // Action pattern: normalize whitespace and trim.
  const rewrittenActionPattern = normalizeText(candidate.actionPattern);
  if (rewrittenActionPattern !== candidate.actionPattern) {
    rewrite.actionPattern = rewrittenActionPattern.slice(0, MAX_ACTION_PATTERN_LEN);
  } else if (candidate.actionPattern.length > MAX_ACTION_PATTERN_LEN) {
    rewrite.actionPattern =
      candidate.actionPattern.slice(0, MAX_ACTION_PATTERN_LEN).trimEnd() + '...';
  }

  // Boundaries: normalize each entry, trim length, cap count.
  const rewrittenBoundaries = candidate.boundaries
    .map(b => normalizeText(b).slice(0, MAX_BOUNDARY_LEN))
    .filter(Boolean)
    .slice(0, MAX_BOUNDARIES);
  if (
    JSON.stringify(rewrittenBoundaries) !== JSON.stringify(candidate.boundaries)
  ) {
    rewrite.boundaries = rewrittenBoundaries;
  }

  // Risks: normalize each entry, trim length, cap count.
  const rewrittenRisks = candidate.risks
    .map(r => normalizeText(r).slice(0, MAX_RISK_LEN))
    .filter(Boolean)
    .slice(0, MAX_RISKS);
  if (JSON.stringify(rewrittenRisks) !== JSON.stringify(candidate.risks)) {
    rewrite.risks = rewrittenRisks;
  }
}

function normalizeText(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Internal: result construction
// ---------------------------------------------------------------------------

function hasRewrite(rewrite: FaithfulRewrite): boolean {
  return (
    rewrite.title !== undefined ||
    rewrite.applicability !== undefined ||
    rewrite.actionPattern !== undefined ||
    rewrite.boundaries !== undefined ||
    rewrite.risks !== undefined
  );
}

function makeResult(
  capabilityId: string,
  decision: PromotionDecision,
  rationale: string,
  reviewRisks: ReviewerRisk[],
  rewrite: FaithfulRewrite | null,
  questions?: string[],
): PromotionReviewResult {
  const result: PromotionReviewResult = {
    schemaVersion: 1,
    capabilityId,
    decision,
    rationale,
    reviewRisks,
    rewrite,
    reviewedAt: new Date().toISOString(),
  };
  if (decision === 'needs_review' && questions && questions.length > 0) {
    result.questions = questions;
  }
  return result;
}
