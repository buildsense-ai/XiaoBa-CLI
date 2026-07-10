import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { SubAgentManager } from '../core/sub-agent-manager';
import { SAFE_SUB_AGENT_TOOL_NAMES } from '../core/sub-agent-session';
import { AIService } from '../utils/ai-service';
import { SkillManager } from '../skills/skill-manager';
import { Logger } from '../utils/logger';
import { styles } from '../theme/colors';

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
      '子智能体只看到传入的 context/user_message，完成结果会作为内部 observation 回到当前主会话，并可用 check_subagent 查询；它不会直接回复用户。',
      '适合可并行的探索、审查、测试或边界清晰的小块实现；具体分工由 subagent_prompt/context 描述，当前主线必须由主 agent 继续推进。',
      '如果最终回复依赖子智能体结果，主 agent 应使用 wait_subagents 等待并整合结果后再收口；只看状态时用 check_subagent。',
      'allowed_tools 是主 agent 从安全工具集合里挑出的子集；默认不会给 ask_parent，除非显式开启。',
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
          description: '可选，兼容旧调用。仅作为任务 hint 和默认工具范围参考；具体角色请写入 subagent_prompt/context。',
        },
        tool_scope: {
          type: 'string',
          enum: ['read_only', 'workspace_write', 'test_only'],
          description: '可选。子智能体工具权限上限；allowed_tools 不能超过这个范围。未指定时会根据 agent_type 或显式 allowed_tools 推断。',
        },
        allowed_tools: {
          type: 'array',
          items: {
            type: 'string',
            enum: [...SAFE_SUB_AGENT_TOOL_NAMES],
          },
          description: '可选。显式指定子智能体可用工具白名单。只能从枚举值中选择；不包含 spawn_subagent，子智能体不能再派生子智能体。',
        },
        allow_parent_questions: {
          type: 'boolean',
          description: '可选。为 true 时默认工具集合会额外包含 ask_parent；不传时默认不允许子智能体挂起询问主 agent。若 allowed_tools 显式包含 ask_parent，也视为显式允许。',
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
    const allowParentQuestionsResult = normalizeOptionalBoolean(args?.allow_parent_questions);
    const maxTurnsResult = normalizeMaxTurns(args?.max_turns);
    const taskDescription = normalizeString(args?.task_description) || normalizeString(args?.task);
    const userMessage = normalizeString(args?.user_message) || normalizeString(args?.context) || taskDescription;

    if (!taskDescription || !userMessage) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: '错误：task/task_description 和 context/user_message 为必填参数' };
    }
    if (!allowedToolsResult.ok) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: allowedToolsResult.message };
    }
    if (!allowParentQuestionsResult.ok) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: allowParentQuestionsResult.message };
    }
    if (!maxTurnsResult.ok) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: maxTurnsResult.message };
    }
    const allowParentQuestions = allowParentQuestionsResult.value ?? toolsIncludeAskParent(allowedToolsResult.value);
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
        allowParentQuestions,
        delegatedToolContext: buildDelegatedSubAgentToolContext(context),
        allowedTools: allowedToolsResult.value,
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

    const reusedExisting = result.reusedExisting === true;
    console.log('\n' + styles.highlight(`${reusedExisting ? '复用子智能体' : '🚀 派遣子智能体'}: ${taskDescription}`));
    if (result.displayName) {
      console.log(styles.text(`   Name: ${result.displayName}`));
    }
    console.log(styles.text(`   ID: ${result.id}`));
    const displayAgentType = result.agentType || agentType || (skillName ? 'skill' : 'worker');
    const displayToolScope = result.toolScope || toolScope || defaultToolScopeFor(displayAgentType, allowedToolsResult.value);
    const effectiveAllowedTools = result.allowedTools ?? allowedToolsResult.value;

    console.log(styles.text(`   Type: ${displayAgentType}`));
    console.log(styles.text(`   Scope: ${displayToolScope}\n`));

    return { ok: true, content: [
      reusedExisting
        ? `已复用正在运行的 ${result.displayName || '子智能体'} (${result.id})，避免重复派发同类任务。`
        : `已派遣 ${result.displayName || '子智能体'} (${result.id})。`,
      `任务: ${taskDescription}`,
      `类型: ${displayAgentType}`,
      `工具范围: ${displayToolScope}`,
      effectiveAllowedTools ? `工具: ${effectiveAllowedTools.length > 0 ? effectiveAllowedTools.join(', ') : '无'}` : '',
      allowParentQuestions ? '允许询问主 agent: 是' : '允许询问主 agent: 否',
      maxTurnsResult.value ? `轮次预算: ${maxTurnsResult.value}` : '轮次预算: 未设置',
      skillName ? `Skill: ${skillName}` : '',
      `状态: running`,
      `完成结果会作为内部 observation 回到主会话；需要整合时用 wait_subagents，你仍负责主线推进和最终回复。`,
    ].filter(Boolean).join('\n') };
  }
}

function normalizeOptionalBoolean(value: unknown): { ok: true; value?: boolean } | { ok: false; message: string } {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: undefined };
  }
  if (typeof value === 'boolean') {
    return { ok: true, value };
  }
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) {
    return { ok: true, value: true };
  }
  if (['0', 'false', 'no', 'off'].includes(text)) {
    return { ok: true, value: false };
  }
  return { ok: false, message: '错误：allow_parent_questions 必须是 boolean' };
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

function toolsIncludeAskParent(tools?: readonly string[]): boolean {
  return Boolean(tools?.some(tool => String(tool || '').trim() === 'ask_parent'));
}

function buildDelegatedSubAgentToolContext(context: ToolExecutionContext): Partial<ToolExecutionContext> {
  return {
    workspaceRoot: context.workspaceRoot,
    surface: context.surface,
    executionScope: context.executionScope,
    localDeviceGrant: context.localDeviceGrant,
    deviceGrants: context.deviceGrants,
    deviceSelection: context.deviceSelection,
    deviceRpc: context.deviceRpc,
    deviceRpcReceiver: context.deviceRpcReceiver,
    thinToolRpc: context.thinToolRpc,
    targetRoutes: context.targetRoutes,
    executionContext: context.executionContext,
    localFileGrants: context.localFileGrants,
    getCurrentDirectory: context.getCurrentDirectory,
  };
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

function defaultToolScopeFor(agentType: string, requestedTools?: readonly string[]): 'read_only' | 'workspace_write' | 'test_only' {
  if (requestedTools?.some(tool => tool === 'write_file' || tool === 'edit_file')) {
    return 'workspace_write';
  }
  if (requestedTools?.some(tool => tool === 'execute_shell')) {
    return 'test_only';
  }
  if (agentType === 'worker' || agentType === 'skill') {
    return 'workspace_write';
  }
  if (agentType === 'tester') {
    return 'test_only';
  }
  return 'read_only';
}
