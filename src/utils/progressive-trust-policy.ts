/**
 * Progressive Trust policy seam (issue: external-evidence false-negative fix).
 *
 * The prompt-only Skill Verifier policy is not a reliable gate against systemic
 * deferral of settled, low-risk, narrowly described external atoms. DeepSeek
 * deferred two valuable Codex external-history atoms solely on sample scarcity
 * (one source / one instance / no independent repetition), exactly the reasons
 * Progressive Trust says must NOT by themselves justify deferral.
 *
 * This module supplies an *enforceable* pre-commit decision seam: the runtime
 * inspects a Verifier `defer` decision and decides whether it is an invalid
 * sample-scarcity-only defer that the Progressive Trust policy forbids. The seam
 * never forces acceptance and never overrides genuine defer reasons:
 *
 *   - truncated / materially ambiguous user intent, action, or result;
 *   - the only support is an unverified assertion for an important outcome;
 *   - destructive, privileged, financial, privacy-sensitive, or irreversible
 *     effects without sufficient corroboration;
 *   - a relevant contradiction or review obligation remains unresolved;
 *   - an invalid transition or genuine sample-scarcity-plus contradicts.
 *
 * The seam is a pure function over the Verifier result + Evidence Bundle shape
 * so it is independently testable and exercised at the public
 * `runSkillVerifierQuantum` integration point.
 *
 * Provider-neutral and bounded: no private ~/.codex or ~/.pi log parsing.
 */

import type {
  BoundedSourceEvidence,
  EvidenceBundle,
  SkillVerifierResult,
} from './skill-evolution';
import type {
  DossierDifferenceIndex,
  EvidenceShard,
  ObligationDisposition,
  ReviewObligation,
} from './evidence-review/types';
import { buildExplicitObligationDispositions } from './evidence-review';
import type { DistilledKnowledgeCandidate } from './capability-distiller';

/** High-risk classifications that require sufficient corroboration to accept. */
const HIGH_RISK_CLASSIFICATIONS = new Set([
  'limitation',
  'risk',
  'contradiction',
  'privilege_implication',
  'source_instruction',
  'unresolved_question',
  'classification_difference',
]);

/** Outcome of inspecting one Verifier `defer` decision. */
export type ProgressiveTrustDeferOutcome =
  | { readonly kind: 'valid_defer'; readonly reason: string }
  | { readonly kind: 'invalid_sample_scarcity_defer'; readonly reason: string };

/**
 * Sample-scarcity-only deferral signals. These only identify the *forbidden*
 * reason; their absence never implies acceptance.
 */
const SAMPLE_SCARCITY_SIGNALS: readonly RegExp[] = [
  /\b(?:single|one|only)\s+(?:source|instance|example|sample|observation|episode)\b/iu,
  /\bonly\s+one\s+(?:source|instance|example|sample|observation|episode)\b/iu,
  /\bno\s+(?:independent|other|additional|second)\s+(?:source|instance|example|sample|observation|episode|repetition)\b/iu,
  /\b(?:not\s+)?independently\s+(?:repeated|corroborated|confirmed|observed)\b/iu,
  /\blacks?\s+of\s+independent\s+(?:repetition|corroboration|confirmation|sources?|samples?)\b/iu,
  /\bsample\s+scarcity\b/iu,
  /\binsufficient\s+(?:sample|sources?|instances?|examples?|observations?|repetition|corroboration)\b/iu,
  /\bneeds?\s+more\s+(?:sources?|instances?|examples?|samples?|observations?|repetition|corroboration)\b/iu,
];

/**
 * Genuine non-scarcity deferral signals. Their presence makes the defer valid
 * regardless of any sample-scarcity overlap.
 */
