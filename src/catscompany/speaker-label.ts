import { createHash } from 'node:crypto';
import type { ContentBlock } from '../types';
import type { IdentityTrustLevel } from '../types/session-identity';

type UnknownRecord = Record<string, unknown>;

export const CATSCO_SPEAKER_LABEL_MAX_CODE_POINTS = 80;

export type CatsCoSpeakerKind = 'human' | 'other_agent';

export interface CatsCoSpeakerIdentity {
  id: string;
  displayName: string;
  kind: CatsCoSpeakerKind;
  trust: 'server_canonical' | 'transport_fallback';
}

interface CatsCoSpeakerIdentityBase {
  metadata?: Record<string, unknown>;
  fallbackUserId: unknown;
  kind?: CatsCoSpeakerKind;
}

export type CatsCoSpeakerIdentityInput =
  | (CatsCoSpeakerIdentityBase & {
    trustSource: 'live_message';
    identityTrust: IdentityTrustLevel;
    expectedTopicId: string;
  })
  | (CatsCoSpeakerIdentityBase & {
    trustSource: 'server_agent_context';
    expectedTopicId: string;
    messageTopicId?: unknown;
  });

/**
 * Resolve a model-visible identity from a server authority bound to the
 * transport sender. Raw display metadata is never used as a fallback.
 */
export function resolveTrustedCatsCoSpeakerIdentity(
  input: CatsCoSpeakerIdentityInput,
): CatsCoSpeakerIdentity {
  const fallbackUserId = sanitizeCatsCoSpeakerId(
    normalizeCatsCoUserId(input.fallbackUserId),
    'User',
  );
  const fallback: CatsCoSpeakerIdentity = {
    id: fallbackUserId,
    displayName: fallbackUserId,
    kind: input.kind ?? 'human',
    trust: 'transport_fallback',
  };
  const expectedTopicId = String(input.expectedTopicId || '').trim();
  if (!expectedTopicId) return fallback;
  if (input.trustSource === 'live_message' && input.identityTrust !== 'server_canonical') {
    return fallback;
  }

  const metadata = asRecord(input.metadata);
  const identity = asRecord(metadata?.catsco_identity);
  const actor = asRecord(identity?.actor);
  const permissions = asRecord(identity?.permissions);
  const permissionsSource = stringField(permissions, 'source');
  if (
    (input.trustSource === 'live_message' && permissionsSource !== 'server_canonical_message')
    || (input.trustSource === 'server_agent_context'
      && permissionsSource
      && permissionsSource !== 'server_canonical_message')
  ) {
    return fallback;
  }

  const rawFallbackUserId = normalizeCatsCoUserId(input.fallbackUserId);
  const actorUserId = normalizeCatsCoUserId(stringField(actor, 'user_id'));
  if (!actorUserId || !rawFallbackUserId || actorUserId !== rawFallbackUserId) return fallback;

  const identityTopicId = stringField(asRecord(identity?.topic), 'topic_id');
  if (identityTopicId && identityTopicId !== expectedTopicId) return fallback;
  if (input.trustSource === 'live_message' && identityTopicId !== expectedTopicId) return fallback;
  if (input.trustSource === 'server_agent_context') {
    const messageTopicId = String(input.messageTopicId ?? '').trim();
    if (messageTopicId && messageTopicId !== expectedTopicId) return fallback;
  }

  const id = sanitizeCatsCoSpeakerId(actorUserId, fallback.id);
  return {
    id,
    displayName: sanitizeCatsCoSpeakerLabel(
      stringField(actor, 'display_name') || stringField(actor, 'username') || actorUserId,
      id,
    ),
    kind: input.kind ?? canonicalActorKind(actor) ?? 'human',
    trust: 'server_canonical',
  };
}

/** @deprecated Prefer the structured identity resolver for new call sites. */
export function resolveTrustedCatsCoSpeakerLabel(input: CatsCoSpeakerIdentityInput): string {
  return resolveTrustedCatsCoSpeakerIdentity(input).displayName;
}

export function formatCatsCoSpeakerPrefix(identity: CatsCoSpeakerIdentity): string {
  const kind = identity.kind === 'other_agent' ? '其他 Agent' : '发言人';
  return `[${kind}: ${identity.displayName}; id=${identity.id}]`;
}

