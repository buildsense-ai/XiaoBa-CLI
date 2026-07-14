import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  listRecentSessionLogs,
  readSessionLogByFileId,
  SessionLogSummary,
} from '../dashboard/session-logs';
import { getSkillDrafts, SkillDraft } from './skill-draft-companion';
import { isSessionTurnEntry, ParsedSessionLogEntry, SessionToolCallLog } from '../utils/session-log-schema';

export interface DailyReportSkillCandidate {
  id: string;
  name: string;
  action: SkillDraft['action'];
  reason: string;
  requiresConfirmation: true;
  autoInstall: false;
}

export interface DailyReport {
  id: string;
  date: string;
  title: string;
  summary: string;
  sections: {
    completed: string[];
    failures: string[];
    preferences: string[];
    repeatedTasks: Array<{ task: string; count: number }>;
    skillCandidates: DailyReportSkillCandidate[];
  };
  metrics: {
    sessions: number;
    turns: number;
    toolCalls: number;
    failures: number;
    runtimeErrors: number;
    preferenceSignals: number;
    repeatedTaskSignals: number;
  };
  noise: {
    scannedTurns: number;
    filteredTurns: number;
    duplicateTurns: number;
  };
  skillCandidates: DailyReportSkillCandidate[];
  reportMarkdown: string;
  requiresConfirmation: true;
  autoSave: false;
  createdAt: string;
}

export interface SavedDailyReport {
  path: string;
  date: string;
  action: 'created' | 'updated';
  requiresConfirmation: true;
  autoSave: false;
}

interface DailyReportSignals {
  completed: string[];
  failures: string[];
  preferences: string[];
  commonTasks: Map<string, number>;
  scannedTurns: number;
  filteredTurns: number;
  duplicateTurns: number;
  seenTurnKeys: Set<string>;
  turns: number;
  toolCalls: number;
  runtimeErrors: number;
}

export function getDailyReport(options: {
  date?: string;
  days?: number;
  limit?: number;
} = {}): { report: DailyReport; scanned: number } {
  const days = clampInteger(options.days, 7, 1, 90);
  const limit = clampInteger(options.limit, 20, 1, 100);
  const sessions = listRecentSessionLogs({ days, limit });
  const date = normalizeReportDate(options.date) || latestSessionDate(sessions) || isoDate(new Date());
  const signals = createSignals();

  for (const session of sessions) {
    const detail = readSessionLogByFileId(session.fileId);
    if (!detail) continue;
    for (const entry of detail.entries) {
      if (entryDate(entry, session) !== date) continue;
      collectEntry(signals, entry);
    }
  }

  const repeatedTasks = Array.from(signals.commonTasks.entries())
    .filter(([, count]) => count >= 2)
    .map(([task, count]) => ({ task, count }))
    .sort((a, b) => b.count - a.count || a.task.localeCompare(b.task))
    .slice(0, 5);
  const skillCandidates = getSkillDrafts({ days, limit }).drafts
    .map(toSkillCandidate)
    .slice(0, 3);
  const createdAt = new Date().toISOString();
  const metrics = {
    sessions: sessions.length,
    turns: signals.turns,
    toolCalls: signals.toolCalls,
    failures: signals.failures.length,
    runtimeErrors: signals.runtimeErrors,
    preferenceSignals: signals.preferences.length,
    repeatedTaskSignals: repeatedTasks.length,
  };
  const summary = buildSummary(date, signals, repeatedTasks, skillCandidates);
  const reportMarkdown = buildReportMarkdown({
    date,
    summary,
    completed: signals.completed,
    failures: signals.failures,
    preferences: signals.preferences,
    repeatedTasks,
    skillCandidates,
    metrics,
    noise: {
      scannedTurns: signals.scannedTurns,
      filteredTurns: signals.filteredTurns,
      duplicateTurns: signals.duplicateTurns,
    },
  });

  const report: DailyReport = {
    id: `daily-report:${date}`,
    date,
    title: `工作日报 - ${date}`,
    summary,
    sections: {
      completed: signals.completed,
      failures: signals.failures,
      preferences: signals.preferences,
      repeatedTasks,
      skillCandidates,
    },
    metrics,
    noise: {
      scannedTurns: signals.scannedTurns,
      filteredTurns: signals.filteredTurns,
      duplicateTurns: signals.duplicateTurns,
    },
    skillCandidates,
    reportMarkdown,
    requiresConfirmation: true,
    autoSave: false,
    createdAt,
  };

  return { report, scanned: sessions.length };
}

