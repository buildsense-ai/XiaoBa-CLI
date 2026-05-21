import type { Message } from '../types';
import { AIService } from './ai-service';
import type { ReviewData, ReviewEntry, ReviewFailure, ReviewSession, ReviewTurn } from './catsco-review-agent-client';
import type { ReviewFinding } from './catsco-review-analyzer';
import type { ReviewUsageAnalysis } from './catsco-review-usage-analyzer';
import { redactReviewText } from './catsco-review-redaction';

export interface ReviewQuestionContext {
  reviewData: ReviewData;
  findings: ReviewFinding[];
  usageAnalysis: ReviewUsageAnalysis;
}

export interface ReviewQuestionEvidencePack {
  question: string;
  summary: Record<string, unknown>;
  conversationHistory: ReviewQuestionChatTurn[];
  evidence: ReviewQuestionEvidenceItem[];
}

export interface ReviewQuestionChatTurn {
  question: string;
  answer: string;
}

export interface ReviewQuestionEvidenceItem {
  id: string;
  kind: 'summary' | 'usage' | 'finding' | 'failure' | 'session' | 'entry' | 'turn';
  score: number;
  text: string;
  refs: Record<string, string | number | null | undefined>;
}

export interface AnswerReviewQuestionOptions {
  maxEvidenceItems?: number;
  maxEvidenceChars?: number;
  conversationHistory?: ReviewQuestionChatTurn[];
}

const DEFAULT_MAX_EVIDENCE_ITEMS = 80;
const DEFAULT_MAX_EVIDENCE_CHARS = 24000;

export async function answerReviewQuestion(
  question: string,
  context: ReviewQuestionContext,
  aiService: AIService = new AIService(),
  options: AnswerReviewQuestionOptions = {},
): Promise<string> {
  const evidencePack = buildReviewQuestionEvidencePack(question, context, options);
  const response = await aiService.chat(buildReviewQuestionMessages(evidencePack));
  return [formatReviewQuestionScope(evidencePack), response.content || '']
    .filter(Boolean)
    .join('\n\n');
}

export function buildReviewQuestionEvidencePack(
  question: string,
  context: ReviewQuestionContext,
  options: AnswerReviewQuestionOptions = {},
): ReviewQuestionEvidencePack {
  const maxEvidenceItems = options.maxEvidenceItems || DEFAULT_MAX_EVIDENCE_ITEMS;
  const maxEvidenceChars = options.maxEvidenceChars || DEFAULT_MAX_EVIDENCE_CHARS;
  const conversationHistory = sanitizeConversationHistory(options.conversationHistory || []);
  const recentQuestionContext = conversationHistory.slice(-3).map(turn => turn.question).join(' ');
  const scoringQuestion = `${recentQuestionContext} ${question}`.trim();
  const queryTerms = queryTokens(scoringQuestion);
  const candidates = [
    summaryEvidence(context.reviewData),
    usageEvidence(context.usageAnalysis),
    ...findingEvidence(context.findings),
    ...failureEvidence(context.reviewData.failures || []),
    ...sessionEvidence(context.reviewData.sessions || []),
    ...entryEvidence(context.reviewData),
    ...turnEvidence(context.reviewData),
  ];

  const scored = candidates
    .map(item => ({
      ...item,
      score: scoreEvidence(scoringQuestion || question, queryTerms, item),
    }))
    .sort((a, b) => b.score - a.score || kindRank(a.kind) - kindRank(b.kind));
  const topTurns = scored
    .filter(item => item.kind === 'turn')
    .slice(0, Math.min(10, Math.max(1, Math.floor(maxEvidenceItems * 0.3))));
  const ranked = dedupeEvidenceItems([...topTurns, ...scored]).slice(0, maxEvidenceItems);

  const selected: ReviewQuestionEvidenceItem[] = [];
  let chars = 0;
  for (const item of ranked) {
    const itemChars = item.text.length;
    if (selected.length > 0 && chars + itemChars > maxEvidenceChars) {
      continue;
    }
    selected.push(item);
    chars += itemChars;
  }

  return {
    question,
    conversationHistory,
    summary: {
      uploaded_from: context.reviewData.summary?.uploaded_from,
      uploaded_to: context.reviewData.summary?.uploaded_to,
      uploads: context.reviewData.summary?.upload_count || 0,
      sessions: context.reviewData.summary?.session_count || 0,
      turns: context.reviewData.summary?.turn_count || 0,
      users: context.usageAnalysis.totals.userCount,
      active_days: context.usageAnalysis.totals.activeDays,
      findings: context.findings.length,
      loaded_sessions: (context.reviewData.sessions || []).length,
      total_sessions_reported: context.reviewData.summary?.session_count || 0,
      loaded_turns: Object.values(context.reviewData.sessionTurns || {}).reduce((sum, turns) => sum + (turns || []).length, 0),
      total_turns_reported: context.reviewData.summary?.turn_count || 0,
      loaded_session_coverage_ratio: ratio(
        (context.reviewData.sessions || []).length,
        context.reviewData.summary?.session_count || 0,
      ),
      loaded_turn_coverage_ratio: ratio(
        Object.values(context.reviewData.sessionTurns || {}).reduce((sum, turns) => sum + (turns || []).length, 0),
        context.reviewData.summary?.turn_count || 0,
      ),
      available_evidence_items: candidates.length,
      ranked_evidence_items: ranked.length,
      selected_evidence_items: selected.length,
      dropped_evidence_items: Math.max(0, candidates.length - selected.length),
      evidence_characters: chars,
      evidence_limit_characters: maxEvidenceChars,
      evidence_selection_note: 'Evidence items below are a ranked selected subset for the current question, not all loaded logs.',
      possibly_truncated: candidates.length > selected.length
        || (context.reviewData.summary?.session_count || 0) > (context.reviewData.sessions || []).length
        || (context.reviewData.summary?.turn_count || 0) > Object.values(context.reviewData.sessionTurns || {}).reduce((sum, turns) => sum + (turns || []).length, 0),
    },
    evidence: selected,
  };
}

