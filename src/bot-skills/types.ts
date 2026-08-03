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
