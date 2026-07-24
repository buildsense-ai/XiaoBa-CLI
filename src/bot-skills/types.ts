export const BOT_SKILL_WORKSPACE_SCHEMA = 'xiaoba.bot-skill-workspace.v1';
export const BOT_LOCAL_SKILL_SCHEMA = 'xiaoba.local-skill.v1';
export const BOT_SKILL_SYNC_BASE_SCHEMA = 'xiaoba.bot-skill-sync-base.v1';

export interface BotSkillWorkspaceIdentity {
  schema: typeof BOT_SKILL_WORKSPACE_SCHEMA;
  workspaceId: string;
  workspaceOwnerBotId: string;
  /**
   * Stable server/account namespace. It prevents a Bot id from another
   * CatsCo deployment or account being mistaken for the same owner.
   */
  authority?: string;
  ownerUserId?: string;
  createdAt: string;
}

export interface BotLocalSkillIdentity {
  schema: typeof BOT_LOCAL_SKILL_SCHEMA;
  localSkillId: string;
  createdAt: string;
}

export interface BotLocalSkillSnapshot {
  localSkillId: string;
  name: string;
  directoryName: string;
  directoryPath: string;
  skillFilePath: string;
  contentHash: string;
  cloudOrigin?: {
    skillId: string;
    version: string;
  };
}

export interface BotSkillSyncBaseEntry {
  localSkillId: string;
  localContentHash: string;
  cloudSkillId: string;
  cloudVersion: string;
}

export interface BotSkillSyncBase {
  schema: typeof BOT_SKILL_SYNC_BASE_SCHEMA;
  botId: string;
  workspaceId: string;
  authority?: string;
  definitionETag?: string;
  entries: BotSkillSyncBaseEntry[];
  updatedAt: string;
}

export type BotSkillWorkspaceInspection =
  | { kind: 'missing'; root: string }
  | { kind: 'unowned'; root: string; skillCount: number }
  | { kind: 'owner_mismatch'; root: string; identity: BotSkillWorkspaceIdentity }
  | { kind: 'unreadable'; root: string; error: string }
  | {
      kind: 'valid';
      root: string;
      identity: BotSkillWorkspaceIdentity;
      skills: BotLocalSkillSnapshot[];
    };

export type BotSkillSyncBaseReadResult =
  | { kind: 'missing' }
  | { kind: 'corrupt'; error: string }
  | { kind: 'valid'; base: BotSkillSyncBase };
