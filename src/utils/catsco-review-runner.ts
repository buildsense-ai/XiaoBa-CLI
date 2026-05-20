import * as path from 'path';
import { analyzeReviewData, ReviewFinding } from './catsco-review-analyzer';
import { CatscoReviewAgentClient, ReviewData } from './catsco-review-agent-client';
import { CatscoReviewAgentConfig, validateCatscoReviewAgentConfig } from './catsco-review-agent-config';
import { runReviewGitWorkflow, ReviewGitResult } from './catsco-review-gitops';
import { makeReviewRunId, ReviewProposalBundle, writeReviewProposalBundle } from './catsco-review-proposals';

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

  const lookbackHours = options.lookbackHours || config.lookbackHours;
  const uploadedFrom = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const runId = makeReviewRunId();
  const outputDir = options.outputDir || config.outputDir;
  const client = new CatscoReviewAgentClient(config.apiBaseUrl, config.reviewToken || '');

  const reviewData = await fetchReviewData(client, {
    uploadedFrom,
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
    maxFailures: number;
    maxSessions: number;
    maxEntriesPerSession: number;
    maxTurnsPerSession: number;
  },
): Promise<ReviewData> {
  const [summary, failuresResponse, sessionsResponse] = await Promise.all([
    client.summary(options.uploadedFrom),
    client.failures(options.maxFailures, options.uploadedFrom),
    client.sessions(options.maxSessions, options.uploadedFrom),
  ]);

  const sessionEntries: ReviewData['sessionEntries'] = {};
  const sessionTurns: ReviewData['sessionTurns'] = {};

  for (const session of sessionsResponse.sessions) {
    const sessionRecordId = session.session_record_id;
    try {
      const [entriesResponse, turnsResponse] = await Promise.all([
        client.entries(sessionRecordId, options.maxEntriesPerSession),
        client.turns(sessionRecordId, options.maxTurnsPerSession),
      ]);
      sessionEntries[sessionRecordId] = entriesResponse.entries;
      sessionTurns[sessionRecordId] = turnsResponse.turns;
    } catch (error: any) {
      sessionEntries[sessionRecordId] = [{
        entry_id: `review-fetch-error-${sessionRecordId}`,
        line_no: 0,
        entry_type: 'review_fetch_error',
        level: 'error',
        message: `Review Agent could not fetch full session details: ${error.message}`,
        event_category: 'review_fetch_error',
      }];
      sessionTurns[sessionRecordId] = [];
    }
  }

  return {
    summary,
    failures: failuresResponse.failures,
    sessions: sessionsResponse.sessions,
    sessionEntries,
    sessionTurns,
  };
}

export function reviewOutputRelativePath(filePath: string, baseDir: string): string {
  return path.relative(baseDir, filePath).replace(/\\/g, '/');
}
