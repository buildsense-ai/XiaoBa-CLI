import { createHash } from 'crypto';
import type { ReviewData, ReviewEntry, ReviewFailure, ReviewSession, ReviewTurn } from './catsco-review-agent-client';

export type ReviewFindingCategory =
  | 'permission_or_auth'
  | 'missing_skill_or_tool'
  | 'tool_failure'
  | 'prompt_confusion'
  | 'network_or_timeout'
  | 'latency'
  | 'token_usage'
  | 'review_data_quality'
  | 'general_failure';

export type ReviewFindingSeverity = 'high' | 'medium' | 'low';

export interface ReviewFinding {
  category: ReviewFindingCategory;
  severity: ReviewFindingSeverity;
  title: string;
  count: number;
  affectedSessions: string[];
  impactScore?: number;
  patternKey?: string;
  primarySignal?: string;
  proposalType?: 'prompt' | 'skill' | 'tool' | 'eval' | 'config' | 'reliability' | 'observability';
  toolNames?: string[];
  eventCategories?: string[];
  evidence: string[];
  suggestedActions: string[];
}

const KEYWORDS: Record<Exclude<ReviewFindingCategory, 'latency' | 'token_usage' | 'general_failure'>, string[]> = {
  permission_or_auth: [
    '401',
    '403',
    'unauthorized',
    'forbidden',
    'permission',
    'denied',
    '权限',
    '认证',
    '登录',
    'invalid token',
    'missing token',
    'token missing',
    'token expired',
    'expired token',
    'review token',
  ],
  missing_skill_or_tool: [
    'unknown tool',
    'tool not found',
    'no such tool',
    'skill not found',
    'missing skill',
    '工具不存在',
    '找不到工具',
    '没有可用工具',
    '缺少skill',
    '缺少 skill',
  ],
  tool_failure: [
    'tool failed',
    'exception',
    'traceback',
    '工具执行失败',
    '工具失败',
    '调用失败',
    '报错',
    '异常',
  ],
  prompt_confusion: [
    'unclear',
    'ambiguous',
    'cannot understand',
    '不清楚',
    '没理解',
    '无法理解',
    '反复',
    '追问',
    '澄清',
  ],
  network_or_timeout: [
    'timeout',
    'timed out',
    'connection reset',
    'connection error',
    'network',
    '超时',
    '网络',
    '连接失败',
  ],
  review_data_quality: [
    'review_fetch_error',
    'could not fetch session entries',
    'could not fetch session turns',
    'review agent could not fetch',
  ],
};

interface FindingDraft {
  category: ReviewFindingCategory;
  title: string;
  patternKey: string;
  count: number;
  affectedSessions: Set<string>;
  toolNames: Set<string>;
  eventCategories: Set<string>;
  evidence: string[];
}

const NOISE_PATTERNS = [
  'no pending stable session logs',
  'review agent scheduled run complete',
  'review api connected',
  'proposal directory:',
];

export function classifyReviewText(text: string): ReviewFindingCategory {
  const lowered = text.toLowerCase();
  for (const [category, keywords] of Object.entries(KEYWORDS) as Array<[ReviewFindingCategory, string[]]>) {
    if (keywords.some(keyword => lowered.includes(keyword.toLowerCase()))) {
      return category;
    }
  }
  return 'general_failure';
}

export function analyzeReviewData(reviewData: ReviewData): ReviewFinding[] {
  const drafts = new Map<string, FindingDraft>();

  for (const failure of reviewData.failures || []) {
    addTextFinding(drafts, failure.message || '', failure.session_record_id || undefined, failure);
  }

  for (const [sessionRecordId, entries] of Object.entries(reviewData.sessionEntries || {})) {
    analyzeEntries(drafts, sessionRecordId, entries);
  }

  for (const [sessionRecordId, turns] of Object.entries(reviewData.sessionTurns || {})) {
    analyzeTurns(drafts, sessionRecordId, turns);
  }

  analyzeSessionMetrics(drafts, reviewData.sessions || [], reviewData.sessionEntries || {});

  return Array.from(drafts.values())
    .map(finalizeDraft)
    .sort((a, b) => {
      const severityRank = { high: 0, medium: 1, low: 2 };
      return severityRank[a.severity] - severityRank[b.severity]
        || (b.impactScore || 0) - (a.impactScore || 0)
        || b.count - a.count
        || a.title.localeCompare(b.title);
    });
}

