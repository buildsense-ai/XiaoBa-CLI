import type { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import type { ReviewGoalCheck, ReviewTaskSpec } from './review-runtime-types';

export interface ReviewRuntimeToolController {
  proposeTask(runId: string, sessionKey: string | undefined, spec: ReviewTaskSpec): Promise<unknown>;
  recordGoalCheck(runId: string, sessionKey: string | undefined, check: ReviewGoalCheck): Promise<unknown>;
  commitTask(
    runId: string,
    sessionKey: string | undefined,
    taskId: string,
    evidenceIds: string[],
  ): Promise<unknown>;
}

export class ReviewRuntimeTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'review_runtime',
    description: [
      'Review 专用持久化编排工具。',
      '主 Reviewer 用它动态提出专项 Task、在每轮停止前记录 Goal Check，或在 Evidence Envelope 已更新后提交 Task。',
      '它不替代取证工具，也不允许 Reviewer 自行批准高风险任务。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['propose_task', 'goal_check', 'commit_task'],
          description: '本次编排动作。',
        },
        run_id: { type: 'string', description: '当前 Review Run ID。' },
        task_id: { type: 'string', description: 'commit_task 时使用。' },
        title: { type: 'string' },
        objective: { type: 'string' },
        expected_artifact: { type: 'string' },
        stop_condition: { type: 'string' },
        safety_boundary: { type: 'string' },
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        approval_required: { type: 'boolean' },
        agent_type: { type: 'string', enum: ['explorer', 'reviewer', 'worker', 'tester'] },
        skill_name: { type: 'string' },
        tool_scope: { type: 'string', enum: ['read_only', 'workspace_write', 'test_only'] },
        allowed_tools: { type: 'array', items: { type: 'string' } },
        max_turns: { type: 'number' },
        idempotency_key: { type: 'string' },
        complete: { type: 'boolean' },
        capabilities_exhausted: { type: 'boolean' },
        summary: { type: 'string' },
        next_action: { type: 'string' },
        next_wake_at: { type: 'string', description: '可选 ISO-8601 下次唤醒时间；未填且本轮无未完成 Task 时默认 24 小时后。' },
        blocker: { type: 'string' },
        evidence_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['action', 'run_id'],
    },
  };

  constructor(private readonly controller: ReviewRuntimeToolController) {}

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const action = requireString(args?.action, 'action');
      const runId = requireString(args?.run_id, 'run_id');
      let result: unknown;
      if (action === 'propose_task') {
        result = await this.controller.proposeTask(runId, context.sessionId, {
          title: requireString(args?.title, 'title'),
          objective: requireString(args?.objective, 'objective'),
          expectedArtifact: requireString(args?.expected_artifact, 'expected_artifact'),
          stopCondition: requireString(args?.stop_condition, 'stop_condition'),
          safetyBoundary: requireString(args?.safety_boundary, 'safety_boundary'),
          risk: parseRisk(args?.risk),
          approvalRequired: args?.approval_required !== false,
          agentType: optionalAgentType(args?.agent_type),
          skillName: optionalString(args?.skill_name),
          toolScope: optionalToolScope(args?.tool_scope),
          allowedTools: stringArray(args?.allowed_tools),
          maxTurns: optionalPositiveInteger(args?.max_turns),
          idempotencyKey: optionalString(args?.idempotency_key),
        });
      } else if (action === 'goal_check') {
        result = await this.controller.recordGoalCheck(runId, context.sessionId, {
          checkedAt: new Date().toISOString(),
          complete: args?.complete === true,
          capabilitiesExhausted: args?.capabilities_exhausted === true,
          summary: requireString(args?.summary, 'summary'),
          nextAction: optionalString(args?.next_action),
          nextWakeAt: optionalTimestamp(args?.next_wake_at, 'next_wake_at'),
          blocker: optionalString(args?.blocker),
          stopCondition: optionalString(args?.stop_condition),
        });
      } else if (action === 'commit_task') {
        result = await this.controller.commitTask(
          runId,
          context.sessionId,
          requireString(args?.task_id, 'task_id'),
          stringArray(args?.evidence_ids) || [],
        );
      } else {
        throw new Error(`Unsupported review_runtime action: ${action}`);
      }
      return { ok: true, content: JSON.stringify(result) };
    } catch (error: any) {
      return {
        ok: false,
        errorCode: 'REVIEW_RUNTIME_ERROR',
        message: String(error?.message || error || 'Review Runtime error'),
      };
    }
  }
}

function requireString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}
function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}
function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Expected an array of strings');
  return Array.from(new Set(value.map(item => requireString(item, 'array item'))));
}
function parseRisk(value: unknown): ReviewTaskSpec['risk'] {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw new Error('risk must be low, medium, or high');
}
function optionalAgentType(value: unknown): ReviewTaskSpec['agentType'] {
  if (value === undefined) return undefined;
  if (value === 'explorer' || value === 'reviewer' || value === 'worker' || value === 'tester') return value;
  throw new Error('invalid agent_type');
}
function optionalToolScope(value: unknown): ReviewTaskSpec['toolScope'] {
  if (value === undefined) return undefined;
  if (value === 'read_only' || value === 'workspace_write' || value === 'test_only') return value;
  throw new Error('invalid tool_scope');
}
function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('max_turns must be a positive integer');
  return parsed;
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  const text = optionalString(value);
  if (!text) return undefined;
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error(`${field} must be an ISO-8601 timestamp`);
  return new Date(milliseconds).toISOString();
}
