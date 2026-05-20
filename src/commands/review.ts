import { Command } from 'commander';
import { Logger } from '../utils/logger';
import {
  getCatscoReviewAgentConfig,
  validateCatscoReviewAgentConfig,
} from '../utils/catsco-review-agent-config';
import { CatscoReviewAgentClient } from '../utils/catsco-review-agent-client';
import { runCatscoReviewAgent } from '../utils/catsco-review-runner';

export function registerReviewCommand(program: Command): void {
  const review = program
    .command('review')
    .description('Run CatsCo Review Agent against Cloud Server A review logs');

  review
    .command('health')
    .description('Check Cloud Server A Review API access')
    .option('--cwd <path>', 'Working directory for .env lookup', process.cwd())
    .action(async (options) => {
      await reviewHealthCommand(options);
    });

  review
    .command('run-once')
    .description('Pull logs, analyze them, and generate Review Agent proposal files')
    .option('--cwd <path>', 'Working directory for .env lookup', process.cwd())
    .option('--lookback-hours <hours>', 'Review window in hours')
    .option('--output-dir <path>', 'Proposal output directory')
    .option('--target-repo <path>', 'Git repo where proposal files should be copied')
    .option('--create-branch', 'Create a review-agent/proposals-* branch')
    .option('--commit', 'Commit proposal files in the target repo')
    .option('--create-pr', 'Push branch and create a GitHub PR with gh')
    .action(async (options) => {
      await reviewRunOnceCommand(options);
    });
}

async function reviewHealthCommand(options: { cwd: string }): Promise<void> {
  try {
    const config = getCatscoReviewAgentConfig(options.cwd);
    validateCatscoReviewAgentConfig(config);
    const client = new CatscoReviewAgentClient(config.apiBaseUrl, config.reviewToken || '');
    const health = await client.health();
    Logger.success(`Review API connected: ${health.status} (${health.review_api})`);
  } catch (error: any) {
    Logger.error(error.message);
    process.exitCode = 1;
  }
}

async function reviewRunOnceCommand(options: {
  cwd: string;
  lookbackHours?: string;
  outputDir?: string;
  targetRepo?: string;
  createBranch?: boolean;
  commit?: boolean;
  createPr?: boolean;
}): Promise<void> {
  try {
    const config = getCatscoReviewAgentConfig(options.cwd);
    const result = await runCatscoReviewAgent(config, {
      lookbackHours: parsePositiveInteger(options.lookbackHours),
      outputDir: options.outputDir,
      targetRepo: options.targetRepo,
      createBranch: options.createBranch,
      commitChanges: options.commit,
      createGithubPr: options.createPr,
    });

    Logger.success(`Review Agent run complete: ${result.runId}`);
    Logger.info(`Proposal directory: ${result.proposalBundle.runDir}`);
    Logger.info(`Findings: ${result.findings.length}`);
    for (const finding of result.findings.slice(0, 5)) {
      Logger.info(`- [${finding.severity}] ${finding.title} (${finding.count})`);
    }
    if (result.git) {
      Logger.info(`Repo proposal directory: ${result.git.repoProposalDir}`);
      if (result.git.branch) Logger.info(`Branch: ${result.git.branch}`);
      if (result.git.commit) Logger.info(`Commit: ${result.git.commit}`);
      if (result.git.prUrl) Logger.info(`PR: ${result.git.prUrl}`);
    } else {
      Logger.info('Git/PR mode was not enabled; proposal files were written locally only.');
    }
  } catch (error: any) {
    Logger.error(error.message);
    process.exitCode = 1;
  }
}

function parsePositiveInteger(raw?: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}
