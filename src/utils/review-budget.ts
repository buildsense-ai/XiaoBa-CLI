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

const MAX_REVIEW_BRANCHES = 4;
const MAX_MODEL_TURNS_PER_BRANCH = 4;

/**
 * Reserve bundle-derived input tokens without claiming provider accounting.
 * A BPE token cannot encode less than one byte of the UTF-8 payload, so raw
 * bytes are a safe upper bound for one serialization. The bounded review
 * protocol permits two Author/Verifier rounds, with at most four model turns
 * in each branch. Charging sixteen copies covers the fixed bundle appearing
 * in every possible model request.
 * Provider-reported completion usage remains observable separately.
 */
export function estimateReviewPromptTokens(input: unknown): number {
  const bytes = Buffer.byteLength(JSON.stringify(input ?? null), 'utf8');
  return Math.max(1, bytes) * MAX_REVIEW_BRANCHES * MAX_MODEL_TURNS_PER_BRANCH;
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