export function buildReviewQuestionMessages(evidencePack: ReviewQuestionEvidencePack): Message[] {
  return [
    {
      role: 'system',
      content: [
        'You are CatsCo Review Agent answering questions from redacted structured log evidence.',
        'Answer flexibly based on the user question; do not limit yourself to a fixed report schema.',
        'Use only the provided evidence. If the evidence is insufficient, say what is missing.',
        'Conversation history can come from earlier log refreshes; treat the current evidence block as authoritative.',
        'State the loaded evidence scope when answering questions about frequency, totals, trends, or coverage.',
        'Never describe the selected evidence items as all logs. If possibly_truncated is true, conclusions must be framed as based on the loaded/selected subset.',
        'If the user asks about an organization, role, or customer segment that is not explicitly present in the evidence, say it is not identifiable from this evidence instead of inferring it from a few examples.',
        'Separate facts from inferences. Mention concrete counts, windows, user_keys, session_keys, and tool names when useful.',
        'Do not reveal secrets, tokens, phone numbers, email addresses, private paths, or raw identifiers beyond redacted/stable keys already present.',
        'Prefer Chinese unless the user asks otherwise.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `问题：${evidencePack.question}`,
        '',
        '请基于下面的日志证据回答。证据来自 Cloud Server A 的 /catsco/review/* Review API，已经过客户端二次脱敏和截断。',
        '',
        '窗口摘要：',
        JSON.stringify(evidencePack.summary, null, 2),
        '',
        evidencePack.conversationHistory.length > 0 ? '对话上下文（用于理解追问，仍必须以日志证据为准）：' : '',
        evidencePack.conversationHistory.length > 0 ? evidencePack.conversationHistory.map((turn, index) => [
          `### Turn ${index + 1}`,
          `Q: ${turn.question}`,
          `A: ${turn.answer}`,
        ].join('\n')).join('\n\n') : '',
        evidencePack.conversationHistory.length > 0 ? '' : '',
        '证据：',
        evidencePack.evidence.map((item, index) => [
          `### Evidence ${index + 1}: ${item.kind} / ${item.id} / score=${item.score}`,
          `refs=${JSON.stringify(item.refs)}`,
          item.text,
        ].join('\n')).join('\n\n'),
      ].join('\n'),
    },
  ];
}

