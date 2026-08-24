import {
  startReviewHeartbeatOwner,
  type ReviewHeartbeatOwner,
  type StartReviewHeartbeatOwnerOptions,
} from './review-heartbeat-owner';
import {
  startReviewWorkbenchOwner,
  type ReviewWorkbenchOwner,
  type StartReviewWorkbenchOwnerOptions,
} from './review-workbench-owner';

export interface ReviewOwnerLifecycle {
  heartbeat?: ReviewHeartbeatOwner;
  workbench?: ReviewWorkbenchOwner;
  stop(): Promise<void>;
}

export interface StartReviewOwnerLifecycleOptions {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  startHeartbeat?: (
    options: StartReviewHeartbeatOwnerOptions,
  ) => Promise<ReviewHeartbeatOwner | undefined>;
  startWorkbench?: (
    options: StartReviewWorkbenchOwnerOptions,
  ) => Promise<ReviewWorkbenchOwner | undefined>;
}

/**
 * Start every Review owner enabled for this installation as one lifecycle.
 * Missing workspaces are a normal opt-out. A partial startup is rolled back so
 * Dashboard never leaves a heartbeat or Workbench process orphaned.
 */
export async function startReviewOwnerLifecycle(
  options: StartReviewOwnerLifecycleOptions,
): Promise<ReviewOwnerLifecycle> {
  let heartbeat: ReviewHeartbeatOwner | undefined;
  let workbench: ReviewWorkbenchOwner | undefined;
  try {
    heartbeat = await (options.startHeartbeat ?? startReviewHeartbeatOwner)({
      projectRoot: options.projectRoot,
      env: options.env,
    });
    workbench = await (options.startWorkbench ?? startReviewWorkbenchOwner)({
      projectRoot: options.projectRoot,
      env: options.env,
    });
  } catch (error) {
    await Promise.allSettled([
      heartbeat?.stop(),
      workbench?.stop(),
    ].filter(Boolean) as Promise<void>[]);
    throw error;
  }

  let stopPromise: Promise<void> | undefined;
  return {
    heartbeat,
    workbench,
    stop(): Promise<void> {
      if (!stopPromise) {
        stopPromise = Promise.allSettled([
          heartbeat?.stop(),
          workbench?.stop(),
        ].filter(Boolean) as Promise<void>[]).then(() => undefined);
      }
      return stopPromise;
    },
  };
}
