import type { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { SkillHubService } from '../skillhub/service';
import { SkillHubSubscriptionService } from '../skillhub/subscription-service';
import type { SkillHubSearchResponse } from '../skillhub/types';
import {
  isCatsCoLocalOwnerSelfContext,
  isCatsCoToolGatewayContext,
} from './tool-gateway';

export interface SkillHubCatalogGateway {
  search(query?: string, options?: { category?: string }): Promise<SkillHubSearchResponse & { installed?: unknown[] }>;
}

export interface SkillHubSubscriptionGateway {
  list(): ReturnType<SkillHubSubscriptionService['list']>;
  subscribe(skillId: string): ReturnType<SkillHubSubscriptionService['subscribe']>;
  unsubscribe(skillId: string): ReturnType<SkillHubSubscriptionService['unsubscribe']>;
}

export class SkillHubTool implements Tool {
  constructor(
    private readonly catalog: SkillHubCatalogGateway = new SkillHubService(),
    private readonly subscriptions: SkillHubSubscriptionGateway = new SkillHubSubscriptionService(),
  ) {}

  definition: ToolDefinition = {
    name: 'skillhub',
    description: [
      '浏览 SkillHub，并管理当前运行环境中已添加的 Skill。',
      'browse/search 用于查看可用 Skill；list_subscriptions 查看当前运行环境已添加的 Skill。',
      '只有当用户在当前请求中明确要求订阅、安装、取消订阅或删除时，才能调用 subscribe/unsubscribe。',
      'subscribe 总是获取 latest：未安装时安装，已有同一 Skill 时更新或保持最新；同名异源会安全拒绝。',
      '在虚拟员工中，subscribe/unsubscribe 只表示为当前员工添加或删除 Skill，不需要 SkillHub 登录。',
      '一次只调用一个 subscribe/unsubscribe；多个 Skill 必须串行处理，任一操作失败后停止，不要并行或重试。',
      'unsubscribe 只删除带有匹配 SkillHub 安装标记的本地 Skill。不要把发布者删除版本的请求交给本工具。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['browse', 'search', 'list_subscriptions', 'subscribe', 'unsubscribe'],
          description: '要执行的 SkillHub 动作。',
        },
        query: {
          type: 'string',
          description: 'browse/search 的可选关键词；browse 可留空。',
        },
        category: {
          type: 'string',
          description: 'browse/search 的可选分类。',
        },
        skillId: {
          type: 'string',
          description: 'subscribe/unsubscribe 使用的完整 SkillHub skillId，例如 author/skill-name。',
        },
      },
      required: ['action'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const action = String(args?.action || '').trim();
    try {
      if (action === 'browse' || action === 'search') {
        const query = action === 'browse' ? String(args?.query || '') : required(args?.query, 'query');
        const response = await this.catalog.search(query, {
          category: String(args?.category || '').trim() || undefined,
        });
        const skills = Array.isArray(response.skills) ? response.skills : [];
        return {
          ok: true,
          content: JSON.stringify({
            query,
            total: skills.length,
            skills: skills.slice(0, 20).map(skill => ({
              skillId: skill.skillId,
              name: skill.displayName || skill.name || skill.skillId,
              description: clipped(skill.description, 500),
              latestVersion: skill.latestVersion,
              categories: skill.categories || [],
              riskLevel: skill.riskLevel,
              permissions: skill.permissions,
            })),
            truncated: skills.length > 20,
          }, null, 2),
        };
      }

      if (action === 'list_subscriptions') {
        const result = await this.subscriptions.list();
        return {
          ok: true,
          content: JSON.stringify(result, null, 2),
        };
      }

      if (action === 'subscribe' || action === 'unsubscribe') {
        const denied = mutationDenied(context);
        if (denied) return denied;
        const skillId = required(args?.skillId, 'skillId');
        if (action === 'subscribe') {
          const result = await this.subscriptions.subscribe(skillId);
          await context.runtimeServices?.skillManager.loadSkills();
          return {
            ok: true,
            content: JSON.stringify(result, null, 2),
          };
        }

        const result = await this.subscriptions.unsubscribe(skillId);
        await context.runtimeServices?.skillManager.loadSkills();
        return {
          ok: true,
          content: JSON.stringify(result, null, 2),
        };
      }

      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: 'action must be browse, search, list_subscriptions, subscribe, or unsubscribe',
      };
    } catch (error: any) {
      return {
        ok: false,
        errorCode: String(error?.code || 'SKILLHUB_OPERATION_FAILED'),
        message: error?.message || String(error),
        retryable: Number(error?.status || 0) >= 500,
      };
    }
  }
}

function mutationDenied(context: ToolExecutionContext): ToolExecutionResult | undefined {
  if (!isCatsCoToolGatewayContext(context) || isCatsCoLocalOwnerSelfContext(context)) return undefined;
  return {
    ok: false,
    errorCode: 'PERMISSION_DENIED',
    message: '只有当前 Agent 的所有者可以添加或删除 Skill。',
  };
}

function required(value: unknown, field: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) {
    const error: any = new Error(`${field} required`);
    error.code = 'INVALID_TOOL_ARGUMENTS';
    throw error;
  }
  return normalized;
}

function clipped(value: unknown, maxLength: number): string {
  const text = String(value || '').trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
