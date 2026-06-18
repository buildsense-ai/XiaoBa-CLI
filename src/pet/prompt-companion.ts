import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';
import {
  getPromptEditorFile,
  getPromptEditorState,
  writePromptOverride,
} from '../utils/prompt-editor';
import { readRequiredDefaultPromptFile } from '../utils/prompt-template';
import {
  isSessionTurnEntry,
  parseSessionLogContent,
  ParsedSessionLogEntry,
  SessionPromptTraceLogEntry,
} from '../utils/session-log-schema';
import { getPetService } from './pet-service';
import { resolvePetDataDir } from './pet-store';
import { PetEvent } from './pet-types';

const STATE_FILE = 'prompt-companion-state.json';
const DEFAULT_TARGET_PROMPT = 'system-prompt.md';

const BRIEF_MARKER = '<!-- catsco:companion-brief-response-v1 -->';
const RECOVERY_MARKER = '<!-- catsco:companion-error-recovery-v1 -->';
const CACHE_TTL_MS = 60 * 60 * 1000;
const ADVISOR_MAX_TOKENS = 900;
type PromptEditorStateSnapshot = Awaited<ReturnType<typeof getPromptEditorState>>;

export interface PromptCompanionProposal {
  id: string;
  title: string;
  path: string;
  operation: 'append' | 'replace';
  reason: string;
  risk: string;
  base_hash: string;
  proposed_hash: string;
  proposed_content: string;
  preview: string;
  trigger: 'baseline' | 'recent_errors';
  signals: PromptCompanionSignals;
  created_at: string;
}

export interface PromptCompanionSignals {
  recent_events: number;
  recent_errors: number;
  recent_skill_failures: number;
  recent_session_logs: number;
  recent_session_turns: number;
  recent_session_failures: number;
  recent_session_tool_calls: number;
  prompt_system_hash: string;
  prompt_bundle_hash: string;
}

interface PromptCompanionState {
  dismissed: Record<string, string>;
  applied: Record<string, string>;
  cached?: PromptCompanionProposal;
}

export async function getPromptCompanionProposal(options: {
  includeDismissed?: boolean;
  id?: string;
} = {}): Promise<{ proposal: PromptCompanionProposal | null; signals: PromptCompanionSignals }> {
  const state = await getPromptEditorState();
  const events = getPetService().timeline(50);
  const signals = buildSignals(events, state.trace, readRecentSessionSignals());
  const stateFile = readState();
  const cached = getUsableCachedProposal(stateFile, state, options.id);
  if (cached) {
    const key = dismissalKey(cached);
    if (!options.includeDismissed && stateFile.dismissed[key]) {
      return { proposal: null, signals };
    }
    return { proposal: cached, signals };
  }

  const proposal = await buildAdvisorProposal({
    requestedId: options.id,
    state,
    signals,
  });

  if (!proposal) return { proposal: null, signals };
  stateFile.cached = proposal;
  writeState(stateFile);
  const key = dismissalKey(proposal);
  if (!options.includeDismissed && stateFile.dismissed[key]) {
    return { proposal: null, signals };
  }
  return { proposal, signals };
}

export async function applyPromptCompanionProposal(id: string): Promise<{
  ok: true;
  applied: true;
  proposal: PromptCompanionProposal;
  file: ReturnType<typeof writePromptOverride>;
}> {
  const { proposal } = await getPromptCompanionProposal({ includeDismissed: true, id });
  if (!proposal) throw new Error(`Prompt proposal is not available: ${id}`);

  const file = writePromptOverride(proposal.path, proposal.proposed_content);
  const state = readState();
  state.applied[dismissalKey(proposal)] = new Date().toISOString();
  writeState(state);

  getPetService().recordEvent({
    event_type: 'task_completed',
    status: 'success',
    message: `已应用 prompt 建议：${proposal.title}`,
    metadata: { surface: 'prompt_companion' },
  });

  return { ok: true, applied: true, proposal, file };
}

