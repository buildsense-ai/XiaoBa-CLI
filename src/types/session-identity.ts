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
export type UserDeviceStatus = 'unknown' | 'online' | 'offline';
export type DeviceGrantStatus = 'active' | 'revoked';
export type DeviceSelectionStatus = 'selected' | 'needs_selection' | 'unavailable';
export type DeviceGrantOperation =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'send_file'
  | 'execute_shell'
  | 'glob'
  | 'grep'
  | 'browser_control'
  | 'desktop_control';

export interface ScopedLocalDeviceGrant {
  kind: 'catscompany_body';
  source: MessageSource;
  bodyId: string;
  installationId?: string;
  deviceId?: string;
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
  deviceId: string;
  displayName?: string;
  operations?: DeviceGrantOperation[];
  lastSeenAt?: number;
}

export interface ScopedDeviceSelection {
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
