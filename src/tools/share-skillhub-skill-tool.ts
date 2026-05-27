import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { SkillHubService } from '../skillhub/service';

export class ShareSkillHubSkillTool implements Tool {
  definition: ToolDefinition = {
    name: 'share_skillhub_skill',
    description: [
      'Share one installed local Skill to SkillHub for cloud publishing.',
      'Use this only after the user clearly names the local skill they want to share.',
      'Input skillName must be the local skill name, for example remotion-best-practices.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        skillName: {
          type: 'string',
          description: 'Local skill name to share.',
        },
        notes: {
          type: 'string',
          description: 'Optional short note for the SkillHub submission.',
        },
      },
      required: ['skillName'],
    },
  };

  async execute(args: any, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
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
      });
      const submission = result?.submission || {};
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