export function saveDailyReport(options: {
  date?: string;
  days?: number;
  limit?: number;
} = {}): { ok: true; report: DailyReport; saved: SavedDailyReport; scanned: number } {
  const { report, scanned } = getDailyReport(options);
  const reportsRoot = resolveDailyReportsRoot();
  fs.mkdirSync(reportsRoot, { recursive: true });
  const reportPath = path.join(reportsRoot, `${report.date}.md`);
  const action = fs.existsSync(reportPath) ? 'updated' : 'created';
  const tmpPath = `${reportPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, buildSavedReportMarkdown(report), 'utf8');
  fs.renameSync(tmpPath, reportPath);
  return {
    ok: true,
    report,
    saved: {
      path: reportPath,
      date: report.date,
      action,
      requiresConfirmation: true,
      autoSave: false,
    },
    scanned,
  };
}

export function resolveDailyReportsRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const userData = String(env.XIAOBA_ELECTRON_USER_DATA_DIR || env.XIAOBA_USER_DATA_DIR || env.CATSCO_USER_DATA_DIR || '').trim();
  const root = userData ? path.resolve(userData) : path.resolve(cwd);
  return path.join(root, 'reports', 'daily');
}

function createSignals(): DailyReportSignals {
  return {
    completed: [],
    failures: [],
    preferences: [],
    commonTasks: new Map(),
    scannedTurns: 0,
    filteredTurns: 0,
    duplicateTurns: 0,
    seenTurnKeys: new Set(),
    turns: 0,
    toolCalls: 0,
    runtimeErrors: 0,
  };
}

function collectEntry(signals: DailyReportSignals, entry: ParsedSessionLogEntry): void {
  if (isSessionTurnEntry(entry)) {
    signals.scannedTurns += 1;
    const userText = compactText(entry.user.text, 900);
    const assistantText = compactText(entry.assistant.text, 1200);
    const turnKey = normalizeTurnKey(userText, assistantText);
    const duplicate = signals.seenTurnKeys.has(turnKey);
    if (duplicate) signals.duplicateTurns += 1;
    else signals.seenTurnKeys.add(turnKey);

    if (duplicate || isNoiseTurn(userText, assistantText, entry.assistant.tool_calls.length)) {
      signals.filteredTurns += 1;
      return;
    }

    signals.turns += 1;
    signals.toolCalls += entry.assistant.tool_calls.length;
    const completed = extractCompletedWork(userText, assistantText, entry.assistant.tool_calls);
    if (completed) pushUnique(signals.completed, completed, 6);
    const preference = extractPreference(userText);
    if (preference) pushUnique(signals.preferences, preference, 5);
    const taskKey = extractTaskKey(userText);
    if (taskKey) signals.commonTasks.set(taskKey, (signals.commonTasks.get(taskKey) || 0) + 1);

    if (looksLikeFailure(assistantText)) {
      pushUnique(signals.failures, summarizeFailure(assistantText), 6);
    }
    for (const toolCall of entry.assistant.tool_calls) {
      const result = compactText(toolCall.result, 900);
      if (looksLikeFailure(result)) pushUnique(signals.failures, summarizeToolFailure(toolCall), 6);
    }
    return;
  }

  if (entry.entry_type === 'runtime') {
    const level = String(entry.level || '').toLowerCase();
    const message = compactText(entry.message, 900);
    if (level === 'error' || looksLikeFailure(message)) {
      signals.runtimeErrors += 1;
      pushUnique(signals.failures, summarizeFailure(message, 'runtime'), 6);
    }
  }
}

function toSkillCandidate(draft: SkillDraft): DailyReportSkillCandidate {
  return {
    id: draft.id,
    name: draft.name,
    action: draft.action,
    reason: summarizeSkillCandidateReason(draft),
    requiresConfirmation: true,
    autoInstall: false,
  };
}

function summarizeSkillCandidateReason(draft: SkillDraft): string {
  const source = draft.source;
  if (draft.name === 'shell-recovery-workflow') {
    return `最近日志里出现 ${source.shellFailures} 次命令失败，可以沉淀一套 Windows/PowerShell 排错流程。`;
  }
  if (draft.name === 'debugging-triage-workflow') {
    return `最近有 ${source.runtimeErrors} 个运行时错误、${source.failures} 个失败轮次，适合沉淀成调试分诊流程。`;
  }
  if (draft.name === 'user-preference-workflow') {
    return `最近捕捉到 ${source.preferenceSignals} 条明确偏好，可以沉淀成后续协作习惯。`;
  }
  if (draft.name === 'common-task-workflow') {
    return `最近出现 ${source.repeatedTaskSignals} 类重复任务，可以整理成可复用工作流。`;
  }
  return cleanReportLine(draft.reason, 140);
}

function buildSummary(
  date: string,
  signals: DailyReportSignals,
  repeatedTasks: Array<{ task: string; count: number }>,
  skillCandidates: DailyReportSkillCandidate[],
): string {
  const parts = [`我整理了 ${date} 的工作记录`];
  if (signals.completed.length) parts.push(`归纳出 ${signals.completed.length} 类有效工作`);
  if (signals.failures.length) parts.push(`发现 ${signals.failures.length} 个需要回看的问题`);
  if (signals.preferences.length) parts.push(`保留 ${signals.preferences.length} 条偏好`);
  if (repeatedTasks.length) parts.push(`识别 ${repeatedTasks.length} 个重复任务模式`);
  if (skillCandidates.length) parts.push(`准备 ${skillCandidates.length} 个需要你确认的 Skill 候选`);
  if (parts.length === 1) parts.push('暂时没有发现值得打扰你的高价值信号');
  return `${parts.join('，')}。`;
}

function buildReportMarkdown(input: {
  date: string;
  summary: string;
  completed: string[];
  failures: string[];
  preferences: string[];
  repeatedTasks: Array<{ task: string; count: number }>;
  skillCandidates: DailyReportSkillCandidate[];
  metrics: DailyReport['metrics'];
  noise: DailyReport['noise'];
}): string {
  const lines = [
    `# 工作日报 - ${input.date}`,
    '',
    input.summary,
    '',
  ];
  addSection(lines, '昨天完成了什么', input.completed);
  addSection(lines, '需要回看的问题', input.failures);
  addSection(lines, '用户偏好/后续习惯', input.preferences.map(item => cleanReportLine(item, 140)));
  addSection(lines, '重复出现的工作模式', input.repeatedTasks.map(item => `${friendlyTaskLabel(item.task)}：出现 ${item.count} 次`));
  addSection(lines, '可以沉淀成 Skill 的建议', input.skillCandidates.map(item => `${item.name}：${item.reason}（需要你确认后才会保存或安装）`));
  lines.push('## 数据概览', '');
  lines.push(`- 扫描会话：${input.metrics.sessions}`);
  lines.push(`- 有效轮次：${input.metrics.turns}`);
  lines.push(`- 工具调用：${input.metrics.toolCalls}`);
  lines.push(`- 运行时错误：${input.metrics.runtimeErrors}`);
  lines.push(`- 已过滤噪声：${input.noise.filteredTurns}/${input.noise.scannedTurns}`);
  lines.push('', '这是一份本地草稿。保存日报或沉淀 Skill 前，都需要你明确确认。');
  return lines.join('\n');
}