function formatReviewQuestionScope(evidencePack: ReviewQuestionEvidencePack): string {
  const summary = evidencePack.summary as Record<string, any>;
  const truncated = summary.possibly_truncated ? '是' : '否';
  return [
    '证据覆盖说明：',
    `- 上传窗口：${summary.uploaded_from || '未知'} 至 ${summary.uploaded_to || '未知'}`,
    `- 已加载会话：${summary.loaded_sessions ?? 0}/${summary.total_sessions_reported ?? 0}；已加载轮次：${summary.loaded_turns ?? 0}/${summary.total_turns_reported ?? 0}`,
    `- 候选证据：${summary.available_evidence_items ?? 0}；本次传给模型的证据：${summary.selected_evidence_items ?? 0}`,
    `- 是否可能截断：${truncated}`,
    '- 下面回答只代表本次已加载并选中的脱敏证据，不等同于云端全部日志。',
  ].join('\n');
}

function dedupeEvidenceItems(items: ReviewQuestionEvidenceItem[]): ReviewQuestionEvidenceItem[] {
  const seen = new Set<string>();
  const deduped: ReviewQuestionEvidenceItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }
  return deduped;
}

function summaryEvidence(reviewData: ReviewData): ReviewQuestionEvidenceItem {
  const summary = reviewData.summary || {};
  return {
    id: 'summary',
    kind: 'summary',
    score: 0,
    refs: {},
    text: sanitizeForReviewAnswer([
      `Summary window uploaded_from=${summary.uploaded_from || 'not set'} uploaded_to=${summary.uploaded_to || 'not set'}`,
      `uploads=${summary.upload_count || 0} parsed=${summary.parsed_upload_count || 0} failed=${summary.failed_upload_count || 0}`,
      `sessions=${summary.session_count || 0} turns=${summary.turn_count || 0} ai_calls=${summary.ai_call_count || 0} tool_calls=${summary.tool_call_count || 0}`,
      `tokens prompt=${summary.prompt_tokens || 0} completion=${summary.completion_tokens || 0} total=${summary.total_tokens || 0}`,
    ].join('\n')),
  };
}

function usageEvidence(usage: ReviewUsageAnalysis): ReviewQuestionEvidenceItem {
  const users = usage.users.slice(0, 20).map(user => (
    `${user.userKey}: sessions=${user.sessionCount}, turns=${user.turnCount}, active_days=${user.activeDays}, top_topics=${user.topTopics.slice(0, 5).map(item => `${item.name}:${item.count}`).join('|') || 'none'}`
  ));
  const topics = usage.topics.slice(0, 20).map(topic => (
    `${topic.label}: count=${topic.count}, users=${topic.userCount}, sessions=${topic.sessionCount}, hashes=${topic.questionHashes.join('|')}`
  ));
  const tools = usage.toolUsage.slice(0, 20).map(tool => (
    `${tool.name}: calls=${tool.count}, sessions=${tool.sessionCount}, users=${tool.userCount}`
  ));
  const segments = [
    `org_types=${namedUsageCounts(usage.segments?.orgTypes) || 'none'}`,
    `org_keys=${namedUsageCounts(usage.segments?.orgKeys) || 'none'}`,
    `user_roles=${namedUsageCounts(usage.segments?.userRoles) || 'none'}`,
    `device_roles=${namedUsageCounts(usage.segments?.deviceRoles) || 'none'}`,
    `channels=${namedUsageCounts(usage.segments?.channelTypes) || 'none'}`,
    `workspaces=${namedUsageCounts(usage.segments?.workspaceKeys) || 'none'}`,
  ];
  return {
    id: 'usage',
    kind: 'usage',
    score: 0,
    refs: {},
    text: sanitizeForReviewAnswer([
      `Loaded usage totals: users=${usage.totals.userCount}, devices=${usage.totals.deviceCount}, sessions=${usage.totals.sessionCount}, active_days=${usage.totals.activeDays}, turns=${usage.totals.turnCount}, loaded_turns=${usage.totals.loadedTurnCount}, avg_turns_per_session=${usage.totals.averageTurnsPerSession}, tool_calls=${usage.totals.toolCallCount}`,
      '',
      'Top users:',
      ...users,
      '',
      'Top topics:',
      ...topics,
      '',
      'Top tools:',
      ...tools,
      '',
      'Segments:',
      ...segments,
      '',
      'By day:',
      ...usage.timeBuckets.byDay.slice(-30).map(bucket => `${bucket.bucket}: sessions=${bucket.sessionCount}, turns=${bucket.turnCount}`),
    ].join('\n')),
  };
}

