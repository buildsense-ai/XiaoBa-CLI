import type { BotSkillRef } from '../bot-definition/types';

export interface SkillHubPackageRef {
  skillId: string;
  version: string;
}

export interface BotSkillLocalMarker {
  schema: 'xiaoba.bot-skill-local.v1';
  localSkillId: string;
  reference?: BotSkillRef;
  origin?: SkillHubPackageRef;
}

export interface BotSkillPackageFile {
  path: string;
  size: number;
  sha256: string;
  contentBase64: string;
}

export interface BotSkillHubInstallMetadata {
  packageChecksumSha256: string;
  signature: {
    algorithm: 'ed25519';
    keyId: string;
    signature: string;
    signedAt?: string;
  };
  packageUrl: string;
}

export interface LocalBotSkillManifestEntry {
  localSkillId: string;
  name: string;
  installName: string;
  path: string;
  contentHash: string;
  files: BotSkillPackageFile[];
  reference?: BotSkillRef;
  origin?: SkillHubPackageRef;
}

export interface BotSkillPackage {
  schema: 'catsco.private-skill-package.v1';
  source?: 'private' | 'public';
  reference: SkillHubPackageRef;
  localSkillId: string;
  name: string;
  contentHash: string;
  createdAt: string;
  skillHubInstall?: BotSkillHubInstallMetadata;
  /**
   * Set when the public catalogue entry for a Definition-pinned Skill was
   * withdrawn (SkillHub metadata 404) and the Bot-scoped package store still
   * served the exact contentHash the Definition requires. The restore installs
   * that copy without public signature metadata instead of failing forever;
   * the caller logs the degradation and the public install marker stays
   * absent, so trusted script entry points stay disabled for the Skill.
   */
  publicMetadataUnavailable?: true;
  origin?: SkillHubPackageRef;
  files: BotSkillPackageFile[];
}

export interface BotSkillSyncBaseEntry {
  localSkillId: string;
  name: string;
  installName: string;
  contentHash: string;
  reference: BotSkillRef;
  origin?: SkillHubPackageRef;
}

export interface BotSkillSyncBase {
  schema: 'xiaoba.bot-skill-sync-base.v2';
  botId: string;
  definitionRevision: number;
  skills: BotSkillSyncBaseEntry[];
  updatedAt: string;
}
