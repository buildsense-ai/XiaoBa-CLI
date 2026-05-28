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
  targetBotId?: string;
  targetPersonId?: string;
  targetActorExternalUserId?: string;
  targetActorCatscoUserId?: string;
  targetActorWeixinUserId?: string;
  targetActorFeishuUserId?: string;
  targetUserKey?: string;
  targetDeviceKey?: string;
  targetBotKey?: string;
  targetPersonKey?: string;
  targetActorKey?: string;
  targetActorCatscoUserKey?: string;
  targetActorWeixinUserKey?: string;
  targetActorFeishuUserKey?: string;
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
    botId: options.targetFilters?.botId ?? options.targetBotId ?? config.targetBotId,
    personId: options.targetFilters?.personId ?? options.targetPersonId ?? config.targetPersonId,
    actorExternalUserId: options.targetFilters?.actorExternalUserId ?? options.targetActorExternalUserId ?? config.targetActorExternalUserId,
    actorCatscoUserId: options.targetFilters?.actorCatscoUserId ?? options.targetActorCatscoUserId ?? config.targetActorCatscoUserId,
    actorWeixinUserId: options.targetFilters?.actorWeixinUserId ?? options.targetActorWeixinUserId ?? config.targetActorWeixinUserId,
    actorFeishuUserId: options.targetFilters?.actorFeishuUserId ?? options.targetActorFeishuUserId ?? config.targetActorFeishuUserId,
    userKey: options.targetFilters?.userKey ?? options.targetUserKey ?? config.targetUserKey,
    deviceKey: options.targetFilters?.deviceKey ?? options.targetDeviceKey ?? config.targetDeviceKey,
    botKey: options.targetFilters?.botKey ?? options.targetBotKey ?? config.targetBotKey,
    personKey: options.targetFilters?.personKey ?? options.targetPersonKey ?? config.targetPersonKey,
    actorKey: options.targetFilters?.actorKey ?? options.targetActorKey ?? config.targetActorKey,
    actorCatscoUserKey: options.targetFilters?.actorCatscoUserKey ?? options.targetActorCatscoUserKey ?? config.targetActorCatscoUserKey,
    actorWeixinUserKey: options.targetFilters?.actorWeixinUserKey ?? options.targetActorWeixinUserKey ?? config.targetActorWeixinUserKey,
    actorFeishuUserKey: options.targetFilters?.actorFeishuUserKey ?? options.targetActorFeishuUserKey ?? config.targetActorFeishuUserKey,
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
    targetBotKey: targetFilters.botKey,
    targetPersonKey: targetFilters.personKey,
    targetActorKey: targetFilters.actorKey,
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
