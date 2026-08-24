import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Logger } from '../utils/logger';
import { createReviewAdapter, type ReviewAdapter } from './review-adapter';
import { ReviewApprovalInbox, approvalHandlerForAdapter } from './review-approval-inbox';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export interface ReviewHeartbeatOwner {
  adapter: ReviewAdapter;
  stop(): Promise<void>;
}

export interface StartReviewHeartbeatOwnerOptions {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  createAdapter?: typeof createReviewAdapter;
}

/**
 * Attach Review orchestration to the already-persistent Dashboard Runtime.
 * Missing Review workspace is a normal opt-out for installations that do not
 * use Evidence Envelope Review. Explicit false/0/no also disables the owner.
 */
export async function startReviewHeartbeatOwner(
  options: StartReviewHeartbeatOwnerOptions,
): Promise<ReviewHeartbeatOwner | undefined> {
  const projectRoot = path.resolve(options.projectRoot);
  const env = effectiveEnv(projectRoot, options.env ?? process.env);
  if (/^(0|false|no)$/i.test(String(env.XIAOBA_REVIEW_HEARTBEAT_ENABLED || '').trim())) return undefined;
  const workspace = path.resolve(env.XIAOBA_REVIEW_WORKSPACE
    || path.join(projectRoot, 'review', 'evidence-envelopes'));
  const skillDirectory = path.join(projectRoot, 'skills', 'build-evidence-envelope-review');
  if (!fs.existsSync(path.join(workspace, 'findings')) || !fs.existsSync(path.join(skillDirectory, 'SKILL.md'))) {
    return undefined;
  }

  const intervalMs = parseInterval(env.XIAOBA_REVIEW_HEARTBEAT_INTERVAL_MS);
  const adapter = await (options.createAdapter ?? createReviewAdapter)({
    workspace,
    skillDirectory,
    workingDirectory: projectRoot,
  });
  await adapter.recoverAll('dashboard-review-recovery');
  const approvalInbox = new ReviewApprovalInbox({ workspace });
  approvalInbox.start(approvalHandlerForAdapter(adapter));
  adapter.startHeartbeat(intervalMs, 'dashboard-review-heartbeat');
  Logger.info(`Review Heartbeat owner started (interval=${intervalMs}ms)`);

  return {
    adapter,
    async stop(): Promise<void> {
      await approvalInbox.stop();
      await adapter.destroy();
    },
  };
}

function effectiveEnv(projectRoot: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const envPath = path.join(projectRoot, '.env');
  let fileEnv: Record<string, string> = {};
  try {
    if (fs.existsSync(envPath)) fileEnv = dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
  } catch {
    // Invalid optional .env cannot alter the process environment.
  }
  return { ...fileEnv, ...env };
}

function parseInterval(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_HEARTBEAT_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1_000) {
    throw new Error('XIAOBA_REVIEW_HEARTBEAT_INTERVAL_MS must be at least 1000');
  }
  return Math.round(value);
}
