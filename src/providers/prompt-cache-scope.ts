import { createHash } from 'crypto';
import type { ExecutionScope } from '../types/session-identity';

export const PROMPT_CACHE_SHARD_COUNT = 8;

function normalize(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Stable virtual-employee identity with bounded per-user shards. */
export function buildPromptCacheScopeKey(
  sessionKey: string | undefined,
  scope?: Pick<ExecutionScope, 'agentId' | 'agentBodyId' | 'actorUserId'>,
): string {
  const employee = normalize(scope?.agentId) || normalize(scope?.agentBodyId);
  if (!employee) return `session:${shortHash(normalize(sessionKey) || 'unscoped')}`;
  const actor = normalize(scope?.actorUserId) || 'unknown-actor';
  const shard = Number.parseInt(shortHash(actor).slice(0, 8), 16) % PROMPT_CACHE_SHARD_COUNT;
  return `employee:${shortHash(employee)}:shard:${shard}`;
}