function buildSavedReportMarkdown(report: DailyReport): string {
  return [
    '---',
    'x-catsco-generated: true',
    'type: daily-report',
    `date: ${report.date}`,
    'requiresConfirmation: true',
    'autoSave: false',
    '---',
    '',
    report.reportMarkdown,
    '',
  ].join('\n');
}

function addSection(lines: string[], heading: string, items: string[]): void {
  lines.push(`## ${heading}`, '');
  if (!items.length) {
    lines.push('- 暂未发现。');
  } else {
    for (const item of items) lines.push(`- ${sanitizeMarkdownLine(item)}`);
  }
  lines.push('');
}

function extractCompletedWork(userText: string, assistantText: string, toolCalls: SessionToolCallLog[]): string {
  if (!assistantText) return '';
  const combined = compactText(`${userText} ${assistantText}`, 1800);
  const hasPositiveSignal = /(completed|done|implemented|added|created|fixed|generated|saved|updated|passed|完成|已完成|新增|修复|生成|保存|通过)/i.test(assistantText);
  const toolSucceeded = toolCalls.some(toolCall => /passed|success|saved|created|generated|完成|通过|成功/i.test(String(toolCall.result || '')));
  if (!hasPositiveSignal && !toolSucceeded) return '';
  if (looksLikeFailure(assistantText) && !/(fixed|resolved|passed|修复|解决|通过)/i.test(assistantText)) return '';
  return summarizeWork(combined);
}

