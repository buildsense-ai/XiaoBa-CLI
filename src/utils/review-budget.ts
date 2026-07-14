/** Conservative, observable budget for one Runtime Learning review wake. */
export interface ReviewBudgetConfig {
  maxCandidates: number;
  maxPromptTokens: number;
  deadlineMs: number;
  now?: () => number;
}

export interface ReviewBudget {
  readonly deadlineAt: number;
  readonly candidates: number;
  readonly estimatedPromptTokens: number;
  canStart(serializedInput: unknown): boolean;
  admit(serializedInput: unknown): boolean;
}

/**
 * Estimate input tokens without claiming provider accounting. JSON bytes are
 * rounded up at four bytes/token and charged before a review starts. This is
 * deliberately conservative and works for both eligible and queued bundles.
 */
export function estimateReviewPromptTokens(input: unknown): number {
  const bytes = Buffer.byteLength(JSON.stringify(input ?? null), 'utf8');
  return Math.max(1, Math.ceil(bytes / 4));
}

export function createReviewBudget(config: ReviewBudgetConfig): ReviewBudget {
  const now = config.now ?? (() => Date.now());
  const deadlineAt = now() + Math.max(1, Math.floor(config.deadlineMs));
  const maxCandidates = Math.max(0, Math.floor(config.maxCandidates));
  const maxPromptTokens = Math.max(0, Math.floor(config.maxPromptTokens));
  let candidates = 0;
  let estimatedPromptTokens = 0;
  const canStart = (input: unknown): boolean => {
    const tokens = estimateReviewPromptTokens(input);
    return now() < deadlineAt
      && candidates < maxCandidates
      && estimatedPromptTokens + tokens <= maxPromptTokens;
  };
  return {
    deadlineAt,
    get candidates() { return candidates; },
    get estimatedPromptTokens() { return estimatedPromptTokens; },
    canStart,
    admit(input: unknown): boolean {
      if (!canStart(input)) return false;
      candidates += 1;
      estimatedPromptTokens += estimateReviewPromptTokens(input);
      return true;
    },
  };
}
