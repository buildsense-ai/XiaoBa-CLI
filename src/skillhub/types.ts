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
}

export interface SkillHubInstallResult {
  ok: true;
  skill: {
    skillId: string;
    name: string;
    version: string;
    path: string;
  };
  signingKeyId: string;
  rootKeyId: string;
}

export interface SkillHubPackageInstallMarker {
  source: 'skillhub';
  skillId: string;
  name: string;
  version: string;
  packageChecksumSha256: string;
  signature: VerifierRegistryEntry['signature'];
  packageUrl: string;
  installedAt: string;
}

export type SkillHubRegistryEntry = VerifierRegistryEntry & {
  contentHash?: string;
};
export type { SkillHubTrustResponse };
