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
const ADVISOR_SCHEMA_VERSION = 'prompt-companion-v4';
type PromptEditorStateSnapshot = Awaited<ReturnType<typeof getPromptEditorState>>;
type PromptCompanionOperation = 'append' | 'replace' | 'delete';

export interface PromptCompanionProposal {
  schema_version: string;
  id: string;
  title: string;
  path: string;
  operation: PromptCompanionOperation;
  issue: string;
  evidence: string;
  change_summary: string;
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

export interface PromptCompanionAdvisorReply {
  skipped: boolean;
  issue: string;
  evidence: string;
  message: string;
  change_summary?: string;
  suggestion?: string;
}

export interface PromptCompanionSignals {
  recent_events: number;
  recent_errors: number;
  recent_skill_failures: number;
  recent_session_logs: number;
  recent_session_turns: number;
  recent_session_failures: number;
  recent_session_tool_calls: number;
  recent_runtime_errors: number;
  recent_runtime_warnings: number;
  recent_session_quality_flags: Record<string, number>;
  recent_session_quality_notes: string[];
  prompt_system_hash: string;
  prompt_bundle_hash: string;
}

interface PromptCompanionState {
  dismissed: Record<string, string>;
  applied: Record<string, string>;
  cached?: PromptCompanionProposal;
  cached_skip?: {
    created_at: string;
    signals_hash: string;
  };
}

interface PromptCompanionBuildResult {
  proposal: PromptCompanionProposal | null;
  advisor?: PromptCompanionAdvisorReply;
}

export async function getPromptCompanionProposal(options: {
  includeDismissed?: boolean;
  id?: string;
  note?: string;
} = {}): Promise<{ proposal: PromptCompanionProposal | null; signals: PromptCompanionSignals; advisor?: PromptCompanionAdvisorReply }> {
  const state = await getPromptEditorState();
  const events = getPetService().timeline(50);
  const signals = buildSignals(events, state.trace, readRecentSessionSignals());
  const stateFile = readState();
  const advisorNote = sanitizeAdvisorNote(options.note);
  if (!options.id && !advisorNote && getUsableCachedSkip(stateFile, signals)) {
    return { proposal: null, signals };
  }
  const cached = advisorNote ? null : getUsableCachedProposal(stateFile, state, options.id);
  if (cached) {
    const key = dismissalKey(cached);
    if (!options.includeDismissed && stateFile.dismissed[key]) {
      return { proposal: null, signals };
    }
    return { proposal: cached, signals };
  }

  const buildResult = await buildAdvisorProposal({
    requestedId: options.id,
    note: advisorNote,
    state,
    signals,
  });
  const proposal = buildResult.proposal;

  if (!proposal) {
    if (!advisorNote) {
      stateFile.cached_skip = {
        created_at: new Date().toISOString(),
        signals_hash: signalHash(signals),
      };
    }
    writeState(stateFile);
    return { proposal: null, signals, advisor: buildResult.advisor };
  }
  stateFile.cached = proposal;
  delete stateFile.cached_skip;
  writeState(stateFile);
  const key = dismissalKey(proposal);
  if (!options.includeDismissed && stateFile.dismissed[key]) {
    return { proposal: null, signals, advisor: buildResult.advisor };
  }
  return { proposal, signals, advisor: buildResult.advisor };
}

export async function getCachedPromptCompanionProposal(options: {
  includeDismissed?: boolean;
  id?: string;
} = {}): Promise<{ proposal: PromptCompanionProposal | null; signals: PromptCompanionSignals }> {
  const state = await getPromptEditorState();
  const events = getPetService().timeline(50);
  const signals = buildSignals(events, state.trace, readRecentSessionSignals());
  const stateFile = readState();
  const cached = getUsableCachedProposal(stateFile, state, options.id);
  if (!cached) return { proposal: null, signals };
  const key = dismissalKey(cached);
  if (!options.includeDismissed && stateFile.dismissed[key]) {
    return { proposal: null, signals };
  }
  return { proposal: cached, signals };
}

export async function applyPromptCompanionProposal(id: string): Promise<{
  ok: true;
  applied: true;
  proposal: PromptCompanionProposal;
  file: ReturnType<typeof writePromptOverride>;
}> {
  const normalizedId = String(id || '').trim();
  if (!normalizedId) throw new Error('Prompt proposal id is required');

  const editorState = await getPromptEditorState();
  const state = readState();
  const proposal = getUsableCachedProposal(state, editorState, normalizedId);
  if (!proposal) throw new Error(`Prompt proposal is not available: ${id}`);

  assertSafePromptCompanionProposal(proposal, getPromptEditorFile(proposal.path).content || '');
  const file = writePromptOverride(proposal.path, proposal.proposed_content);
  state.applied[dismissalKey(proposal)] = new Date().toISOString();
  delete state.cached;
  delete state.cached_skip;
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
  const normalizedId = String(id || '').trim();
  if (!normalizedId) throw new Error('Prompt proposal id is required');

  const editorState = await getPromptEditorState();
  const state = readState();
  const proposal = getUsableCachedProposal(state, editorState, normalizedId);
  if (!proposal) throw new Error(`Prompt proposal is not available: ${id}`);

  state.dismissed[dismissalKey(proposal)] = new Date().toISOString();
  delete state.cached;
  writeState(state);
  return { ok: true, dismissed: true, proposal };
}

async function buildAdvisorProposal(options: {
  requestedId?: string;
  note?: string;
  state: PromptEditorStateSnapshot;
  signals: PromptCompanionSignals;
}): Promise<PromptCompanionBuildResult> {
  if (!options.requestedId) {
    const llmResult = await tryBuildLlmProposal(options);
    if (llmResult.proposal || llmResult.advisor) return llmResult;
    if (options.note) {
      return {
        proposal: null,
        advisor: createManualNoDiffAdvisor(),
      };
    }
  }
  return { proposal: buildFallbackProposal(options) };
}

function buildFallbackProposal(options: {
  requestedId?: string;
  note?: string;
  state: PromptEditorStateSnapshot;
  signals: PromptCompanionSignals;
}): PromptCompanionProposal | null {
  const file = getPromptEditorFile(DEFAULT_TARGET_PROMPT);
  const current = file.content || '';
  const baseHash = file.effective.short_hash;
  const wantsRecovery = options.signals.recent_errors > 0
    || options.signals.recent_skill_failures > 0
    || options.signals.recent_session_failures > 0
    || options.signals.recent_runtime_errors > 0;

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
  note?: string;
  state: PromptEditorStateSnapshot;
  signals: PromptCompanionSignals;
}): Promise<PromptCompanionBuildResult> {
  if (/^(0|false|off|no)$/i.test(String(process.env.XIAOBA_PROMPT_COMPANION_LLM || 'true').trim())) {
    return { proposal: null };
  }

  try {
    const ai = new AIService({ maxTokens: ADVISOR_MAX_TOKENS });
    const response = await ai.chat([
      { role: 'system', content: readRequiredDefaultPromptFile('sidecars/prompt-companion-advisor.md') },
      { role: 'user', content: buildAdvisorUserPrompt(options.state, options.signals, options.note) },
    ]);
    const parsed = parseAdvisorJson(response.content || '');
    if (!parsed) {
      return {
        proposal: null,
        advisor: options.note ? createManualNoDiffAdvisor('旁路模型没有返回可解析的 JSON，所以这次没有生成 prompt diff。') : undefined,
      };
    }
    if (parsed.skip) {
      return {
        proposal: null,
        advisor: createAdvisorReply(parsed, createManualNoDiffAdvisor()),
      };
    }
    const targetPath = normalizeAdvisorTargetPath(parsed.target_path, options.state);
    if (!targetPath) return { proposal: null, advisor: createRejectedAdvisor('旁路模型给了改动方向，但目标文件不在可编辑 prompt 列表里。') };
    const file = getPromptEditorFile(targetPath);
    const current = file.content || '';
    const patch = buildAdvisorPatch(current, parsed);
    if (!patch) return { proposal: null, advisor: createRejectedAdvisor('旁路模型给了改动方向，但 diff 没通过安全校验或无法精确命中原文。') };
    const proposal = createProposal({
      id: `advisor-${hashText(`${targetPath}\n${patch.preview}`).slice(0, 10)}`,
      title: sanitizeSingleLine(parsed.title || 'Prompt 调优建议', 40),
      reason: sanitizeSingleLine(parsed.reason || '宠物 advisor 根据最近运行信号提出了一条 prompt 小改动。', 180),
      risk: sanitizeSingleLine(parsed.risk || '需要人工确认；只写入本地 prompt 覆盖。', 160),
      issue: sanitizeAdvisorReplyText(parsed.issue || parsed.problem || parsed.reason || '发现一条可以通过 prompt 小改动改善的稳定行为问题。', 180),
      evidence: sanitizeAdvisorReplyText(parsed.evidence || parsed.observation || '依据最近 session/runtime log 摘要、宠物事件和 prompt 摘要判断。', 220),
      changeSummary: sanitizeAdvisorReplyText(parsed.change_summary || parsed.change || parsed.message || '生成一处小 diff，应用前需要人工确认。', 180),
      trigger: options.signals.recent_errors > 0 || options.signals.recent_session_failures > 0 || options.signals.recent_runtime_errors > 0 ? 'recent_errors' : 'baseline',
      path: targetPath,
      operation: patch.operation,
      baseHash: file.effective.short_hash,
      current,
      proposed: patch.proposed,
      preview: patch.preview,
      signals: options.signals,
    });
    return {
      proposal,
      advisor: createAdvisorReply(parsed, {
        skipped: false,
        issue: '发现一条可以通过 prompt 小改动改善的稳定行为问题。',
        evidence: '依据最近 session/runtime log 摘要、宠物事件和 prompt 摘要判断。',
        message: '已根据你的补充生成一条可预览的小 diff。',
        change_summary: '生成一处小 diff，应用前需要人工确认。',
      }),
    };
  } catch (error: any) {
    Logger.warning(`[PromptCompanion] LLM advisor failed, fallback will be used: ${error?.message || String(error)}`);
    return {
      proposal: null,
      advisor: options.note ? createManualNoDiffAdvisor('旁路模型调用失败，所以这次没有生成 prompt diff。') : undefined,
    };
  }
}

