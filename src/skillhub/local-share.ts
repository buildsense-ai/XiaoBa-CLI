import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
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
  createSkillHubService?: () => Pick<SkillHubService, 'loginWithCatsCo' | 'shareLocalSkill'>;
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
    const rejected: Array<{ localSkillId: string; error: Error }> = [];
    let selectedSkill;
    try {
      selectedSkill = expectedLocalSkillId
        ? scanBotSkillWorkspace(context.skillsRoot, {
          onValidationFailure: failure => rejected.push(failure),
        }).find(candidate => candidate.localSkillId === expectedLocalSkillId)
        : undefined;
    } catch {
      throw skillHubConflict(
        'The selected local Skill could not be validated safely.',
        'skillhub.share_local_skill_invalid',
      );
    }
    if (expectedLocalSkillId) {
      const rejectedSkill = rejected.find(candidate => (
        candidate.localSkillId === expectedLocalSkillId
      ));
      if (rejectedSkill) {
        throw skillHubConflict(
          rejectedSkill.error.message,
          'skillhub.share_local_skill_invalid',
        );
      }
      if (!selectedSkill) {
        throw skillHubConflict(
          'The selected local Skill changed before it could be shared.',
          'skillhub.share_local_skill_changed',
        );
      }
      const metadataError = validateSkillHubShareMetadata(selectedSkill.path);
      if (metadataError) {
        throw skillHubConflict(
          metadataError.message,
          'skillhub.share_local_skill_invalid',
        );
      }
      if (selectedSkill.name !== skillName) {
        throw skillHubConflict(
          'The selected local Skill changed before it could be shared.',
          'skillhub.share_local_skill_changed',
        );
      }
    }
    const cats = await options.getCatsCoAuth!();
    if (String(cats.user?.uid || '').trim() !== expectedUserUid) {
      throw skillHubConflict(
        'The local CatsCo account changed before the Skill was shared.',
        'skillhub.share_user_changed',
      );
    }
    const service = options.createSkillHubService?.()
      ?? new SkillHubService({ sessionScope: 'memory' });
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
      let currentSkill;
      try {
        currentSkill = scanBotSkillWorkspace(context.skillsRoot, {
          onValidationFailure: () => {},
        }).find((candidate) => (
          candidate.localSkillId === selectedSkill.localSkillId
          && candidate.name === selectedSkill.name
        ));
      } catch {
        throw skillHubConflict(
          'The selected local Skill could not be validated safely.',
          'skillhub.share_local_skill_invalid',
        );
      }
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

export function validateSkillHubShareMetadata(skillDir: string): Error | undefined {
  try {
    const skillFile = path.join(skillDir, 'SKILL.md');
    const parsed = matter(fs.readFileSync(skillFile, 'utf8'), {});
    const name = parsed.data?.name;
    const description = parsed.data?.description;
    if (typeof name === 'string' && name.trim() && name !== name.trim()) {
      return new Error('SKILL.md 的 name 不能包含首尾空格。请移除多余空格后重试。');
    }
    if (
      typeof name !== 'string'
      || !name.trim()
      || typeof description !== 'string'
      || !description.trim()
    ) {
      return new Error(
        'SKILL.md 缺少有效的必填字段 name 或 description。请在文件顶部的 YAML frontmatter 中填写非空文本后重试。',
      );
    }
    return undefined;
  } catch {
    return new Error('SKILL.md 格式无效。请检查文件顶部的 YAML frontmatter 后重试。');
  }
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