function summarizeWork(text: string): string {
  const lower = text.toLowerCase();
  if (/(daily report|report companion|日报|日总结)/i.test(text)) {
    return '整理/完善桌宠日报能力，加入日志清洗、工作总结和 Skill 候选建议。';
  }
  if (/(skill draft|generate skill|skill candidate|skillhub|沉淀.*skill|生成.*skill)/i.test(text)) {
    return '整理可沉淀 Skill 的候选建议，并保持用户确认后再保存或安装。';
  }
  if (/(desktop companion|pet shell|pet window|桌宠|宠物)/i.test(text)) {
    return '优化桌宠交互、状态提示和本地入口体验。';
  }
  if (/(dashboard|webapp|web app|网页端)/i.test(text)) {
    return '梳理 Dashboard/WebApp 与桌面端之间的入口和联动方式。';
  }
  if (/(remotion|video|mp4|render|渲染|视频)/i.test(text)) {
    return '完成视频/渲染相关交付，并整理输出文件信息。';
  }
  if (/(test|build|passed|compile|验证|测试|构建)/i.test(text)) {
    return '补充本地验证，确认相关测试或构建流程通过。';
  }
  if (/(fix|debug|bug|error|修复|排查)/i.test(text)) {
    return '排查并修复问题，减少后续重复处理成本。';
  }
  const fallback = cleanReportLine(text, 96);
  if (!fallback || looksLikeRawArtifact(fallback)) {
    return lower.includes('skill')
      ? '整理了一项可复用的工作能力。'
      : '完成了一项需要回看的有效工作。';
  }
  return fallback.endsWith('。') ? fallback : `${fallback}。`;
}

function extractPreference(text: string): string {
  const value = compactText(text, 220);
  if (!value) return '';
  if (value.length > 220) return '';
  if (/(from now on|always|never|prefer|please use|keep .* concise|in chinese|use chinese|以后|从现在起|之后|记住|偏好|我希望)/i.test(value)) return summarizePreference(value);
  if (/(from now on|always|never|prefer|please use|keep .* concise|in chinese|use chinese)/i.test(value)) return value;
  if (/(以后|从现在起|之后).*(请|用|不要|别|都|保持|尽量)/.test(value)) return value;
  if (/(记住|偏好|我希望).*(回复|格式|语气|中文|英文|简短|详细)/.test(value)) return value;
  return '';
}

function summarizePreference(text: string): string {
  const lower = text.toLowerCase();
  const wantsConcise = /concise|short|brief|简洁|简短/.test(lower);
  const wantsChinese = /chinese|中文/.test(lower);
  if (wantsConcise && wantsChinese) return '用户希望日报保持简洁，并使用中文。';
  if (wantsConcise) return '用户希望后续输出保持简洁。';
  if (wantsChinese) return '用户希望后续输出使用中文。';
  if (/never|不要|别/.test(lower)) return `用户明确了一个不要做的偏好：${cleanReportLine(text, 90)}。`;
  return `用户偏好：${cleanReportLine(text, 100)}。`;
}

function extractTaskKey(text: string): string {
  const value = compactText(text, 120).toLowerCase();
  if (!value) return '';
  const known = [
    'daily report',
    'weekly report',
    'debug',
    'fix test',
    'generate skill',
    'skill draft',
    'webapp usage',
  ];
  for (const task of known) {
    if (value.includes(task)) return task;
  }
  const match = value.match(/\b(generate|create|write|summarize|debug|fix|review|analyze)\b.{0,36}/);
  return match ? compactText(match[0], 48) : '';
}

function friendlyTaskLabel(task: string): string {
  const value = String(task || '').toLowerCase();
  if (value.includes('daily report')) return '整理日报';
  if (value.includes('weekly report')) return '整理周报';
  if (value.includes('debug')) return '调试/排错';
  if (value.includes('fix test')) return '修复测试';
  if (value.includes('generate skill')) return '生成 Skill';
  if (value.includes('skill draft')) return '整理 Skill 草稿';
  if (value.includes('webapp usage')) return '分析 WebApp 使用记录';
  return cleanReportLine(task, 48) || '重复任务';
}

function summarizeToolFailure(toolCall: SessionToolCallLog): string {
  const name = String(toolCall.name || '').trim();
  const result = String(toolCall.result || '');
  if (/execute_shell|shell|command/i.test(name) || /command failed|exit code|command not found|not recognized|powershell/i.test(result)) {
    return '命令执行失败：需要回看命令、路径或本地依赖环境。';
  }
  return summarizeFailure(result || name);
}