const GENUINE_DEFER_SIGNALS: readonly RegExp[] = [
  /\btruncat(?:ed|ion)\b/iu,
  /\bmaterially\s+ambiguous\b/iu,
  /\bunverified(?:\s+assertion)?\b/iu,
  /\bunsupported\b/iu,
  /\bunknown\b/iu,
  /\b(?:destructive|irreversible|privileged|financial|privacy[\s-]sensitive|(?:external(?:ly)?)?\s*consequential)\b/iu,
  /\bunresolved\s+(?:contradiction|review\s+obligation|obligation)\b/iu,
  /\bopen\s+review\s+obligation\b/iu,
  /\bunsafe\s+(?:trigger|boundary)\b/iu,
  /\bno\s+safe\s+(?:trigger|boundary|narrow\s+skill)\b/iu,
  /\binsufficient\s+(?:evidence|corroboration)\s+for\s+(?:a\s+)?(?:high[\s-]risk|destructive|privileged|sensitive)\b/iu,
];

/**
 * Inspect a Verifier `defer` decision under Progressive Trust.
 *
 * Returns `valid_defer` when the defer rationale carries a genuine non-scarcity
 * reason (or when no recognizable settled low-risk atom is present to enforce).
 * Returns `invalid_sample_scarcity_defer` only when:
 *   - the decision is `defer`;
 *   - the bundle carries a settled low-risk external atom with a recognizable
 *     trigger/action/result (the capsule/evidence preserved it);
 *   - the defer rationale cites ONLY sample-scarcity signals and no genuine
 *     non-scarcity signal.
 */
export function inspectProgressiveTrustDefer(input: {
  readonly verification: SkillVerifierResult;
  readonly bundle: EvidenceBundle;
  readonly obligations: readonly ReviewObligation[];
  readonly differenceIndex: DossierDifferenceIndex;
  readonly round: number;
  readonly maxRounds: number;
}): ProgressiveTrustDeferOutcome {
  const { verification, obligations, differenceIndex, bundle, round, maxRounds } = input;
  if (verification.decision !== 'defer') {
    return { kind: 'valid_defer', reason: 'not a defer decision' };
  }

  // Combine rationale and issues as a single space-delimited text so both
  // genuine-defer signals and sample-scarcity signals are inspected over the
  // full structured text — not only rationale (regression: precedence bug).
  const rationale = [
    verification.rationale ?? '',
    ...verification.issues.map(issue => issue.message),
    ...(verification.obligationDispositions ?? []).map(disposition => disposition.rationale),
  ].filter(Boolean).join(' ');

  // 1. Any genuine non-scarcity defer reason makes the defer valid.
  if (GENUINE_DEFER_SIGNALS.some(re => re.test(rationale))) {
    return {
      kind: 'valid_defer',
      reason: 'defer rationale carries a genuine non-scarcity reason',
    };
  }

  // 2. Any unresolved high-risk review obligation makes the defer valid.
  const hasUnresolvedHighRisk = obligations.some(obligation =>
    HIGH_RISK_CLASSIFICATIONS.has(obligation.kind as string)
    || obligation.kind === 'difference',
  );
  if (hasUnresolvedHighRisk) {
    return {
      kind: 'valid_defer',
      reason: 'unresolved high-risk review obligation or structural difference remains',
    };
  }

  // 3. Any structural difference that is not a benign paraphrase-corroboration
  //    edge makes the defer valid. (Paraphrase corroboration is already removed
  //    by the Difference Index fix, so any remaining entry is a real gap.)
  if (differenceIndex.entries.length > 0) {
    return {
      kind: 'valid_defer',
      reason: 'structural evidence-review differences remain',
    };
  }

  // 4. Only when the bundle carries a settled low-risk external atom with a
  //    recognizable trigger/action/result AND the rationale cites sample
  //    scarcity do we flag an invalid sample-scarcity-only defer.
  const candidate = extractCandidate(bundle);
  const settledLowRiskExternal = isSettledLowRiskExternalAtom(bundle, candidate);
  if (!settledLowRiskExternal) {
    return {
      kind: 'valid_defer',
      reason: 'no recognizable settled low-risk external atom to enforce against',
    };
  }

  const scarcityMatches = SAMPLE_SCARCITY_SIGNALS.filter(re => re.test(rationale));
  if (scarcityMatches.length === 0) {
    return {
      kind: 'valid_defer',
      reason: 'defer rationale does not cite sample scarcity',
    };
  }

  // Genuine signals were excluded in step 1, so the only matched signals are
  // sample-scarcity signals. This is the forbidden Progressive Trust defer.
  return {
    kind: 'invalid_sample_scarcity_defer',
    reason:
      `Progressive Trust forbids deferring a settled, low-risk, narrow external atom solely for sample scarcity `
      + `(one source / one instance / no independent repetition). The defer rationale cites only scarcity signals. `
      + `Round ${round}/${maxRounds}.`,
  };
}

