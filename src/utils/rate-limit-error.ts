const RATE_LIMIT_ERROR_CODES = new Set([
  'RATE_LIMIT',
  'HTTP_429',
  'TOO_MANY_REQUESTS',
]);

export function isRateLimitErrorCode(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return RATE_LIMIT_ERROR_CODES.has(value.trim().toUpperCase());
}

/**
 * Read rate-limit state from transport metadata only. Error messages may contain
 * arbitrary command output or source text and must never drive retry policy.
 */
export function getStructuredRateLimitErrorCode(error: any): string | undefined {
  const statusCandidates = [
    error?.status,
    error?.statusCode,
    error?.response?.status,
    error?.cause?.status,
    error?.cause?.response?.status,
  ];
  if (statusCandidates.some(status => Number(status) === 429)) {
    return 'HTTP_429';
  }

  const codeCandidates = [
    error?.errorCode,
    error?.code,
    error?.response?.data?.code,
    error?.cause?.errorCode,
    error?.cause?.code,
  ];
  return codeCandidates.find(isRateLimitErrorCode)?.trim().toUpperCase();
}