export async function dismissPromptCompanionProposal(id: string): Promise<{
  ok: true;
  dismissed: true;
  proposal: PromptCompanionProposal;
}> {
  const { proposal } = await getPromptCompanionProposal({ includeDismissed: true, id });
  if (!proposal) throw new Error(`Prompt proposal is not available: ${id}`);

  const state = readState();
  state.dismissed[dismissalKey(proposal)] = new Date().toISOString();
  writeState(state);
  return { ok: true, dismissed: true, proposal };
}

async function buildAdvisorProposal(options: {
  requestedId?: string;
  state: PromptEditorStateSnapshot;
  signals: PromptCompanionSignals;
}): Promise<PromptCompanionProposal | null> {
  if (!options.requestedId) {
    const llmProposal = await tryBuildLlmProposal(options);
    if (llmProposal) return llmProposal;
  }
  return buildFallbackProposal(options);
}

function buildFallbackProposal(options: {
  requestedId?: string;
  state: PromptEditorStateSnapshot;
  signals: PromptCompanionSignals;
}): PromptCompanionProposal | null {
  const file = getPromptEditorFile(DEFAULT_TARGET_PROMPT);
  const current = file.content || '';
  const baseHash = file.effective.short_hash;
  const wantsRecovery = options.signals.recent_errors > 0
    || options.signals.recent_skill_failures > 0
    || options.signals.recent_session_failures > 0;

  if (wantsRecovery && !current.includes(RECOVERY_MARKER)) {
    const proposal = createRecoveryProposal(current, baseHash, options.signals);
    return matchesRequested(proposal, options.requestedId) ? proposal : null;
  }

  if (!current.includes(BRIEF_MARKER)) {
    const proposal = createBriefProposal(current, baseHash, options.signals);
    return matchesRequested(proposal, options.requestedId) ? proposal : null;
  }

  if (!current.includes(RECOVERY_MARKER)) {
    const proposal = createRecoveryProposal(current, baseHash, options.signals);
    return matchesRequested(proposal, options.requestedId) ? proposal : null;
  }

  return null;
}

async function tryBuildLlmProposal(options: {
  state: PromptEditorStateSnapshot;
  signals: PromptCompanionSignals;
}): Promise<PromptCompanionProposal | null> {
  if (/^(0|false|off|no)$/i.test(String(process.env.XIAOBA_PROMPT_COMPANION_LLM || 'true').trim())) {
    return null;
  }

  try {
    const ai = new AIService({ maxTokens: ADVISOR_MAX_TOKENS });
    const response = await ai.chat([
      { role: 'system', content: readRequiredDefaultPromptFile('sidecars/prompt-companion-advisor.md') },
      { role: 'user', content: buildAdvisorUserPrompt(options.state, options.signals) },
    ]);
    const parsed = parseAdvisorJson(response.content || '');
    if (!parsed || parsed.skip) return null;
    const targetPath = normalizeAdvisorTargetPath(parsed.target_path, options.state);
    if (!targetPath) return null;
    const file = getPromptEditorFile(targetPath);
    const current = file.content || '';
    const patch = buildAdvisorPatch(current, parsed);
    if (!patch) return null;
    return createProposal({
      id: `advisor-${hashText(`${targetPath}\n${patch.preview}`).slice(0, 10)}`,
      title: sanitizeSingleLine(parsed.title || 'Prompt 调优建议', 40),
      reason: sanitizeSingleLine(parsed.reason || '宠物 advisor 根据最近运行信号提出了一条 prompt 小改动。', 180),
      risk: sanitizeSingleLine(parsed.risk || '需要人工确认；只写入本地 prompt 覆盖。', 160),
      trigger: options.signals.recent_errors > 0 || options.signals.recent_session_failures > 0 ? 'recent_errors' : 'baseline',
      path: targetPath,
      operation: patch.operation,
      baseHash: file.effective.short_hash,
      current,
      proposed: patch.proposed,
      preview: patch.preview,
      signals: options.signals,
    });
  } catch (error: any) {
    Logger.warning(`[PromptCompanion] LLM advisor failed, fallback will be used: ${error?.message || String(error)}`);
    return null;
  }
}