function buildAdvisorUserPrompt(state: PromptEditorStateSnapshot, signals: PromptCompanionSignals, note?: string): string {
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
    user_note: note || '',
    editable_paths: editablePaths,
    constraints: [
      '只能修改 editable_paths 里的现有 .md 文件。',
      '优先提出一处小改动；operation 可为 append、replace 或 delete。',
      'append 用 append_section；replace 必须提供原文精确 find 和替换文本 replace；delete 必须提供原文精确 find。',
      '不要重写整篇 prompt；不要输出完整文件。',
      'delete 只用于删除过时、重复或互相冲突的短片段，不能删除整篇 prompt 或大段核心规则。',
      '不要加入密钥、用户隐私、长日志或具体聊天内容。',
      'append_section、replace 或 delete 的 find 应该对应稳定规则，不是一次性任务说明。',
      '先诊断问题，再描述改动：issue 写问题，evidence 写你根据什么判断，change_summary 写准备怎么改，不要混成一句。',
      '如果 user_note 为空，主要根据最近 session log、runtime log 和宠物事件信号判断。',
      '如果 user_note 不为空，把它当作用户给旁路 advisor 的调优方向，但仍必须遵守所有安全和小改动约束。',
      'recent_session_quality_flags 和 recent_session_quality_notes 是从 session 内容脱敏聚合出的质量信号，优先用于判断回复内容问题；不要要求或复述原始聊天文本。',
      '不要凭质量标签推断具体操作系统、shell 或命令族；除非信号明确给出，只能写“当前 shell 的等价命令/更可移植命令”。',
      '如果没有明显收益，返回 {"skip":true}。',
    ],
    signals,
    prompt_excerpts: excerpts,
  }, null, 2);
}

