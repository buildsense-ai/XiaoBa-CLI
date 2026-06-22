import * as fs from 'fs';
import * as path from 'path';
import { Message, ContentBlock } from '../types';

export const TRANSIENT_MODE_HINT_PREFIX = '[transient_mode_hint]';

export const PROMPT_MODE_IDS = [
  'coding-agent',
  'classroom',
  'office',
  'team-assistant',
] as const;

export type PromptModeId = typeof PROMPT_MODE_IDS[number];

export interface PromptModeDefinition {
  id: PromptModeId;
  title: string;
  description: string;
  turnHint: string[];
}

export interface PromptModeDetection {
  mode: PromptModeId;
  reason: string;
}

const PROMPT_MODE_ID_SET = new Set<string>(PROMPT_MODE_IDS);

export const PROMPT_MODE_DEFINITIONS: Record<PromptModeId, PromptModeDefinition> = {
  'coding-agent': {
    id: 'coding-agent',
    title: '工程协作模式',
    description: '处理代码、仓库、日志、构建、测试、配置和本地开发任务。',
    turnHint: [
      '涉及本地代码、项目文件、日志、配置或运行结果时，先用工具确认真实上下文。',
      '优先顺序：grep/glob 定位 -> read_file 阅读 -> edit_file/write_file 修改 -> execute_shell 验证。',
      '不要空口推断文件内容、测试结果或命令输出。',
    ],
  },
  classroom: {
    id: 'classroom',
    title: '课堂辅助模式',
    description: '面向老师、学生和课堂场景的讲解、练习、讲义、批改辅助。',
    turnHint: [
      '优先帮助用户理解概念、拆解步骤、形成练习或课堂材料。',
      '面对学生作业，优先给提示、思路和检查点，避免无解释地直接代写完整答案。',
      '注意学生隐私和年龄/水平适配。',
    ],
  },
  office: {
    id: 'office',
    title: '办公文档模式',
    description: '处理文档、表格、演示、报告、格式检查和文件交付。',
    turnHint: [
      '涉及真实文件时先读取或确认文件路径，不要脑补文件内容。',
      '输出适合直接用于办公交付，结构清晰、格式稳定。',
      '生成或修改文件后尽量检查关键内容、格式或可打开性。',
    ],
  },
  'team-assistant': {
    id: 'team-assistant',
    title: '团队协作模式',
    description: '处理会议纪要、任务拆解、日报周报、公告、项目同步和信息整理。',
    turnHint: [
      '优先把信息整理成清晰、可执行、适合团队同步的内容。',
      '涉及事实、文件、历史记录或任务状态时先查证，不脑补。',
      '输出应突出负责人、时间、风险、下一步和待确认事项。',
    ],
  },
};

export function isPromptModeId(value: unknown): value is PromptModeId {
  return typeof value === 'string' && PROMPT_MODE_ID_SET.has(value);
}

export function normalizePromptModeId(value: unknown): PromptModeId | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return isPromptModeId(normalized) ? normalized : undefined;
}

export function loadPromptModePrompt(promptsDir: string, mode: unknown): string | undefined {
  const modeId = normalizePromptModeId(mode);
  if (!modeId) return undefined;

  const modePath = path.join(promptsDir, 'modes', `${modeId}.md`);
  try {
    const raw = fs.readFileSync(modePath, 'utf-8').trim();
    const content = stripFrontmatter(raw).trim();
    if (!content) return undefined;
    return [`[mode:${modeId}]`, content].join('\n');
  } catch {
    return undefined;
  }
}

export function buildTransientModeHintFromMessages(messages: Message[]): Message | undefined {
  const latestUserText = findLatestRealUserText(messages);
  if (!latestUserText) return undefined;
  const detection = detectPromptMode(latestUserText);
  if (!detection) return undefined;
  return buildTransientModeHint(detection);
}

export function detectPromptMode(text: string): PromptModeDetection | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;

  if (looksLikeClassroomTask(normalized)) {
    return { mode: 'classroom', reason: '用户提到课堂、老师、学生、作业、讲义、题目或教学场景。' };
  }
  if (looksLikeTeamTask(normalized)) {
    return { mode: 'team-assistant', reason: '用户提到会议、日报、任务、公告、项目同步或团队协作。' };
  }
  if (looksLikeOfficeTask(normalized)) {
    return { mode: 'office', reason: '用户提到文档、表格、演示、报告、格式或办公文件。' };
  }
  if (looksLikeCodingTask(normalized)) {
    return { mode: 'coding-agent', reason: '用户提到代码、仓库、报错、构建、测试或本地开发任务。' };
  }

  return undefined;
}

function buildTransientModeHint(detection: PromptModeDetection): Message {
  const definition = PROMPT_MODE_DEFINITIONS[detection.mode];
  return {
    role: 'user',
    content: [
      TRANSIENT_MODE_HINT_PREFIX,
      'Runtime context only. Not a user request. Do not answer this message directly.',
      `Matched mode: ${definition.id} (${definition.title})`,
      `Reason: ${detection.reason}`,
      'This turn guidance:',
      ...definition.turnHint.map(line => `- ${line}`),
      'The current real user message remains authoritative.',
    ].join('\n'),
    __injected: true,
  };
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

function contentToString(content: string | ContentBlock[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => block.type === 'text' ? block.text : '[图片]')
    .join('\n');
}

function looksLikeCodingTask(text: string): boolean {
  return /代码|源码|仓库|bug|报错|异常|日志|接口|路由|组件|编译|构建|测试|单测|启动失败|npm|pnpm|yarn|git|commit|PR|TypeScript|JavaScript|Python|Go\b|Rust|Docker|Kubernetes|数据库|SQL|API/i.test(text);
}

function looksLikeClassroomTask(text: string): boolean {
  return /课堂|老师|学生|同学|作业|题目|试卷|考试|练习题|讲义|教案|课程|知识点|板书|批改|评分|解析|解题思路|教学|家长|班级/.test(text);
}

function looksLikeOfficeTask(text: string): boolean {
  return /文档|表格|PPT|幻灯片|演示|Word|Excel|PowerPoint|docx|xlsx|pptx|PDF|报告|合同|简历|格式|排版|图表|汇总表|模板|导出/.test(text);
}

function looksLikeTeamTask(text: string): boolean {
  return /会议|纪要|日报|周报|月报|OKR|任务拆解|待办|负责人|排期|里程碑|公告|通知|项目同步|进度|风险清单|复盘|协作|团队/.test(text);
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) return raw;
  return raw.slice(match[0].length);
}
