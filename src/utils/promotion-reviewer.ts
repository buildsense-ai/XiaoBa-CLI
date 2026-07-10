import * as fs from 'fs';
import * as path from 'path';
import {
  CapabilityProvenanceRef,
  DistilledKnowledgeCandidate,
  SolvedLoopEvidence,
} from './capability-distiller';
import {
  CapabilityPrefilterMatch,
  prefilterCapabilities,
} from './capability-prefilter';
import {
  CapabilityRegistryState,
  EvidenceRef,
} from './capability-registry';
import {
  buildDistilledSkillDescription,
  resolveEffectiveFields,
} from './distilled-skill-content';

/**
 * Promotion Reviewer (issue #4, #27, #28).
 *
 * Reviews a Promotion Packet built from a capability candidate, solved-loop
 * evidence, risks, and provenance refs, and returns one of `promote`,
 * `needs_review`, or `reject` with review rationale.
 *
 * When the packet carries an optional V2 Capability Registry context, the
 * reviewer also performs registry-aware consolidation: a candidate with no
 * related capability becomes `new_capability`, equivalent guidance appends
 * evidence, and a material action-pattern or boundary change produces
 * `supersede_snapshot`. This exposes the matched capability's Active Snapshot
 * and traceable evidence refs to the reviewer so the decision is auditable.
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
export const PROMOTION_REVIEWER_VERSION = 'promotion-reviewer-v2';

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
 * V2 Capability Registry context exposed to the reviewer so it can compare a
 * candidate against the Active Snapshot and traceable evidence of a matched
 * capability. This is the registry-aware consolidation input for issue #28.
 */
export interface RegistryPromotionContext {
  /** Top related capabilities returned by the Capability Prefilter. */
  matches: CapabilityPrefilterMatch[];
  /** Active snapshot SKILL.md content keyed by capabilityId. */
  activeSnapshotContents: Record<string, string>;
  /** Evidence refs for each matched capability (traceable sources). */
  evidenceRefsByCapability: Record<string, EvidenceRef[]>;
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
  /**
   * Optional V2 Capability Registry context for consolidation decisions. When
   * present, the reviewer compares the candidate against matched capabilities'
   * Active Snapshots and traceable evidence refs.
   */
  registryContext?: RegistryPromotionContext;
}

export interface BuildPromotionPacketOptions {
  /** Solved-loop evidence supplied by the promotion branch, if different from the candidate copy. */
  solvedLoopEvidence?: SolvedLoopEvidence;
  /** Provenance refs supplied by the promotion branch, if different from the candidate copy. */
  provenance?: CapabilityProvenanceRef[];
  /** Reviewer-observed risks to carry into the packet. */
  reviewRisks?: ReviewerRisk[];
  /** Optional V2 Capability Registry context for consolidation decisions. */
  registryContext?: RegistryPromotionContext;
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
  /**
   * V2 consolidation target: the registry capability this decision appends
   * evidence to or supersedes the Active Snapshot of. Absent when the decision
   * is not registry-backed or the candidate is new.
   */
  targetCapabilityId?: string;
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
    registryContext: options.registryContext,
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
 * When the packet includes a V2 Capability Registry context, a candidate that
 * would otherwise be promoted is further consolidated: `new_capability` for
 * an unrelated candidate, `append_evidence` for equivalent guidance, or
 * `supersede_snapshot` for a material action-pattern or boundary change. The
 * prior Active Snapshot and its traceable evidence refs are exposed in the
 * context for this decision.
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

  // All checks pass → promote, or perform V2 registry-aware consolidation when
  // a Capability Registry context is present.
  const baseRisks = [...risks, ...packet.reviewRisks];
  const finalDecision = packet.registryContext
    ? consolidateWithRegistry(packet, baseRisks, rewrite)
    : 'promote';