function createAdvisorReply(parsed: any, fallback: PromptCompanionAdvisorReply): PromptCompanionAdvisorReply {
  const issue = sanitizeAdvisorReplyText(
    parsed.issue || parsed.problem || fallback.issue,
    180,
  ) || fallback.issue;
  const evidence = sanitizeAdvisorReplyText(
    parsed.evidence || parsed.observation || fallback.evidence,
    220,
  ) || fallback.evidence;
  const message = sanitizeAdvisorReplyText(
    parsed.message || parsed.skip_reason || parsed.reason || fallback.message,
    240,
  ) || fallback.message;
  const changeSummary = sanitizeAdvisorReplyText(
    parsed.change_summary || parsed.change || fallback.change_summary || '',
    180,
  );
  const suggestion = sanitizeAdvisorReplyText(
    parsed.suggestion || parsed.next_question || parsed.hint || fallback.suggestion || '',
    220,
  );
  return {
    skipped: Boolean(parsed.skip),
    issue,
    evidence,
    message,
    ...(changeSummary ? { change_summary: changeSummary } : {}),
    ...(suggestion ? { suggestion } : {}),
  };
}

function createManualNoDiffAdvisor(message = '这更像一次运行链路诊断，不一定适合直接写进长期 system prompt。'): PromptCompanionAdvisorReply {
  return {
    skipped: true,
    issue: '这次询问还没有形成稳定、可复用的 prompt 问题。',
    evidence: '旁路 advisor 只看到摘要信号和你的补充说明，没有足够依据把它写成长效规则。',
    message,
    suggestion: '如果你想让它形成改动，可以这样问：请把“遇到网络/工具问题时如何说明和恢复”写成一条长期规则，只改 system-prompt.md。',
  };
}

