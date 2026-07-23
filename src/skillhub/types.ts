import type {
  SkillHubRegistryEntry as VerifierRegistryEntry,
  SkillHubTrustResponse,
} from './package-verifier';

export interface SkillHubUser {
  id: string;
  email: string;
  displayName: string;
  status?: string;
  emailVerified?: boolean;
}

export interface SkillHubAuthState {
  authenticated: boolean;
  baseUrl: string;
  user?: SkillHubUser;
  roles: string[];
  permissions: string[];
  developerProfile?: any;
}

export interface SkillHubSearchResponse {
  skills: SkillHubRegistryEntry[];
}

export interface SkillHubSkillDetailResponse {
  skill?: SkillHubRegistryEntry;
  version?: SkillHubRegistryEntry;
  versions?: SkillHubRegistryEntry[];
}

export interface SkillHubDeveloperDashboard {
  authenticated: boolean;
  user?: SkillHubUser;
  roles: string[];
  permissions: string[];
  developerProfile?: any;
  application?: any;
  submissions: any[];
  packageVersions?: SkillHubRegistryEntry[];
}

export interface SkillHubInstallResult {
  ok: true;
  skill: {
    skillId: string;
    name: string;
    version: string;
    path: string;
    installName: string;
    action: 'installed' | 'updated' | 'unchanged';
  };
  signingKeyId: string;
  rootKeyId: string;
}

export type SkillHubSubscriptionScope =
  | { kind: 'user'; userId: string }
  | { kind: 'runtime' };

export interface SkillHubPackageInstallMarker {
  source: 'skillhub';
  visibility?: 'public' | 'private';
  userId?: string;
  ownerBotId?: string;
  localSkillId?: string;
  skillId: string;
  name: string;
  installName: string;
  version: string;
  packageChecksumSha256: string;
  /** Hash of the installed editable tree at the time this package was committed. */
  installedContentHash?: string;
  signature: VerifierRegistryEntry['signature'];
  packageUrl: string;
  installedAt: string;
}

export type SkillHubRegistryEntry = VerifierRegistryEntry & {
  visibility?: 'public' | 'private';
  ownerBotId?: string;
  localSkillId?: string;
  installName?: string;
  contentHash?: string;
  description?: string;
  categories?: string[];
  tags?: string[];
  permissions?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  riskLevel?: string;
};

export interface SkillHubBotCredential {
  botId: string;
  apiKey: string;
}

export interface SkillHubPrivateUpsertInput {
  botId: string;
  workspaceId: string;
  localSkillId: string;
  contentHash: string;
  name: string;
  installName: string;
  forkedFrom?: { skillId: string; version: string };
  files: Array<{
    path: string;
    size: number;
    sha256: string;
    contentBase64: string;
  }>;
}

export interface SkillHubPrivateSkillResponse {
  skill: SkillHubRegistryEntry & {
    visibility: 'private';
    ownerBotId: string;
    localSkillId: string;
    installName: string;
    contentHash: string;
  };
}

export interface UserSkillSubscription {
  skillId: string;
  name: string;
  installName: string;
  versionPolicy: 'latest';
  resolvedVersion: string;
  subscribedAt: string;
  updatedAt: string;
}
export type { SkillHubTrustResponse };