function namedUsageCounts(values?: Array<{ name: string; count: number }>): string {
  return (values || []).slice(0, 10).map(item => `${item.name}:${item.count}`).join('|');
}

function findingEvidence(findings: ReviewFinding[]): ReviewQuestionEvidenceItem[] {
  return findings.map((finding, index) => ({
    id: `finding-${index + 1}`,
    kind: 'finding' as const,
    score: 0,
    refs: {
      category: finding.category,
      severity: finding.severity,
      patternKey: finding.patternKey,
    },
    text: sanitizeForReviewAnswer([
      `Finding ${finding.title}`,
      `category=${finding.category} severity=${finding.severity} count=${finding.count} impact=${finding.impactScore || 0} proposal_type=${finding.proposalType || 'unknown'}`,
      `affected_sessions=${finding.affectedSessions.length} tools=${(finding.toolNames || []).join(', ') || 'none'} events=${(finding.eventCategories || []).join(', ') || 'none'}`,
      `evidence=${(finding.evidence || []).slice(0, 5).join(' | ')}`,
      `actions=${(finding.suggestedActions || []).join(' | ')}`,
    ].join('\n')),
  }));
}

function failureEvidence(failures: ReviewFailure[]): ReviewQuestionEvidenceItem[] {
  return failures.map((failure, index) => ({
    id: `failure-${index + 1}`,
    kind: 'failure' as const,
    score: 0,
    refs: {
      upload_id: failure.upload_id,
      session_record_id: failure.session_record_id,
      entry_id: failure.entry_id,
      event_category: failure.event_category,
    },
    text: sanitizeForReviewAnswer([
      `Failure type=${failure.failure_type} level=${failure.level || 'unknown'} event=${failure.event_category} timestamp=${failure.timestamp || 'unknown'}`,
      `session_record_id=${failure.session_record_id || 'none'} upload_id=${failure.upload_id}`,
      `message=${failure.message || ''}`,
    ].join('\n')),
  }));
}

function sessionEvidence(sessions: ReviewSession[]): ReviewQuestionEvidenceItem[] {
  return sessions.map(session => ({
    id: `session-${session.session_record_id}`,
    kind: 'session' as const,
    score: 0,
    refs: {
      session_record_id: session.session_record_id,
      user_key: session.user_key,
      device_key: session.device_key,
      session_key: session.session_key,
      org_type: session.org_type,
      user_role: session.user_role,
      channel_type: session.channel_type,
    },
    text: sanitizeForReviewAnswer([
      `Session user_key=${session.user_key} device_key=${session.device_key} session_key=${session.session_key} type=${session.session_type}`,
      `context org_key=${session.org_key || 'unknown'} org_type=${session.org_type || 'unknown'} user_role=${session.user_role || 'unknown'} device_role=${session.device_role || 'unknown'} channel=${session.channel_type || 'unknown'} workspace=${session.workspace_key || 'unknown'}`,
      `started_at=${session.started_at || 'unknown'} ended_at=${session.ended_at || 'unknown'} created_at=${session.created_at}`,
      `entries=${session.entry_count} turns=${session.turn_count} ai_calls=${session.ai_call_count} tool_calls=${session.tool_call_count} tokens=${session.total_tokens}`,
      `summary_status=${session.summary_status}`,
    ].join('\n')),
  }));
}