function summarizeFailure(value: unknown, source = 'turn'): string {
  const text = compactText(value, 1000);
  const lower = text.toLowerCase();
  if (/command failed|exit code|command not found|not recognized|powershell|npm |npx |git /i.test(text)) {
    return '命令执行失败：需要回看命令、路径或本地依赖环境。';
  }
  if (source === 'runtime' || /runtime/.test(lower)) {
    return '运行时错误：需要回看对应功能的异常原因。';
  }
  if (/rate limit|too many requests/.test(lower)) {
    return '请求被限流：需要稍后重试或调整调用频率。';
  }
  if (/typeerror|exception|referenceerror|syntaxerror/.test(lower)) {
    return '代码异常：需要回看错误堆栈并定位触发条件。';
  }
  const cleaned = cleanReportLine(text, 90);
  return cleaned ? `问题信号：${cleaned}` : '发现一个需要回看的问题信号。';
}

function isNoiseTurn(userText: string, assistantText: string, toolCalls: number): boolean {
  if (toolCalls > 0) return false;
  const combined = compactText(`${userText} ${assistantText}`, 120).toLowerCase();
  if (!combined) return true;
  if (looksLikeAction(combined) || looksLikeFailure(combined)) return false;
  if (combined.length <= 36 && /^(hi|hello|ok|okay|thanks|thank you|test|testing|收到|好的|可以|嗯|哈哈|辛苦了)/i.test(combined)) return true;
  return /(just testing|test message|ignore this|随便试|测试一下)/i.test(combined);
}

function looksLikeAction(text: string): boolean {
  return /(generate|create|write|summarize|debug|fix|review|analyze|implement|report|skill|dashboard|webapp|生成|创建|修复|分析|报告|日报|技能)/i.test(text || '');
}

function looksLikeFailure(text: string): boolean {
  return /(error|failed|failure|exception|runtime|typeerror|command not found|not recognized|rate limit|错误|失败|异常|报错)/i.test(text || '');
}

function entryDate(entry: ParsedSessionLogEntry, session: SessionLogSummary): string {
  const timestamp = String((entry as any).timestamp || session.lastTimestamp || session.updatedAt || '');
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return isoDate(new Date(session.updatedAt));
  return isoDate(date);
}

function latestSessionDate(sessions: SessionLogSummary[]): string {
  for (const session of sessions) {
    const timestamp = session.lastTimestamp || session.updatedAt;
    const date = normalizeReportDate(String(timestamp || '').slice(0, 10));
    if (date) return date;
  }
  return '';
}

function normalizeReportDate(value: unknown): string {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? '' : text;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalizeTurnKey(userText: string, assistantText: string): string {
  return compactText(`${userText}\n${assistantText}`, 300).toLowerCase();
}

function pushUnique(target: string[], value: string, limit: number): void {
  const next = cleanReportLine(value, 260);
  if (!next || target.includes(next)) return;
  target.push(next);
  if (target.length > limit) target.splice(limit);
}

function compactText(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function sanitizeMarkdownLine(value: string): string {
  return cleanReportLine(value, 320).replace(/\r?\n/g, ' ');
}

function cleanReportLine(value: unknown, limit: number): string {
  let text = String(value || '')
    .replace(/\r?\n/g, ' ')
    .replace(/```[\s\S]*?```/g, '代码块')
    .replace(/\$?\s*powershell\s+-command\s+["'][^"']+["']/ig, 'PowerShell 命令')
    .replace(/Working directory:\s*[^。；]+/ig, '')
    .replace(/Final cwd:\s*[^。；]+/ig, '')
    .replace(/Command failed:\s*/ig, '命令失败：')
    .replace(/execute_shell/ig, '命令工具')
    .replace(/\b[A-Z]:\\[^\s"'，。；)]+/g, '本地路径')
    .replace(/\{["']?command["']?:[^}]+}/ig, '命令参数')
    .replace(/\b(npm|pnpm|yarn|git|node|npx)\s+[^\n\r，。；]{0,140}/ig, '$1 命令')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (looksLikeRawArtifact(text)) text = summarizeRawArtifact(text);
  return text.slice(0, limit).trim();
}

function looksLikeRawArtifact(text: string): boolean {
  return /(powershell -command|Working directory|execute_shell|\{["']?command["']?:|\\AppData\\|\\Users\\|Command failed:\n|\$ powershell)/i.test(text);
}

function summarizeRawArtifact(text: string): string {
  if (/command|powershell|npm|npx|git|shell/i.test(text)) {
    return '命令执行失败：需要回看命令、路径或本地依赖环境。';
  }
  return '内部日志已清洗，仅保留可回看的问题信号。';
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
