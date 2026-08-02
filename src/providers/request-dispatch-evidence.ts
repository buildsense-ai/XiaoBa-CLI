export type ProviderRequestDispatchStatus = 'not_dispatched';

const PROVABLY_PRE_DISPATCH_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Return evidence only for transport failures that prove no HTTP request could
 * have reached the provider. Absence means unknown, never "dispatched".
 *
 * This intentionally excludes generic timeouts, resets, socket errors and HTTP
 * responses: those may happen after the provider accepted enough request bytes
 * to populate its prompt cache.
 */
export function attestProviderRequestDispatch(
  error: unknown,
): ProviderRequestDispatchStatus | undefined {
  const candidate = error as {
    code?: unknown;
    cause?: { code?: unknown; message?: unknown };
    message?: unknown;
    response?: unknown;
  } | undefined;
  if (!candidate || candidate.response !== undefined) return undefined;

  const code = String(candidate.code ?? candidate.cause?.code ?? '').toUpperCase();
  if (PROVABLY_PRE_DISPATCH_CODES.has(code)) return 'not_dispatched';

  // Node labels a TCP connection timeout as "connect ETIMEDOUT". A bare
  // ETIMEDOUT may instead be a response/read timeout and is not proof.
  const message = String(candidate.message ?? candidate.cause?.message ?? '');
  if (code === 'ETIMEDOUT' && /^connect\s+ETIMEDOUT\b/i.test(message.trim())) {
    return 'not_dispatched';
  }
  return undefined;
}
