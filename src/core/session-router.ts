import type {
  IdentityTrustLevel,
  ExecutionScope,
  MessageEnvelope,
  MessageSource,
  MessageTopicType,
  SessionRoute,
} from '../types/session-identity';
import type { ParsedFeishuMessage } from '../feishu/types';
import type { WeixinMessage } from '../weixin/types';

export const SESSION_KEY_V2_PREFIX = 'session:v2';

export interface CreateSessionRouteInput {
  source: MessageSource;
  topicId: string;
  sessionTopicId?: string;
  topicType: MessageTopicType;
  actorUserId: string;
  agentId?: string;
  agentBodyId?: string;
  messageId?: string;
  channelSeq?: number;
  identityTrust?: IdentityTrustLevel;
  identitySource?: string;
  legacySessionKey?: string;
  legacyRestoreKey?: string;
  legacyCleanupKey?: string;
}

export interface ParsedSessionKeyV2 {
  version: 2;
  source: MessageSource;
  topicType: MessageTopicType;
  topicId: string;
  agentId?: string;
}

export function createSessionRoute(input: CreateSessionRouteInput): SessionRoute {
  const source = normalizeSource(input.source);
  const topicType = normalizeTopicType(input.topicType);
  const actorUserId = normalizeId(input.actorUserId) || 'unknown_actor';
  const topicId = normalizeId(input.topicId) || actorUserId;
  const sessionTopicId = normalizeId(input.sessionTopicId) || topicId;
  const agentId = normalizeOptionalId(input.agentId);
  const agentBodyId = normalizeOptionalId(input.agentBodyId);
  const identityTrust = input.identityTrust || 'legacy_context';
  const identitySource = normalizeOptionalId(input.identitySource);
  const sessionKey = buildSessionKeyV2({ source, topicType, topicId: sessionTopicId, agentId });
  const legacySessionKey = normalizeOptionalId(input.legacyRestoreKey)
    || normalizeOptionalId(input.legacySessionKey);
  const legacyRestoreKey = legacySessionKey;
  const legacyCleanupKey = normalizeOptionalId(input.legacyCleanupKey)
    || legacyRestoreKey;

  return {
    version: 2,
    source,
    sessionKey,
    legacySessionKey,
    legacyRestoreKey,
    legacyCleanupKey,
    topicId,
    topicType,
    actorUserId,
    agentId,
    agentBodyId,
    messageId: normalizeOptionalId(input.messageId),
    channelSeq: normalizeSeq(input.channelSeq),
    identityTrust,
    identitySource,
    identity: {
      source,
      topicId,
      topicType,
      actorUserId,
      agentId,
      agentBodyId,
      identityTrust,
      identitySource,
    },
  };
}

export function buildCatsCoSessionTopicId(
  topicType: MessageTopicType,
  topicId: string,
  actorUserId: string,
): string {
  const normalizedTopicId = normalizeId(topicId) || 'unknown_topic';
  void topicType;
  void actorUserId;
  return normalizedTopicId;
}

export function createCatsCoSessionRoute(envelope: MessageEnvelope): SessionRoute {
  const fallbackLegacyKey = buildLegacyCatsCoSessionKey(
    envelope.topicType,
    envelope.topicId,
    envelope.actorUserId,
  );
  const legacyRestoreKey = envelope.legacyRestoreKey
    || envelope.legacySessionKey
    || fallbackLegacyKey;
  const legacyCleanupKey = envelope.legacyCleanupKey
    || envelope.legacySessionKey
    || fallbackLegacyKey;
  const route = createSessionRoute({
    source: 'catscompany',
    topicId: envelope.topicId,
    sessionTopicId: buildCatsCoSessionTopicId(
      envelope.topicType,
      envelope.topicId,
      envelope.actorUserId,
    ),
    topicType: envelope.topicType,
    actorUserId: envelope.actorUserId,
    agentId: envelope.agentId,
    agentBodyId: envelope.agentBodyId,
    messageId: envelope.messageId,
    channelSeq: envelope.channelSeq,
    identityTrust: envelope.identityTrust,
    identitySource: envelope.identitySource,
    legacyRestoreKey,
    legacyCleanupKey,
  });
  if (route.topicType === 'group') {
    return {
      ...route,
      sessionKey: fallbackLegacyKey,
      legacySessionKey: fallbackLegacyKey,
      legacyRestoreKey: fallbackLegacyKey,
      legacyCleanupKey: fallbackLegacyKey,
    };
  }
  return route;
}

