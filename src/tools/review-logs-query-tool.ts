import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { AIService } from '../utils/ai-service';
import { answerReviewQuestion } from '../utils/catsco-review-question-answerer';
import { loadReviewQuestionContext } from '../utils/catsco-review-question-context';

function readPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

export class ReviewLogsQueryTool implements Tool {
  definition: ToolDefinition = {
    name: 'review_logs_query',
    description: [
      '基于 CatsCo Review API 的脱敏云端日志回答问题。用于用户询问 Agent 使用频率、老师问了什么、主要用途、失败原因、工具调用、改进建议等日志相关问题。',
      '这是只读工具；每次调用都会拉取截至当前时刻的最新日志时间范围，不创建 proposal、不提交 PR。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要基于云端 Review 日志回答的自然语言问题。',
        },
        lookback_hours: {
          type: 'number',
          description: '向前查看多少小时的日志。默认使用 CATSCO_REVIEW_LOOKBACK_HOURS，当前建议默认一周。',
        },
        user_key: {
          type: 'string',
          description: '可选。只分析某个 Review API 返回的匿名 user_key。',
        },
        device_key: {
          type: 'string',
          description: '可选。只分析某个 Review API 返回的匿名 device_key。',
        },
        user_id: {
          type: 'string',
          description: '可选。按云端原始 user_id 过滤；仅作为查询条件，不写入回答证据。',
        },
        device_id: {
          type: 'string',
          description: '可选。按云端原始 device_id 过滤；仅作为查询条件，不写入回答证据。',
        },
        device_name: {
          type: 'string',
          description: '可选。按云端原始 device_name 过滤；仅作为查询条件，不写入回答证据。',
        },
        session_id: {
          type: 'string',
          description: '可选。按云端原始 session_id 过滤；仅作为查询条件，不写入回答证据。',
        },
        session_key: {
          type: 'string',
          description: '可选。只分析某个 Review API 返回的匿名 session_key。',
        },
        session_type: {
          type: 'string',
          description: '可选。只分析某类 session_type。',
        },
        org_key: {
          type: 'string',
          description: '可选。只分析某个 org_key，例如某个学校或客户。',
        },
        org_type: {
          type: 'string',
          description: '可选。只分析某类组织，例如 school。',
        },
        user_role: {
          type: 'string',
          description: '可选。只分析某类 user_role。',
        },
        device_role: {
          type: 'string',
          description: '可选。只分析某类 device_role。',
        },
        channel_type: {
          type: 'string',
          description: '可选。只分析某类 channel_type。',
        },
        workspace_key: {
          type: 'string',
          description: '可选。只分析某个 workspace_key。',
        },
        max_evidence_items: {
          type: 'number',
          description: '可选。传给模型的最大证据条数。',
        },
        max_evidence_chars: {
          type: 'number',
          description: '可选。传给模型的最大证据字符数；大范围分析时可提高。',
        },
        max_sessions: {
          type: 'number',
          description: '可选。最多拉取多少个 session；问题需要覆盖更多日志时可提高。',
        },
        max_turns_per_session: {
          type: 'number',
          description: '可选。每个 session 最多拉取多少个 turn。',
        },
        max_target_turns: {
          type: 'number',
          description: '可选。使用目标过滤时最多拉取多少条顶层 turns。',
        },
      },
      required: ['question'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const question = String(args?.question || '').trim();
    if (!question) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: 'question 不能为空',
      };
    }

    try {
      const reviewContext = await loadReviewQuestionContext({
        cwd: context.workingDirectory || process.cwd(),
        lookbackHours: readPositiveInteger(args?.lookback_hours),
        targetUserId: stringOrUndefined(args?.user_id),
        targetDeviceId: stringOrUndefined(args?.device_id),
        targetDeviceName: stringOrUndefined(args?.device_name),
        targetUserKey: stringOrUndefined(args?.user_key),
        targetDeviceKey: stringOrUndefined(args?.device_key),
        targetSessionId: stringOrUndefined(args?.session_id),
        targetSessionKey: stringOrUndefined(args?.session_key),
        targetSessionType: stringOrUndefined(args?.session_type),
        targetOrgKey: stringOrUndefined(args?.org_key),
        targetOrgType: stringOrUndefined(args?.org_type),
        targetUserRole: stringOrUndefined(args?.user_role),
        targetDeviceRole: stringOrUndefined(args?.device_role),
        targetChannelType: stringOrUndefined(args?.channel_type),
        targetWorkspaceKey: stringOrUndefined(args?.workspace_key),
        maxSessions: readPositiveInteger(args?.max_sessions),
        maxTurnsPerSession: readPositiveInteger(args?.max_turns_per_session),
        maxTargetTurns: readPositiveInteger(args?.max_target_turns),
      });
      const aiService = context.runtimeServices?.aiService || new AIService();
      const answer = await answerReviewQuestion(question, reviewContext, aiService, {
        maxEvidenceItems: readPositiveInteger(args?.max_evidence_items),
        maxEvidenceChars: readPositiveInteger(args?.max_evidence_chars),
      });
      return { ok: true, content: answer || '没有从已加载的 Review 日志证据中得到回答。' };
    } catch (error: any) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `Review 日志查询失败: ${error.message}`,
      };
    }
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = String(value || '').trim();
  return text || undefined;
}
