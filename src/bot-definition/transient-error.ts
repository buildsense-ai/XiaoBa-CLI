/** Classify transport failures by structured status/code, never provider prose. */
export function isTransientCloudError(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const value = current as { status?: number; code?: string; name?: string; message?: string; cause?: unknown };
    if (value.status !== undefined) return [408, 425, 429, 500, 502, 503, 504].includes(value.status);
    if (['AbortError', 'TimeoutError', 'RelayCredentialUnreachableError'].includes(value.name || '')) return true;
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND',
      'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'].includes(value.code || '')) return true;
    if (value.name === 'TypeError' && value.message === 'fetch failed') return true;
    current = value.cause;
  }
  return false;
}
