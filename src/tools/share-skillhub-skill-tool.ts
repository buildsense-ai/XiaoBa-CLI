import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { SkillHubService } from '../skillhub/service';
import {
  isCatsCoLocalOwnerSelfContext,
  isCatsCoToolGatewayContext,
} from './tool-gateway';

export class ShareSkillHubSkillTool implements Tool {
  definition: ToolDefinition = {
    name: 'share_skillhub_skill',
    description: [
      'Share one installed local Skill to SkillHub for cloud publishing.',
      'Use this only after the user clearly names the local skill they want to share.',
      'Input skillName should be the local Skill name, for example remotion.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        skillName: {
          type: 'string',
          description: 'Local skill name or local skill folder name to share.',
        },
        notes: {
          type: 'string',
          description: 'Optional short note for the SkillHub submission.',
        },
        confirmPublish: {
          type: 'boolean',
          description: 'Set true only after the user confirms publishing a new patch version for same-name changed content.',
        },
      },
      required: ['skillName'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (
      isCatsCoToolGatewayContext(context)
      && !isCatsCoLocalOwnerSelfContext(context)
    ) {
      return {
        ok: false,
        errorCode: 'PERMISSION_DENIED',
        message: 'Only the local CatsCo owner can share local Skills to SkillHub.',
        retryable: false,
      };
    }

    const skillName = String(args?.skillName || args?.skill || args?.name || '').trim();
    if (!skillName) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: 'skillName required',
      };
    }

    try {
      const service = new SkillHubService();
      const result = await service.shareLocalSkill({
        skillName,
        notes: args?.notes,
        confirmPublish: args?.confirmPublish === true,
      });
      const submission = result?.submission || {};
      if (result?.requiresConfirmation) {
        return {
          ok: true,
          content: [
            'SkillHub share needs user confirmation.',
            `Skill: ${result?.skill?.name || skillName}`,
            `Path: ${result?.skill?.path || ''}`,
            result?.latestVersion ? `Latest version: ${result.latestVersion}` : '',
            'A SkillHub skill with the same name already exists, but the local content is different.',
            'Ask the user to confirm publishing a new patch version before calling this tool again with confirmPublish=true.',
          ].filter(Boolean).join('\n'),
        };
      }
      if (result?.existing) {
        return {
          ok: true,
          content: [
            'SkillHub already has this exact Skill content.',
            `Skill: ${result?.skill?.name || skillName}`,
            result?.latestVersion ? `Version: ${result.latestVersion}` : '',
          ].filter(Boolean).join('\n'),
        };
      }
      const submissionId = submission.id || submission.submissionId || 'unknown';
      return {
        ok: true,
        content: [
          'SkillHub share submitted.',
          `Skill: ${result?.skill?.name || skillName}`,
          `Path: ${result?.skill?.path || ''}`,
          `Submission: ${submissionId}`,
          submission.status ? `Status: ${submission.status}` : '',
        ].filter(Boolean).join('\n'),
      };
    } catch (error: any) {
      return {
        ok: false,
        errorCode: error?.code || 'SKILLHUB_SHARE_FAILED',
        message: error?.message || String(error),
        retryable: Number(error?.status || 0) >= 500,
      };
    }
  }
}
