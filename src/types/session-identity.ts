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
  legacyRestoreKey?: string;
  legacyCleanupKey?: string;
  messageId?: string;
  topicId: string;
  topicType: MessageTopicType;
  actorUserId: string;
  agentId?: string;
  agentBodyId?: string;
  channelSeq?: number;
  rawText: string;
  rawMetadata?: Record<string, unknown>;
  /**
   * 平台派活时给的「这次调用属于哪个会话」（`metadata.catsco_bot_session_id`）。
   * 只在平台可信信封下透传：一次工具调用一个会话，同 id 就是同一场对话。
   */
  botSessionId?: string;
  permissionsSource?: string;
  deviceOwnerUserId?: string;
  deviceOwnerSource?: string;
  channelSource?: string;
  identityTrust: IdentityTrustLevel;
  identitySource?: string;
  warnings?: string[];
  /** Opaque, short-lived Artifact context reference from a trusted live envelope. */
  artifactContextRef?: string;
  /** Opaque, short-lived Artifact task reference from a trusted live envelope. */
  artifactTaskRef?: string;
}

export interface ExecutionScope {
  source: MessageSource;
  sessionKey: string;
  legacySessionKey?: string;
  legacyRestoreKey?: string;
  legacyCleanupKey?: string;
  topicId: string;
  topicType: MessageTopicType;
  actorUserId: string;
  agentId?: string;
  agentBodyId?: string;
  channelSeq?: number;
  permissionsSource?: string;
  deviceOwnerUserId?: string;
  deviceOwnerSource?: string;
  channelSource?: string;
  identityTrust: IdentityTrustLevel;
  isTrusted: boolean;
}

/**
 * Opaque, short-lived connector capability delivered only with one trusted
 * CatsCo turn. It must never be rendered into model context or persisted.
 */
export interface SkillConnectorGrant {
  provider: string;
  skillId: string;
  connectorUrl: string;
  actorToken: string;
  expiresAt: number;
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
  legacyRestoreKey?: string;
  legacyCleanupKey?: string;
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
export type UserDeviceStatus = 'unknown' | 'online' | 'offline';
export type DeviceGrantStatus = 'active' | 'revoked';
export type DeviceSelectionStatus = 'selected' | 'needs_selection' | 'unavailable';
export type DeviceGrantOperation =
  | 'read_file'
  | 'resolve_common_directory'
  | 'write_file'
  | 'edit_file'
  | 'send_file'
  | 'execute_shell'
  | 'glob'
  | 'grep'
  | 'browser_control'
  | 'desktop_control'
  | 'skillhub.localWorkspace.get'
  | 'skillhub.localWorkspace.pagination.v1'
  | 'skillhub.localWorkspace.applyDefinition'
  | 'skillhub.localWorkspace.syncToAgent'
  | 'skillhub.localSkill.share'
  | 'skillhub.publication.sourceProbe.v1'
  | 'skillhub.publication.capture.v1'
  | 'skillhub.publication.verifyRepairSource.v1'
  | 'skillhub.publication.upload.v1'
  | 'skillhub.localSkill.finalize'
  | 'skillhub.localSkill.delete'
  | 'skillhub.localBot.switch'
  | 'knowledge.document.list'
  | 'knowledge.document.read';

export interface ScopedLocalDeviceGrant {
  kind: 'catscompany_body';
  source: MessageSource;
  ownerUserId?: string;
  bodyId: string;
  installationId?: string;
  deviceId?: string;
  capabilities?: DeviceGrantOperation[];
  createdAt: number;
}

export interface UserDevice {
  kind: 'user_device';
  source: MessageSource;
  ownerUserId: string;
  deviceId: string;
  displayName?: string;
  bodyId?: string;
  installationId?: string;
  identityTrust: IdentityTrustLevel;
  identitySource?: string;
  status: UserDeviceStatus;
  registeredAt: number;
  lastSeenAt?: number;
}

export interface ScopedDeviceGrant {
  targetScope?: 'explicit_device';
  selectionRevision?: string;
  kind: 'user_device_grant';
  source: MessageSource;
  grantId: string;
  status: DeviceGrantStatus;
  identityTrust: IdentityTrustLevel;
  identitySource?: string;
  deviceId: string;
  deviceDisplayName?: string;
  deviceBodyId?: string;
  deviceInstallationId?: string;
  ownerUserId: string;
  sessionKey: string;
  topicId: string;
  topicType: MessageTopicType;
  actorUserId: string;
  agentId?: string;
  agentBodyId?: string;
  operations: DeviceGrantOperation[];
  createdAt: number;
  expiresAt: number;
}

export interface DeviceSelectionCandidate {
  os?: string;
  status?: 'ready' | 'unavailable';
  deviceId: string;
  displayName?: string;
  operations?: DeviceGrantOperation[];
  lastSeenAt?: number;
}

export interface ScopedDeviceSelection {
  revision?: string;
  kind: 'user_device_selection';
  source: MessageSource;
  status: DeviceSelectionStatus;
  selectionSource?: string;
  sessionKey: string;
  topicId: string;
  topicType: MessageTopicType;
  actorUserId: string;
  agentId?: string;
  identityTrust: IdentityTrustLevel;
  identitySource?: string;
  selectedDeviceId?: string;
  selectedDeviceDisplayName?: string;
  selectedDeviceBodyId?: string;
  selectedDeviceInstallationId?: string;
  selectedDeviceOperations?: DeviceGrantOperation[];
  candidates?: DeviceSelectionCandidate[];
  candidateCount?: number;
  createdAt?: number;
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
