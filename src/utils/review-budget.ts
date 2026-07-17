/** Conservative, observable budget for one Runtime Learning review wake. */
export interface ReviewBudgetConfig {
  maxCandidates: number;
  deadlineMs: number;
  now?: () => number;
  /**
   * @deprecated Estimated prompt size is not a Review Admission signal.
   * Accepted only for compatibility with older call sites and is ignored.
   */
  maxPromptTokens?: number;
}

export interface ReviewBudget {
  readonly deadlineAt: number;
  readonly candidates: number;
  canStart(serializedInput?: unknown): boolean;
  admit(serializedInput?: unknown): boolean;
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
  const canStart = (_input?: unknown): boolean => (
    now() < deadlineAt && candidates < maxCandidates
  );
  return {
    deadlineAt,
    get candidates() { return candidates; },
    canStart,
    admit(input?: unknown): boolean {
      if (!canStart(input)) return false;
      candidates += 1;
      return true;
    },
  };
}
