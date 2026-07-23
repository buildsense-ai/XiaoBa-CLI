import type { BotSkillRef } from '../bot-definition/types';
import type { SimulatedSkillArtifact } from './simulated-artifact-store';

export interface BotSkillArtifactTransportContext {
  botId: string;
  workspaceId: string;
}

export interface BotSkillPrivateUploadInput extends BotSkillArtifactTransportContext {
  artifact: SimulatedSkillArtifact;
  forkedFrom?: BotSkillRef;
}

/**
 * Remote transport boundary for Bot Skill synchronization.
 *
 * Production uses Bot-authenticated SkillHub private storage. Tests may inject a
 * deterministic fake. The transport must return only fully downloaded and
 * signature-verified artifacts; the sync service commits Definition/Base after
 * this promise resolves.
 */
export interface BotSkillArtifactTransport {
  upsertPrivate(input: BotSkillPrivateUploadInput): Promise<SimulatedSkillArtifact>;
  fetchVerified(
    ref: BotSkillRef,
    context: BotSkillArtifactTransportContext,
  ): Promise<SimulatedSkillArtifact>;
}