/**
 * Decide the enforced Verifier outcome after inspecting a `defer`.
 *
 * - On `valid_defer`: keep the defer.
 * - On `invalid_sample_scarcity_defer` at an expandable round: convert to
 *   `revise` so the Author gets one bounded chance to narrow the draft; the
 *   issue list carries the Progressive Trust guidance for the Author.
 * - On `invalid_sample_scarcity_defer` at the final round (no revision budget
 *   remains) AND the draft is valid AND every obligation is resolvable: convert
 *   to `accept` with synthesized accepted dispositions. Otherwise keep defer.
 */
export function enforceProgressiveTrustDefer(input: {
  readonly verification: SkillVerifierResult;
  readonly bundle: EvidenceBundle;
  readonly obligations: readonly ReviewObligation[];
  readonly differenceIndex: DossierDifferenceIndex;
  readonly round: number;
  readonly maxRounds: number;
  readonly draftValid: boolean;
  readonly shards?: readonly EvidenceShard[];
}): {
  readonly verification: SkillVerifierResult;
  readonly enforced: boolean;
  readonly enforceReason?: string;
} {
  const inspection = inspectProgressiveTrustDefer({
    verification: input.verification,
    bundle: input.bundle,
    obligations: input.obligations,
    differenceIndex: input.differenceIndex,
    round: input.round,
    maxRounds: input.maxRounds,
  });

  if (inspection.kind === 'valid_defer') {
    return { verification: input.verification, enforced: false };
  }

  // Expandable: give the Author a bounded revision chance with explicit
  // Progressive Trust guidance. Do not blindly accept.
  const canRevise = input.round < input.maxRounds;
  if (canRevise) {
    const revised: SkillVerifierResult = {
      ...input.verification,
      decision: 'revise',
      issues: [
        ...input.verification.issues,
        {
          code: 'progressive-trust-invalid-scarcity-defer',
          message: inspection.reason,
          severity: 'warning',
        },
      ],
      rationale:
        `${input.verification.rationale} [Progressive Trust override]: ${inspection.reason} `
        + `Narrow the draft to the settled, low-risk external atom and resubmit; do not defer solely for scarcity.`,
    };
    return { verification: revised, enforced: true, enforceReason: inspection.reason };
  }

  // Final round: only accept when the draft is valid and no structural
  // difference / unresolved high-risk obligation remains. Otherwise the
  // original defer stands (we never blindly force accept).
  if (!input.draftValid) {
    return { verification: input.verification, enforced: false, enforceReason: inspection.reason };
  }
  if (input.differenceIndex.entries.length > 0) {
    return { verification: input.verification, enforced: false, enforceReason: inspection.reason };
  }
  if (input.obligations.some(o => HIGH_RISK_CLASSIFICATIONS.has(o.kind as string) || o.kind === 'difference')) {
    return { verification: input.verification, enforced: false, enforceReason: inspection.reason };
  }

  // Synthesize accepted dispositions for every obligation with valid cited
  // spans from real shards. This ensures the production seam (resolveVerifierObligationDispositions
  // + executeCommit) sees resolved obligations and does NOT flip accept back to
  // defer. If no valid shard span is available, fail closed — do NOT force accept.
  let obligationDispositions: ObligationDisposition[] | undefined;
  if (input.obligations.length > 0 && input.shards && input.shards.length > 0) {
    try {
      obligationDispositions = buildExplicitObligationDispositions(
        input.obligations,
        input.shards,
        'accepted',
        `${inspection.reason}. Settled low-risk external atom accepted under Progressive Trust; no high-risk obligation or structural difference remains.`,
      );
    } catch {
      // No valid non-empty shard span available — cannot synthesize safe
      // dispositions. Fail closed: do not force accept.
      return { verification: input.verification, enforced: false, enforceReason: inspection.reason };
    }
  }

  const accepted: SkillVerifierResult = {
    ...input.verification,
    decision: 'accept',
    obligationDispositions,
    issues: [
      ...input.verification.issues,
      {
        code: 'progressive-trust-invalid-scarcity-defer',
        message: inspection.reason,
        severity: 'warning',
      },
    ],
    rationale:
      `${input.verification.rationale} [Progressive Trust override]: ${inspection.reason} `
      + `No revision budget remained; the draft is valid and no high-risk obligation or structural difference is open, `
      + `so the settled low-risk external atom is accepted rather than deferring solely for scarcity.`,
  };
  return { verification: accepted, enforced: true, enforceReason: inspection.reason };
}

