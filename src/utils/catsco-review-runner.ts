import * as path from 'path';
import { analyzeReviewData, ReviewFinding } from './catsco-review-analyzer';
import { CatscoReviewAgentClient, ReviewData, ReviewPage, ReviewTargetFilters, ReviewTurn } from './catsco-review-agent-client';
import { CatscoReviewAgentConfig, validateCatscoReviewAgentConfig } from './catsco-review-agent-config';
import { runReviewGitWorkflow, ReviewGitResult } from './catsco-review-gitops';
import { makeReviewRunId, ReviewProposalBundle, writeReviewProposalBundle } from './catsco-review-proposals';
import { analyzeUsageData, ReviewUsageAnalysis } from './catsco-review-usage-analyzer';
import { redactReviewText } from './catsco-review-redaction';

const REVIEW_GIT_PROPOSAL_FILES = [
  'report.md',
  'findings.json',
  'prompt_suggestions.md',
  'skill_suggestions.md',
  'code_suggestions.md',
  'eval_cases.jsonl',
];

const PAGE_LIMITS = {
  failures: 200,
  sessions: 200,
  entries: 500,
  turns: 300,
};

export interface ReviewRunOptions {
  lookbackHours?: number;
  outputDir?: string;
  targetRepo?: string;
  createBranch?: boolean;
  commitChanges?: boolean;
  createGithubPr?: boolean;
  targetUserId?: string;
  targetDeviceId?: string;
  targetDeviceName?: string;
  targetUserKey?: string;
  targetDeviceKey?: string;
  targetSessionId?: string;
  targetSessionKey?: string;
  targetSessionType?: string;
  targetOrgKey?: string;
  targetOrgType?: string;
  targetUserRole?: string;
  targetDeviceRole?: string;
  targetChannelType?: string;
  targetWorkspaceKey?: string;
  targetFilters?: ReviewTargetFilters;
}

export interface ReviewRunResult {
  runId: string;
  uploadedFrom: string;
  uploadedTo: string;
  reviewData: ReviewData;
  findings: ReviewFinding[];
  usageAnalysis: ReviewUsageAnalysis;
  proposalBundle: ReviewProposalBundle;
  git?: ReviewGitResult;
}

export async function runCatscoReviewAgent(
  config: CatscoReviewAgentConfig,
  options: ReviewRunOptions = {},
): Promise<ReviewRunResult> {
  validateCatscoReviewAgentConfig(config);
  if (!config.enabled) {
    throw new Error('CatsCo Review Agent is disabled. Set CATSCO_REVIEW_ENABLED=true to run it.');
  }

  const lookbackHours = options.lookbackHours || config.lookbackHours;
  const uploadedTo = new Date().toISOString();
  const uploadedFrom = new Date(Date.parse(uploadedTo) - lookbackHours * 60 * 60 * 1000).toISOString();
  const runId = makeReviewRunId();
  const outputDir = options.outputDir || config.outputDir;
  const client = new CatscoReviewAgentClient(config.apiBaseUrl, config.reviewToken || '');
  const targetFilters = reviewTargetFiltersFromConfig(config, options);

  const reviewData = await fetchReviewData(client, {
    uploadedFrom,
    uploadedTo,
    maxFailures: config.maxFailures,
    maxSessions: config.maxSessions,
    maxEntriesPerSession: config.maxEntriesPerSession,
    maxTurnsPerSession: config.maxTurnsPerSession,
    maxTargetTurns: config.maxTargetTurns,
    targetFilters,
  });
  const findings = analyzeReviewData(reviewData);
  const usageAnalysis = analyzeUsageData(reviewData, {
    targetUserKey: targetFilters.userKey,
    targetDeviceKey: targetFilters.deviceKey,
  });
  const proposalBundle = writeReviewProposalBundle({
    outputDir,
    runId,
    reviewData,
    findings,
    usageAnalysis,
  });

  const targetRepo = options.targetRepo || config.targetRepo;
  const createBranch = options.createBranch ?? config.createBranch;
  const commitChanges = options.commitChanges ?? config.commitChanges;
  const createGithubPr = options.createGithubPr ?? config.createGithubPr;
  const shouldUseGit = Boolean(targetRepo && (createBranch || commitChanges || createGithubPr));

  const git = shouldUseGit
    ? runReviewGitWorkflow({
      targetRepo: targetRepo || process.cwd(),
      proposalSourceDir: proposalBundle.runDir,
      includeFiles: REVIEW_GIT_PROPOSAL_FILES,
      runId,
      prBaseBranch: config.prBaseBranch,
      gitRemote: config.gitRemote,
      createBranch,
      commitChanges,
      createGithubPr,
    })
    : undefined;

  return {
    runId,
    uploadedFrom,
    uploadedTo,
    reviewData,
    findings,
    usageAnalysis,
    proposalBundle,
    git,
  };
}

