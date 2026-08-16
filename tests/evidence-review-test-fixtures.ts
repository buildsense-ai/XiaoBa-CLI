import type {
  EvidenceBundle,
  ObligationDisposition,
  ReviewObligation,
} from '../src/utils/evidence-review-types';

export function acceptReviewObligations(
  bundle: EvidenceBundle,
): ObligationDisposition[] {
  const episode = bundle.episode as { reviewObligations?: ReviewObligation[] } | null;
  return (episode?.reviewObligations ?? []).map(obligation => ({
    obligationId: obligation.obligationId,
    decision: 'accepted',
    rationale: 'Test verifier explicitly accepted this cited obligation.',
    citedSpans: obligation.requiredShardIds.map(shardId => ({
      shardId,
      span: { start: 0, end: 1 },
    })),
  }));
}