  if (finalDecision === 'needs_review') {
    return makeResult(
      candidate.capabilityId,
      'needs_review',
      'Registry-aware consolidation could not safely compare the candidate against the active snapshot; held for review.',
      baseRisks,
      hasRewrite(rewrite) ? rewrite : null,
      [
        'Could the active snapshot content be read from disk?',
        'Is the action-pattern or boundary change intentional and well-supported by evidence?',
      ],
    );
  }

  // For registry-backed append/supersede the decision is about the matched
  // registry capability, so the review identity is the target capabilityId.
  // This keeps the reviewer's `capabilityId` aligned with the immutable snapshot
  // install path and the registry transition target.
  const consolidationTarget =
    packet.registryContext && finalDecision !== 'promote' && finalDecision !== 'new_capability'
      ? selectConsolidationTarget(packet.registryContext, candidate)
      : undefined;
  const reviewCapabilityId = consolidationTarget
    ? consolidationTarget.capabilityId
    : candidate.capabilityId;

  const rationale = buildConsolidationRationale(finalDecision, packet, consolidationTarget);
  const result = makeResult(
    reviewCapabilityId,
    finalDecision,
    rationale,
    baseRisks,
    hasRewrite(rewrite) ? rewrite : null,
  );
  if (consolidationTarget) {
    result.targetCapabilityId = consolidationTarget.capabilityId;
  }