function buildAdvisorUserPrompt(state: PromptEditorStateSnapshot, signals: PromptCompanionSignals): string {
  const editablePaths = (state.files || []).map(file => file.path);
  const excerpts = editablePaths
    .filter(path => shouldIncludePromptExcerpt(path))
    .slice(0, 10)
    .map(path => {
      const file = getPromptEditorFile(path);
      return {
        path,
        hash: file.effective.short_hash,
        excerpt: file.content.trim().slice(0, 1800),
      };
    });
  return JSON.stringify({
    goal: '根据 CatsCo 最近运行信号，判断是否需要调用 catsco-prompt-editor 风格的 prompt 小改动。',
    editable_paths: editablePaths,
    constraints: [
      '只能修改 editable_paths 里的现有 .md 文件。',
      '优先提出一处小改动；operation 可为 append 或 replace。',
      'append 用 append_section；replace 必须提供原文精确 find 和替换文本 replace。',
      '不要重写整篇 prompt；不要输出完整文件。',
      '不要加入密钥、用户隐私、长日志或具体聊天内容。',
      '如果没有明显收益，返回 {"skip":true}。',
    ],
    signals,
    prompt_excerpts: excerpts,
  }, null, 2);
}

function parseAdvisorJson(text: string): any | null {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fenced ? fenced[1].trim() : raw.replace(/^[\s\S]*?(\{)/, '$1').replace(/(\})[\s\S]*$/, '$1');
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function buildAdvisorPatch(current: string, parsed: any): { operation: 'append' | 'replace'; proposed: string; preview: string } | null {
  const operation = String(parsed.operation || 'append').toLowerCase();
  if (operation === 'replace') {
    const find = sanitizePatchText(parsed.find, 1800);
    const replacement = sanitizePatchText(parsed.replace, 2400);
    if (!find || !replacement || !current.includes(find)) return null;
    const proposed = current.replace(find, replacement);
    return { operation: 'replace', proposed, preview: `- ${find}\n+ ${replacement}` };
  }

  const appendSection = sanitizeAdvisorSection(parsed.append_section);
  if (!appendSection) return null;
  const proposed = appendSectionToPrompt(current, appendSection);
  return { operation: 'append', proposed, preview: appendSection };
}

function sanitizeAdvisorSection(value: unknown): string {
  const text = String(value || '').trim();
  if (!text || text.length > 1800) return '';
  if (/api[_-]?key|secret|token|password|sk-[a-z0-9_-]{12,}/i.test(text)) return '';
  const marker = `<!-- catsco:companion-advisor-v1:${hashText(text).slice(0, 10)} -->`;
  return text.includes('<!-- catsco:companion-advisor-v1') ? text : `${marker}\n${text}`;
}

function appendSectionToPrompt(current: string, section: string): string {
  return appendSection(current, section);
}

function sanitizePatchText(value: unknown, maxLength: number): string {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) return '';
  if (/api[_-]?key|secret|token|password|sk-[a-z0-9_-]{12,}/i.test(text)) return '';
  return text;
}

function normalizeAdvisorTargetPath(value: unknown, state: PromptEditorStateSnapshot): string {
  const target = String(value || DEFAULT_TARGET_PROMPT).replace(/\\/g, '/').trim();
  const available = new Set((state.files || []).map(file => file.path));
  return available.has(target) ? target : '';
}

function shouldIncludePromptExcerpt(filePath: string): boolean {
  return filePath === 'system-prompt.md'
    || filePath === 'runtime-context.md'
    || filePath === 'compact-system.md'
    || filePath === 'sidecars/prompt-companion-advisor.md'
    || filePath.startsWith('subagents/')
    || filePath.startsWith('transient/');
}

function createBriefProposal(current: string, baseHash: string, signals: PromptCompanionSignals): PromptCompanionProposal {
  const section = [
    BRIEF_MARKER,
    '## 默认表达',
    '- 默认先给结论或下一步，少写铺垫。',
    '- 简单问题用 3-6 行回答；复杂任务再分段，并优先行动。',
    '- 不确定时说明依据和需要确认的点，不堆砌内部过程。',
  ].join('\n');
  const proposed = appendSection(current, section);
  return createProposal({
    id: 'brief-response-v1',
    title: '让默认回复更简洁',
    reason: '宠物建议先把主 agent 的默认表达收紧，便于后续做 prompt A/B 对比。',
    risk: '低风险：只影响默认回复风格；用户要求详细时仍可展开。',
    trigger: 'baseline',
    baseHash,
    current,
    proposed,
    signals,
  });
}

