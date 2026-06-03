export type MessageSource = 'catscompany' | 'feishu' | 'weixin' | 'cli' | 'unknown';

export type MessageTopicType = 'p2p' | 'group' | 'unknown';

export type IdentityTrustLevel =
  | 'server_canonical'
  | 'legacy_context'
  | 'untrusted';

export interface MessageEnvelope {
  source: MessageSource;
  sessionKey: string;
  messageId?: string;
  topicId: string;
  topicType: MessageTopicType;
  actorUserId: string;
  agentId?: string;
  agentBodyId?: string;
  channelSeq?: number;
  rawText: string;
  rawMetadata?: Record<string, unknown>;
  permissionsSource?: string;
  identityTrust: IdentityTrustLevel;
  identitySource?: string;
  warnings?: string[];
}

export interface ExecutionScope {
  source: MessageSource;
  sessionKey: string;
  topicId: string;
  topicType: MessageTopicType;
  actorUserId: string;
  agentId?: string;
  agentBodyId?: string;
  channelSeq?: number;
  permissionsSource?: string;
  identityTrust: IdentityTrustLevel;
  isTrusted: boolean;
}
