import { ContentBlock, Message } from '../types';
import { ToolDefinition, ToolSurface } from '../types/tool';

export type TransientIntentKind =
  | 'office'
  | 'skill'
  | 'workspace'
  | 'plain-chat';

export interface TransientTurnIntent {
  kind: TransientIntentKind;
  latestUserText: string;
  actionable: boolean;
  workspaceRelevant: boolean;
  skillRelevant: boolean;
  complexWork: boolean;
  plainChat: boolean;
}

export interface TurnContextTransientPolicy {
  intent: TransientTurnIntent;
  injectSkillsList: boolean;
}

export interface ProviderTransientPolicy {
  intent: TransientTurnIntent;
  injectEnvironment: boolean;
  injectRunnerHint: boolean;
  reasons: string[];
}

export interface ProviderTransientPolicyOptions {
  messages: Message[];
  tools: ToolDefinition[];
  turn: number;
  executedToolCalls: number;
  surface?: ToolSurface;
  currentDirectory?: string;
  orchestrationHintCount?: number;
}

const FILE_AND_SHELL_TOOLS = new Set([
  'glob',
  'grep',
  'read_file',
  'edit_file',
  'write_file',
  'resolve_common_directory',
  'execute_shell',
]);

const ORCHESTRATION_TOOL_NAMES = new Set([
  'update_plan',
  'record_decision',
  'spawn_subagent',
  'check_subagent',
  'resume_subagent',
  'stop_subagent',
]);

const ACTION_SIGNAL =
  /帮我|看一下|看下|看看|检查|排查|定位|修复|修一下|修改|改一下|实现|优化|重构|跑一下|运行|执行|构建|编译|测试|读取|读一下|打开|搜索|整理|生成|创建|写入|保存|导出|review|inspect|debug|fix|edit|modify|implement|run|execute|build|test|read|open|search|create|generate/i;

const TOOL_ACTION_SIGNAL =
  /检查|排查|定位|修复|修改|跑一下|运行|执行|构建|编译|测试|读取|读一下|打开|搜索|写入|保存|导出|inspect|debug|fix|edit|modify|run|execute|build|test|read|open|search/i;

const WORKSPACE_SIGNAL =
  /代码|源码|仓库|文件|目录|路径|本地|报错|异常|日志|接口|路由|组件|依赖|配置|命令|终端|shell|powershell|bash|npm|pnpm|yarn|git|commit|PR|TypeScript|JavaScript|Python|Docker|Kubernetes|数据库|SQL|API|repo|repository|workspace|file|folder|path|terminal|package\.json|tsconfig|src[\\/]|tests?[\\/]|\.tsx?\b|\.jsx?\b|\.py\b|\.json\b|\.ya?ml\b|\.md\b|\.txt\b|\.log\b/i;

const OFFICE_SIGNAL =
  /文档|表格|演示|报告|PPT|Word|Excel|PowerPoint|docx|xlsx|pptx|PDF|格式|排版|图表|office/i;

const BROWSER_SIGNAL =
  /浏览器|网页|网站|页面|点击|表单|截图|打开链接|url|browser|website|web page|screenshot/i;

const MEMORY_SIGNAL =
  /记忆|回忆|之前|过去|历史|上次|以前|搜一下.*对话|查找.*对话|memory|remember|previous conversation/i;

const SELF_EVOLUTION_SIGNAL =
  /创建.*skill|新建.*skill|自我进化|扩展能力|写.*工具|新增.*工具|self[-_ ]?evolution/i;

const SKILL_SIGNAL =
  /skill|技能|能力列表|工具列表|会什么|能做什么|调用.*工具|使用.*工具|agent-browser|coding-context|memory-search|officecli|self-evolution/i;

const COMPLEX_WORK_SIGNAL =
  /完整|全面|系统性|评估|优化|重构|方案|策略|架构|多阶段|长期|端到端|测试覆盖|上线|发布|梳理|审查|review|comprehensive|end-to-end|architecture|strategy/i;

const CONCEPTUAL_SIGNAL =
  /是什么|什么意思|怎么理解|解释一下|讲讲|原理|区别|为什么|what is|explain|difference between|how does/i;

export function resolveTurnContextTransientPolicy(messages: Message[]): TurnContextTransientPolicy {
  const intent = analyzeTransientIntent(messages);
  // Every real user turn gets the complete list of user-invocable skills.
  // Skill descriptions cannot participate in model routing unless the model
  // can see them, so do not pre-filter the list with hard-coded intent rules.
  const injectSkillsList = Boolean(intent.latestUserText);

  return {
    intent,
    injectSkillsList,
  };
}

