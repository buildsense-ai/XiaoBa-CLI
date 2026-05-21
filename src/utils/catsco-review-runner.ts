import * as path from 'path';
import { analyzeReviewData, ReviewFinding } from './catsco-review-analyzer';
import { CatscoReviewAgentClient, ReviewData, ReviewPage } from './catsco-review-agent-client';
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
  targetUserKey?: string;
  targetDeviceKey?: string;
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
  const targetUserKey = options.targetUserKey || config.targetUserKey;
  const targetDeviceKey = options.targetDeviceKey || config.targetDeviceKey;

  const reviewData = await fetchReviewData(client, {
    uploadedFrom,
    uploadedTo,
    maxFailures: config.maxFailures,
    maxSessions: config.maxSessions,
    maxEntriesPerSession: config.maxEntriesPerSession,
    maxTurnsPerSession: config.maxTurnsPerSession,
    targetUserKey,
    targetDeviceKey,
  });
  const findings = analyzeReviewData(reviewData);
  const usageAnalysis = analyzeUsageData(reviewData, { targetUserKey, targetDeviceKey });
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
    targetUserKey?: string;
    targetDeviceKey?: string;
  },
): Promise<ReviewData> {
  const [apiSummary, rawFailures, sessions] = await Promise.all([
    client.summary(options.uploadedFrom, options.uploadedTo),
    fetchPagedReviewItems(
      options.maxFailures,
      PAGE_LIMITS.failures,
      (limit, offset) => client.failures(limit, options.uploadedFrom, offset, options.uploadedTo),
      response => response.failures,
      item => `${item.failure_type}:${item.entry_id || item.upload_id}:${item.session_record_id || ''}`,
    ),
    fetchPagedReviewItems(
      options.maxSessions,
      PAGE_LIMITS.sessions,
      (limit, offset) => client.sessions(limit, options.uploadedFrom, offset, options.uploadedTo, {
        userKey: options.targetUserKey,
        deviceKey: options.targetDeviceKey,
      }),
      response => response.sessions,
      item => item.session_record_id,
    ),
  ]);

  const sessionIds = new Set(sessions.map(session => session.session_record_id));
  const hasTargetFilter = Boolean(options.targetUserKey || options.targetDeviceKey);
  const failures = hasTargetFilter
    ? rawFailures.filter(failure => failure.session_record_id && sessionIds.has(failure.session_record_id))
    : rawFailures;
  const summary = hasTargetFilter
    ? summarizeFilteredReviewData(apiSummary, sessions, failures, options.uploadedFrom, options.uploadedTo)
    : apiSummary;

  const sessionEntries: ReviewData['sessionEntries'] = {};
  const sessionTurns: ReviewData['sessionTurns'] = {};

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
      fetchPagedReviewItems(
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

function summarizeFilteredReviewData(
  baseSummary: ReviewData['summary'],
  sessions: ReviewData['sessions'],
  failures: ReviewData['failures'],
  uploadedFrom: string,
  uploadedTo?: string,
): ReviewData['summary'] {
  const uploadIds = new Set<string>();
  for (const session of sessions) uploadIds.add(session.upload_id);
  for (const failure of failures) uploadIds.add(failure.upload_id);
  return {
    uploaded_from: baseSummary.uploaded_from || uploadedFrom,
    uploaded_to: baseSummary.uploaded_to || uploadedTo,
    upload_count: uploadIds.size,
    parsed_upload_count: new Set(sessions.map(session => session.upload_id)).size,
    failed_upload_count: new Set(failures.filter(failure => failure.failure_type === 'parse_failure').map(failure => failure.upload_id)).size,
    session_count: sessions.length,
    turn_count: sessions.reduce((sum, session) => sum + Number(session.turn_count || 0), 0),
    ai_call_count: sessions.reduce((sum, session) => sum + Number(session.ai_call_count || 0), 0),
    tool_call_count: sessions.reduce((sum, session) => sum + Number(session.tool_call_count || 0), 0),
    prompt_tokens: sessions.reduce((sum, session) => sum + Number(session.prompt_tokens || 0), 0),
    completion_tokens: sessions.reduce((sum, session) => sum + Number(session.completion_tokens || 0), 0),
    total_tokens: sessions.reduce((sum, session) => sum + Number(session.total_tokens || 0), 0),
  };
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
