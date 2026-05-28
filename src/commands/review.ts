import * as readline from 'readline';
import { Command } from 'commander';
import { Logger } from '../utils/logger';
import {
  getCatscoReviewAgentConfig,
  validateCatscoReviewAgentConfig,
} from '../utils/catsco-review-agent-config';
import { CatscoReviewAgentClient } from '../utils/catsco-review-agent-client';
import {
  answerReviewQuestion,
  ReviewQuestionChatTurn,
  ReviewQuestionContext,
} from '../utils/catsco-review-question-answerer';
import {
  loadReviewQuestionContext,
  LoadReviewQuestionContextOptions,
  validateReviewQuestionConfig,
} from '../utils/catsco-review-question-context';
import { AIService } from '../utils/ai-service';
import { runCatscoReviewAgent } from '../utils/catsco-review-runner';

interface ReviewTargetCliOptions {
  userId?: string;
  deviceId?: string;
  deviceName?: string;
  botId?: string;
  personId?: string;
  actorExternalUserId?: string;
  actorCatscoUserId?: string;
  actorWeixinUserId?: string;
  actorFeishuUserId?: string;
  userKey?: string;
  deviceKey?: string;
  botKey?: string;
  personKey?: string;
  actorKey?: string;
  actorCatscoUserKey?: string;
  actorWeixinUserKey?: string;
  actorFeishuUserKey?: string;
  sessionId?: string;
  sessionKey?: string;
  sessionType?: string;
  orgKey?: string;
  orgType?: string;
  userRole?: string;
  deviceRole?: string;
  channelType?: string;
  workspaceKey?: string;
}

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
    .option('--user-id <id>', 'Limit usage analysis by raw server user_id; used only as a Review API filter')
    .option('--device-id <id>', 'Limit usage analysis by raw server device_id; used only as a Review API filter')
    .option('--device-name <name>', 'Limit usage analysis by raw server device_name; used only as a Review API filter')
    .option('--bot-key <key>', 'Limit usage analysis to one redacted Review API bot_key')
    .option('--person-key <key>', 'Limit usage analysis to one redacted Review API person_key')
    .option('--actor-key <key>', 'Limit usage analysis to one redacted Review API actor_key')
    .option('--actor-catsco-user-key <key>', 'Limit usage analysis to one redacted Review API actor_catsco_user_key')
    .option('--actor-weixin-user-key <key>', 'Limit usage analysis to one redacted Review API actor_weixin_user_key')
    .option('--actor-feishu-user-key <key>', 'Limit usage analysis to one redacted Review API actor_feishu_user_key')
    .option('--bot-id <id>', 'Limit usage analysis by raw server bot_id; used only as a Review API filter')
    .option('--person-id <id>', 'Limit usage analysis by raw server person_id; used only as a Review API filter')
    .option('--actor-external-user-id <id>', 'Limit usage analysis by raw server actor_external_user_id; used only as a Review API filter')
    .option('--actor-catsco-user-id <id>', 'Limit usage analysis by raw server actor_catsco_user_id; used only as a Review API filter')
    .option('--actor-weixin-user-id <id>', 'Limit usage analysis by raw server actor_weixin_user_id; used only as a Review API filter')
    .option('--actor-feishu-user-id <id>', 'Limit usage analysis by raw server actor_feishu_user_id; used only as a Review API filter')
    .option('--session-id <id>', 'Limit usage analysis by raw server session_id; used only as a Review API filter')
    .option('--session-key <key>', 'Limit usage analysis to one redacted Review API session_key')
    .option('--session-type <type>', 'Limit usage analysis to one session_type')
    .option('--org-key <key>', 'Limit usage analysis to one org_key')
    .option('--org-type <type>', 'Limit usage analysis to one org_type, such as school')
    .option('--user-role <role>', 'Limit usage analysis to one user_role')
    .option('--device-role <role>', 'Limit usage analysis to one device_role')
    .option('--channel-type <type>', 'Limit usage analysis to one channel_type')
    .option('--workspace-key <key>', 'Limit usage analysis to one workspace_key')
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
    .option('--user-id <id>', 'Limit log retrieval by raw server user_id; used only as a Review API filter')
    .option('--device-id <id>', 'Limit log retrieval by raw server device_id; used only as a Review API filter')
    .option('--device-name <name>', 'Limit log retrieval by raw server device_name; used only as a Review API filter')
    .option('--bot-key <key>', 'Limit log retrieval to one redacted Review API bot_key')
    .option('--person-key <key>', 'Limit log retrieval to one redacted Review API person_key')
    .option('--actor-key <key>', 'Limit log retrieval to one redacted Review API actor_key')
    .option('--actor-catsco-user-key <key>', 'Limit log retrieval to one redacted Review API actor_catsco_user_key')
    .option('--actor-weixin-user-key <key>', 'Limit log retrieval to one redacted Review API actor_weixin_user_key')
    .option('--actor-feishu-user-key <key>', 'Limit log retrieval to one redacted Review API actor_feishu_user_key')
    .option('--bot-id <id>', 'Limit log retrieval by raw server bot_id; used only as a Review API filter')
    .option('--person-id <id>', 'Limit log retrieval by raw server person_id; used only as a Review API filter')
    .option('--actor-external-user-id <id>', 'Limit log retrieval by raw server actor_external_user_id; used only as a Review API filter')
    .option('--actor-catsco-user-id <id>', 'Limit log retrieval by raw server actor_catsco_user_id; used only as a Review API filter')
    .option('--actor-weixin-user-id <id>', 'Limit log retrieval by raw server actor_weixin_user_id; used only as a Review API filter')
    .option('--actor-feishu-user-id <id>', 'Limit log retrieval by raw server actor_feishu_user_id; used only as a Review API filter')
    .option('--session-id <id>', 'Limit log retrieval by raw server session_id; used only as a Review API filter')
    .option('--session-key <key>', 'Limit log retrieval to one redacted Review API session_key')
    .option('--session-type <type>', 'Limit log retrieval to one session_type')
    .option('--org-key <key>', 'Limit log retrieval to one org_key')
    .option('--org-type <type>', 'Limit log retrieval to one org_type, such as school')
    .option('--user-role <role>', 'Limit log retrieval to one user_role')
    .option('--device-role <role>', 'Limit log retrieval to one device_role')
    .option('--channel-type <type>', 'Limit log retrieval to one channel_type')
    .option('--workspace-key <key>', 'Limit log retrieval to one workspace_key')
    .option('--max-evidence-items <count>', 'Maximum evidence items passed to the model')
    .option('--max-evidence-chars <count>', 'Maximum evidence characters passed to the model')
    .option('--max-sessions <count>', 'Maximum sessions to fetch for this question')
    .option('--max-turns-per-session <count>', 'Maximum turns to fetch per session')
    .option('--max-target-turns <count>', 'Maximum top-level turns to fetch when a target filter is used')
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
    .option('--user-id <id>', 'Limit log retrieval by raw server user_id; used only as a Review API filter')
    .option('--device-id <id>', 'Limit log retrieval by raw server device_id; used only as a Review API filter')
    .option('--device-name <name>', 'Limit log retrieval by raw server device_name; used only as a Review API filter')
    .option('--bot-key <key>', 'Limit log retrieval to one redacted Review API bot_key')
    .option('--person-key <key>', 'Limit log retrieval to one redacted Review API person_key')
    .option('--actor-key <key>', 'Limit log retrieval to one redacted Review API actor_key')
    .option('--actor-catsco-user-key <key>', 'Limit log retrieval to one redacted Review API actor_catsco_user_key')
    .option('--actor-weixin-user-key <key>', 'Limit log retrieval to one redacted Review API actor_weixin_user_key')
    .option('--actor-feishu-user-key <key>', 'Limit log retrieval to one redacted Review API actor_feishu_user_key')
    .option('--bot-id <id>', 'Limit log retrieval by raw server bot_id; used only as a Review API filter')
    .option('--person-id <id>', 'Limit log retrieval by raw server person_id; used only as a Review API filter')
    .option('--actor-external-user-id <id>', 'Limit log retrieval by raw server actor_external_user_id; used only as a Review API filter')
    .option('--actor-catsco-user-id <id>', 'Limit log retrieval by raw server actor_catsco_user_id; used only as a Review API filter')
    .option('--actor-weixin-user-id <id>', 'Limit log retrieval by raw server actor_weixin_user_id; used only as a Review API filter')
    .option('--actor-feishu-user-id <id>', 'Limit log retrieval by raw server actor_feishu_user_id; used only as a Review API filter')
    .option('--session-id <id>', 'Limit log retrieval by raw server session_id; used only as a Review API filter')
    .option('--session-key <key>', 'Limit log retrieval to one redacted Review API session_key')
    .option('--session-type <type>', 'Limit log retrieval to one session_type')
    .option('--org-key <key>', 'Limit log retrieval to one org_key')
    .option('--org-type <type>', 'Limit log retrieval to one org_type, such as school')
    .option('--user-role <role>', 'Limit log retrieval to one user_role')
    .option('--device-role <role>', 'Limit log retrieval to one device_role')
    .option('--channel-type <type>', 'Limit log retrieval to one channel_type')
    .option('--workspace-key <key>', 'Limit log retrieval to one workspace_key')
    .option('--max-evidence-items <count>', 'Maximum evidence items passed to the model per question')
    .option('--max-evidence-chars <count>', 'Maximum evidence characters passed to the model per question')
    .option('--max-sessions <count>', 'Maximum sessions to fetch per question')
    .option('--max-turns-per-session <count>', 'Maximum turns to fetch per session')
    .option('--max-target-turns <count>', 'Maximum top-level turns to fetch when a target filter is used')
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
    .option('--user-id <id>', 'Limit usage analysis by raw server user_id; used only as a Review API filter')
    .option('--device-id <id>', 'Limit usage analysis by raw server device_id; used only as a Review API filter')
    .option('--device-name <name>', 'Limit usage analysis by raw server device_name; used only as a Review API filter')
    .option('--bot-key <key>', 'Limit usage analysis to one redacted Review API bot_key')
    .option('--person-key <key>', 'Limit usage analysis to one redacted Review API person_key')
    .option('--actor-key <key>', 'Limit usage analysis to one redacted Review API actor_key')
    .option('--actor-catsco-user-key <key>', 'Limit usage analysis to one redacted Review API actor_catsco_user_key')
    .option('--actor-weixin-user-key <key>', 'Limit usage analysis to one redacted Review API actor_weixin_user_key')
    .option('--actor-feishu-user-key <key>', 'Limit usage analysis to one redacted Review API actor_feishu_user_key')
    .option('--bot-id <id>', 'Limit usage analysis by raw server bot_id; used only as a Review API filter')
    .option('--person-id <id>', 'Limit usage analysis by raw server person_id; used only as a Review API filter')
    .option('--actor-external-user-id <id>', 'Limit usage analysis by raw server actor_external_user_id; used only as a Review API filter')
    .option('--actor-catsco-user-id <id>', 'Limit usage analysis by raw server actor_catsco_user_id; used only as a Review API filter')
    .option('--actor-weixin-user-id <id>', 'Limit usage analysis by raw server actor_weixin_user_id; used only as a Review API filter')
    .option('--actor-feishu-user-id <id>', 'Limit usage analysis by raw server actor_feishu_user_id; used only as a Review API filter')
    .option('--session-id <id>', 'Limit usage analysis by raw server session_id; used only as a Review API filter')
    .option('--session-key <key>', 'Limit usage analysis to one redacted Review API session_key')
    .option('--session-type <type>', 'Limit usage analysis to one session_type')
    .option('--org-key <key>', 'Limit usage analysis to one org_key')
    .option('--org-type <type>', 'Limit usage analysis to one org_type, such as school')
    .option('--user-role <role>', 'Limit usage analysis to one user_role')
    .option('--device-role <role>', 'Limit usage analysis to one device_role')
    .option('--channel-type <type>', 'Limit usage analysis to one channel_type')
    .option('--workspace-key <key>', 'Limit usage analysis to one workspace_key')
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
  targetRepo?: string;
  createBranch?: boolean;
  commit?: boolean;
  createPr?: boolean;
} & ReviewTargetCliOptions): Promise<void> {
  try {
    const config = getCatscoReviewAgentConfig(options.cwd);
    const result = await runCatscoReviewAgent(config, {
      lookbackHours: parsePositiveInteger(options.lookbackHours),
      outputDir: options.outputDir,
      ...reviewTargetOptionsFromCli(options),
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
  maxEvidenceItems?: string;
  maxEvidenceChars?: string;
  maxSessions?: string;
  maxTurnsPerSession?: string;
  maxTargetTurns?: string;
} & ReviewTargetCliOptions): Promise<void> {
  try {
    const context = await loadReviewQuestionContext(reviewQuestionOptionsFromCli(options));
    const answer = await answerReviewQuestion(question, context, new AIService(), {
      maxEvidenceItems: parsePositiveInteger(options.maxEvidenceItems),
      maxEvidenceChars: parsePositiveInteger(options.maxEvidenceChars),
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
  maxEvidenceItems?: string;
  maxEvidenceChars?: string;
  maxSessions?: string;
  maxTurnsPerSession?: string;
  maxTargetTurns?: string;
  fixedRange?: boolean;
} & ReviewTargetCliOptions): Promise<void> {
  const fixedRange = Boolean(options.fixedRange);
  let fixedContext: ReviewQuestionContext | undefined;

  if (fixedRange) {
    try {
      fixedContext = await loadReviewQuestionContext(reviewQuestionOptionsFromCli(options));
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
  const maxEvidenceChars = parsePositiveInteger(options.maxEvidenceChars);
  const aiService = new AIService();
  const history: ReviewQuestionChatTurn[] = [];
  let closed = false;
  let queue = Promise.resolve();

  rl.prompt();
  rl.on('close', () => {
    closed = true;
  });
  rl.on('line', (line) => {
    const question = line.trim();
    queue = queue
      .then(() => handleReviewChatQuestion(question, {
        aiService,
        fixedContext,
        history,
        maxEvidenceItems,
        maxEvidenceChars,
        options,
        rl,
        isClosed: () => closed,
      }))
      .catch((error: any) => {
        Logger.error(error.message);
        if (!closed) rl.prompt();
      });
  });
}

async function handleReviewChatQuestion(question: string, input: {
  aiService: AIService;
  fixedContext?: ReviewQuestionContext;
  history: ReviewQuestionChatTurn[];
  maxEvidenceItems?: number;
  maxEvidenceChars?: number;
  options: {
    cwd: string;
    lookbackHours?: string;
    maxSessions?: string;
    maxTurnsPerSession?: string;
    maxTargetTurns?: string;
  } & ReviewTargetCliOptions;
  rl: readline.Interface;
  isClosed: () => boolean;
}): Promise<void> {
  if (input.isClosed()) return;

  if (!question) {
    input.rl.prompt();
    return;
  }
  if (question === '/exit' || question === 'exit' || question === 'quit') {
    input.rl.close();
    return;
  }
  try {
    const context = input.fixedContext || (await loadReviewQuestionContext(reviewQuestionOptionsFromCli(input.options)));
    const answer = await answerReviewQuestion(question, context, input.aiService, {
      maxEvidenceItems: input.maxEvidenceItems,
      maxEvidenceChars: input.maxEvidenceChars,
      conversationHistory: input.history,
    });
    console.log(`\n${answer}\n`);
    input.history.push({ question, answer });
    if (input.history.length > 6) input.history.shift();
  } catch (error: any) {
    Logger.error(error.message);
  }
  if (!input.isClosed()) {
    input.rl.prompt();
  }
}

function reviewQuestionOptionsFromCli(options: {
  cwd: string;
  lookbackHours?: string;
  maxSessions?: string;
  maxTurnsPerSession?: string;
  maxTargetTurns?: string;
} & ReviewTargetCliOptions): LoadReviewQuestionContextOptions {
  return {
    cwd: options.cwd,
    lookbackHours: parsePositiveInteger(options.lookbackHours),
    ...reviewTargetOptionsFromCli(options),
    maxSessions: parsePositiveInteger(options.maxSessions),
    maxTurnsPerSession: parsePositiveInteger(options.maxTurnsPerSession),
    maxTargetTurns: parsePositiveInteger(options.maxTargetTurns),
  };
}

async function reviewDaemonCommand(options: {
  cwd: string;
  intervalMinutes?: string;
  lookbackHours?: string;
  outputDir?: string;
} & ReviewTargetCliOptions): Promise<void> {
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
  let wakeSleep: (() => void) | undefined;

  const stop = () => {
    stopped = true;
    wakeSleep?.();
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
        ...reviewTargetOptionsFromCli(options),
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
      await sleep(intervalMinutes * 60 * 1000, wake => {
        wakeSleep = wake;
      });
      wakeSleep = undefined;
    }
  }
}

function reviewTargetOptionsFromCli(options: ReviewTargetCliOptions) {
  return {
    targetUserId: stringOrUndefined(options.userId),
    targetDeviceId: stringOrUndefined(options.deviceId),
    targetDeviceName: stringOrUndefined(options.deviceName),
    targetBotId: stringOrUndefined(options.botId),
    targetPersonId: stringOrUndefined(options.personId),
    targetActorExternalUserId: stringOrUndefined(options.actorExternalUserId),
    targetActorCatscoUserId: stringOrUndefined(options.actorCatscoUserId),
    targetActorWeixinUserId: stringOrUndefined(options.actorWeixinUserId),
    targetActorFeishuUserId: stringOrUndefined(options.actorFeishuUserId),
    targetUserKey: stringOrUndefined(options.userKey),
    targetDeviceKey: stringOrUndefined(options.deviceKey),
    targetBotKey: stringOrUndefined(options.botKey),
    targetPersonKey: stringOrUndefined(options.personKey),
    targetActorKey: stringOrUndefined(options.actorKey),
    targetActorCatscoUserKey: stringOrUndefined(options.actorCatscoUserKey),
    targetActorWeixinUserKey: stringOrUndefined(options.actorWeixinUserKey),
    targetActorFeishuUserKey: stringOrUndefined(options.actorFeishuUserKey),
    targetSessionId: stringOrUndefined(options.sessionId),
    targetSessionKey: stringOrUndefined(options.sessionKey),
    targetSessionType: stringOrUndefined(options.sessionType),
    targetOrgKey: stringOrUndefined(options.orgKey),
    targetOrgType: stringOrUndefined(options.orgType),
    targetUserRole: stringOrUndefined(options.userRole),
    targetDeviceRole: stringOrUndefined(options.deviceRole),
    targetChannelType: stringOrUndefined(options.channelType),
    targetWorkspaceKey: stringOrUndefined(options.workspaceKey),
  };
}

function stringOrUndefined(value?: string): string | undefined {
  const text = String(value || '').trim();
  return text || undefined;
}

function parsePositiveInteger(raw?: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function sleep(ms: number, registerWake?: (wake: () => void) => void): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(finish, ms);
    registerWake?.(finish);
  });
}