export async function fetchReviewData(
  client: CatscoReviewAgentClient,
  options: {
    uploadedFrom: string;
    uploadedTo?: string;
    maxFailures: number;
    maxSessions: number;
    maxEntriesPerSession: number;
    maxTurnsPerSession: number;
    maxTargetTurns?: number;
    targetUserKey?: string;
    targetDeviceKey?: string;
    targetFilters?: ReviewTargetFilters;
  },
): Promise<ReviewData> {
  const targetFilters = compactReviewTargetFilters({
    ...options.targetFilters,
    userKey: options.targetFilters?.userKey ?? options.targetUserKey,
    deviceKey: options.targetFilters?.deviceKey ?? options.targetDeviceKey,
  });
  const hasTargetFilter = hasReviewTargetFilter(targetFilters);
  const [apiSummary, rawFailures, sessions] = await Promise.all([
    client.summary(options.uploadedFrom, options.uploadedTo, targetFilters),
    fetchPagedReviewItems(
      options.maxFailures,
      PAGE_LIMITS.failures,
      (limit, offset) => client.failures(limit, options.uploadedFrom, offset, options.uploadedTo, targetFilters),
      response => response.failures,
      item => `${item.failure_type}:${item.entry_id || item.upload_id}:${item.session_record_id || ''}`,
    ),
    fetchPagedReviewItems(
      options.maxSessions,
      PAGE_LIMITS.sessions,
      (limit, offset) => client.sessions(limit, options.uploadedFrom, offset, options.uploadedTo, targetFilters),
      response => response.sessions,
      item => item.session_record_id,
    ),
  ]);

  const sessionIds = new Set(sessions.map(session => session.session_record_id));
  const failures = hasTargetFilter
    ? rawFailures.filter(failure => Boolean(failure.session_record_id && sessionIds.has(failure.session_record_id)))
    : rawFailures;
  const summary = apiSummary;
  const targetTurns = hasTargetFilter
    ? await fetchPagedReviewItems(
      Math.max(1, options.maxTargetTurns || targetTurnLimit(options.maxSessions, options.maxTurnsPerSession)),
      PAGE_LIMITS.turns,
      (limit, offset) => client.reviewTurns(limit, options.uploadedFrom, offset, options.uploadedTo, targetFilters),
      response => response.turns,
      item => item.turn_record_id,
    )
    : undefined;
  const targetTurnsBySession = targetTurns
    ? groupReviewTurnsBySession(targetTurns.filter(turn => {
      const sessionRecordId = String(turn.session_record_id || '');
      if (!sessionRecordId) return false;
      if (sessionIds.size === 0) return false;
      return sessionIds.has(sessionRecordId);
    }))
    : {};

  const sessionEntries: ReviewData['sessionEntries'] = {};
  const sessionTurns: ReviewData['sessionTurns'] = {};
  for (const [sessionRecordId, turns] of Object.entries(targetTurnsBySession)) {
    sessionTurns[sessionRecordId] = turns;
  }

  for (const session of sessions) {
    const sessionRecordId = session.session_record_id;
    const [entriesResult, turnsResult] = await Promise.allSettled([
      fetchPagedReviewItems(
        options.maxEntriesPerSession,
        PAGE_LIMITS.entries,
        (limit, offset) => client.entries(sessionRecordId, limit, offset),
        response => response.entries,
        item => item.entry_id,
      ),
      hasTargetFilter
        ? Promise.resolve(sessionTurns[sessionRecordId] || [])
        : fetchPagedReviewItems(
        options.maxTurnsPerSession,
        PAGE_LIMITS.turns,
        (limit, offset) => client.turns(sessionRecordId, limit, offset),
        response => response.turns,
        item => item.turn_record_id,
      ),
    ]);

    sessionEntries[sessionRecordId] = entriesResult.status === 'fulfilled'
      ? entriesResult.value
      : [reviewFetchErrorEntry(sessionRecordId, entriesResult.reason)];
    sessionTurns[sessionRecordId] = turnsResult.status === 'fulfilled'
      ? turnsResult.value
      : [];
    if (turnsResult.status === 'rejected' && entriesResult.status === 'fulfilled') {
      sessionEntries[sessionRecordId] = [{
        entry_id: `review-fetch-error-${sessionRecordId}`,
        line_no: 0,
        entry_type: 'review_fetch_error',
        level: 'error',
        message: `Review Agent could not fetch session turns: ${sanitizeReviewErrorMessage(turnsResult.reason?.message || String(turnsResult.reason))}`,
        event_category: 'review_fetch_error',
      }, ...sessionEntries[sessionRecordId]];
    }
  }

  return {
    summary,
    failures,
    sessions,
    sessionEntries,
    sessionTurns,
  };
}

