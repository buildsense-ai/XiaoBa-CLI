export type SessionChannel = 'catsco' | 'wechat' | 'feishu' | 'cli' | 'api' | 'unknown' | string;
export type SessionTopicType = 'p2p' | 'group' | 'task' | 'unknown' | string;

export interface SessionActorIdentity {
  /** Stable CatsCo actor/user id when known. */
  actorUserId?: string;
  actorDisplayName?: string;
  /** Raw user id from the transport, e.g. CatsCo uid, WeChat openid, Feishu user id. */
  externalUserId?: string;
  /** Future ChannelBinding id once platform-side binding exists. */
  channelBindingId?: string;
}

export interface SessionAgentIdentity {
  agentId?: string;
  agentDisplayName?: string;
  bodyId?: string;
  orgId?: string;
}

export interface SessionTopicIdentity {
  topicId?: string;
  topicType?: SessionTopicType;
  externalMessageId?: string;
  channelSeq?: number;
}

export interface SessionIdentitySnapshot {
  schemaVersion: 1;
  sessionId: string;
  legacySessionKey?: string;
  sessionType?: string;
  channel: SessionChannel;
  actor?: SessionActorIdentity;
  agent?: SessionAgentIdentity;
  topic?: SessionTopicIdentity;
  permissionsSnapshot?: Record<string, unknown>;
  receivedAt?: string;
}

function compact(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function describeActor(identity: SessionIdentitySnapshot): string {
  const actor = identity.actor || {};
  const parts = [
    compact(actor.actorDisplayName),
    compact(actor.actorUserId),
  ].filter(Boolean);
  const external = compact(actor.externalUserId);
  if (external && external !== actor.actorUserId) {
    parts.push(`external=${external}`);
  }
  return parts.length > 0 ? parts.join(' / ') : 'unknown';
}

function describeAgent(identity: SessionIdentitySnapshot): string {
  const agent = identity.agent || {};
  const parts = [
    compact(agent.agentDisplayName),
    compact(agent.agentId),
  ].filter(Boolean);
  const bodyId = compact(agent.bodyId);
  if (bodyId) parts.push(`body=${bodyId}`);
  return parts.length > 0 ? parts.join(' / ') : 'current runtime';
}

export function formatSessionIdentityForPrompt(identity?: SessionIdentitySnapshot): string {
  if (!identity) return '';

  const topic = identity.topic || {};
  const lines = [
    '[transient_session_identity]',
    '当前对话身份上下文：',
    `- session: ${identity.sessionId}`,
    `- channel: ${identity.channel}`,
    `- actor: ${describeActor(identity)}`,
    `- agent: ${describeAgent(identity)}`,
  ];

  const topicParts = [
    compact(topic.topicType),
    compact(topic.topicId),
  ].filter(Boolean);
  if (topicParts.length > 0) {
    lines.push(`- topic: ${topicParts.join(' / ')}`);
  }
  if (typeof topic.channelSeq === 'number' && Number.isFinite(topic.channelSeq)) {
    lines.push(`- message_seq: ${topic.channelSeq}`);
  }
  if (identity.agent?.orgId) {
    lines.push(`- org: ${identity.agent.orgId}`);
  }

  lines.push('处理本轮请求时，以当前 actor/session 为准；不要把不同 actor 的个人需求互相混淆。');
  return lines.join('\n');
}
