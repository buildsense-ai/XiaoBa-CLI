import * as readline from 'readline';
import { Command } from 'commander';
import { Logger } from '../utils/logger';
import {
  getCatscoReviewAgentConfig,
  validateCatscoReviewAgentConfig,
} from '../utils/catsco-review-agent-config';
import { CatscoReviewAgentClient } from '../utils/catsco-review-agent-client';
import { analyzeReviewData } from '../utils/catsco-review-analyzer';
import { analyzeUsageData } from '../utils/catsco-review-usage-analyzer';
import {
  answerReviewQuestion,
  ReviewQuestionChatTurn,
  ReviewQuestionContext,
} from '../utils/catsco-review-question-answerer';
import { AIService } from '../utils/ai-service';
import { fetchReviewData, runCatscoReviewAgent } from '../utils/catsco-review-runner';

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
    .option('--user-key <key>', 'Limit usage analysis to one redacted Review API user_key')
    .option('--device-key <key>', 'Limit usage analysis to one redacted Review API device_key')
    .option('--target-repo <path>', 'Git repo where proposal files should be copied')
    .option('--create-branch', 'Create a review-agent/proposals-* branch')
    .option('--commit', 'Commit proposal files in the target repo')
    .option('--create-pr', 'Push branch and create a GitHub PR with gh')
    .action(async (options) => {
      await reviewRunOnceCommand(options);
    });

  review
    .command('ask')
    .description('Ask a flexible natural-language question over Cloud Server A review logs')
    .argument('<question...>', 'Question to answer from review logs')
    .option('--cwd <path>', 'Working directory for .env lookup', process.cwd())
    .option('--lookback-hours <hours>', 'Review window in hours')
    .option('--user-key <key>', 'Limit log retrieval to one redacted Review API user_key')
    .option('--device-key <key>', 'Limit log retrieval to one redacted Review API device_key')
    .option('--max-evidence-items <count>', 'Maximum evidence items passed to the model')
    .action(async (questionParts: string[], options) => {
      await reviewAskCommand(questionParts.join(' '), options);
    });

  review
    .command('chat')
    .description('Start an interactive Review Agent chat over the latest review logs')
    .option('--cwd <path>', 'Working directory for .env lookup', process.cwd())
    .option('--lookback-hours <hours>', 'Review window in hours')
    .option('--user-key <key>', 'Limit log retrieval to one redacted Review API user_key')
    .option('--device-key <key>', 'Limit log retrieval to one redacted Review API device_key')
    .option('--max-evidence-items <count>', 'Maximum evidence items passed to the model per question')
    .option('--fixed-range', 'Fetch logs once at startup instead of refreshing before every question')
    .action(async (options) => {
      await reviewChatCommand(options);
    });

  review
    .command('daemon')
    .description('Run Review Agent periodically in proposal-only mode')
    .option('--cwd <path>', 'Working directory for .env lookup', process.cwd())
    .option('--interval-minutes <minutes>', 'Run interval in minutes')
    .option('--lookback-hours <hours>', 'Review window in hours')
    .option('--output-dir <path>', 'Proposal output directory')
    .option('--user-key <key>', 'Limit usage analysis to one redacted Review API user_key')
    .option('--device-key <key>', 'Limit usage analysis to one redacted Review API device_key')
    .action(async (options) => {
      await reviewDaemonCommand(options);
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
  userKey?: string;
  deviceKey?: string;
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
      targetUserKey: options.userKey,
      targetDeviceKey: options.deviceKey,
      targetRepo: options.targetRepo,
      createBranch: options.createBranch,
      commitChanges: options.commit,
      createGithubPr: options.createPr,
    });

    Logger.success(`Review Agent run complete: ${result.runId}`);
    Logger.info(`Proposal directory: ${result.proposalBundle.runDir}`);
    Logger.info(`Usage report: ${result.proposalBundle.files.usageReport}`);
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

async function reviewAskCommand(question: string, options: {
  cwd: string;
  lookbackHours?: string;
  userKey?: string;
  deviceKey?: string;
  maxEvidenceItems?: string;
}): Promise<void> {
  try {
    const context = await loadReviewQuestionContext(options);
    const answer = await answerReviewQuestion(question, context, new AIService(), {
      maxEvidenceItems: parsePositiveInteger(options.maxEvidenceItems),
    });
    console.log(`\n${answer}\n`);
  } catch (error: any) {
    Logger.error(error.message);
    process.exitCode = 1;
  }
}

