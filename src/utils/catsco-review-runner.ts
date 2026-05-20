import * as path from 'path';
import { analyzeReviewData, ReviewFinding } from './catsco-review-analyzer';
import { CatscoReviewAgentClient, ReviewData, ReviewPage } from './catsco-review-agent-client';
import { CatscoReviewAgentConfig, validateCatscoReviewAgentConfig } from './catsco-review-agent-config';
import { runReviewGitWorkflow, ReviewGitResult } from './catsco-review-gitops';
import { makeReviewRunId, ReviewProposalBundle, writeReviewProposalBundle } from './catsco-review-proposals';

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
}

export interface ReviewRunResult {
  runId: string;
  uploadedFrom: string;
  uploadedTo: string;
  reviewData: ReviewData;
  findings: ReviewFinding[];
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

  const reviewData = await fetchReviewData(client, {
    uploadedFrom,
    uploadedTo,
    maxFailures: config.maxFailures,
    maxSessions: config.maxSessions,
    maxEntriesPerSession: config.maxEntriesPerSession,
    maxTurnsPerSession: config.maxTurnsPerSession,
  });
  const findings = analyzeReviewData(reviewData);
  const proposalBundle = writeReviewProposalBundle({
    outputDir,
    runId,
    reviewData,
    findings,
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
  },
): Promise<ReviewData> {
  const [summary, failures, sessions] = await Promise.all([
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
      (limit, offset) => client.sessions(limit, options.uploadedFrom, offset, options.uploadedTo),
      response => response.sessions,
      item => item.session_record_id,
    ),
  ]);

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
  return String(message || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/catslog_(?:tok|review)_[A-Za-z0-9._~+/=-]+/g, 'catslog_[REDACTED]')
    .replace(/[A-Za-z]:\\[^\s]+/g, '[PATH_REDACTED]')
    .replace(/\/home\/[^/\s]+/g, '/home/[USER_REDACTED]')
    .slice(0, 500);
}

export function reviewOutputRelativePath(filePath: string, baseDir: string): string {
  return path.relative(baseDir, filePath).replace(/\\/g, '/');
}