export function prefixCatsCoParticipantContent(
  identity: CatsCoSpeakerIdentity,
  content: string | ContentBlock[],
): string | ContentBlock[] {
  const prefix = `${formatCatsCoSpeakerPrefix(identity)}\n`;
  if (typeof content === 'string') {
    return `${prefix}${escapeCatsCoParticipantBodyText(content)}`;
  }
  const escapedBlocks = content.map(block => block.type === 'text'
    ? { ...block, text: escapeCatsCoParticipantBodyText(block.text) }
    : block);
  return [{ type: 'text', text: prefix.trimEnd() }, ...escapedBlocks];
}

/**
 * Reserve model-visible participant headers for the trusted framing layer.
 * Only header-shaped line starts are escaped so ordinary brackets remain intact.
 */
export function escapeCatsCoParticipantBodyText(value: string): string {
  return value.replace(
    /(^|[\u0000-\u001f\u007f-\u009f\u2028\u2029])([^\u0000-\u001f\u007f-\u009f\u2028\u2029]*)/gu,
    (match, boundary: string, line: string) => {
      const detectionSkeleton = line
        .normalize('NFKC')
        .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
        .trimStart();
      if (!/^\[(?:发言人|其他\s*Agent)\s*:/u.test(detectionSkeleton)) return match;
      return `${boundary}↳ ${line.replace(/[\[［]/u, '‹')}`;
    },
  );
}

export function sanitizeCatsCoSpeakerId(value: unknown, fallback: unknown = 'User'): string {
  const raw = normalizeCatsCoUserId(value).normalize('NFC').trim();
  const cleaned = cleanLabel(raw);
  if (cleaned && cleaned === raw && Array.from(raw).length <= CATSCO_SPEAKER_LABEL_MAX_CODE_POINTS) {
    return raw;
  }
  if (raw) return collisionResistantSanitizedId(cleaned || 'User', raw);

  const fallbackRaw = normalizeCatsCoUserId(fallback).normalize('NFC').trim() || 'User';
  const cleanedFallback = cleanLabel(fallbackRaw) || 'User';
  if (
    cleanedFallback === fallbackRaw
    && Array.from(fallbackRaw).length <= CATSCO_SPEAKER_LABEL_MAX_CODE_POINTS
  ) {
    return fallbackRaw;
  }
  return collisionResistantSanitizedId(cleanedFallback, fallbackRaw);
}

export function sanitizeCatsCoSpeakerLabel(value: unknown, fallback: unknown = 'User'): string {
  const cleaned = cleanLabel(value);
  if (cleaned) return truncateCodePoints(cleaned, CATSCO_SPEAKER_LABEL_MAX_CODE_POINTS);
  const cleanedFallback = cleanLabel(fallback) || 'User';
  return truncateCodePoints(cleanedFallback, CATSCO_SPEAKER_LABEL_MAX_CODE_POINTS);
}

export function normalizeCatsCoUserId(value: unknown): string {
  const raw = String(value ?? '').trim();
  const numeric = raw.match(/^(?:usr)?(\d+)$/i);
  return numeric ? `usr${numeric[1]}` : raw;
}

export function sameCatsCoUserId(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeCatsCoUserId(left);
  const normalizedRight = normalizeCatsCoUserId(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function cleanLabel(value: unknown): string {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/giu, '')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］')
    .replace(/;/g, '；')
    .replace(/=/g, '＝')
    .replace(/\s+/gu, ' ')
    .trim();
}

function collisionResistantSanitizedId(cleaned: string, raw: string): string {
  const suffix = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const prefixLength = CATSCO_SPEAKER_LABEL_MAX_CODE_POINTS - suffix.length - 1;
  const prefix = Array.from(cleaned).slice(0, prefixLength).join('') || 'User';
  return `${prefix}~${suffix}`;
}

function canonicalActorKind(actor: UnknownRecord | undefined): CatsCoSpeakerKind | undefined {
  const value = firstStringField(actor, ['kind', 'type', 'actor_type']).toLowerCase();
  if (value === 'agent' || value === 'other_agent' || value === 'ai_agent') {
    return 'other_agent';
  }
  if (value === 'human' || value === 'user') return 'human';
  return undefined;
}

function truncateCodePoints(value: string, maximum: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= maximum) return value;
  return `${codePoints.slice(0, maximum - 1).join('')}…`;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function stringField(record: UnknownRecord | undefined, key: string): string {
  return typeof record?.[key] === 'string' ? String(record[key]).trim() : '';
}

function firstStringField(record: UnknownRecord | undefined, keys: string[]): string {
  for (const key of keys) {
    const value = stringField(record, key);
    if (value) return value;
  }
  return '';
}