async function reviewChatCommand(options: {
  cwd: string;
  lookbackHours?: string;
  userKey?: string;
  deviceKey?: string;
  maxEvidenceItems?: string;
  fixedRange?: boolean;
}): Promise<void> {
  const fixedRange = Boolean(options.fixedRange);
  let fixedContext: ReviewQuestionContext | undefined;

  if (fixedRange) {
    try {
      fixedContext = await loadReviewQuestionContext(options);
    } catch (error: any) {
      Logger.error(error.message);
      process.exitCode = 1;
      return;
    }
    Logger.success('Review Agent review-log time range loaded. Ask questions about the fetched review logs.');
    Logger.info('Type /exit to quit. Fixed-range mode answers from the startup log time range.');
  } else {
    try {
      validateReviewQuestionConfig(options.cwd);
    } catch (error: any) {
      Logger.error(error.message);
      process.exitCode = 1;
      return;
    }
    Logger.success('Review Agent chat ready. Each question refreshes the latest review logs for the selected lookback range.');
    Logger.info('Type /exit to quit. Use --fixed-range when you need every answer grounded in the exact same fetched data.');
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'review> ',
  });

  const maxEvidenceItems = parsePositiveInteger(options.maxEvidenceItems);
  const aiService = new AIService();
  const history: ReviewQuestionChatTurn[] = [];

  rl.prompt();
  rl.on('line', async (line) => {
    const question = line.trim();
    if (!question) {
      rl.prompt();
      return;
    }
    if (question === '/exit' || question === 'exit' || question === 'quit') {
      rl.close();
      return;
    }
    try {
      const context = fixedContext || (await loadReviewQuestionContext(options));
      const answer = await answerReviewQuestion(question, context, aiService, {
        maxEvidenceItems,
        conversationHistory: history,
      });
      console.log(`\n${answer}\n`);
      history.push({ question, answer });
      if (history.length > 6) history.shift();
    } catch (error: any) {
      Logger.error(error.message);
    }
    rl.prompt();
  });
}

async function loadReviewQuestionContext(options: {
  cwd: string;
  lookbackHours?: string;
  userKey?: string;
  deviceKey?: string;
}): Promise<ReviewQuestionContext> {
  const config = getCatscoReviewAgentConfig(options.cwd);
  validateCatscoReviewAgentConfig(config);
  if (!config.enabled) {
    throw new Error('CatsCo Review Agent is disabled. Set CATSCO_REVIEW_ENABLED=true to run it.');
  }

  const lookbackHours = parsePositiveInteger(options.lookbackHours) || config.lookbackHours;
  const uploadedTo = new Date().toISOString();
  const uploadedFrom = new Date(Date.parse(uploadedTo) - lookbackHours * 60 * 60 * 1000).toISOString();
  const targetUserKey = options.userKey || config.targetUserKey;
  const targetDeviceKey = options.deviceKey || config.targetDeviceKey;
  const client = new CatscoReviewAgentClient(config.apiBaseUrl, config.reviewToken || '');
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
  return { reviewData, findings, usageAnalysis };
}

function validateReviewQuestionConfig(cwd: string): void {
  const config = getCatscoReviewAgentConfig(cwd);
  validateCatscoReviewAgentConfig(config);
  if (!config.enabled) {
    throw new Error('CatsCo Review Agent is disabled. Set CATSCO_REVIEW_ENABLED=true to run it.');
  }
}

async function reviewDaemonCommand(options: {
  cwd: string;
  intervalMinutes?: string;
  lookbackHours?: string;
  outputDir?: string;
  userKey?: string;
  deviceKey?: string;
}): Promise<void> {
  const config = getCatscoReviewAgentConfig(options.cwd);
  try {
    validateCatscoReviewAgentConfig(config);
    if (!config.enabled) {
      throw new Error('CatsCo Review Agent is disabled. Set CATSCO_REVIEW_ENABLED=true to run it.');
    }
  } catch (error: any) {
    Logger.error(error.message);
    process.exitCode = 1;
    return;
  }

  const intervalMinutes = parsePositiveInteger(options.intervalMinutes) || config.intervalMinutes;
  let stopped = false;

  const stop = () => {
    stopped = true;
    Logger.info('Review Agent daemon stopping after the current cycle.');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  Logger.info(`Review Agent daemon started; interval=${intervalMinutes} minute(s), PR mode disabled.`);

  while (!stopped) {
    try {
      const result = await runCatscoReviewAgent(config, {
        lookbackHours: parsePositiveInteger(options.lookbackHours),
        outputDir: options.outputDir,
        targetUserKey: options.userKey,
        targetDeviceKey: options.deviceKey,
        createBranch: false,
        commitChanges: false,
        createGithubPr: false,
      });
      Logger.success(`Review Agent scheduled run complete: ${result.runId}`);
      Logger.info(`Proposal directory: ${result.proposalBundle.runDir}`);
      Logger.info(`Usage report: ${result.proposalBundle.files.usageReport}`);
      Logger.info(`Findings: ${result.findings.length}`);
    } catch (error: any) {
      Logger.error(`Review Agent scheduled run failed: ${error.message}`);
    }

    if (!stopped) {
      await sleep(intervalMinutes * 60 * 1000);
    }
  }
}

function parsePositiveInteger(raw?: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