function entryEvidence(reviewData: ReviewData): ReviewQuestionEvidenceItem[] {
  const sessionsById = new Map((reviewData.sessions || []).map(session => [session.session_record_id, session]));
  const items: ReviewQuestionEvidenceItem[] = [];
  for (const [sessionRecordId, entries] of Object.entries(reviewData.sessionEntries || {})) {
    const session = sessionsById.get(sessionRecordId);
    for (const entry of entries || []) {
      items.push({
        id: `entry-${entry.entry_id}`,
        kind: 'entry',
        score: 0,
        refs: {
          session_record_id: sessionRecordId,
          user_key: session?.user_key,
          device_key: session?.device_key,
          entry_id: entry.entry_id,
          line_no: entry.line_no,
          tool_name: entry.tool_name,
          event_category: entry.event_category,
        },
        text: sanitizeForReviewAnswer(entryText(entry, sessionRecordId, session)),
      });
    }
  }
  return items;
}

function turnEvidence(reviewData: ReviewData): ReviewQuestionEvidenceItem[] {
  const sessionsById = new Map((reviewData.sessions || []).map(session => [session.session_record_id, session]));
  const items: ReviewQuestionEvidenceItem[] = [];
  for (const [sessionRecordId, turns] of Object.entries(reviewData.sessionTurns || {})) {
    const session = sessionsById.get(sessionRecordId);
    for (const turn of turns || []) {
      items.push({
        id: `turn-${turn.turn_record_id}`,
        kind: 'turn',
        score: 0,
        refs: {
          session_record_id: sessionRecordId,
          user_key: session?.user_key || turn.user_key,
          device_key: session?.device_key || turn.device_key,
          session_key: session?.session_key || turn.session_key,
          session_type: session?.session_type || turn.session_type,
          org_type: session?.org_type || turn.org_type,
          user_role: session?.user_role || turn.user_role,
          channel_type: session?.channel_type || turn.channel_type,
          turn_record_id: turn.turn_record_id,
          turn_no: turn.turn_no,
        },
        text: sanitizeForReviewAnswer(turnText(turn, sessionRecordId, session)),
      });
    }
  }
  return items;
}

function entryText(entry: ReviewEntry, sessionRecordId: string, session?: ReviewSession): string {
  return [
    `Entry session_record_id=${sessionRecordId} user_key=${session?.user_key || 'unknown'} line=${entry.line_no} type=${entry.entry_type}`,
    `timestamp=${entry.timestamp || 'unknown'} level=${entry.level || 'unknown'} event=${entry.event_category} tool=${entry.tool_name || 'none'} duration_ms=${entry.duration_ms ?? 'unknown'}`,
    `tokens prompt=${entry.prompt_tokens ?? 'unknown'} completion=${entry.completion_tokens ?? 'unknown'} total=${entry.total_tokens ?? 'unknown'}`,
    `message=${entry.message || ''}`,
  ].join('\n');
}

function turnText(turn: ReviewTurn, sessionRecordId: string, session?: ReviewSession): string {
  const userKey = session?.user_key || turn.user_key || 'unknown';
  const deviceKey = session?.device_key || turn.device_key || 'unknown';
  const sessionKey = session?.session_key || turn.session_key || 'unknown';
  const sessionType = session?.session_type || turn.session_type || 'unknown';
  const orgKey = session?.org_key || turn.org_key || 'unknown';
  const orgType = session?.org_type || turn.org_type || 'unknown';
  const userRole = session?.user_role || turn.user_role || 'unknown';
  const deviceRole = session?.device_role || turn.device_role || 'unknown';
  const channelType = session?.channel_type || turn.channel_type || 'unknown';
  const workspaceKey = session?.workspace_key || turn.workspace_key || 'unknown';
  return [
    `Turn session_record_id=${sessionRecordId} user_key=${userKey} device_key=${deviceKey} session_key=${sessionKey} type=${sessionType} turn_no=${turn.turn_no}`,
    `context org_key=${orgKey} org_type=${orgType} user_role=${userRole} device_role=${deviceRole} channel=${channelType} workspace=${workspaceKey}`,
    `timestamp=${turn.timestamp || 'unknown'} tokens prompt=${turn.prompt_tokens ?? 'unknown'} completion=${turn.completion_tokens ?? 'unknown'} total=${turn.total_tokens ?? 'unknown'}`,
    `user_text=${turn.user_text || ''}`,
    `assistant_text=${turn.assistant_text || ''}`,
    `tool_calls=${turn.tool_calls_json || ''}`,
  ].join('\n');
}