export function resolveProviderTransientPolicy(
  options: ProviderTransientPolicyOptions,
): ProviderTransientPolicy {
  const intent = analyzeTransientIntent(options.messages);
  const toolNames = new Set(options.tools.map(tool => tool.name));
  const hasFileOrShellTools = [...toolNames].some(name => FILE_AND_SHELL_TOOLS.has(name));
  const hasOrchestrationTools = [...toolNames].some(name => ORCHESTRATION_TOOL_NAMES.has(name));
  const toolLoopActive = options.executedToolCalls > 0 || hasRecentToolExchange(options.messages);
  const isMessageSurface = options.surface === 'catscompany'
    || options.surface === 'feishu'
    || options.surface === 'weixin';

  const reasons: string[] = [];
  const injectEnvironment = Boolean(
    options.currentDirectory
    && hasFileOrShellTools
    && (intent.workspaceRelevant || toolLoopActive),
  );
  if (injectEnvironment) reasons.push('workspace-context');

  const hasSpecificOrchestrationHint = (options.orchestrationHintCount ?? 0) > 0;
  const injectRunnerHint = Boolean(
    hasOrchestrationTools
    && !hasSpecificOrchestrationHint
    && !isMessageSurface
    && options.turn === 1
    && intent.complexWork
    && intent.actionable,
  );
  if (injectRunnerHint) reasons.push('complex-work-orchestration');

  return {
    intent,
    injectEnvironment,
    injectRunnerHint,
    reasons,
  };
}

export function analyzeTransientIntent(messages: Message[]): TransientTurnIntent {
  const latestUserText = findLatestRealUserText(messages);
  const recentToolContext = hasRecentToolExchange(messages);
  const hasActionSignal = ACTION_SIGNAL.test(latestUserText);
  const hasToolActionSignal = TOOL_ACTION_SIGNAL.test(latestUserText);
  const hasWorkspaceSignal = WORKSPACE_SIGNAL.test(latestUserText);
  const hasOfficeSignal = OFFICE_SIGNAL.test(latestUserText);
  const hasBrowserSignal = BROWSER_SIGNAL.test(latestUserText);
  const hasMemorySignal = MEMORY_SIGNAL.test(latestUserText);
  const hasSelfEvolutionSignal = SELF_EVOLUTION_SIGNAL.test(latestUserText);
  const hasSkillSignal = SKILL_SIGNAL.test(latestUserText);
  const conceptualOnly = CONCEPTUAL_SIGNAL.test(latestUserText)
    && !hasActionSignal
    && !hasWorkspaceSignal
    && !hasOfficeSignal
    && !hasBrowserSignal
    && !hasMemorySignal
    && !hasSelfEvolutionSignal
    && !hasSkillSignal;

  const actionable = !conceptualOnly && (
    hasActionSignal
    || hasWorkspaceSignal
    || hasOfficeSignal
    || hasBrowserSignal
    || hasMemorySignal
    || hasSelfEvolutionSignal
    || hasSkillSignal
    || recentToolContext
  );
  const workspaceRelevant = !conceptualOnly && (
    hasWorkspaceSignal
    || hasToolActionSignal
    || hasOfficeSignal
    || hasBrowserSignal
    || recentToolContext
  );
  const skillRelevant = hasSkillSignal
    || hasBrowserSignal
    || hasMemorySignal
    || hasSelfEvolutionSignal
    || (hasWorkspaceSignal && actionable)
    || (hasOfficeSignal && actionable);
  const complexWork = !conceptualOnly && (
    COMPLEX_WORK_SIGNAL.test(latestUserText)
    || (latestUserText.length >= 120 && actionable)
  );

  const kind = resolveIntentKind({
    hasSkillSignal,
    hasOfficeSignal,
    hasBrowserSignal,
    hasMemorySignal,
    hasSelfEvolutionSignal,
    workspaceRelevant,
    actionable,
  });

  return {
    kind,
    latestUserText,
    actionable,
    workspaceRelevant,
    skillRelevant,
    complexWork,
    plainChat: kind === 'plain-chat',
  };
}

function resolveIntentKind(options: {
  hasSkillSignal: boolean;
  hasOfficeSignal: boolean;
  hasBrowserSignal: boolean;
  hasMemorySignal: boolean;
  hasSelfEvolutionSignal: boolean;
  workspaceRelevant: boolean;
  actionable: boolean;
}): TransientIntentKind {
  if (options.hasOfficeSignal) return 'office';
  if (
    options.hasSkillSignal
    || options.hasBrowserSignal
    || options.hasMemorySignal
    || options.hasSelfEvolutionSignal
  ) {
    return 'skill';
  }
  if (options.workspaceRelevant || options.actionable) return 'workspace';
  return 'plain-chat';
}

function findLatestRealUserText(messages: Message[]): string {
  for (let idx = messages.length - 1; idx >= 0; idx--) {
    const message = messages[idx];
    if (message.role !== 'user' || message.__injected) continue;
    const text = contentToString(message.content).trim();
    if (text) return text;
  }
  return '';
}

function hasRecentToolExchange(messages: Message[]): boolean {
  return messages.slice(-12).some(message => (
    message.role === 'tool'
    || Boolean(message.tool_calls?.length)
  ));
}

function contentToString(content: string | ContentBlock[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => block.type === 'text' ? block.text : '[image]')
    .join('\n');
}