export function createFeishuSessionRoute(message: ParsedFeishuMessage): SessionRoute {
  const topicType: MessageTopicType = message.chatType === 'group' ? 'group' : 'p2p';
  const topicId = normalizeId(message.chatId) || normalizeId(message.senderId) || 'unknown_chat';
  return createSessionRoute({
    source: 'feishu',
    topicId,
    topicType,
    actorUserId: message.senderId,
    messageId: message.messageId,
    identityTrust: 'legacy_context',
    identitySource: 'feishu.event',
    legacySessionKey: buildLegacyFeishuSessionKey(topicType, topicId, message.senderId),
  });
}

export function createFeishuBridgeSessionRoute(input: {
  chatId: string;
  from?: string;
  messageId?: string;
}): SessionRoute {
  const topicId = normalizeId(input.chatId) || 'unknown_chat';
  const actorUserId = normalizeId(input.from) || 'bridge_peer';
  return createSessionRoute({
    source: 'feishu',
    topicId,
    topicType: 'group',
    actorUserId,
    messageId: input.messageId,
    identityTrust: 'legacy_context',
    identitySource: 'feishu.bridge',
    legacySessionKey: `group:${topicId}`,
  });
}

export function createWeixinSessionRoute(message: WeixinMessage): SessionRoute {
  const actorUserId = normalizeId(message.from?.id) || 'unknown_user';
  return createSessionRoute({
    source: 'weixin',
    topicId: actorUserId,
    topicType: 'p2p',
    actorUserId,
    messageId: message.message_id,
    identityTrust: 'legacy_context',
    identitySource: 'weixin.ilink',
    legacySessionKey: `user:${actorUserId}`,
  });
}

export function createExecutionScopeFromRoute(route: SessionRoute): ExecutionScope {
  return {
    source: route.source,
    sessionKey: route.sessionKey,
    legacySessionKey: route.legacySessionKey,
    legacyRestoreKey: route.legacyRestoreKey,
    legacyCleanupKey: route.legacyCleanupKey,
    topicId: route.topicId,
    topicType: route.topicType,
    actorUserId: route.actorUserId,
    agentId: route.agentId,
    agentBodyId: route.agentBodyId,
    channelSeq: route.channelSeq,
    identityTrust: route.identityTrust,
    isTrusted: route.identityTrust === 'server_canonical',
  };
}

export function buildSessionKeyV2(input: {
  source: MessageSource;
  topicType: MessageTopicType;
  topicId: string;
  agentId?: string;
}): string {
  const parts = [
    SESSION_KEY_V2_PREFIX,
    encodeKeyPart(normalizeSource(input.source)),
    encodeKeyPart(normalizeTopicType(input.topicType)),
    encodeKeyPart(normalizeId(input.topicId) || 'unknown_topic'),
  ];
  const agentId = normalizeOptionalId(input.agentId);
  if (agentId) {
    parts.push('agent', encodeKeyPart(agentId));
  }
  return parts.join(':');
}

export function parseSessionKeyV2(sessionKey: string): ParsedSessionKeyV2 | undefined {
  const parts = sessionKey.split(':');
  if (parts.length < 5 || parts[0] !== 'session' || parts[1] !== 'v2') return undefined;
  const source = normalizeSource(decodeKeyPart(parts[2]));
  const topicType = normalizeTopicType(decodeKeyPart(parts[3]));
  const topicId = normalizeId(decodeKeyPart(parts[4]));
  if (!topicId) return undefined;
  let agentId: string | undefined;
  if (parts[5] === 'agent' && parts[6]) {
    agentId = normalizeOptionalId(decodeKeyPart(parts[6]));
  }
  return {
    version: 2,
    source,
    topicType,
    topicId,
    agentId,
  };
}

export function isSessionRoute(value: unknown): value is SessionRoute {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as SessionRoute).version === 2
    && typeof (value as SessionRoute).sessionKey === 'string',
  );
}

export function buildLegacyCatsCoSessionKey(
  topicType: MessageTopicType,
  topicId: string,
  actorUserId: string,
): string {
  if (topicType === 'group') {
    return `cc_group:${topicId || 'unknown'}`;
  }
  return `cc_user:${actorUserId || 'unknown'}`;
}

export function buildLegacyFeishuSessionKey(
  topicType: MessageTopicType,
  topicId: string,
  actorUserId: string,
): string {
  if (topicType === 'group') {
    return `group:${topicId || 'unknown'}`;
  }
  return `user:${actorUserId || 'unknown'}`;
}

function normalizeSource(value: MessageSource | string | undefined): MessageSource {
  if (value === 'catscompany' || value === 'feishu' || value === 'weixin' || value === 'cli') {
    return value;
  }
  return 'unknown';
}

function normalizeTopicType(value: MessageTopicType | string | undefined): MessageTopicType {
  if (value === 'p2p' || value === 'group') return value;
  return 'unknown';
}

function normalizeId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

function normalizeOptionalId(value: unknown): string | undefined {
  return normalizeId(value);
}

function normalizeSeq(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function decodeKeyPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
