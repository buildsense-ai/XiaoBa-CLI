import { Message } from '../types';
import { ToolDefinition } from '../types/tool';

export const TRANSIENT_TOOL_GUIDANCE_PREFIX = '[transient_tool_guidance]';

interface ToolGroup {
  label: string;
  names: string[];
  guidance: string;
}

const TOOL_GROUPS: ToolGroup[] = [
  {
    label: 'files',
    names: ['glob', 'grep', 'read_file', 'edit_file', 'write_file', 'resolve_common_directory'],
    guidance: '代码/文件任务先定位再读取；明确要改时优先用 edit_file，需要新建文件时再用 write_file。',
  },
  {
    label: 'shell',
    names: ['execute_shell'],
    guidance: '需要验证、运行测试或排查环境时使用 execute_shell；破坏性或高风险命令先确认用户意图。',
  },
  {
    label: 'planning',
    names: ['update_plan', 'record_decision'],
    guidance: '多阶段任务用 update_plan 维护真实进度；关键取舍可用 record_decision 记录理由。',
  },
  {
    label: 'subagents',
    names: ['spawn_subagent', 'check_subagent', 'resume_subagent', 'stop_subagent'],
    guidance: '独立、耗时、可并行的支线可派子 agent；简单单线任务直接完成。',
  },
  {
    label: 'skills',
    names: ['skill', 'share_skillhub_skill'],
    guidance: '匹配垂直场景时通过 skill 工具调用，不要只复述 skill 名称。',
  },
  {
    label: 'messaging',
    names: ['send_text', 'send_file'],
    guidance: '聊天平台外发消息或文件只在确实需要发送给用户时使用。',
  },
];

export function buildTransientToolGuidance(tools: ToolDefinition[]): Message | null {
  const toolNames = new Set(tools.map(tool => tool.name));
  if (toolNames.size === 0) return null;

  const groups = TOOL_GROUPS
    .map(group => ({
      ...group,
      enabledNames: group.names.filter(name => toolNames.has(name)),
    }))
    .filter(group => group.enabledNames.length > 0);

  const knownNames = new Set(TOOL_GROUPS.flatMap(group => group.names));
  const otherNames = [...toolNames]
    .filter(name => !knownNames.has(name))
    .sort();

  const enabledGroups = [
    ...groups.map(group => `${group.label}(${group.enabledNames.join(', ')})`),
    otherNames.length > 0 ? `other(${otherNames.join(', ')})` : '',
  ].filter(Boolean);

  const lines = [
    TRANSIENT_TOOL_GUIDANCE_PREFIX,
    'Runtime context only. Not a user request. Do not answer this message directly.',
    `本轮 API tools 字段已启用的工具组：${enabledGroups.join('; ')}。`,
    '使用建议：',
    ...groups.map(group => `- ${group.guidance}`),
  ];

  if (otherNames.length > 0) {
    lines.push('- 其他工具按其 schema 语义谨慎使用；不要为了使用工具而调用工具。');
  }

  return {
    role: 'user',
    content: lines.join('\n'),
    __injected: true,
  };
}
