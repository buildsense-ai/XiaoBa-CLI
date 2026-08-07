import * as path from 'path';
import {
  withCurrentBotSkillWorkspaceWrite,
  type CurrentBotSkillWorkspaceWriteContext,
} from '../bot-skills/runtime';
import { scanBotSkillWorkspace } from '../bot-skills/local-manifest';
import { writeSkillHubLocalMetadata } from './local-skill-metadata';
import { SkillHubService } from './service';

export interface SkillHubCatsCoAuthPayload {
  token: string;
  baseUrl: string;
  user?: {
    uid?: string;
    username?: string;
    displayName?: string;
  };
}

export interface ShareLocalSkillForCatsCoOptions {
  getCatsCoAuth?: () => Promise<SkillHubCatsCoAuthPayload> | SkillHubCatsCoAuthPayload;
  writeLocalMetadata?: boolean;
  runtimeRoot?: string;
  validateScope?: (
    context: CurrentBotSkillWorkspaceWriteContext,
  ) => Promise<void> | void;
}

export async function shareLocalSkillForCatsCo(
  input: any,
  options: ShareLocalSkillForCatsCoOptions = {},
): Promise<any> {
  const expectedBotUid = String(input?.expectedBotUid || '').trim();
  const expectedUserUid = String(input?.expectedUserUid || '').trim();
  const expectedLocalSkillId = String(input?.expectedLocalSkillId || '').trim();
  const skillName = String(input?.skillName || input?.skill || input?.name || '').trim();
  if (Boolean(expectedBotUid) !== Boolean(expectedUserUid)) {
    throw skillHubConflict(
      'expectedBotUid and expectedUserUid must be provided together.',
      'skillhub.share_scope_incomplete',
    );
  }

  if (!expectedBotUid) {
    return new SkillHubService().shareLocalSkill(input, {
      writeLocalMetadata: options.writeLocalMetadata,
    });
  }
  if (!options.getCatsCoAuth) {
    const error: any = new Error('CatsCo SkillHub login is not configured');
    error.status = 501;
    error.code = 'skillhub.catsco_exchange_unavailable';
    throw error;
  }

  const preflightCats = await options.getCatsCoAuth();
  if (String(preflightCats.user?.uid || '').trim() !== expectedUserUid) {
    throw skillHubConflict(
      'The local CatsCo account changed before the Skill was shared.',
      'skillhub.share_user_changed',
    );
  }

  return withCurrentBotSkillWorkspaceWrite(async (context) => {
    assertExpectedLocalSkillShareScope(expectedBotUid, context.botId, context.activeBotId);
    await options.validateScope?.(context);
    const selectedSkill = expectedLocalSkillId
      ? scanBotSkillWorkspace(context.skillsRoot, {
        onValidationFailure: () => {},
      }).find((candidate) => (
        candidate.localSkillId === expectedLocalSkillId && candidate.name === skillName
      ))
      : undefined;
    if (expectedLocalSkillId) {
      if (!selectedSkill) {
        throw skillHubConflict(
          'The selected local Skill changed before it could be shared.',
          'skillhub.share_local_skill_changed',
        );
      }
    }
    const cats = await options.getCatsCoAuth!();
    const service = new SkillHubService({ sessionScope: 'memory' });
    const skillHubAuth = await service.loginWithCatsCo(cats);
    const actualUserUid = String(skillHubAuth.catsCo?.uid || '').trim();
    if (!actualUserUid) {
      throw skillHubConflict(
        'SkillHub did not return the CatsCo identity for the exchanged session.',
        'skillhub.share_identity_unavailable',
      );
    }
    if (actualUserUid !== expectedUserUid) {
      throw skillHubConflict(
        'The local CatsCo account changed before the Skill was shared.',
        'skillhub.share_user_changed',
      );
    }
    const result = await service.shareLocalSkill(input, {
      writeLocalMetadata: false,
      ...(selectedSkill ? { localSkillPath: selectedSkill.path } : {}),
    });
    let revalidatedSkill = selectedSkill;
    if (selectedSkill) {
      const currentSkill = scanBotSkillWorkspace(context.skillsRoot, {
        onValidationFailure: () => {},
      }).find((candidate) => (
        candidate.localSkillId === selectedSkill.localSkillId
        && candidate.name === selectedSkill.name
      ));
      if (!currentSkill || currentSkill.contentHash !== selectedSkill.contentHash) {
        throw skillHubConflict(
          'The selected local Skill changed while it was being shared.',
          'skillhub.share_local_skill_changed',
        );
      }
      revalidatedSkill = currentSkill;
    }
    await options.validateScope?.(context);
    if (result?.skillHub && options.writeLocalMetadata !== false) {
      const localSkillPath = revalidatedSkill?.path || String(result?.skill?.path || '').trim();
      writeSkillHubLocalMetadata(path.join(localSkillPath, 'SKILL.md'), result.skillHub);
    }
    return { ...result, botUid: expectedBotUid };
  }, { runtimeRoot: options.runtimeRoot });
}

export function assertExpectedLocalSkillShareScope(
  expectedBotUid: string,
  configuredBotUid?: string,
  activeBotUid?: string,
): void {
  if (configuredBotUid !== expectedBotUid || activeBotUid !== expectedBotUid) {
    throw skillHubConflict(
      'The active Bot Skill workspace changed before the Skill was shared.',
      'skillhub.share_bot_changed',
    );
  }
}

function skillHubConflict(message: string, code: string): Error {
  const error: any = new Error(message);
  error.status = 409;
  error.code = code;
  return error;
}
