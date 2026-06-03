export type MessageSource = 'catscompany' | 'feishu' | 'weixin' | 'cli' | 'unknown';

export type MessageTopicType = 'p2p' | 'group' | 'unknown';

export type IdentityTrustLevel =
  | 'server_canonical'
  | 'legacy_context'
  | 'untrusted';

export interface MessageEnvelope {
  source: MessageSource;
  sessionKey: string;
  legacySessionKey?: string;
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
  legacySessionKey?: string;
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

export interface SessionIdentitySnapshot {
  source: MessageSource;
  topicId: string;
  topicType: MessageTopicType;
  actorUserId: string;
  agentId?: string;
  agentBodyId?: string;
  identityTrust: IdentityTrustLevel;
  identitySource?: string;
}

export interface SessionRoute {
  version: 2;
  source: MessageSource;
  sessionKey: string;
  legacySessionKey?: string;
  topicId: string;
  topicType: MessageTopicType;
  actorUserId: string;
  agentId?: string;
  agentBodyId?: string;
  messageId?: string;
  channelSeq?: number;
  identityTrust: IdentityTrustLevel;
  identitySource?: string;
  identity: SessionIdentitySnapshot;
}

export type LocalFileGrantKind = 'catscompany_attachment';
export type LocalFileGrantFileType = 'file' | 'image' | 'unknown';
export type LocalFileGrantOperation = 'read_file' | 'send_file';

export interface ScopedLocalDeviceGrant {
  kind: 'catscompany_body';
  source: MessageSource;
  bodyId: string;
  installationId?: string;
  deviceId?: string;
  createdAt: number;
}

export interface ScopedLocalFileGrant {
  kind: LocalFileGrantKind;
  source: MessageSource;
  attachmentRef?: string;
  filePath: string;
  fileName: string;
  fileType: LocalFileGrantFileType;
  size: number;
  mtimeMs: number;
  sessionKey: string;
  topicId: string;
  topicType: MessageTopicType;
  actorUserId: string;
  agentId?: string;
  agentBodyId: string;
  deviceBodyId: string;
  deviceInstallationId?: string;
  identityTrust: IdentityTrustLevel;
  operations: LocalFileGrantOperation[];
  createdAt: number;
  expiresAt: number;
}
