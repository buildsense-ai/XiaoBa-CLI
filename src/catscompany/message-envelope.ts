import type { ExecutionScope, IdentityTrustLevel, MessageEnvelope, MessageTopicType } from '../types/session-identity';

type UnknownRecord = Record<string, unknown>;

export interface CatsCoEnvelopeInput {
  topic: string;
  isGroup?: boolean;
  senderId: string;
  seq?: number;
  text: string;
  metadata?: Record<string, unknown>;
  botUid?: string | null;
}

export function createCatsCoMessageEnvelope(input: CatsCoEnvelopeInput): MessageEnvelope {
  const topicId = safeString(input.topic) || 'unknown_topic';
  const senderId = safeString(input.senderId) || 'unknown';
  const topicType = inferTopicType(topicId, input.isGroup);
  const metadata = input.metadata;
  const catscoIdentity = asRecord(metadata?.catsco_identity);
  const warnings: string[] = [];

  const actor = asRecord(catscoIdentity?.actor);
  const agent = asRecord(catscoIdentity?.agent);
  const identityTopic = asRecord(catscoIdentity?.topic);
  const permissions = asRecord(catscoIdentity?.permissions);

  const canonicalActorId = stringField(actor, 'user_id');
  const canonicalTopicId = stringField(identityTopic, 'topic_id');
  const canonicalTopicType = normalizeTopicType(stringField(identityTopic, 'type'));
  const permissionsSource = stringField(permissions, 'source');
  const canonicalChannelSeq = numberField(identityTopic, 'channel_seq');
  const metadataLooksCanonical = permissionsSource === 'server_canonical_message';

  if (catscoIdentity && !metadataLooksCanonical) {
    warnings.push('catsco_identity permissions.source is not server_canonical_message');
  }
  if (metadataLooksCanonical && canonicalTopicId && canonicalTopicId !== topicId) {
    warnings.push('catsco_identity topic_id does not match message topic');
  }
  if (metadataLooksCanonical && canonicalActorId && senderId !== 'unknown' && canonicalActorId !== senderId) {
    warnings.push('catsco_identity actor.user_id does not match message sender');
  }

  const isCanonicalTrusted = Boolean(
    catscoIdentity
    && metadataLooksCanonical
    && canonicalActorId
    && canonicalTopicId === topicId
    && (senderId === 'unknown' || canonicalActorId === senderId),
  );

  const actorUserId = isCanonicalTrusted ? canonicalActorId! : senderId;
  const resolvedTopicType = isCanonicalTrusted && canonicalTopicType !== 'unknown'
    ? canonicalTopicType
    : topicType;
  const agentId = isCanonicalTrusted
    ? firstNonEmpty(stringField(agent, 'agent_id'), safeString(input.botUid))
    : safeString(input.botUid);
  const agentBodyId = isCanonicalTrusted ? stringField(agent, 'body_id') : undefined;
  const channelSeq = isCanonicalTrusted
    ? canonicalChannelSeq ?? normalizeSeq(input.seq)
    : normalizeSeq(input.seq);
  const identityTrust: IdentityTrustLevel = isCanonicalTrusted
    ? 'server_canonical'
    : catscoIdentity
      ? 'untrusted'
      : 'legacy_context';
  const sessionKey = buildCatsCoSessionKey(resolvedTopicType, topicId, actorUserId);

  return {
    source: 'catscompany',
    sessionKey,
    messageId: buildMessageId(topicId, channelSeq, metadata),
    topicId,
    topicType: resolvedTopicType,
    actorUserId,
    agentId,
    agentBodyId,
    channelSeq,
    rawText: input.text,
    rawMetadata: metadata,
    permissionsSource: isCanonicalTrusted ? permissionsSource : undefined,
    identityTrust,
    identitySource: isCanonicalTrusted ? 'metadata.catsco_identity' : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export function createExecutionScope(envelope: MessageEnvelope): ExecutionScope {
  return {
    source: envelope.source,
    sessionKey: envelope.sessionKey,
    topicId: envelope.topicId,
    topicType: envelope.topicType,
    actorUserId: envelope.actorUserId,
    agentId: envelope.agentId,
    agentBodyId: envelope.agentBodyId,
    channelSeq: envelope.channelSeq,
    permissionsSource: envelope.permissionsSource,
    identityTrust: envelope.identityTrust,
    isTrusted: envelope.identityTrust === 'server_canonical',
  };
}

export function buildCatsCoSessionKey(
  topicType: MessageTopicType,
  topicId: string,
  actorUserId: string,
): string {
  if (topicType === 'group') {
    return `cc_group:${topicId}`;
  }
  return `cc_user:${actorUserId || 'unknown'}`;
}

function buildMessageId(
  topicId: string,
  channelSeq: number | undefined,
  metadata?: UnknownRecord,
): string | undefined {
  const clientMessageId = firstNonEmpty(
    stringField(metadata, 'client_msg_id'),
    stringField(metadata, 'clientMessageId'),
    stringField(metadata, 'client_message_id'),
  );
  if (clientMessageId) return clientMessageId;
  if (channelSeq && channelSeq > 0) return `${topicId}:${channelSeq}`;
  return undefined;
}

function inferTopicType(topicId: string, isGroup?: boolean): MessageTopicType {
  if (isGroup || topicId.startsWith('grp_')) return 'group';
  if (topicId.startsWith('p2p_')) return 'p2p';
  return 'unknown';
}

function normalizeTopicType(value?: string): MessageTopicType {
  if (value === 'p2p' || value === 'group') return value;
  return 'unknown';
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

function stringField(record: UnknownRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

function numberField(record: UnknownRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeSeq(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value) return value;
  }
  return undefined;
}
