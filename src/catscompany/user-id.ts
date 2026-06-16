export function normalizeCatsCoUserId(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  return /^\d+$/.test(text) ? `usr${text}` : text;
}

export function sameCatsCoUserId(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeCatsCoUserId(left);
  const normalizedRight = normalizeCatsCoUserId(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}
