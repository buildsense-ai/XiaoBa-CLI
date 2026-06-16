import { PlanStepStatus, RuntimePlanSnapshot } from '../core/plan-runtime';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';

const STATUS_LABELS: Record<PlanStepStatus, string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
};

export class UpdatePlanTool implements Tool {
  definition: ToolDefinition = {
    name: 'update_plan',
    description: [
      '创建、更新或清空当前任务的临时运行时计划卡片。',
      '每次更新都传完整 steps 列表；每个步骤状态只能是 pending、in_progress 或 completed。',
      '计划卡片是运行时 UI 状态，不是长期会话历史。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: '完整计划步骤列表。每次调用都传当前完整列表，而不是只传变化项。',
          items: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: '步骤内容，应简短、具体、可执行。',
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: '步骤状态。',
              },
            },
            required: ['text', 'status'],
          },
        },
        clear: {
          type: 'boolean',
          description: '清空当前临时计划。通常只有任务取消、重置或明确不再需要计划时使用。',
        },
      },
      required: [],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (!context.planRuntime) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: 'update_plan 当前会话没有可用的 plan runtime。',
      };
    }

    let snapshot: RuntimePlanSnapshot;
    try {
      snapshot = context.planRuntime.update({
        steps: normalizeInputSteps(args?.steps),
        clear: Boolean(args?.clear),
      });
    } catch (error: any) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: `计划更新失败：${error.message}`,
      };
    }

    let planUiWarning = '';
    if (context.channel?.sendRuntimePlan) {
      try {
        await context.channel.sendRuntimePlan(context.channel.chatId, snapshot);
      } catch (error: any) {
        planUiWarning = `\n注意：计划已更新，但计划卡片推送失败：${error.message}`;
      }
    }

    return {
      ok: true,
      content: `${formatPlanResult(snapshot)}${planUiWarning}`,
    };
  }
}

function normalizeInputSteps(value: unknown): Array<{ text: string; status: PlanStepStatus }> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('steps 必须是数组');
  }
  return value.map(step => ({
    text: String(step?.text || ''),
    status: String(step?.status || 'pending') as PlanStepStatus,
  }));
}

function formatPlanResult(snapshot: RuntimePlanSnapshot): string {
  if (snapshot.steps.length === 0) {
    return '计划已清空';
  }
  const completed = snapshot.steps.filter(step => step.status === 'completed').length;
  const active = snapshot.steps.filter(step => step.status === 'in_progress');
  const lines = snapshot.steps.map((step, index) => `${index + 1}. ${STATUS_LABELS[step.status]} - ${step.text}`);
  return [
    `计划已更新：${completed}/${snapshot.steps.length} 已完成`,
    active.length > 0 ? `进行中：${active.map(step => step.text).join('；')}` : '',
    ...lines,
  ].filter(Boolean).join('\n');
}