  return result;
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

// ---------------------------------------------------------------------------
// Internal: V2 registry-aware consolidation (issue #28)
// ---------------------------------------------------------------------------

/**
 * Build a RegistryPromotionContext for a candidate by running the Capability
 * Prefilter against the registry and reading each matched capability's Active
 * Snapshot from disk. This exposes the Active Snapshot and traceable evidence
 * refs to the reviewer without giving the reviewer direct registry mutation
 * access.
 */
export function buildRegistryPromotionContext(
  candidate: DistilledKnowledgeCandidate,
  registry: CapabilityRegistryState,
  outputDir: string,
): RegistryPromotionContext {
  const prefilterResult = prefilterCapabilities(candidate, registry, { limit: 5 });
  const activeSnapshotContents: Record<string, string> = {};
  const evidenceRefsByCapability: Record<string, EvidenceRef[]> = {};

  for (const match of prefilterResult.matches) {
    const entry = registry.capabilities[match.capabilityId];
    if (!entry) continue;

    const snapshotPath = path.join(
      outputDir,
      entry.capabilityId,
      entry.activeSnapshotId,
      'SKILL.md',
    );
    try {
      if (fs.existsSync(snapshotPath)) {
        activeSnapshotContents[entry.capabilityId] = fs.readFileSync(snapshotPath, 'utf-8');
      }
    } catch {
      // Snapshot is unreadable; leave content absent so the reviewer can fall
      // back to needs_review rather than guessing.
    }
    evidenceRefsByCapability[entry.capabilityId] = entry.evidenceRefs;
  }

  return {
    matches: prefilterResult.matches,
    activeSnapshotContents,
    evidenceRefsByCapability,
  };
}

/**
 * Consolidate a promoted candidate against its matched registry capabilities.
 *
 * - No related capability above the match threshold → `new_capability`.
 * - Related capability exists and the candidate's action pattern + boundaries
 *   are materially equivalent to the Active Snapshot → `append_evidence`.
 * - Related capability exists and the action pattern or boundaries changed
 *   materially → `supersede_snapshot`.
 * - Active Snapshot content is unreadable → `needs_review`.
 */
function consolidateWithRegistry(
  packet: PromotionPacket,
  reviewRisks: ReviewerRisk[],
  rewrite: FaithfulRewrite,
): PromotionDecision {
  const { registryContext, candidate } = packet;
  if (!registryContext || registryContext.matches.length === 0) {
    return 'new_capability';
  }

  const target = selectConsolidationTarget(registryContext, candidate);
  if (!target) {
    const unreadableMatch = registryContext.matches.find(
      match => !registryContext.activeSnapshotContents[match.capabilityId],
    );
    if (unreadableMatch) {
      reviewRisks.push({
        label: 'unreadable-active-snapshot',
        detail: `Active snapshot for prefiltered capability ${unreadableMatch.capabilityId} could not be read.`,
      });
      return 'needs_review';
    }
    return 'new_capability';
  }

  const activeContent = registryContext.activeSnapshotContents[target.capabilityId];
  if (!activeContent) {
    reviewRisks.push({
      label: 'unreadable-active-snapshot',
      detail: `Active snapshot for matched capability ${target.capabilityId} could not be read.`,
    });
    return 'needs_review';
  }

  const candidateGuidance = resolveCandidateGuidance(candidate, hasRewrite(rewrite) ? rewrite : null);
  const snapshotGuidance = parseSnapshotGuidance(activeContent);
  if (!snapshotGuidance) {
    reviewRisks.push({
      label: 'malformed-active-snapshot',
      detail: `Active snapshot for matched capability ${target.capabilityId} does not contain complete guidance.`,
    });
    return 'needs_review';
  }

  const actionPatternChanged =
    !guidanceTextEquivalent(
      candidateGuidance.actionPattern,
      snapshotGuidance.actionPattern,
    );
  const boundariesChanged = !boundariesEquivalent(
    candidateGuidance.boundaries,
    snapshotGuidance.boundaries,
  );

  if (actionPatternChanged || boundariesChanged) {
    return 'supersede_snapshot';
  }

  return 'append_evidence';
}

/**
 * Select the best consolidation target from the prefilter matches. An exact
 * capabilityId match wins. Otherwise, a prefilter result must also have a
 * strongly matching title/applicability in its readable Active Snapshot before
 * it is eligible as a consolidation target. The prefilter is recall only, so a
 * weak lexical hit must not append evidence to or supersede another capability.
 */
function selectConsolidationTarget(
  registryContext: RegistryPromotionContext,
  candidate: DistilledKnowledgeCandidate,
): CapabilityPrefilterMatch | undefined {
  const exact = registryContext.matches.find(m => m.capabilityId === candidate.capabilityId);
  if (exact) return exact;

  const candidateRouting = buildDistilledSkillDescription(
    resolveEffectiveFields(candidate, null),
  );
  const routingMatch = registryContext.matches.find(
    match => match.routingDescription === candidateRouting,
  );
  if (routingMatch) return routingMatch;

  const identityMatch = registryContext.matches.find(match => {
    const content = registryContext.activeSnapshotContents[match.capabilityId];
    const guidance = content ? parseSnapshotGuidance(content) : null;
    return guidance !== null && hasStrongCapabilityIdentity(candidate, guidance);
  });
  if (identityMatch) return identityMatch;

  return registryContext.matches.find(match => match.score >= STRONG_MATCH_SCORE_THRESHOLD);
}

const STRONG_MATCH_SCORE_THRESHOLD = 80;

function buildConsolidationRationale(
  decision: PromotionDecision,
  packet: PromotionPacket,
  target: CapabilityPrefilterMatch | undefined,
): string {
  if (decision === 'promote') {
    return 'All checks passed: solved-loop evidence is complete, provenance is sufficient, and no unsupported claims were detected.';
  }
  if (decision === 'new_capability') {
    return 'No related capability found in the registry; create a new capability entry and Active Snapshot.';
  }

  const targetId = target ? target.capabilityId : 'matched capability';

  if (decision === 'append_evidence') {
    return `Matched capability ${targetId} has materially equivalent action pattern and boundaries; append traceable evidence without changing the Active Snapshot.`;
  }

  if (decision === 'supersede_snapshot') {
    return `Matched capability ${targetId} has a material action-pattern or boundary change; install a new immutable Active Snapshot and preserve the predecessor.`;
  }

  return 'Registry-aware consolidation produced an unexpected decision.';
}

function resolveCandidateGuidance(
  candidate: DistilledKnowledgeCandidate,
  rewrite: FaithfulRewrite | null,
): { actionPattern: string; boundaries: string[] } {
  return {
    actionPattern: rewrite?.actionPattern ?? candidate.actionPattern,
    boundaries: rewrite?.boundaries ?? candidate.boundaries,
  };
}

interface SnapshotGuidance {
  title: string;
  applicability: string;
  actionPattern: string;
  boundaries: string[];
}

function parseSnapshotGuidance(content: string): SnapshotGuidance | null {
  const guidance: SnapshotGuidance = {
    title: extractDocumentTitle(content),
    applicability: extractSectionParagraph(content, 'Capability Guidance', 'Applicability'),
    actionPattern: extractSectionParagraph(content, 'Capability Guidance', 'Action Pattern'),
    boundaries: extractBulletList(extractSection(content, 'Boundaries')),
  };
  return guidance.title && guidance.applicability && guidance.actionPattern && guidance.boundaries.length > 0
    ? guidance
    : null;
}

function extractDocumentTitle(content: string): string {
  const body = content.replace(/^---\s*[\s\S]*?\n---\s*/u, '');
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function extractSection(content: string, heading: string): string {
  const regex = new RegExp(`##\\s+${escapeRegExp(heading)}\\s*(.*?)(?=\\n##\\s|$)`, 's');
  const match = content.match(regex);
  return match ? match[1].trim() : '';
}

function extractSectionParagraph(
  content: string,
  heading: string,
  subheading: string,
): string {
  const section = extractSection(content, heading);
  const regex = new RegExp(
    `\\*\\*${escapeRegExp(subheading)}\\*\\*\\s*(.*?)(?=\\n\\n|$)`,
    's',
  );
  const match = section.match(regex);
  return match ? match[1].trim() : '';
}

function extractBulletList(section: string): string[] {
  const items: string[] = [];
  for (const line of section.split('\n')) {
    const match = line.match(/^-\s+(.*)$/);
    if (match) {
      items.push(match[1].trim());
    }
  }
  return items;
}

function boundariesEquivalent(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const remaining = b.filter(Boolean);
  return a.filter(Boolean).every(boundary => {
    const index = remaining.findIndex(other => guidanceTextEquivalent(boundary, other));
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
}

/**
 * Treat formatting-only differences as equivalent so punctuation, casing, and
 * singular/plural wording do not churn immutable snapshots. Because a false
 * supersession creates a permanent artifact, treat substantially overlapping
 * guidance as equivalent; a materially different technique has little shared
 * vocabulary and remains a supersession.
 */
function guidanceTextEquivalent(a: string, b: string): boolean {
  const canonical = (value: string) =>
    value
      .toLocaleLowerCase('en')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  if (canonical(a) === canonical(b)) return true;

  const tokens = (value: string) => new Set(
    canonical(value)
      .replace(/\bjsonl\b/gu, 'json')
      .split(' ')
      .filter(Boolean)
      .map(token => token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token)
      .filter(token => !GUIDANCE_NOISE_TOKENS.has(token)),
  );
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return shared / (left.size + right.size - shared) >= 0.3;
}

const GUIDANCE_NOISE_TOKENS = new Set([
  'a', 'an', 'and', 'apply', 'at', 'by', 'each', 'file', 'interface', 'instead',
  'line', 'node', 'of', 'one', 'pattern', 'process', 'read', 'record', 'the',
  'then', 'this', 'time', 'to', 'tool', 'tools', 'use', 'with',
]);

function hasStrongCapabilityIdentity(
  candidate: DistilledKnowledgeCandidate,
  snapshot: SnapshotGuidance,
): boolean {
  const candidateIdentity = `${candidate.title} ${candidate.applicability}`;
  const snapshotIdentity = `${snapshot.title} ${snapshot.applicability}`;
  return guidanceTextEquivalent(candidateIdentity, snapshotIdentity);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