function analyzeEntries(
  drafts: Map<string, FindingDraft>,
  sessionRecordId: string,
  entries: ReviewEntry[],
): void {
  for (const entry of entries) {
    const level = String(entry.level || '').toLowerCase();
    const message = entry.message || '';
    if (level === 'error' || level === 'critical' || level === 'fatal' || level === 'warning' || level === 'warn') {
      addTextFinding(drafts, message, sessionRecordId, entry);
    }
    if (entry.duration_ms != null && Number(entry.duration_ms) >= 15000) {
      const draft = ensureDraft(drafts, 'latency', signatureForText(`${entry.tool_name || entry.event_category || 'operation'} slow`));
      draft.count += 1;
      draft.affectedSessions.add(sessionRecordId);
      if (entry.tool_name) draft.toolNames.add(entry.tool_name);
      if (entry.event_category) draft.eventCategories.add(entry.event_category);
      pushEvidence(draft, compactText(`${entry.tool_name || entry.event_category || 'operation'} took ${entry.duration_ms}ms`));
    }
  }
}

function analyzeTurns(
  drafts: Map<string, FindingDraft>,
  sessionRecordId: string,
  turns: ReviewTurn[],
): void {
  for (const turn of turns) {
    const combined = `${turn.user_text || ''}\n${turn.assistant_text || ''}`;
    const category = classifyReviewText(combined);
    if (category === 'prompt_confusion') {
      const draft = ensureDraft(drafts, category, signatureForText(combined));
      draft.count += 1;
      draft.affectedSessions.add(sessionRecordId);
      pushEvidence(draft, compactText(combined));
    }
  }
}

function analyzeSessionMetrics(
  drafts: Map<string, FindingDraft>,
  sessions: ReviewSession[],
  sessionEntries: Record<string, ReviewEntry[]>,
): void {
  for (const session of sessions) {
    if (Number(session.total_tokens || 0) >= 12000) {
      const draft = ensureDraft(drafts, 'token_usage', signatureForText(`${session.session_type} high token usage`));
      draft.count += 1;
      draft.affectedSessions.add(session.session_record_id);
      pushEvidence(draft, `Session exceeded token threshold: ${session.session_record_id}`);
    }

    const entries = sessionEntries[session.session_record_id] || [];
    if (entries.length === 0 && session.entry_count > 0) {
      const draft = ensureDraft(drafts, 'general_failure', 'unfetched-session-details');
      pushEvidence(draft, `Session ${session.session_record_id} has entries on server but none were fetched by the review window.`);
    }
  }
}

function addTextFinding(
  drafts: Map<string, FindingDraft>,
  message: string,
  sessionRecordId?: string,
  fallback?: ReviewFailure | ReviewEntry,
): void {
  const evidence = compactText(message || JSON.stringify(fallback || {}));
  if (!evidence || isNoiseEvidence(evidence)) return;

  const category = classifyReviewText(evidence);
  const draft = ensureDraft(drafts, category, signatureForText(evidence));
  draft.count += 1;
  if (sessionRecordId) {
    draft.affectedSessions.add(sessionRecordId);
  }
  const toolName = (fallback as ReviewEntry | undefined)?.tool_name;
  const eventCategory = (fallback as ReviewEntry | ReviewFailure | undefined)?.event_category;
  if (toolName) draft.toolNames.add(toolName);
  if (eventCategory) draft.eventCategories.add(eventCategory);
  pushEvidence(draft, evidence);
}

function ensureDraft(drafts: Map<string, FindingDraft>, category: ReviewFindingCategory, patternKey: string): FindingDraft {
  const draftKey = `${category}:${patternKey}`;
  const existing = drafts.get(draftKey);
  if (existing) return existing;

  const next: FindingDraft = {
    category,
    title: titleForCategory(category, patternKey),
    patternKey,
    count: 0,
    affectedSessions: new Set<string>(),
    toolNames: new Set<string>(),
    eventCategories: new Set<string>(),
    evidence: [],
  };
  drafts.set(draftKey, next);
  return next;
}

function finalizeDraft(draft: FindingDraft): ReviewFinding {
  const impactScore = impactScoreForDraft(draft);
  return {
    category: draft.category,
    severity: severityForCategory(draft.category, draft.count, draft.affectedSessions.size, impactScore),
    title: draft.title,
    count: draft.count,
    affectedSessions: Array.from(draft.affectedSessions).sort(),
    impactScore,
    patternKey: draft.patternKey,
    primarySignal: draft.evidence[0],
    proposalType: proposalTypeForCategory(draft.category),
    toolNames: Array.from(draft.toolNames).sort(),
    eventCategories: Array.from(draft.eventCategories).sort(),
    evidence: draft.evidence.slice(0, 10),
    suggestedActions: actionsForCategory(draft.category),
  };
}

function pushEvidence(draft: FindingDraft, evidence: string): void {
  if (evidence && !draft.evidence.includes(evidence) && draft.evidence.length < 20) {
    draft.evidence.push(evidence);
  }
}

function compactText(text: string, limit = 280): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
}

function isNoiseEvidence(evidence: string): boolean {
  const lowered = evidence.toLowerCase();
  return NOISE_PATTERNS.some(pattern => lowered.includes(pattern));
}

