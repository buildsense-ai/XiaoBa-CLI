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
  userId?: string;
  skillId: string;
  name: string;
  installName: string;
  version: string;
  packageChecksumSha256: string;
  signature: VerifierRegistryEntry['signature'];
  packageUrl: string;
  installedAt: string;
}

export type SkillHubRegistryEntry = VerifierRegistryEntry & {
  contentHash?: string;
  description?: string;
  categories?: string[];
  tags?: string[];
  permissions?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  riskLevel?: string;
};

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
