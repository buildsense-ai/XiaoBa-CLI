import type { ReviewData, ReviewEntry, ReviewFailure, ReviewSession, ReviewTurn } from './catsco-review-agent-client';

export type ReviewFindingCategory =
  | 'permission_or_auth'
  | 'missing_skill_or_tool'
  | 'tool_failure'
  | 'prompt_confusion'
  | 'network_or_timeout'
  | 'latency'
  | 'token_usage'
  | 'general_failure';

export type ReviewFindingSeverity = 'high' | 'medium' | 'low';

export interface ReviewFinding {
  category: ReviewFindingCategory;
  severity: ReviewFindingSeverity;
  title: string;
  count: number;
  affectedSessions: string[];
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
    'token',
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
};

interface FindingDraft {
  category: ReviewFindingCategory;
  title: string;
  count: number;
  affectedSessions: Set<string>;
  evidence: string[];
}

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
  const drafts = new Map<ReviewFindingCategory, FindingDraft>();

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
        || b.count - a.count
        || a.category.localeCompare(b.category);
    });
}

function analyzeEntries(
  drafts: Map<ReviewFindingCategory, FindingDraft>,
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
      const draft = ensureDraft(drafts, 'latency');
      draft.count += 1;
      draft.affectedSessions.add(sessionRecordId);
      pushEvidence(draft, compactText(`${entry.tool_name || entry.event_category || 'operation'} took ${entry.duration_ms}ms`));
    }
  }
}

function analyzeTurns(
  drafts: Map<ReviewFindingCategory, FindingDraft>,
  sessionRecordId: string,
  turns: ReviewTurn[],
): void {
  for (const turn of turns) {
    const combined = `${turn.user_text || ''}\n${turn.assistant_text || ''}`;
    const category = classifyReviewText(combined);
    if (category === 'prompt_confusion') {
      const draft = ensureDraft(drafts, category);
      draft.count += 1;
      draft.affectedSessions.add(sessionRecordId);
      pushEvidence(draft, compactText(combined));
    }
  }
}

function analyzeSessionMetrics(
  drafts: Map<ReviewFindingCategory, FindingDraft>,
  sessions: ReviewSession[],
  sessionEntries: Record<string, ReviewEntry[]>,
): void {
  for (const session of sessions) {
    if (Number(session.total_tokens || 0) >= 12000) {
      const draft = ensureDraft(drafts, 'token_usage');
      draft.count += 1;
      draft.affectedSessions.add(session.session_record_id);
      pushEvidence(draft, `Session exceeded token threshold: ${session.session_record_id}`);
    }

    const entries = sessionEntries[session.session_record_id] || [];
    if (entries.length === 0 && session.entry_count > 0) {
      const draft = ensureDraft(drafts, 'general_failure');
      pushEvidence(draft, `Session ${session.session_record_id} has entries on server but none were fetched by the review window.`);
    }
  }
}

function addTextFinding(
  drafts: Map<ReviewFindingCategory, FindingDraft>,
  message: string,
  sessionRecordId?: string,
  fallback?: ReviewFailure | ReviewEntry,
): void {
  const evidence = compactText(message || JSON.stringify(fallback || {}));
  if (!evidence) return;

  const category = classifyReviewText(evidence);
  const draft = ensureDraft(drafts, category);
  draft.count += 1;
  if (sessionRecordId) {
    draft.affectedSessions.add(sessionRecordId);
  }
  pushEvidence(draft, evidence);
}

function ensureDraft(drafts: Map<ReviewFindingCategory, FindingDraft>, category: ReviewFindingCategory): FindingDraft {
  const existing = drafts.get(category);
  if (existing) return existing;

  const next: FindingDraft = {
    category,
    title: titleForCategory(category),
    count: 0,
    affectedSessions: new Set<string>(),
    evidence: [],
  };
  drafts.set(category, next);
  return next;
}

function finalizeDraft(draft: FindingDraft): ReviewFinding {
  return {
    category: draft.category,
    severity: severityForCategory(draft.category, draft.count),
    title: draft.title,
    count: draft.count,
    affectedSessions: Array.from(draft.affectedSessions).sort(),
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

export function severityForCategory(category: ReviewFindingCategory, count: number): ReviewFindingSeverity {
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

export function titleForCategory(category: ReviewFindingCategory): string {
  return {
    permission_or_auth: 'Permission or authentication failures',
    missing_skill_or_tool: 'Missing skill or missing tool routing',
    tool_failure: 'Tool execution failures',
    prompt_confusion: 'Prompt confusion or repeated clarification',
    network_or_timeout: 'Network or timeout instability',
    latency: 'Long-running calls need progress or optimization',
    token_usage: 'High token usage sessions',
    general_failure: 'General unresolved failures',
  }[category];
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
  return [
    'Inspect representative sessions and decide whether this needs prompt, skill, or tool changes.',
    'Add a regression eval once the expected behavior is clarified.',
  ];
}