function createRejectedAdvisor(message: string): PromptCompanionAdvisorReply {
  return {
    skipped: true,
    issue: '旁路模型给出了方向，但改动没有通过安全或精确命中检查。',
    evidence: '目标文件、find 文本或 diff 范围不满足受控 prompt 编辑规则。',
    message,
    suggestion: '可以指定目标文件和稳定规则，例如：只改 system-prompt.md，追加一条“网络异常时先说明卡点和下一步”的短规则。',
  };
}

function sanitizeAdvisorReplyText(value: unknown, maxLength: number): string {
  const text = sanitizeSingleLine(String(value || ''), maxLength);
  if (!text) return '';
  if (/api[_-]?key|secret|password|sk-[a-z0-9_-]{12,}|token\s*[:=]/i.test(text)) return '';
  return text;
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

function buildAdvisorPatch(current: string, parsed: any): { operation: PromptCompanionOperation; proposed: string; preview: string } | null {
  const operation = String(parsed.operation || 'append').toLowerCase();
  if (operation === 'replace') {
    const find = sanitizePatchText(parsed.find, 1800);
    const replacement = sanitizePatchText(parsed.replace, 2400);
    if (!find || !replacement || !hasUniqueMatch(current, find)) return null;
    if (containsProtectedPromptText(find) || containsUnsafePromptInstruction(replacement)) return null;
    const proposed = current.replace(find, replacement);
    if (!isSafePromptAdvisorPatch(current, proposed)) return null;
    return { operation: 'replace', proposed, preview: `- ${find}\n+ ${replacement}` };
  }

  if (operation === 'delete') {
    const find = sanitizePatchText(parsed.find, 1800);
    if (!find || !canDeletePromptText(current, find)) return null;
    const proposed = normalizePromptAfterDelete(current.replace(find, ''));
    if (!isUsablePromptAfterDelete(current, proposed)) return null;
    return { operation: 'delete', proposed, preview: `- ${find}` };
  }

  const appendSection = sanitizeAdvisorSection(parsed.append_section);
  if (!appendSection) return null;
  if (containsUnsafePromptInstruction(appendSection)) return null;
  const proposed = appendSectionToPrompt(current, appendSection);
  if (!isSafePromptAdvisorPatch(current, proposed)) return null;
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

function canDeletePromptText(current: string, find: string): boolean {
  const source = String(current || '').trim();
  if (!source || !hasUniqueMatch(source, find)) return false;
  if (source === find.trim()) return false;
  if (find.length > Math.min(600, Math.max(80, Math.floor(source.length * 0.2)))) return false;
  if (find.split('\n').length > 12) return false;
  if (containsProtectedPromptText(find)) return false;
  if (!looksLikeStalePromptText(find)) return false;
  return true;
}

function hasUniqueMatch(source: string, find: string): boolean {
  if (!source || !find) return false;
  const first = source.indexOf(find);
  return first >= 0 && source.indexOf(find, first + find.length) < 0;
}

function containsProtectedPromptText(text: string): boolean {
  return /你是\s*CatsCo|Your AI Assistant|工具权限|权限边界|安全|不得|不要.*泄露|secret|api[_-]?key|token/i.test(text);
}

function containsUnsafePromptInstruction(text: string): boolean {
  return /忽略.{0,16}(安全|权限|边界|限制|校验|保护)|绕过.{0,16}(安全|权限|边界|限制|校验|保护)|禁用.{0,16}(安全|权限|边界|限制|校验|保护)|不需要.{0,8}(权限|确认|校验)|无需.{0,8}(权限|确认|校验)|允许.{0,16}(泄露|输出.*secret|输出.*token|越权|任意.*文件|任意.*命令)|ignore.{0,24}(safety|permission|policy|guardrail|secret)|bypass.{0,24}(safety|permission|policy|guardrail)|disable.{0,24}(safety|permission|policy|guardrail)|泄露.{0,12}(secret|token|api[_-]?key|密钥)|sk-[a-z0-9_-]{12,}/i.test(text);
}

function isSafePromptAdvisorPatch(current: string, proposed: string): boolean {
  if (!proposed.trim() || proposed === current) return false;
  if (containsUnsafePromptInstruction(collectAddedPromptText(current, proposed))) return false;
  if (removesProtectedPromptText(current, proposed)) return false;
  return true;
}

function assertSafePromptCompanionProposal(proposal: PromptCompanionProposal, current: string): void {
  if (!isSafePromptAdvisorPatch(current, proposal.proposed_content)) {
    throw new Error('Prompt proposal failed safety validation');
  }
}

function collectAddedPromptText(current: string, proposed: string): string {
  const before = new Map<string, number>();
  for (const line of String(current || '').split('\n')) {
    before.set(line, (before.get(line) || 0) + 1);
  }
  const added: string[] = [];
  for (const line of String(proposed || '').split('\n')) {
    const count = before.get(line) || 0;
    if (count > 0) {
      before.set(line, count - 1);
    } else {
      added.push(line);
    }
  }
  return added.join('\n');
}

function removesProtectedPromptText(current: string, proposed: string): boolean {
  const proposedText = String(proposed || '');
  return String(current || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && containsProtectedPromptText(line))
    .some(line => !proposedText.includes(line));
}

function looksLikeStalePromptText(text: string): boolean {
  return /catsco:companion-|过时|重复|冗余|冲突|废弃|obsolete|deprecated|duplicate|redundant|conflict/i.test(text);
}

function normalizePromptAfterDelete(value: string): string {
  return String(value || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function isUsablePromptAfterDelete(current: string, proposed: string): boolean {
  const before = String(current || '').trim();
  const after = String(proposed || '').trim();
  if (!after || after === before) return false;
  if (before.length > 200 && after.length < Math.max(120, Math.floor(before.length * 0.5))) return false;
  return true;
}

function normalizeAdvisorTargetPath(value: unknown, state: PromptEditorStateSnapshot): string {
  const target = String(value || DEFAULT_TARGET_PROMPT).replace(/\\/g, '/').trim();
  if (target === 'sidecars/prompt-companion-advisor.md') return '';
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
    issue: '默认回复容易偏长或报告化，用户只是想快速得到结论时阅读成本偏高。',
    evidence: '这是基线建议：当前 prompt 还没有默认表达收束规则，适合作为后续 A/B 测试的起点。',
    changeSummary: '在 system-prompt.md 末尾追加一小段默认表达规则，要求先给结论、简单问题短答。',
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
    issue: '工具、网络或模型失败时，用户容易只看到生硬错误，不知道当前卡点和下一步。',
    evidence: buildRecoveryEvidence(signals),
    changeSummary: '在 system-prompt.md 末尾追加异常恢复规则，要求先解释卡点，再给重试或替代方案。',
    reason: signals.recent_errors > 0
      ? `最近观察到 ${signals.recent_errors} 次异常事件，建议让 agent 更清楚地解释失败和下一步。`
      : signals.recent_session_failures > 0
        ? `最近 session log 中有 ${signals.recent_session_failures} 轮失败回复，建议让 agent 更清楚地解释失败和下一步。`
      : signals.recent_runtime_errors > 0
        ? `最近 runtime log 中有 ${signals.recent_runtime_errors} 条错误信号，建议让 agent 更清楚地解释失败和下一步。`
      : '宠物建议预先补一条异常恢复规则，减少用户看到生硬错误。',
    risk: '低风险：只影响异常提示方式，不改变工具权限或执行逻辑。',
    trigger: (signals.recent_errors > 0 || signals.recent_session_failures > 0 || signals.recent_runtime_errors > 0) ? 'recent_errors' : 'baseline',
    baseHash,
    current,
    proposed,
    signals,
  });
}

function buildRecoveryEvidence(signals: PromptCompanionSignals): string {
  if (signals.recent_errors > 0) return `最近宠物事件里有 ${signals.recent_errors} 次异常。`;
  if (signals.recent_session_failures > 0) return `最近 session log 里有 ${signals.recent_session_failures} 轮失败回复。`;
  if (signals.recent_runtime_errors > 0) return `最近 runtime log 里有 ${signals.recent_runtime_errors} 条错误信号。`;
  return '当前 prompt 还没有明确异常恢复规则，适合作为稳定性兜底。';
}

function createProposal(options: {
  id: string;
  title: string;
  issue: string;
  evidence: string;
  changeSummary: string;
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
    schema_version: ADVISOR_SCHEMA_VERSION,
    id: options.id,
    title: options.title,
    path: options.path || DEFAULT_TARGET_PROMPT,
    operation: options.operation || 'append',
    issue: options.issue,
    evidence: options.evidence,
    change_summary: options.changeSummary,
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
  if (proposal.schema_version !== ADVISOR_SCHEMA_VERSION) return null;
  const file = (editorState.files || []).find(item => item.path === proposal.path);
  if (!file || file.effective.short_hash !== proposal.base_hash) return null;
  if (requestedId && proposal.id !== requestedId) return null;
  const created = Date.parse(proposal.created_at || '');
  if (!Number.isFinite(created) || Date.now() - created > CACHE_TTL_MS) return null;
  return proposal;
}

function getUsableCachedSkip(state: PromptCompanionState, signals: PromptCompanionSignals): boolean {
  const cached = state.cached_skip;
  if (!cached) return false;
  if (cached.signals_hash !== signalHash(signals)) return false;
  const created = Date.parse(cached.created_at || '');
  return Number.isFinite(created) && Date.now() - created <= CACHE_TTL_MS;
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
    recent_runtime_errors: sessionSignals.runtimeErrors,
    recent_runtime_warnings: sessionSignals.runtimeWarnings,
    recent_session_quality_flags: sessionSignals.qualityFlags,
    recent_session_quality_notes: sessionSignals.qualityNotes,
    prompt_system_hash: trace.system?.short_hash || '',
    prompt_bundle_hash: trace.bundle?.short_hash || '',
  };
}

interface SessionSignals {
  logs: number;
  turns: number;
  failures: number;
  toolCalls: number;
  runtimeErrors: number;
  runtimeWarnings: number;
  qualityFlags: Record<string, number>;
  qualityNotes: string[];
}

function readRecentSessionSignals(): SessionSignals {
  const files = listRecentSessionLogFiles(resolveSessionLogsDir(), 8);
  const signals: SessionSignals = {
    logs: files.length,
    turns: 0,
    failures: 0,
    toolCalls: 0,
    runtimeErrors: 0,
    runtimeWarnings: 0,
    qualityFlags: {},
    qualityNotes: [],
  };
  for (const filePath of files) {
    for (const entry of readPartialSessionLog(filePath)) {
      if (isSessionTurnEntry(entry)) {
        signals.turns += 1;
        signals.toolCalls += entry.assistant.tool_calls.length;
        if (looksLikeFailedAssistantText(entry.assistant.text)) signals.failures += 1;
        collectTurnQualitySignals(entry, signals);
      } else if (entry.entry_type === 'runtime') {
        const level = String((entry as any).level || '').toLowerCase();
        const text = String((entry as any).message || '');
        if (level === 'error' || looksLikeRuntimeError(text)) signals.runtimeErrors += 1;
        else if (level === 'warn' || level === 'warning') signals.runtimeWarnings += 1;
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

function collectTurnQualitySignals(entry: ParsedSessionLogEntry, signals: SessionSignals): void {
  if (!isSessionTurnEntry(entry)) return;
  const userText = normalizeQualityText(entry.user.text);
  const assistantText = normalizeQualityText(entry.assistant.text);
  const toolCalls = Array.isArray(entry.assistant.tool_calls) ? entry.assistant.tool_calls : [];

  if (isShortAcknowledgement(userText) && assistantText) {
    addQualitySignal(signals, 'ack_replied', `turn ${entry.turn}: short acknowledgement still received an assistant reply`);
  }
  if (asksForCurrentState(userText) && toolCalls.length === 0 && assistantText) {
    addQualitySignal(signals, 'current_state_without_tool', `turn ${entry.turn}: current-state request had no tool call`);
  }
  if (asksForBriefReply(userText) && assistantText.length > 1200) {
    addQualitySignal(signals, 'brief_request_long_reply', `turn ${entry.turn}: brief-reply request produced a long answer`);
  }
  if (looksLikeFailedAssistantText(assistantText)) {
    addQualitySignal(signals, 'final_error_reply', `turn ${entry.turn}: final reply exposed a failure message`);
  }
  for (const toolCall of toolCalls) {
    const toolName = String(toolCall?.name || '');
    const result = normalizeQualityText(String(toolCall?.result || ''));
    if (toolName === 'execute_shell' && looksLikeShellPortabilityError(result)) {
      addQualitySignal(signals, 'shell_portability_error', `turn ${entry.turn}: shell command failed because a command was unavailable`);
    }
  }
}

function addQualitySignal(signals: SessionSignals, key: string, note: string): void {
  signals.qualityFlags[key] = (signals.qualityFlags[key] || 0) + 1;
  if (signals.qualityNotes.length >= 8) return;
  if (!signals.qualityNotes.includes(note)) signals.qualityNotes.push(note);
}

function normalizeQualityText(text: string): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isShortAcknowledgement(text: string): boolean {
  if (!text || text.length > 18) return false;
  return /^(好|好的|好呀|好嘞|嗯|嗯嗯|行|可以|收到|明白|懂了|谢谢|谢了|辛苦了|ok|okay|thx|thanks)[。！!,.，\s]*$/i.test(text);
}

function asksForCurrentState(text: string): boolean {
  return /(当前|现在|刚才|最新|最近|本地|工作区|状态|日志|目录|文件|git|diff|status|branch|分支|有没有|还在|启动|运行)/i.test(text)
    && /(看|查|确认|检查|诊断|分析|告诉|列|同步|rebase|启动|清理|改了|变更)/i.test(text);
}

function asksForBriefReply(text: string): boolean {
  return /(简短|简单|别写长|不要长报告|快速|一句|几句|短答|过一遍|少点|精简)/i.test(text);
}

function looksLikeShellPortabilityError(text: string): boolean {
  return /无法将.+项识别为|is not recognized as|not recognized as|不是内部或外部命令|command not found/i.test(text);
}

function resolveSessionLogsDir(env: NodeJS.ProcessEnv = process.env): string {
  const userData = String(env.XIAOBA_ELECTRON_USER_DATA_DIR || env.XIAOBA_USER_DATA_DIR || env.CATSCO_USER_DATA_DIR || '').trim();
  if (userData) return path.join(path.resolve(userData), 'logs', 'sessions');
  return path.resolve(process.cwd(), 'logs', 'sessions');
}

function listRecentSessionLogFiles(root: string, limit: number): string[] {
  if (!fs.existsSync(root)) return [];
  const files: { path: string; mtime: number }[] = [];
  const maxScanned = Math.max(64, limit * 16);
  walkFiles(root, filePath => {
    if (path.extname(filePath).toLowerCase() !== '.jsonl') return;
    try {
      files.push({ path: filePath, mtime: fs.statSync(filePath).mtimeMs });
    } catch (_error) {
      // Ignore disappearing log files.
    }
  }, maxScanned);
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

function looksLikeRuntimeError(text: string): boolean {
  return /\b(error|failed|failure|exception|timeout|timed out|rate limit|429|500|502|503|504)\b|API错误|请求失败|处理失败|超时|失败|异常/i.test(text || '');
}

function walkFiles(directory: string, visit: (filePath: string) => void, maxFiles = 256, state = { seen: 0 }): void {
  if (state.seen >= maxFiles) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (state.seen >= maxFiles) return;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(filePath, visit, maxFiles, state);
    else if (entry.isFile()) {
      state.seen += 1;
      visit(filePath);
    }
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
      cached_skip: parsed.cached_skip,
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

function signalHash(signals: PromptCompanionSignals): string {
  return hashText(JSON.stringify(signals));
}

function sanitizeSingleLine(value: string, maxLength: number): string {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeAdvisorNote(value: unknown): string {
  const text = String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (/api[_-]?key|secret|password|sk-[a-z0-9_-]{12,}|token\s*[:=]/i.test(text)) return '';
  return text.slice(0, 600);
}

export const __promptCompanionTest = {
  buildAdvisorPatch,
  buildAdvisorUserPrompt,
  sanitizeAdvisorNote,
};
