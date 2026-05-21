import {
  getCatscoReviewAgentConfig,
  validateCatscoReviewAgentConfig,
} from './catsco-review-agent-config';
import { CatscoReviewAgentClient, ReviewTargetFilters } from './catsco-review-agent-client';
import { analyzeReviewData } from './catsco-review-analyzer';
import { analyzeUsageData } from './catsco-review-usage-analyzer';
import { compactReviewTargetFilters, fetchReviewData } from './catsco-review-runner';
import type { ReviewQuestionContext } from './catsco-review-question-answerer';

export interface LoadReviewQuestionContextOptions {
  cwd: string;
  lookbackHours?: number;
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
  maxFailures?: number;
  maxSessions?: number;
  maxEntriesPerSession?: number;
  maxTurnsPerSession?: number;
  maxTargetTurns?: number;
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
  const targetFilters = compactReviewTargetFilters({
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
  const client = new CatscoReviewAgentClient(config.apiBaseUrl, config.reviewToken || '');
  const reviewData = await fetchReviewData(client, {
    uploadedFrom,
    uploadedTo,
    maxFailures: options.maxFailures || config.maxFailures,
    maxSessions: options.maxSessions || config.maxSessions,
    maxEntriesPerSession: options.maxEntriesPerSession || config.maxEntriesPerSession,
    maxTurnsPerSession: options.maxTurnsPerSession || config.maxTurnsPerSession,
    maxTargetTurns: options.maxTargetTurns || config.maxTargetTurns,
    targetFilters,
  });
  const findings = analyzeReviewData(reviewData);
  const usageAnalysis = analyzeUsageData(reviewData, {
    targetUserKey: targetFilters.userKey,
    targetDeviceKey: targetFilters.deviceKey,
  });
  return { reviewData, findings, usageAnalysis };
}

export function validateReviewQuestionConfig(cwd: string): void {
  const config = getCatscoReviewAgentConfig(cwd);
  validateCatscoReviewAgentConfig(config);
  if (!config.enabled) {
    throw new Error('CatsCo Review Agent is disabled. Set CATSCO_REVIEW_ENABLED=true to run it.');
  }
}