function scoreEvidence(question: string, queryTerms: string[], item: ReviewQuestionEvidenceItem): number {
  const haystack = `${item.kind} ${item.id} ${item.text} ${JSON.stringify(item.refs)}`.toLowerCase();
  const loweredQuestion = question.toLowerCase();
  let score = baseKindScore(item.kind);
  if (loweredQuestion.includes('频率') || loweredQuestion.includes('次数') || loweredQuestion.includes('多久') || loweredQuestion.includes('使用')) {
    if (item.kind === 'usage' || item.kind === 'summary' || item.kind === 'session') score += 20;
  }
  if (loweredQuestion.includes('问') || loweredQuestion.includes('问题') || loweredQuestion.includes('原话')) {
    if (item.kind === 'turn' || item.kind === 'usage') score += 20;
  }
  if (loweredQuestion.includes('工具') || loweredQuestion.includes('失败') || loweredQuestion.includes('报错')) {
    if (item.kind === 'entry' || item.kind === 'failure' || item.kind === 'finding') score += 20;
  }
  for (const term of queryTerms) {
    if (term && haystack.includes(term)) score += term.length >= 4 ? 5 : 2;
  }
  return score;
}

function queryTokens(question: string): string[] {
  const normalized = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\-\u4e00-\u9fa5]+/gu, ' ')
    .trim();
  const terms = normalized.split(/\s+/).filter(Boolean);
  for (const chunk of normalized.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (const token of chineseQueryTokens(chunk)) {
      terms.push(token);
    }
  }
  for (const phrase of ['使用频率', '主要用', '问了什么', '教务处', '老师', '学生', '成绩', '课表', '通知', '工具', '失败', '报错', '耗时']) {
    if (question.includes(phrase)) terms.push(phrase.toLowerCase());
  }
  return Array.from(new Set(terms)).slice(0, 40);
}

function chineseQueryTokens(chunk: string): string[] {
  const stopwords = ['这个', '那个', '这些', '那些', '是否', '有没有', '是不是', '什么', '怎么', '如何', '主要', '老师', '用户', '可以'];
  const compact = stopwords.reduce((text, word) => text.replace(new RegExp(word, 'g'), ' '), chunk);
  const tokens: string[] = compact.split(/\s+/).filter(token => token.length >= 2);
  for (const token of tokens.slice(0, 8)) {
    const maxGram = Math.min(6, token.length);
    for (let size = Math.min(4, maxGram); size >= 2; size -= 1) {
      for (let index = 0; index <= token.length - size; index += 1) {
        tokens.push(token.slice(index, index + size));
      }
    }
  }
  return tokens.filter(token => token.length >= 2);
}

function sanitizeConversationHistory(history: ReviewQuestionChatTurn[]): ReviewQuestionChatTurn[] {
  return history.slice(-6).map(turn => ({
    question: sanitizeForReviewAnswer(turn.question).slice(0, 1000),
    answer: sanitizeForReviewAnswer(turn.answer).slice(0, 2000),
  }));
}

function sanitizeForReviewAnswer(value: string): string {
  return redactReviewText(value, 4000);
}

function ratio(value: number, total: number): number {
  if (!total) return value ? 1 : 0;
  return Math.round((value / total) * 1000) / 1000;
}

function baseKindScore(kind: ReviewQuestionEvidenceItem['kind']): number {
  return {
    summary: 12,
    usage: 15,
    finding: 10,
    failure: 8,
    session: 5,
    entry: 4,
    turn: 4,
  }[kind];
}

function kindRank(kind: ReviewQuestionEvidenceItem['kind']): number {
  return {
    summary: 0,
    usage: 1,
    finding: 2,
    failure: 3,
    session: 4,
    entry: 5,
    turn: 6,
  }[kind];
}
