import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  listRecentSessionLogs,
  readSessionLogByFileId,
  SessionLogSummary,
} from '../dashboard/session-logs';
import { getSkillDrafts, SkillDraft } from './skill-draft-companion';
import { isSessionTurnEntry, ParsedSessionLogEntry } from '../utils/session-log-schema';

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
    title: `Daily Report - ${date}`,
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
    const userText = compactText(entry.user.text, 260);
    const assistantText = compactText(entry.assistant.text, 260);
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
    const completed = extractCompletedWork(userText, assistantText);
    if (completed) pushUnique(signals.completed, completed, 6);
    const preference = extractPreference(userText);
    if (preference) pushUnique(signals.preferences, preference, 5);
    const taskKey = extractTaskKey(userText);
    if (taskKey) signals.commonTasks.set(taskKey, (signals.commonTasks.get(taskKey) || 0) + 1);

    if (looksLikeFailure(assistantText)) {
      pushUnique(signals.failures, assistantText, 6);
    }
    for (const toolCall of entry.assistant.tool_calls) {
      const result = compactText(toolCall.result, 220);
      if (looksLikeFailure(result)) pushUnique(signals.failures, result, 6);
    }
    return;
  }

  if (entry.entry_type === 'runtime') {
    const level = String(entry.level || '').toLowerCase();
    const message = compactText(entry.message, 260);
    if (level === 'error' || looksLikeFailure(message)) {
      signals.runtimeErrors += 1;
      pushUnique(signals.failures, message, 6);
    }
  }
}

function toSkillCandidate(draft: SkillDraft): DailyReportSkillCandidate {
  return {
    id: draft.id,
    name: draft.name,
    action: draft.action,
    reason: draft.reason,
    requiresConfirmation: true,
    autoInstall: false,
  };
}

function buildSummary(
  date: string,
  signals: DailyReportSignals,
  repeatedTasks: Array<{ task: string; count: number }>,
  skillCandidates: DailyReportSkillCandidate[],
): string {
  const parts = [`Daily report for ${date}`];
  if (signals.completed.length) parts.push(`${signals.completed.length} useful work item${signals.completed.length === 1 ? '' : 's'} captured`);
  if (signals.failures.length) parts.push(`${signals.failures.length} issue signal${signals.failures.length === 1 ? '' : 's'} found`);
  if (signals.preferences.length) parts.push(`${signals.preferences.length} preference signal${signals.preferences.length === 1 ? '' : 's'} kept`);
  if (repeatedTasks.length) parts.push(`${repeatedTasks.length} repeated task pattern${repeatedTasks.length === 1 ? '' : 's'}`);
  if (skillCandidates.length) parts.push(`${skillCandidates.length} confirmation-gated skill candidate${skillCandidates.length === 1 ? '' : 's'}`);
  if (parts.length === 1) parts.push('no high-value work signals found yet');
  return `${parts.join('; ')}.`;
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
    `# Daily Report - ${input.date}`,
    '',
    input.summary,
    '',
  ];
  addSection(lines, 'Completed Work', input.completed);
  addSection(lines, 'Issues To Review', input.failures);
  addSection(lines, 'User Preferences', input.preferences);
  addSection(lines, 'Repeated Tasks', input.repeatedTasks.map(item => `${item.task}: seen ${item.count} times`));
  addSection(lines, 'Skill Candidates', input.skillCandidates.map(item => `${item.name}: ${item.reason}`));
  lines.push('## Metrics', '');
  lines.push(`- Sessions scanned: ${input.metrics.sessions}`);
  lines.push(`- Useful turns: ${input.metrics.turns}`);
  lines.push(`- Tool calls: ${input.metrics.toolCalls}`);
  lines.push(`- Runtime errors: ${input.metrics.runtimeErrors}`);
  lines.push(`- Noise filtered: ${input.noise.filteredTurns}/${input.noise.scannedTurns}`);
  lines.push('', 'This report is a local draft. Save or turn items into skills only after user confirmation.');
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
    lines.push('- None detected.');
  } else {
    for (const item of items) lines.push(`- ${sanitizeMarkdownLine(item)}`);
  }
  lines.push('');
}

function extractCompletedWork(userText: string, assistantText: string): string {
  if (!assistantText) return '';
  if (/(completed|done|implemented|added|created|fixed|generated|saved|updated|passed|完成|已完成|新增|修复|生成|保存|通过)/i.test(assistantText)) {
    return assistantText;
  }
  if (/(report|skill|dashboard|webapp|pet|log|test|build)/i.test(userText) && assistantText.length > 16) {
    return assistantText;
  }
  return '';
}

function extractPreference(text: string): string {
  const value = compactText(text, 220);
  if (!value) return '';
  if (value.length > 220) return '';
  if (/(from now on|always|never|prefer|please use|keep .* concise|in chinese|use chinese)/i.test(value)) return value;
  if (/(以后|从现在起|之后).*(请|用|不要|别|都|保持|尽量)/.test(value)) return value;
  if (/(记住|偏好|我希望).*(回复|格式|语气|中文|英文|简短|详细)/.test(value)) return value;
  return '';
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
  const next = compactText(value, 260);
  if (!next || target.includes(next)) return;
  target.push(next);
  if (target.length > limit) target.splice(limit);
}

function compactText(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function sanitizeMarkdownLine(value: string): string {
  return compactText(value, 320).replace(/\r?\n/g, ' ');
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
