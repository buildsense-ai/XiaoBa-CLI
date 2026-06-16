import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { SubAgentManager } from '../core/sub-agent-manager';
import { SAFE_SUB_AGENT_TOOL_NAMES } from '../core/sub-agent-session';
import { AIService } from '../utils/ai-service';
import { SkillManager } from '../skills/skill-manager';
import { Logger } from '../utils/logger';
import { styles } from '../theme/colors';
import { isCatsCoToolGatewayContext } from './tool-gateway';

const CATSCO_SUBAGENT_ALLOWED_TOOLS = ['ask_parent'] as const;

/**
 * spawn_subagent - 派遣子智能体后台执行隔离任务
 *
 * 主 agent 用它派出可并行的侧路任务：
 * 调用后立即返回，子智能体在后台独立运行，
 * 主会话不阻塞，可以继续和用户对话。
 */
export class SpawnSubagentTool implements Tool {
  definition: ToolDefinition = {
    name: 'spawn_subagent',
    description: [
      '启动一个后台子智能体执行独立任务；调用成功后立即返回，不等待完成。',
      '子智能体只看到传入的 context/user_message，完成后以后台结果回流到当前主会话，不会直接回复用户。',
      '适合可并行的探索、审查、测试或边界清晰的小块实现；当前主线必须由主 agent 继续推进。',
      '只有本工具返回的展示名和 ID 才是真实子智能体引用，不要编造子智能体或 sub-... ID。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: '可选。要让子智能体执行的已注册 skill 名称。通常优先用 agent_type。',
        },
        agent_type: {
          type: 'string',
          enum: ['explorer', 'reviewer', 'worker', 'tester'],
          description: '可选。内置子 agent 类型。explorer/reviewer 默认只读，tester 可执行测试命令，worker 可在工作区写文件。',
        },
        tool_scope: {
          type: 'string',
          enum: ['read_only', 'workspace_write', 'test_only'],
          description: '可选。覆盖子智能体工具权限范围。默认由 agent_type 决定。',
        },
        allowed_tools: {
          type: 'array',
          items: {
            type: 'string',
            enum: [...SAFE_SUB_AGENT_TOOL_NAMES],
          },
          description: '可选。显式指定子智能体可用工具白名单。只能从枚举值中选择。',
        },
        max_turns: {
          type: 'number',
          description: '可选。子智能体最大工具推理轮次；不传则不设置轮次上限。',
        },
        subagent_prompt: {
          type: 'string',
          description: '可选。给子智能体的额外系统级约束，例如审查重点、输出格式、禁止改动范围。',
        },
        task: {
          type: 'string',
          description: '任务的简短描述。新格式推荐用 task。',
        },
        task_description: {
          type: 'string',
          description: '任务的简短描述，用于进度通知（兼容旧参数）',
        },
        context: {
          type: 'string',
          description: '传递给子智能体的完整任务上下文和约束。新格式推荐用 context。',
        },
        user_message: {
          type: 'string',
          description: '传递给子智能体的完整用户指令（兼容旧参数，包含文件路径等必要信息）',
        },
      },
      required: [],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const skillName = normalizeString(args?.skill_name);
    const agentType = normalizeAgentType(args?.agent_type);
    const toolScope = normalizeToolScope(args?.tool_scope);
    const subAgentPrompt = normalizeString(args?.subagent_prompt);
    const allowedToolsResult = normalizeAllowedTools(args?.allowed_tools);
    const maxTurnsResult = normalizeMaxTurns(args?.max_turns);
    const taskDescription = normalizeString(args?.task_description) || normalizeString(args?.task);
    const userMessage = normalizeString(args?.user_message) || normalizeString(args?.context) || taskDescription;

    if (!taskDescription || !userMessage) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: '错误：task/task_description 和 context/user_message 为必填参数' };
    }
    if (!skillName && !agentType) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: '错误：请提供 agent_type，或在确实需要现有 skill 流程时提供 skill_name' };
    }
    if (!allowedToolsResult.ok) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: allowedToolsResult.message };
    }
    if (!maxTurnsResult.ok) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: maxTurnsResult.message };
    }
    const catsCoSubAgentTools = resolveCatsCoSubAgentAllowedTools(context, allowedToolsResult.value);
    if (!catsCoSubAgentTools.ok) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: catsCoSubAgentTools.message };
    }

    const manager = SubAgentManager.getInstance();
    const sessionKey = context.sessionId || 'unknown';

    const { aiService, skillManager } = await resolveSubAgentServices(context, Boolean(skillName));

    const result = await manager.spawn(
      sessionKey,
      {
        skillName,
        agentType,
        toolScope,
        subAgentPrompt,
        allowedTools: catsCoSubAgentTools.value,
        maxTurns: maxTurnsResult.value,
        taskDescription,
        userMessage,
      },
      context.workingDirectory,
      aiService,
      skillManager,
    );

    if ('error' in result) {
      return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: `派遣失败：${result.error}` };
    }

    console.log('\n' + styles.highlight(`🚀 派遣子智能体: ${taskDescription}`));
    if (result.displayName) {
      console.log(styles.text(`   Name: ${result.displayName}`));
    }
    console.log(styles.text(`   ID: ${result.id}`));
    const displayAgentType = result.agentType || agentType || (skillName ? 'skill' : 'worker');
    const displayToolScope = result.toolScope || toolScope || defaultToolScopeFor(displayAgentType);
    const effectiveAllowedTools = result.allowedTools ?? catsCoSubAgentTools.value;

    console.log(styles.text(`   Type: ${displayAgentType}`));
    console.log(styles.text(`   Scope: ${displayToolScope}\n`));

    return { ok: true, content: [
      `已派遣 ${result.displayName || '子智能体'} (${result.id})。`,
      `任务: ${taskDescription}`,
      `类型: ${displayAgentType}`,
      `工具范围: ${displayToolScope}`,
      effectiveAllowedTools ? `工具: ${effectiveAllowedTools.length > 0 ? effectiveAllowedTools.join(', ') : '无'}` : '',
      maxTurnsResult.value ? `轮次预算: ${maxTurnsResult.value}` : '轮次预算: 未设置',
      skillName ? `Skill: ${skillName}` : '',
      `状态: running`,
      `完成后会以后台结果通知回到主会话；你仍负责主线推进和最终回复。`,
    ].filter(Boolean).join('\n') };
  }
}

