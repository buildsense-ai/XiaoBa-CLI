/** Conservative, observable budget for one Runtime Learning review wake. */
export interface ReviewBudgetConfig {
  maxCandidates: number;
  deadlineMs: number;
  now?: () => number;
}

export interface ReviewBudget {
  readonly deadlineAt: number;
  readonly candidates: number;
  canStart(): boolean;
  admit(): boolean;
}

/**
 * Review Admission bounds wake scheduling capacity only.
 * Estimated serialized prompt size never decides eligibility; actual model
 * context capacity is enforced later at request construction.
 */
export function createReviewBudget(config: ReviewBudgetConfig): ReviewBudget {
  const now = config.now ?? (() => Date.now());
  const deadlineAt = now() + Math.max(1, Math.floor(config.deadlineMs));
  const maxCandidates = Math.max(0, Math.floor(config.maxCandidates));
  let candidates = 0;
  const canStart = (): boolean => (
    now() < deadlineAt && candidates < maxCandidates
  );
  return {
    deadlineAt,
    get candidates() { return candidates; },
    canStart,
    admit(): boolean {
      if (!canStart()) return false;
      candidates += 1;
      return true;
    },
  };
}
