/**
 * Canonical hashing helpers for Evidence Review foundations.
 *
 * Shard and manifest identity must not depend on model choice, tokenizer,
 * or non-deterministic key order. Mutated content under an existing hash is
 * always rejected by callers that re-hash content.
 */

import * as crypto from 'crypto';

/** Stable recursive key sort used for content-addressed hashes. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b, 'en'))) {
      const next = record[key];
      if (next === undefined) continue;
      out[key] = canonicalize(next);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON encoding for hashing domain material. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashEvidenceContent(content: string): string {
  return sha256Hex(content);
}