function createRecoveryProposal(current: string, baseHash: string, signals: PromptCompanionSignals): PromptCompanionProposal {
  const section = [
    RECOVERY_MARKER,
    '## 异常恢复',
    '- 工具、网络或模型调用失败时，先用一句话告诉用户当前卡点和下一步。',
    '- 能重试时短暂重试一次；继续失败时给出替代方案或请用户确认。',
    '- 不把长错误栈、原始 JSON 或无关日志直接丢给用户，除非用户要求排查。',
  ].join('\n');
  const proposed = appendSection(current, section);
  return createProposal({
    id: 'error-recovery-v1',
    title: '补充异常恢复规则',
    reason: signals.recent_errors > 0
      ? `最近观察到 ${signals.recent_errors} 次异常事件，建议让 agent 更清楚地解释失败和下一步。`
      : signals.recent_session_failures > 0
        ? `最近 session log 中有 ${signals.recent_session_failures} 轮失败回复，建议让 agent 更清楚地解释失败和下一步。`
      : '宠物建议预先补一条异常恢复规则，减少用户看到生硬错误。',
    risk: '低风险：只影响异常提示方式，不改变工具权限或执行逻辑。',
    trigger: (signals.recent_errors > 0 || signals.recent_session_failures > 0) ? 'recent_errors' : 'baseline',
    baseHash,
    current,
    proposed,
    signals,
  });
}

function createProposal(options: {
  id: string;
  title: string;
  reason: string;
  risk: string;
  trigger: PromptCompanionProposal['trigger'];
  path?: string;
  operation?: PromptCompanionProposal['operation'];
  baseHash: string;
  current: string;
  proposed: string;
  preview?: string;
  signals: PromptCompanionSignals;
}): PromptCompanionProposal {
  return {
    id: options.id,
    title: options.title,
    path: options.path || DEFAULT_TARGET_PROMPT,
    operation: options.operation || 'append',
    reason: options.reason,
    risk: options.risk,
    base_hash: options.baseHash,
    proposed_hash: hashText(options.proposed).slice(0, 12),
    proposed_content: options.proposed,
    preview: options.preview || buildPreview(options.current, options.proposed),
    trigger: options.trigger,
    signals: options.signals,
    created_at: new Date().toISOString(),
  };
}

function getUsableCachedProposal(
  state: PromptCompanionState,
  editorState: PromptEditorStateSnapshot,
  requestedId?: string,
): PromptCompanionProposal | null {
  const proposal = state.cached;
  if (!proposal) return null;
  const file = (editorState.files || []).find(item => item.path === proposal.path);
  if (!file || file.effective.short_hash !== proposal.base_hash) return null;
  if (requestedId && proposal.id !== requestedId) return null;
  const created = Date.parse(proposal.created_at || '');
  if (!Number.isFinite(created) || Date.now() - created > CACHE_TTL_MS) return null;
  return proposal;
}

function buildSignals(
  events: PetEvent[],
  trace: Awaited<ReturnType<typeof getPromptEditorState>>['trace'],
  sessionSignals: SessionSignals,
): PromptCompanionSignals {
  const recentEvents = events.filter(event => isRecent(event.created_at));
  const recentErrors = recentEvents.filter(event => event.status === 'failed' || event.event_type === 'skill_failed').length;
  const recentSkillFailures = recentEvents.filter(event => event.event_type === 'skill_failed').length;
  return {
    recent_events: recentEvents.length,
    recent_errors: recentErrors,
    recent_skill_failures: recentSkillFailures,
    recent_session_logs: sessionSignals.logs,
    recent_session_turns: sessionSignals.turns,
    recent_session_failures: sessionSignals.failures,
    recent_session_tool_calls: sessionSignals.toolCalls,
    prompt_system_hash: trace.system?.short_hash || '',
    prompt_bundle_hash: trace.bundle?.short_hash || '',
  };
}

interface SessionSignals {
  logs: number;
  turns: number;
  failures: number;
  toolCalls: number;
}

