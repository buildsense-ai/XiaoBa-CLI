import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { SubAgentManager } from '../core/sub-agent-manager';

export class WaitSubagentsTool implements Tool {
  definition: ToolDefinition = {
    name: 'wait_subagents',
    description: [
      '等待当前会话下一个或多个后台子智能体完成，并把结果摘要作为本次工具结果返回。',
      '适合已经派出子 agent，且最终回复需要整合它们结果的场景；避免反复 check_subagent 轮询。',
      '不指定 subagent_ids 时，等待调用时当前会话里所有仍在运行的子 agent。',
      '如果只是查看状态、不想等待，用 check_subagent。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        subagent_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '可选。要等待的子智能体 ID、唯一短前缀或展示名（如 子agent1）。不填则等待所有当前运行中的子 agent。',
        },
        wait_for: {
          type: 'string',
          enum: ['all', 'any'],
          description: '可选。all 等全部完成；any 等任意一个完成。默认 all。',
        },
        timeout_ms: {
          type: 'number',
          description: '可选。最长等待毫秒数，默认 120000，最大 300000。超时会返回当前状态。',
        },
      },
      required: [],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const sessionKey = context.sessionId || 'unknown';
    const refs = normalizeRefs(args?.subagent_ids);
    const waitFor = args?.wait_for === 'any' ? 'any' : 'all';
    const timeoutMs = normalizeTimeoutMs(args?.timeout_ms);

    const result = await SubAgentManager.getInstance().waitForParent(sessionKey, refs, {
      waitFor,
      timeoutMs,
      consumeResults: true,
      abortSignal: context.abortSignal,
    });

    const unknown = result.unknownRefs.length
      ? `未找到子任务引用: ${result.unknownRefs.join(', ')}\n`
      : '';
    if (result.infos.length === 0) {
      return {
        ok: true,
        content: `${unknown}当前没有需要等待的后台子任务。`.trim(),
      };
    }

    const status = result.aborted
      ? '等待已取消，以下是当前状态'
      : result.waitingForParentInput
        ? '有子任务正在等待主 agent 回复，以下是当前状态'
        : result.timedOut
          ? '等待超时，以下是当前状态'
          : '等待完成，以下是子任务结果';
    return {
      ok: true,
      content: [
        unknown.trim(),
        status,
        result.infos.map(formatInfo).join('\n\n---\n\n'),
      ].filter(Boolean).join('\n\n'),
    };
  }
}

function normalizeRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item || '').trim())
    .filter(Boolean);
}

function normalizeTimeoutMs(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.min(Math.floor(parsed), 300_000));
}

function formatInfo(info: any): string {
  const statusMap: Record<string, string> = {
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    stopped: '已停止',
    waiting_for_input: '等待主 agent 回复',
  };
  const lines = [
    `[${info.displayName || info.id}] ${info.taskDescription}`,
    info.displayName ? `ID: ${info.id}` : '',
    `状态: ${statusMap[info.status] || info.status}`,
    info.pendingQuestion ? `等待问题: ${info.pendingQuestion}` : '',
    info.resultSummary ? `结果摘要: ${String(info.resultSummary).slice(0, 1200)}` : '',
    info.outputFiles?.length ? `产出文件:\n${info.outputFiles.map((file: string) => `- ${file}`).join('\n')}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}
