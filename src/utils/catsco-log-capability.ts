/**
 * Shared validation helpers for CatsLog bootstrap capability responses.
 *
 * Both the upload scheduler and the memory provider perform the same
 * bootstrap handshake and must agree on what makes a read/write capability
 * usable, and on which response fields belong to which capability group.
 * Keeping one copy prevents the two call sites from drifting (for example
 * one accepting an upload token as a Skill token and the other not).
 *
 * Skew semantics are intentional and differ by call shape:
 * - validating a *fresh* bootstrap response needs no refresh skew (the server
 *   just issued the token), so these helpers compare against `now` directly;
 * - re-reading a *persisted* capability from state (provider-side) applies an
 *   extra refresh skew there, because the stored expiry is aging on disk.
 */

/** Trimmed non-empty string, or undefined. Shared response-cleaning helper. */
export function cleanCapabilityText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

export function responseHasReadCapabilityFields(response: Record<string, unknown>): boolean {
  return [
    'skill_token_id', 'skill_token', 'skill_token_expires_at', 'skills_url',
    'skill_graph_url', 'sessions_url', 'memory_url', 'memory_recall_url',
  ].some(key => response[key] !== undefined);
}

export function responseHasWriteCapabilityFields(response: Record<string, unknown>): boolean {
  return [
    'memory_notes_url', 'memory_write_token_id', 'memory_write_token',
    'memory_write_token_expires_at',
  ].some(key => response[key] !== undefined);
}

/** A read capability is only usable when the skill token is live and distinct from the upload/write tokens. */
export function hasUsableReadCapability(response: Record<string, unknown>, now = Date.now()): boolean {
  const skillToken = cleanCapabilityText(response.skill_token);
  const skillTokenExpiresAt = cleanCapabilityText(response.skill_token_expires_at);
  const uploadToken = cleanCapabilityText(response.token);
  const writeToken = cleanCapabilityText(response.memory_write_token);
  return Boolean(skillToken && skillToken !== uploadToken && skillToken !== writeToken
    && skillTokenExpiresAt && Date.parse(skillTokenExpiresAt) > now);
}

/** A write capability is only usable when the write token is live and distinct from the upload/skill tokens. */
export function hasUsableWriteCapability(response: Record<string, unknown>, now = Date.now()): boolean {
  const token = cleanCapabilityText(response.memory_write_token);
  const expiresAt = cleanCapabilityText(response.memory_write_token_expires_at);
  const uploadToken = cleanCapabilityText(response.token);
  const skillToken = cleanCapabilityText(response.skill_token);
  return Boolean(token && token !== uploadToken && token !== skillToken
    && expiresAt && Date.parse(expiresAt) > now);
}