function signatureForText(text: string): string {
  const normalized = compactText(text, 500)
    .toLowerCase()
    .replace(/\b[0-9a-f]{8,}\b/g, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}:\d{2}(?:\.\d+z?)?\b/g, '<time>')
    .replace(/\b\d+\b/g, '<num>')
    .replace(/[a-z]:\\[^\s]+/gi, '<path>')
    .replace(/\/[^\s]+/g, '<path>')
    .replace(/[^a-z0-9_\-\u4e00-\u9fa5<> ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return 'sig_unknown';
  return `sig_${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

function impactScoreForDraft(draft: FindingDraft): number {
  const severityWeight = draft.category === 'permission_or_auth' || draft.category === 'tool_failure' ? 20 : 10;
  return severityWeight
    + draft.count * 3
    + draft.affectedSessions.size * 5
    + draft.toolNames.size * 2
    + Math.min(draft.evidence.length, 10);
}

export function severityForCategory(
  category: ReviewFindingCategory,
  count: number,
  affectedSessionCount: number = 0,
  impactScore: number = 0,
): ReviewFindingSeverity {
  if (impactScore >= 60 || affectedSessionCount >= 8) {
    return 'high';
  }
  if ((category === 'permission_or_auth' || category === 'tool_failure') && count >= 5) {
    return 'high';
  }
  if (category === 'missing_skill_or_tool' || category === 'network_or_timeout') {
    return 'medium';
  }
  if (count >= 10) {
    return 'medium';
  }
  return 'low';
}

export function titleForCategory(category: ReviewFindingCategory, patternKey?: string): string {
  const base = {
    permission_or_auth: 'Permission or authentication failures',
    missing_skill_or_tool: 'Missing skill or missing tool routing',
    tool_failure: 'Tool execution failures',
    prompt_confusion: 'Prompt confusion or repeated clarification',
    network_or_timeout: 'Network or timeout instability',
    latency: 'Long-running calls need progress or optimization',
    token_usage: 'High token usage sessions',
    review_data_quality: 'Review data quality or observability gaps',
    general_failure: 'General unresolved failures',
  }[category];
  return patternKey && patternKey !== 'unknown' ? `${base}: ${patternKey}` : base;
}

function proposalTypeForCategory(category: ReviewFindingCategory): ReviewFinding['proposalType'] {
  if (category === 'prompt_confusion') return 'prompt';
  if (category === 'missing_skill_or_tool') return 'skill';
  if (category === 'permission_or_auth') return 'config';
  if (category === 'tool_failure') return 'tool';
  if (category === 'network_or_timeout' || category === 'latency') return 'reliability';
  if (category === 'token_usage') return 'prompt';
  if (category === 'review_data_quality') return 'observability';
  return 'eval';
}

export function actionsForCategory(category: ReviewFindingCategory): string[] {
  if (category === 'permission_or_auth') {
    return [
      'Add a preflight permission check before invoking protected tools.',
      'Improve the user-facing error message when credentials or scopes are missing.',
      'Document the required token/scope in the relevant skill.',
    ];
  }
  if (category === 'missing_skill_or_tool') {
    return [
      'Create or refine a skill that explicitly covers this task type.',
      'Add routing examples so the agent chooses the right tool earlier.',
      'Add an eval case for the missing capability.',
    ];
  }
  if (category === 'tool_failure') {
    return [
      'Add argument validation before the tool call.',
      'Add retry or fallback behavior for transient failures.',
      'Record the failed tool name and sanitized parameters in future logs.',
    ];
  }
  if (category === 'prompt_confusion') {
    return [
      'Add a prompt rule for clarifying ambiguous requests before tool use.',
      'Add examples of correct behavior for this repeated user pattern.',
      'Create an eval case from the redacted turn.',
    ];
  }
  if (category === 'network_or_timeout') {
    return [
      'Add timeout-specific fallback messaging.',
      'Add retry with backoff for idempotent calls.',
      'Track latency and timeout counters per tool.',
    ];
  }
  if (category === 'latency') {
    return [
      'Review slow tool calls and consider caching or narrower queries.',
      'Add a progress update for long-running tasks.',
    ];
  }
  if (category === 'token_usage') {
    return [
      'Trim retrieved context before model calls.',
      'Summarize long logs before passing them to the model.',
      'Add an eval to detect unnecessarily long answers.',
    ];
  }
  if (category === 'review_data_quality') {
    return [
      'Improve Review API/detail fetch observability so partial data is visible without blocking the run.',
      'Record sanitized fetch failure counters by endpoint and session.',
      'Add a regression test for partial review data collection.',
    ];
  }
  return [
    'Inspect representative sessions and decide whether this needs prompt, skill, or tool changes.',
    'Add a regression eval once the expected behavior is clarified.',
  ];
}