export function reviewTargetFiltersFromConfig(
  config: CatscoReviewAgentConfig,
  options: ReviewRunOptions = {},
): ReviewTargetFilters {
  return compactReviewTargetFilters({
    userId: options.targetFilters?.userId ?? options.targetUserId ?? config.targetUserId,
    deviceId: options.targetFilters?.deviceId ?? options.targetDeviceId ?? config.targetDeviceId,
    deviceName: options.targetFilters?.deviceName ?? options.targetDeviceName ?? config.targetDeviceName,
    userKey: options.targetFilters?.userKey ?? options.targetUserKey ?? config.targetUserKey,
    deviceKey: options.targetFilters?.deviceKey ?? options.targetDeviceKey ?? config.targetDeviceKey,
    sessionId: options.targetFilters?.sessionId ?? options.targetSessionId ?? config.targetSessionId,
    sessionKey: options.targetFilters?.sessionKey ?? options.targetSessionKey ?? config.targetSessionKey,
    sessionType: options.targetFilters?.sessionType ?? options.targetSessionType ?? config.targetSessionType,
    orgKey: options.targetFilters?.orgKey ?? options.targetOrgKey ?? config.targetOrgKey,
    orgType: options.targetFilters?.orgType ?? options.targetOrgType ?? config.targetOrgType,
    userRole: options.targetFilters?.userRole ?? options.targetUserRole ?? config.targetUserRole,
    deviceRole: options.targetFilters?.deviceRole ?? options.targetDeviceRole ?? config.targetDeviceRole,
    channelType: options.targetFilters?.channelType ?? options.targetChannelType ?? config.targetChannelType,
    workspaceKey: options.targetFilters?.workspaceKey ?? options.targetWorkspaceKey ?? config.targetWorkspaceKey,
  });
}

export function compactReviewTargetFilters(filters: ReviewTargetFilters = {}): ReviewTargetFilters {
  const compact: ReviewTargetFilters = {};
  for (const [key, value] of Object.entries(filters) as Array<[keyof ReviewTargetFilters, string | undefined]>) {
    const text = String(value || '').trim();
    if (text) compact[key] = text;
  }
  return compact;
}

export function hasReviewTargetFilter(filters: ReviewTargetFilters = {}): boolean {
  return Object.values(filters).some(value => Boolean(String(value || '').trim()));
}

function targetTurnLimit(maxSessions: number, maxTurnsPerSession: number): number {
  return Math.max(1, maxSessions) * Math.max(1, maxTurnsPerSession);
}

function groupReviewTurnsBySession(turns: ReviewTurn[]): Record<string, ReviewTurn[]> {
  const grouped: Record<string, ReviewTurn[]> = {};
  for (const turn of turns) {
    const sessionRecordId = turn.session_record_id || `unknown-${turn.turn_record_id}`;
    grouped[sessionRecordId] ||= [];
    grouped[sessionRecordId].push(turn);
  }
  return grouped;
}

async function fetchPagedReviewItems<TResponse extends { page: ReviewPage }, TItem>(
  maxItems: number,
  pageLimit: number,
  fetchPage: (limit: number, offset: number) => Promise<TResponse>,
  getItems: (response: TResponse) => TItem[],
  getKey?: (item: TItem) => string | undefined,
): Promise<TItem[]> {
  const items: TItem[] = [];
  const seen = new Set<string>();
  let offset = 0;

  while (items.length < maxItems) {
    const limit = Math.min(pageLimit, maxItems - items.length);
    const response = await fetchPage(limit, offset);
    const pageItems = getItems(response) || [];
    for (const item of pageItems) {
      const key = getKey?.(item);
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      items.push(item);
    }

    const nextOffset = response.page?.next_offset ?? (offset + pageItems.length);
    const hasMore = response.page?.has_more ?? pageItems.length === limit;
    if (!hasMore || pageItems.length === 0 || nextOffset <= offset) {
      break;
    }
    offset = nextOffset;
  }

  return items.slice(0, maxItems);
}

function reviewFetchErrorEntry(sessionRecordId: string, error: any) {
  return {
    entry_id: `review-fetch-error-${sessionRecordId}`,
    line_no: 0,
    entry_type: 'review_fetch_error',
    level: 'error',
    message: `Review Agent could not fetch session entries: ${sanitizeReviewErrorMessage(error?.message || String(error))}`,
    event_category: 'review_fetch_error',
  };
}

function sanitizeReviewErrorMessage(message: string): string {
  return redactReviewText(message, 500);
}

export function reviewOutputRelativePath(filePath: string, baseDir: string): string {
  return path.relative(baseDir, filePath).replace(/\\/g, '/');
}