function readRecentSessionSignals(): SessionSignals {
  const files = listRecentSessionLogFiles(resolveSessionLogsDir(), 8);
  const signals: SessionSignals = { logs: files.length, turns: 0, failures: 0, toolCalls: 0 };
  for (const filePath of files) {
    for (const entry of readPartialSessionLog(filePath)) {
      if (isSessionTurnEntry(entry)) {
        signals.turns += 1;
        signals.toolCalls += entry.assistant.tool_calls.length;
        if (looksLikeFailedAssistantText(entry.assistant.text)) signals.failures += 1;
      } else if (entry.entry_type === 'prompt_trace') {
        const promptTrace = entry as SessionPromptTraceLogEntry;
        if (promptTrace.prompt?.system?.short_hash) {
          // Touching the trace keeps this scanner aligned with prompt observability without
          // storing full prompt text or user transcript content.
        }
      }
    }
  }
  return signals;
}

function resolveSessionLogsDir(env: NodeJS.ProcessEnv = process.env): string {
  const userData = String(env.XIAOBA_ELECTRON_USER_DATA_DIR || env.XIAOBA_USER_DATA_DIR || env.CATSCO_USER_DATA_DIR || '').trim();
  if (userData) return path.join(path.resolve(userData), 'logs', 'sessions');
  return path.resolve(process.cwd(), 'logs', 'sessions');
}

function listRecentSessionLogFiles(root: string, limit: number): string[] {
  if (!fs.existsSync(root)) return [];
  const files: { path: string; mtime: number }[] = [];
  walkFiles(root, filePath => {
    if (path.extname(filePath).toLowerCase() !== '.jsonl') return;
    try {
      files.push({ path: filePath, mtime: fs.statSync(filePath).mtimeMs });
    } catch (_error) {
      // Ignore disappearing log files.
    }
  });
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.max(1, limit))
    .map(file => file.path);
}

function readPartialSessionLog(filePath: string): ParsedSessionLogEntry[] {
  try {
    const stat = fs.statSync(filePath);
    const maxBytes = 256 * 1024;
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const text = buffer.toString('utf8');
      const normalized = start > 0 ? text.replace(/^[^\n]*(\n|$)/, '') : text;
      return parseSessionLogContent(normalized).slice(-80);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_error) {
    return [];
  }
}

function looksLikeFailedAssistantText(text: string): boolean {
  return /\[处理失败|API错误|请求失败|Connection error|MaxRetriesExceeded|rate limit|上下文|context/i.test(text || '');
}

function walkFiles(directory: string, visit: (filePath: string) => void): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(filePath, visit);
    else if (entry.isFile()) visit(filePath);
  }
}

function appendSection(current: string, section: string): string {
  return `${String(current || '').trim()}\n\n${section.trim()}`;
}

function buildPreview(current: string, proposed: string): string {
  if (proposed.startsWith(current.trim())) {
    return proposed.slice(current.trim().length).trim();
  }
  return proposed.slice(Math.max(0, proposed.length - 1200)).trim();
}

function matchesRequested(proposal: PromptCompanionProposal, requestedId?: string): boolean {
  return !requestedId || proposal.id === requestedId;
}

function dismissalKey(proposal: PromptCompanionProposal): string {
  return `${proposal.id}:${proposal.base_hash}`;
}

function isRecent(value: string): boolean {
  const time = Date.parse(value || '');
  return Number.isFinite(time) && Date.now() - time <= 24 * 60 * 60 * 1000;
}

function statePath(): string {
  return path.join(resolvePetDataDir(), STATE_FILE);
}

function readState(): PromptCompanionState {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PromptCompanionState>;
    return {
      dismissed: parsed.dismissed && typeof parsed.dismissed === 'object' ? parsed.dismissed : {},
      applied: parsed.applied && typeof parsed.applied === 'object' ? parsed.applied : {},
      cached: parsed.cached,
    };
  } catch (_error) {
    return { dismissed: {}, applied: {} };
  }
}

function writeState(state: PromptCompanionState): void {
  const filePath = statePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sanitizeSingleLine(value: string, maxLength: number): string {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
