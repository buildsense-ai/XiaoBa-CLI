import type { CatsCoAuthSnapshot } from '../catscompany/local-config';
import {
  patchCloudBotDefinitionSkills,
  pullCloudBotDefinition,
} from '../bot-definition/cloud-client';
import type { BotDefinition, BotSkillRef } from '../bot-definition/types';
import { canonicalizeBotSkillRefs } from './canonical';

export interface CloudBotSkills {
  botId: string;
  skills: BotSkillRef[];
  revision: number;
  definition?: BotDefinition;
  updatedAt?: string;
}

export interface BotSkillsCloudClientOptions {
  botId: string;
  auth: CatsCoAuthSnapshot;
  fetchImpl?: typeof fetch;
}

export class BotSkillsCloudConflictError extends Error {
  constructor(message: string, public readonly currentRevision?: number) {
    super(message);
    this.name = 'BotSkillsCloudConflictError';
  }
}

export async function pullCloudBotSkills(
  options: BotSkillsCloudClientOptions,
): Promise<CloudBotSkills | undefined> {
  const snapshot = await pullCloudBotDefinition(options);
  if (!snapshot) return undefined;
  if (!snapshot.configured || !snapshot.definition) {
    return {
      botId: String(options.botId).trim(),
      skills: [],
      revision: snapshot.revision,
    };
  }
  if (snapshot.definition.skills === undefined) return undefined;
  return {
    botId: snapshot.definition.botId,
    skills: canonicalizeBotSkillRefs(snapshot.definition.skills),
    revision: snapshot.revision,
    definition: snapshot.definition,
    ...(typeof snapshot.runtime?.updatedAt === 'string'
      ? { updatedAt: snapshot.runtime.updatedAt }
      : {}),
  };
}

export async function replaceCloudBotSkills(
  options: BotSkillsCloudClientOptions,
  current: Pick<CloudBotSkills, 'revision'>,
  skills: readonly BotSkillRef[],
): Promise<CloudBotSkills> {
  let revision: number | undefined;
  try {
    revision = await patchCloudBotDefinitionSkills(
      options,
      canonicalizeBotSkillRefs(skills),
      current.revision,
    );
  } catch (error) {
    if ((error as { status?: number } | undefined)?.status === 409) {
      throw new BotSkillsCloudConflictError(
        error instanceof Error ? error.message : String(error),
        current.revision,
      );
    }
    throw error;
  }
  if (revision === undefined) {
    throw new Error('CatsCo cloud does not support BotDefinition skills.');
  }
  const latest = await pullCloudBotSkills(options);
  if (!latest || latest.revision !== revision) {
    throw new Error('CatsCo cloud BotDefinition could not be verified after updating skills.');
  }
  return latest;
}
