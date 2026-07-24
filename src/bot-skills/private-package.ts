import type { BotSkillReference } from '../bot-definition/types';
import type { BotSkillSourceSnapshot } from './source-snapshot';

export interface BotPrivateSkillOrigin {
  skillId: string;
  version: string;
}

export interface BotPrivateSkillUpsertInput {
  localSkillId: string;
  name: string;
  snapshot: BotSkillSourceSnapshot;
  origin?: BotPrivateSkillOrigin;
}

export interface BotPrivateSkillVersion {
  reference: BotSkillReference;
  localSkillId: string;
  name: string;
  contentHash: string;
  createdAt: string;
  origin?: BotPrivateSkillOrigin;
}

export interface BotSkillDownloadedPackage extends BotPrivateSkillVersion {
  files: Array<{
    path: string;
    size: number;
    sha256: string;
    bytes: Buffer;
  }>;
}

export interface BotPrivateSkillPackageClient {
  upsert(input: BotPrivateSkillUpsertInput): Promise<BotPrivateSkillVersion>;
  download(reference: BotSkillReference): Promise<BotSkillDownloadedPackage>;
}
