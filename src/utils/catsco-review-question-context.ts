import {
  getCatscoReviewAgentConfig,
  validateCatscoReviewAgentConfig,
} from './catsco-review-agent-config';
import { CatscoReviewAgentClient } from './catsco-review-agent-client';
import { analyzeReviewData } from './catsco-review-analyzer';
import { analyzeUsageData } from './catsco-review-usage-analyzer';
import { fetchReviewData } from './catsco-review-runner';
import type { ReviewQuestionContext } from './catsco-review-question-answerer';

export interface LoadReviewQuestionContextOptions {
  cwd: string;
  lookbackHours?: number;
  targetUserKey?: string;
  targetDeviceKey?: string;
  maxFailures?: number;
  maxSessions?: number;
  maxEntriesPerSession?: number;
  maxTurnsPerSession?: number;
}

export async function loadReviewQuestionContext(
  options: LoadReviewQuestionContextOptions,
): Promise<ReviewQuestionContext> {
  const config = getCatscoReviewAgentConfig(options.cwd);
  validateCatscoReviewAgentConfig(config);
  if (!config.enabled) {
    throw new Error('CatsCo Review Agent is disabled. Set CATSCO_REVIEW_ENABLED=true to run it.');
  }

  const lookbackHours = options.lookbackHours || config.lookbackHours;
  const uploadedTo = new Date().toISOString();
  const uploadedFrom = new Date(Date.parse(uploadedTo) - lookbackHours * 60 * 60 * 1000).toISOString();
  const targetUserKey = options.targetUserKey || config.targetUserKey;
  const targetDeviceKey = options.targetDeviceKey || config.targetDeviceKey;
  const client = new CatscoReviewAgentClient(config.apiBaseUrl, config.reviewToken || '');
  const reviewData = await fetchReviewData(client, {
    uploadedFrom,
    uploadedTo,
    maxFailures: options.maxFailures || config.maxFailures,
    maxSessions: options.maxSessions || config.maxSessions,
    maxEntriesPerSession: options.maxEntriesPerSession || config.maxEntriesPerSession,
    maxTurnsPerSession: options.maxTurnsPerSession || config.maxTurnsPerSession,
    targetUserKey,
    targetDeviceKey,
  });
  const findings = analyzeReviewData(reviewData);
  const usageAnalysis = analyzeUsageData(reviewData, { targetUserKey, targetDeviceKey });
  return { reviewData, findings, usageAnalysis };
}

export function validateReviewQuestionConfig(cwd: string): void {
  const config = getCatscoReviewAgentConfig(cwd);
  validateCatscoReviewAgentConfig(config);
  if (!config.enabled) {
    throw new Error('CatsCo Review Agent is disabled. Set CATSCO_REVIEW_ENABLED=true to run it.');
  }
}
