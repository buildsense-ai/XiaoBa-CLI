import { createHash } from 'crypto';

export function formatPathForLog(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '-';

  const normalized = text.replace(/\\/g, '/');
  const rawName = normalized.split('/').filter(Boolean).pop() || 'file';
  const safeName = rawName
    .replace(/[\r\n\t=]/g, '_')
    .slice(0, 120)
    || 'file';
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 8);
  return `${safeName}#${hash}`;
}
