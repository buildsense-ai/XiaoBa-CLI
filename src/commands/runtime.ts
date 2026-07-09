import { Logger } from '../utils/logger';
import { getDistillationHeartbeatConfig } from '../utils/distillation-heartbeat-config';
import {
  loadNeedsReviewQueue,
  markRetryEligible,
  NeedsReviewQueueEntry,
  saveNeedsReviewQueue,
} from '../utils/needs-review-queue';
import { formatRuntimeSummary, resolveRuntimeEnvironment } from '../utils/runtime-environment';

interface RuntimeCommandOptions {
  retryNeedsReview?: string;
  reason?: string;
  workingDirectory?: string;
}

export function requestNeedsReviewRetry(
  workingDirectory: string,
  entryId: string,
  reason: string = 'Explicit runtime command requested retry.',
  updatedAt: string = new Date().toISOString(),
): NeedsReviewQueueEntry {
  const config = getDistillationHeartbeatConfig(workingDirectory);
  const queue = loadNeedsReviewQueue(config.needsReviewQueuePath);
  const entry = markRetryEligible(queue, entryId, reason, updatedAt);
  saveNeedsReviewQueue(config.needsReviewQueuePath, queue);
  return entry;
}

export async function runtimeCommand(options: RuntimeCommandOptions = {}): Promise<void> {
  if (options.retryNeedsReview) {
    const entry = requestNeedsReviewRetry(
      options.workingDirectory ?? process.cwd(),
      options.retryNeedsReview,
      options.reason,
    );
    Logger.info(`Needs Review Queue entry marked retry eligible: ${entry.entryId}`);
    return;
  }

  const runtimeEnvironment = resolveRuntimeEnvironment({
    env: process.env,
  });

  Logger.title('Runtime Diagnostics');

  if (runtimeEnvironment.runtimeRoot) {
    Logger.info(`Runtime root: ${runtimeEnvironment.runtimeRoot}`);
  } else {
    Logger.warning('Runtime root: not detected');
  }

  if (runtimeEnvironment.shimDirectory) {
    Logger.info(`Runtime shim directory: ${runtimeEnvironment.shimDirectory}`);
  } else {
    Logger.info('Runtime shim directory: none');
  }

  if (runtimeEnvironment.prependedPaths.length > 0) {
    Logger.info(`Prepended PATH entries: ${runtimeEnvironment.prependedPaths.join(', ')}`);
  } else {
    Logger.info('Prepended PATH entries: none');
  }

  for (const name of ['node', 'python', 'git'] as const) {
    const binary = runtimeEnvironment.binaries[name];
    if (binary.executable) {
      Logger.text(formatRuntimeSummary(binary));
      continue;
    }

    Logger.warning(`${name}: missing`);
  }
}