function extractCandidate(bundle: EvidenceBundle): DistilledKnowledgeCandidate | null {
  const episode = bundle.episode as unknown;
  if (!episode || typeof episode !== 'object') return null;
  if ((episode as { kind?: unknown }).kind !== 'capability') return null;
  return episode as DistilledKnowledgeCandidate;
}

function isSettledLowRiskExternalAtom(
  bundle: EvidenceBundle,
  candidate: DistilledKnowledgeCandidate | null,
): boolean {
  // Requires a recognizable solved-loop trigger/action/result (narrow atom).
  if (!candidate) return false;
  const solved = candidate.solvedLoop;
  if (!solved) return false;
  const hasRecognizableTrigger = typeof solved.problem === 'string' && solved.problem.trim().length > 0
    && !/^Admitted external event/i.test(solved.problem);
  const hasRecognizableAction = typeof solved.action === 'string' && solved.action.trim().length > 0
    && !/external event was admitted/i.test(solved.action);
  const hasRecognizableResult = typeof solved.verification === 'string' && solved.verification.trim().length > 0
    && !/^Redacted and pinned at/i.test(solved.verification);
  if (!hasRecognizableTrigger || !hasRecognizableAction || !hasRecognizableResult) return false;

  // External origin: at least one typed/runtime-owned evidence entry must use
  // an external session-log scheme (xurl:// or agents://). This is the
  // runtime-owned adapter seam — provider-neutral and bounded.
  const sourceEvidence = (bundle.sourceEvidence ?? []) as readonly BoundedSourceEvidence[];
  const hasExternalOrigin = sourceEvidence.some(
    e => EXTERNAL_SOURCE_FILE_SCHEMES.test(e.sourceFilePath ?? ''),
  ) || bundle.completionEvidence.some(
    e => EXTERNAL_SOURCE_FILE_SCHEMES.test(e.sourceFilePath ?? ''),
  ) || bundle.settlementEvidence.some(
    e => EXTERNAL_SOURCE_FILE_SCHEMES.test(e.sourceFilePath ?? ''),
  );
  if (!hasExternalOrigin) return false;

  // Settled maturation: at least one verification-role sourceEvidence entry
  // must explicitly assert "settled at" — the content produced by
  // buildEpisodeSettlementEvidence for eligible/contradicted episodes.
  // "not settled" (from settling/historical-* status) must NOT be accepted.
  const verificationContent = sourceEvidence
    .filter(e => e.role === 'verification' && typeof e.content === 'string')
    .map(e => e.content)
    .join(' ');
  const hasSettlementAssertion = /settled\s+at/iu.test(verificationContent);
  const hasEligibleStatus = /status\s*:\s*eligible\b/iu.test(verificationContent);
  const hasUnsettledMarker = /not\s+settled/iu.test(verificationContent);
  const hasContradictedStatus = /status\s*:\s*contradicted\b/iu.test(verificationContent);
  if (!hasSettlementAssertion || !hasEligibleStatus || hasUnsettledMarker || hasContradictedStatus) return false;

  // Low-risk and narrow are proven by the surrounding gates (no high-risk
  // obligations, no structural differences) and the recognizable solved-loop.
  // Do NOT trust semanticObservations as authority.
  return true;
}

/** Runtime-owned external session-log URI schemes. Provider-neutral, bounded. */
const EXTERNAL_SOURCE_FILE_SCHEMES = /^(?:xurl|agents):\/\//i;