function resolveCatsCoSubAgentAllowedTools(
  context: ToolExecutionContext,
  requestedTools?: string[],
): { ok: true; value?: string[] } | { ok: false; message: string } {
  const hasCatsCoDeviceContext = isCatsCoToolGatewayContext(context)
    && Boolean(context.executionScope || context.deviceGrants?.length || context.localFileGrants?.length || context.localDeviceGrant);
  if (!hasCatsCoDeviceContext) {
    return { ok: true, value: requestedTools };
  }

  if (!requestedTools) {
    return { ok: true, value: [...CATSCO_SUBAGENT_ALLOWED_TOOLS] };
  }

  const deniedTools = requestedTools.filter(tool => !CATSCO_SUBAGENT_ALLOWED_TOOLS.includes(tool as any));
  if (deniedTools.length > 0) {
    return {
      ok: false,
      message: [
        'CatsCo 用户设备授权不会传递给子智能体，已阻止子智能体使用本地文件或命令工具。',
        `被拒绝的工具: ${deniedTools.join(', ')}`,
        '请在主会话当前 turn 中直接使用已授权工具，或让子智能体通过 ask_parent 请求主会话继续处理。',
      ].join('\n'),
    };
  }

  return { ok: true, value: requestedTools };
}

function normalizeMaxTurns(value: unknown): { ok: true; value?: number } | { ok: false; message: string } {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: undefined };
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, message: '错误：max_turns 必须是正整数' };
  }
  return { ok: true, value: parsed };
}

function normalizeString(value: unknown): string {
  return String(value || '').trim();
}

function normalizeAgentType(value: unknown): 'explorer' | 'reviewer' | 'worker' | 'tester' | undefined {
  const text = normalizeString(value);
  if (text === 'explorer' || text === 'reviewer' || text === 'worker' || text === 'tester') {
    return text;
  }
  return undefined;
}

function normalizeToolScope(value: unknown): 'read_only' | 'workspace_write' | 'test_only' | undefined {
  const text = normalizeString(value);
  if (text === 'read_only' || text === 'workspace_write' || text === 'test_only') {
    return text;
  }
  return undefined;
}

function normalizeAllowedTools(value: unknown): { ok: true; value?: string[] } | { ok: false; message: string } {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: undefined };
  }

  const rawTools = Array.isArray(value)
    ? value
    : String(value).split(',').map(item => item.trim()).filter(Boolean);
  const safeTools = new Set<string>(SAFE_SUB_AGENT_TOOL_NAMES);
  const normalized = Array.from(new Set(rawTools.map(tool => String(tool || '').trim()).filter(Boolean)));
  const invalid = normalized.filter(tool => !safeTools.has(tool));
  if (invalid.length > 0) {
    return {
      ok: false,
      message: `错误：allowed_tools 包含不允许的工具：${invalid.join(', ')}。允许值：${SAFE_SUB_AGENT_TOOL_NAMES.join(', ')}`,
    };
  }
  return { ok: true, value: normalized };
}

async function resolveSubAgentServices(
  context: ToolExecutionContext,
  needsSkills: boolean,
): Promise<{ aiService: AIService; skillManager: SkillManager }> {
  const runtimeServices = context.runtimeServices;
  if (runtimeServices) {
    return runtimeServices;
  }

  const aiService = new AIService();
  const skillManager = new SkillManager();
  if (needsSkills) {
    await skillManager.loadSkills();
  }
  return { aiService, skillManager };
}

function defaultToolScopeFor(agentType: string): 'read_only' | 'workspace_write' | 'test_only' {
  if (agentType === 'worker' || agentType === 'skill') {
    return 'workspace_write';
  }
  if (agentType === 'tester') {
    return 'test_only';
  }
  return 'read_only';
}
